import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  resolverTramos,
  type TramoModo,
  type TramoResuelto,
  type TramoRow,
} from "@/lib/rrhh/novedadTramo";

export const dynamic = "force-dynamic";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// GET ?desde&hasta[&employee_no] — novedades "con marca" del rango, ya
// resueltas contra las fichadas del reloj y el horario asignado al área.
// Barato: sólo toca las filas de asistencia.novedad_tramo del rango y las
// marcas de esos (empleado, día).
export async function GET(req: NextRequest) {
  try {
    const sp = new URL(req.url).searchParams;
    const desde = sp.get("desde");
    const hasta = sp.get("hasta");
    const employee_no = sp.get("employee_no");
    if (!desde || !hasta || !ISO_DATE.test(desde) || !ISO_DATE.test(hasta)) {
      return NextResponse.json(
        { error: "desde y hasta (YYYY-MM-DD) son obligatorios" },
        { status: 400 },
      );
    }

    const params: unknown[] = [desde, hasta];
    let filtroEmp = "";
    if (employee_no) {
      params.push(employee_no);
      filtroEmp = "AND t.employee_no = $3";
    }

    // Tramos + horario del área (con fallback a "Estándar (Lun-Vie)").
    const tramos = await prisma.$queryRawUnsafe<any[]>(
      `
      SELECT t.id, t.employee_no, to_char(t.fecha, 'YYYY-MM-DD') AS fecha,
             t.novedad, t.modo, t.creado_at,
             to_char(ht.hora_entrada, 'HH24:MI') AS entrada,
             to_char(
               CASE WHEN EXTRACT(DOW FROM t.fecha) = 5
                    THEN COALESCE(ht.hora_salida_vie, ht.hora_salida)
                    ELSE ht.hora_salida END,
               'HH24:MI') AS salida
      FROM asistencia.novedad_tramo t
      LEFT JOIN everwear.legajo l
        ON COALESCE(l."employeeNo", 'L' || l.id::text) = t.employee_no
       AND l.estado = 'ACTIVO'
      LEFT JOIN everwear.sector s ON s.id = l."sectorId"
      LEFT JOIN everwear.area   ar ON ar.id = s."areaId"
      LEFT JOIN asistencia.horario_area ha
        ON ha.departamento = COALESCE(ar.nombre, l.sector)
      LEFT JOIN asistencia.horario_tipo ht
        ON ht.id = COALESCE(
             ha.horario_tipo_id,
             (SELECT id FROM asistencia.horario_tipo WHERE nombre = 'Estándar (Lun-Vie)' LIMIT 1))
      WHERE t.fecha BETWEEN $1::date AND $2::date ${filtroEmp}
      ORDER BY t.fecha, t.creado_at
      `,
      ...params,
    );

    if (tramos.length === 0) return NextResponse.json([]);

    // Marcas del reloj sólo para los (empleado, día) con novedad. Cruce
    // exacto por employee_no; con padding distinto ("40" vs "00000040") cae al
    // match sin ceros sólo si NINGÚN otro legajo activo comparte esa clave
    // (mismo criterio que resumen/route.ts).
    const marcasRows = await prisma.$queryRawUnsafe<any[]>(
      `
      WITH t AS (
        SELECT DISTINCT t.employee_no, t.fecha
        FROM asistencia.novedad_tramo t
        WHERE t.fecha BETWEEN $1::date AND $2::date ${filtroEmp}
      )
      SELECT t.employee_no, to_char(t.fecha, 'YYYY-MM-DD') AS fecha, e.event_time
      FROM t
      JOIN asistencia.evento e
        ON e.event_time >= (t.fecha::timestamp AT TIME ZONE 'America/Argentina/Buenos_Aires')
       AND e.event_time <  ((t.fecha + 1)::timestamp AT TIME ZONE 'America/Argentina/Buenos_Aires')
       AND ltrim(e.employee_no, '0') = ltrim(t.employee_no, '0')
       AND (
         e.employee_no = t.employee_no
         OR NOT EXISTS (
           SELECT 1 FROM everwear.legajo l2
           WHERE l2.estado = 'ACTIVO'
             AND l2."employeeNo" IS NOT NULL
             AND l2."employeeNo" <> t.employee_no
             AND ltrim(l2."employeeNo", '0') = ltrim(t.employee_no, '0')
         )
       )
      UNION ALL
      -- Ajuste manual de ingreso/egreso (RRHH) cuenta como marca.
      SELECT t.employee_no, to_char(t.fecha, 'YYYY-MM-DD'), x.ts
      FROM t
      JOIN asistencia.ajuste_manual am
        ON am.employee_no = t.employee_no AND am.fecha = t.fecha
      CROSS JOIN LATERAL (VALUES (am.check_in), (am.check_out)) AS x(ts)
      WHERE x.ts IS NOT NULL
      `,
      ...params,
    );

    const marcasPor = new Map<string, Date[]>();
    for (const m of marcasRows) {
      const k = `${m.employee_no}|${m.fecha}`;
      const arr = marcasPor.get(k) ?? [];
      arr.push(new Date(m.event_time));
      marcasPor.set(k, arr);
    }

    const grupos = new Map<
      string,
      { rows: TramoRow[]; entrada: string | null; salida: string | null }
    >();
    for (const r of tramos) {
      const k = `${r.employee_no}|${r.fecha}`;
      const g: { rows: TramoRow[]; entrada: string | null; salida: string | null } =
        grupos.get(k) ?? { rows: [], entrada: r.entrada ?? null, salida: r.salida ?? null };
      g.rows.push({
        id: r.id,
        employee_no: r.employee_no,
        fecha: r.fecha,
        novedad: r.novedad,
        modo: r.modo as TramoModo,
        creado_at: new Date(r.creado_at).toISOString(),
      });
      grupos.set(k, g);
    }

    const ahora = new Date();
    const out: TramoResuelto[] = [];
    for (const [k, g] of grupos) {
      out.push(
        ...resolverTramos(
          g.rows,
          marcasPor.get(k) ?? [],
          { entrada: g.entrada, salida: g.salida },
          ahora,
        ),
      );
    }
    return NextResponse.json(out);
  } catch (e: any) {
    console.error("[tramos GET]", e);
    return NextResponse.json({ error: e?.message ?? "error" }, { status: 500 });
  }
}

