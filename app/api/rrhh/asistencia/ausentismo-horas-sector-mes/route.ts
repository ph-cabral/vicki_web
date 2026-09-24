import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// Horas solicitadas por área (sector) y mes para un año completo — gráfico
// "Ausentismo por sector – Horas solicitadas" de la pestaña Ausentismo de /rrhh.
//
// Fuente: asistencia.novedad_diaria (columna `novedades`: [{novedad, horas}]).
// Si un día trae varias novedades se suman todas; si `novedades` viene vacía
// se usa la columna `horas`. Área = everwear.area del sector del legajo (mismo
// COALESCE que /resumen), incluyendo legajos dados de baja.
export async function GET(req: NextRequest) {
  try {
    const anioParam = req.nextUrl.searchParams.get("anio");
    const anio = anioParam ? Number(anioParam) : new Date().getFullYear();
    if (!Number.isInteger(anio) || anio < 2000 || anio > 2100) {
      return NextResponse.json({ error: "anio inválido" }, { status: 400 });
    }

    const rows = await prisma.$queryRawUnsafe<
      { mes: string; area: string; horas: number }[]
    >(
      `
      WITH leg AS (
        SELECT DISTINCT ON (COALESCE(l."employeeNo", 'L' || l.id::text))
               COALESCE(l."employeeNo", 'L' || l.id::text) AS employee_no,
               NULLIF(TRIM(COALESCE(ar.nombre, l.sector)), '') AS area
        FROM everwear.legajo l
        LEFT JOIN everwear.sector s ON s.id = l."sectorId"
        LEFT JOIN everwear.area  ar ON ar.id = s."areaId"
        ORDER BY COALESCE(l."employeeNo", 'L' || l.id::text), (l.estado = 'ACTIVO') DESC, l.id DESC
      )
      SELECT to_char(n.fecha, 'YYYY-MM') AS mes,
             COALESCE(g.area, 'Sin área') AS area,
             SUM(COALESCE(
               (SELECT SUM((e->>'horas')::numeric)
                  FROM jsonb_array_elements(
                         CASE WHEN jsonb_typeof(n.novedades) = 'array'
                              THEN n.novedades ELSE '[]'::jsonb END) e),
               n.horas, 0
             ))::float8 AS horas
      FROM asistencia.novedad_diaria n
      LEFT JOIN leg g ON g.employee_no = n.employee_no
      WHERE n.fecha BETWEEN $1::date AND $2::date
      GROUP BY 1, 2
      ORDER BY 1, 2
      `,
      `${anio}-01-01`,
      `${anio}-12-31`,
    );

    return NextResponse.json({
      anio,
      rows: rows.map((r) => ({ mes: r.mes, area: r.area, horas: Number(r.horas) })),
    });
  } catch (e: any) {
    console.error("[ausentismo-horas-sector-mes]", e);
    return NextResponse.json({ error: e?.message ?? "error" }, { status: 500 });
  }
}
