import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ESTADOS_NO_AUSENCIA } from "@/lib/rrhh/asistenciaIndicadores";

export const dynamic = "force-dynamic";

// Ausentismo por área (sector de la empresa) y mes para un año completo —
// gráfico "Ausentismo por sector y mes" de la pestaña Ausentismo de /rrhh.
//
// Mismo criterio de "día de ausencia" que computeIndicadores
// (lib/rrhh/asistenciaIndicadores.ts), pero resuelto en SQL y sin pasar por
// las fichadas (el endpoint /resumen calcula eventos del reloj para cada
// empleado × día, demasiado pesado para un año entero):
//   - Estado vigente del día = registro explícito de estado_diario para esa
//     fecha, o el arrastre (`dias`) del origen más reciente que lo cubra.
//     Un registro explícito con dias <= 0 anula el estado de ese día.
//   - Cuenta si el estado NO está en ESTADOS_NO_AUSENCIA.
//   - Sólo días hábiles: tope > 0 según el horario_tipo del área
//     (fallback "Estándar (Lun-Vie)") y que no sea feriado.
// Área = everwear.area del sector del legajo (mismo COALESCE que /resumen).
// Incluye legajos dados de baja: el ausentismo de meses pasados no se pierde
// cuando alguien deja la empresa.
export async function GET(req: NextRequest) {
  try {
    const anioParam = req.nextUrl.searchParams.get("anio");
    const anio = anioParam ? Number(anioParam) : new Date().getFullYear();
    if (!Number.isInteger(anio) || anio < 2000 || anio > 2100) {
      return NextResponse.json({ error: "anio inválido" }, { status: 400 });
    }

    const rows = await prisma.$queryRawUnsafe<
      { mes: string; area: string; dias: number }[]
    >(
      `
      WITH rango AS (
        SELECT $1::date AS lo,
               LEAST($2::date, (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date) AS hi
      ),
      -- Cada registro se expande a los días que cubre (dias NULL o <= 0 → sólo su fecha).
      exp AS (
        SELECT ed.employee_no,
               gs::date AS dia,
               ed.fecha AS origen,
               CASE WHEN ed.dias IS NOT NULL AND ed.dias <= 0 THEN NULL ELSE ed.estado END AS estado
        FROM asistencia.estado_diario ed
        CROSS JOIN rango r
        CROSS JOIN LATERAL generate_series(
          ed.fecha,
          ed.fecha + (GREATEST(COALESCE(ed.dias, 1), 1) - 1),
          interval '1 day'
        ) gs
        WHERE ed.fecha <= r.hi
          AND ed.fecha + (GREATEST(COALESCE(ed.dias, 1), 1) - 1) >= r.lo
      ),
      -- Estado vigente: el origen más reciente (el explícito del día gana solo).
      vig AS (
        SELECT DISTINCT ON (e.employee_no, e.dia) e.employee_no, e.dia, e.estado
        FROM exp e, rango r
        WHERE e.dia BETWEEN r.lo AND r.hi
        ORDER BY e.employee_no, e.dia, e.origen DESC
      ),
      -- Un legajo por clave (misma clave sintética 'L<id>' que /resumen);
      -- si la clave se repite, prima el ACTIVO.
      leg AS (
        SELECT DISTINCT ON (COALESCE(l."employeeNo", 'L' || l.id::text))
               COALESCE(l."employeeNo", 'L' || l.id::text) AS employee_no,
               NULLIF(TRIM(COALESCE(ar.nombre, l.sector)), '') AS area
        FROM everwear.legajo l
        LEFT JOIN everwear.sector s ON s.id = l."sectorId"
        LEFT JOIN everwear.area  ar ON ar.id = s."areaId"
        ORDER BY COALESCE(l."employeeNo", 'L' || l.id::text), (l.estado = 'ACTIVO') DESC, l.id DESC
      ),
      std AS (
        SELECT * FROM asistencia.horario_tipo
        ORDER BY (nombre = 'Estándar (Lun-Vie)') DESC, id
        LIMIT 1
      )
      SELECT to_char(v.dia, 'YYYY-MM') AS mes,
             COALESCE(g.area, 'Sin área') AS area,
             COUNT(*)::int AS dias
      FROM vig v
      JOIN leg g ON g.employee_no = v.employee_no
      LEFT JOIN asistencia.horario_area ha ON ha.departamento = g.area
      LEFT JOIN asistencia.horario_tipo ht ON ht.id = ha.horario_tipo_id
      LEFT JOIN std ON true
      WHERE v.estado IS NOT NULL
        AND v.estado <> ALL($3::text[])
        AND NOT EXISTS (SELECT 1 FROM asistencia.feriado f WHERE f.fecha = v.dia)
        AND COALESCE(
              CASE EXTRACT(ISODOW FROM v.dia)::int
                WHEN 1 THEN COALESCE(ht.tope_lun, std.tope_lun)
                WHEN 2 THEN COALESCE(ht.tope_mar, std.tope_mar)
                WHEN 3 THEN COALESCE(ht.tope_mie, std.tope_mie)
                WHEN 4 THEN COALESCE(ht.tope_jue, std.tope_jue)
                WHEN 5 THEN COALESCE(ht.tope_vie, std.tope_vie)
                WHEN 6 THEN COALESCE(ht.tope_sab, std.tope_sab)
                ELSE COALESCE(ht.tope_dom, std.tope_dom)
              END,
              -- sin horario_tipo cargado: Lun-Vie hábil (mismo fallback que topeMin)
              CASE WHEN EXTRACT(ISODOW FROM v.dia) BETWEEN 1 AND 5 THEN 1 ELSE 0 END
            ) > 0
      GROUP BY 1, 2
      ORDER BY 1, 2
      `,
      `${anio}-01-01`,
      `${anio}-12-31`,
      ESTADOS_NO_AUSENCIA,
    );

    return NextResponse.json({
      anio,
      rows: rows.map((r) => ({ mes: r.mes, area: r.area, dias: Number(r.dias) })),
    });
  } catch (e: any) {
    console.error("[ausentismo-sector-mes]", e);
    return NextResponse.json({ error: e?.message ?? "error" }, { status: 500 });
  }
}