// POST { employee_no, fecha, novedad, modo } — carga la novedad. No lleva
// horas: corre cuando el empleado marca en el reloj.
export async function POST(req: NextRequest) {
  try {
    const b = await req.json();
    const employee_no = String(b.employee_no ?? "").trim();
    const fecha = String(b.fecha ?? "");
    const novedad = String(b.novedad ?? "").trim();
    const modo = b.modo;
    if (!employee_no || !ISO_DATE.test(fecha) || !novedad || (modo !== "sale" && modo !== "llega_tarde")) {
      return NextResponse.json(
        { error: "employee_no, fecha, novedad y modo (sale|llega_tarde) son obligatorios" },
        { status: 400 },
      );
    }
    await prisma.$executeRaw`
      INSERT INTO asistencia.novedad_tramo (employee_no, fecha, novedad, modo)
      VALUES (${employee_no}, ${fecha}::date, ${novedad}, ${modo})
    `;
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error("[tramos POST]", e);
    return NextResponse.json({ error: e?.message ?? "error" }, { status: 500 });
  }
}

// DELETE ?id=N — quita la novedad.
export async function DELETE(req: NextRequest) {
  try {
    const id = Number(new URL(req.url).searchParams.get("id"));
    if (!Number.isInteger(id) || id <= 0) {
      return NextResponse.json({ error: "id inválido" }, { status: 400 });
    }
    await prisma.$executeRaw`DELETE FROM asistencia.novedad_tramo WHERE id = ${id}`;
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error("[tramos DELETE]", e);
    return NextResponse.json({ error: e?.message ?? "error" }, { status: 500 });
  }
}
