import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

type NovItem = { novedad: string; horas: number };

type Row = {
  employee_no: string;
  employee_name: string | null;
  departamento: string | null;
  sector: string | null;
  lugar: string | null;
  fecha: string;
  check_in: string | null;
  check_out: string | null;
  minutos: number | null;
  eventos_dia: number | null;
  devices: string | null;
  ajustado: boolean;
  feriado: boolean;
  estado: string | null;
  dias: number | null;
  novedad: string | null; // legacy: nombres unidos por ", "
  horas: number | null; // SUMA de horas de las novedades del día
  novedades: NovItem[]; // lista [{novedad, horas}]
};

// jsonb puede llegar ya parseado (array) o como string según el driver.
const asItems = (v: unknown): NovItem[] => {
  if (Array.isArray(v)) return v as NovItem[];
  if (typeof v === "string" && v.trim()) {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }
  return [];
};

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const desde = searchParams.get("desde");
    const hasta = searchParams.get("hasta");
    const employee_no = searchParams.get("employee_no");

    if (!desde || !hasta) {
      return NextResponse.json(
        { error: "desde y hasta son obligatorios (YYYY-MM-DD)" },
        { status: 400 },
      );
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(desde) || !/^\d{4}-\d{2}-\d{2}$/.test(hasta)) {
      return NextResponse.json(
        { error: "desde y hasta deben tener formato YYYY-MM-DD" },
        { status: 400 },
      );
    }
    if (hasta < desde) {
      return NextResponse.json(
        { error: "hasta debe ser >= desde" },
        { status: 400 },
      );
    }

    const rows = await prisma.$queryRawUnsafe<any[]>(
      `
      WITH bounds AS (
        SELECT ($1::date)::timestamp AT TIME ZONE 'America/Argentina/Buenos_Aires' AS lo,
               (($2::date + 1)::timestamp) AT TIME ZONE 'America/Argentina/Buenos_Aires' AS hi
      ),
      dias AS (
        SELECT generate_series($1::date, $2::date, interval '1 day')::date AS fecha
      ),
      -- Legajo sin employeeNo (no pasa por el reloj de asistencia — hoy 14 de
      -- 87 activos) recibe una clave sintética 'L<id>': nunca puede pisar un
      -- employeeNo real (el reloj sólo manda IDs numéricos) y es estable
      -- mientras no se le cargue employeeNo. MISMA fórmula que
      -- /api/rrhh/asistencia/empleados — así lo que se guarda desde el botón
      -- "Nuevo estado"/"Nueva novedad" para esa gente aparece acá en vez de
      -- quedar huérfano en estado_diario/novedad_diaria (2026-09-18).
      act AS (
        SELECT COALESCE(l."employeeNo", 'L' || l.id::text) AS employee_no,
               NULLIF(TRIM(l.nombre), '') AS employee_name,
               COALESCE(ar.nombre, l.sector) AS departamento,
               COALESCE(s.nombre, l.sector) AS sector,
               lu.nombre AS lugar
        FROM everwear.legajo l
        LEFT JOIN everwear.sector s ON s.id = l."sectorId"
        LEFT JOIN everwear.area   ar ON ar.id = s."areaId"
        LEFT JOIN everwear.lugar  lu ON lu.id = l."lugarId"
        WHERE l.estado = 'ACTIVO'
        ${employee_no ? `AND COALESCE(l."employeeNo", 'L' || l.id::text) = $3` : ""}
      ),
      -- Cuántos legajos activos comparten la misma clave "sin ceros a la
      -- izquierda" (ej. "40" y "00000040" comparten clave "40" pero son
      -- personas DISTINTAS — bug reportado 2026-08-13: Boscacci Vladimir
      -- vs Pereyra Francisco quedaban fusionados en asistencia).
      fuzzy_counts AS (
        SELECT ltrim(employee_no, '0') AS fuzzy_key, COUNT(*) AS n
        FROM act
        GROUP BY ltrim(employee_no, '0')
      ),
      ev_ids AS (
        SELECT DISTINCT e.employee_no AS raw_no
        FROM asistencia.evento e, bounds b
        WHERE e.event_time >= b.lo AND e.event_time < b.hi
      ),
      -- Resuelve cada ID crudo que manda el reloj al employeeNo real del
      -- legajo:
      --   1) match EXACTO si existe — nunca se mezclan dos legajos activos
      --      que sólo difieren en ceros a la izquierda.
      --   2) si no hay exacto, cae al match "sin ceros" (mismo criterio que
      --      antes) SÓLO si es único entre los legajos activos — cubre el
      --      caso real (commit "fix match employee chock") donde un reloj
      --      devuelve el ID con padding distinto al del legajo para la
      --      MISMA persona.
      emp_map AS (
        SELECT
          i.raw_no,
          COALESCE(exacto.employee_no, difuso.employee_no) AS employee_no
        FROM ev_ids i
        LEFT JOIN act exacto ON exacto.employee_no = i.raw_no
        LEFT JOIN LATERAL (
          SELECT a.employee_no
          FROM act a
          JOIN fuzzy_counts fc ON fc.fuzzy_key = ltrim(a.employee_no, '0')
          WHERE exacto.employee_no IS NULL
            AND ltrim(a.employee_no, '0') = ltrim(i.raw_no, '0')
            AND fc.n = 1
          LIMIT 1
        ) difuso ON true
      ),
      -- Margen anti-duplicado: 2 marcas del mismo reloj a menos de esto se
      -- colapsan en 1 sola (el reloj a veces tipea 2 veces el mismo toque).
      params AS (
        SELECT interval '5 minutes' AS margen
      ),
      raw_ev AS (
        SELECT
          m.employee_no AS emp_key,
          (e.event_time AT TIME ZONE 'America/Argentina/Buenos_Aires')::date AS fecha,
          e.device,
          e.event_time
        FROM asistencia.evento e
        JOIN emp_map m ON m.raw_no = e.employee_no
        CROSS JOIN bounds b
        WHERE e.event_time >= b.lo AND e.event_time < b.hi
          AND m.employee_no IS NOT NULL
      ),
      devices_agg AS (
        SELECT emp_key, fecha, string_agg(DISTINCT device, ',' ORDER BY device) AS devices
        FROM raw_ev
        GROUP BY emp_key, fecha
      ),
      gapped AS (
        SELECT r.*,
               r.event_time - LAG(r.event_time)
                 OVER (PARTITION BY r.emp_key, r.fecha ORDER BY r.event_time) AS gap
        FROM raw_ev r
      ),
      -- "Islas": corridas de fichajes separadas por >= margen. Cada isla es
      -- 1 sola marca real (si el reloj duplicó el toque, cae en la misma isla).
      islas AS (
        SELECT g.*,
               SUM(CASE WHEN g.gap IS NULL OR g.gap >= p.margen THEN 1 ELSE 0 END)
                 OVER (PARTITION BY g.emp_key, g.fecha ORDER BY g.event_time) AS isla
        FROM gapped g, params p
      ),
      marcas AS (
        SELECT emp_key, fecha, isla, MIN(event_time) AS mark_time
        FROM islas
        GROUP BY emp_key, fecha, isla
      ),
      -- Un día con marcas completas (entrada/salida, con o sin cortes para
      -- almorzar) siempre tiene una cantidad PAR de marcas. Si un día tiene
      -- exactamente 3, la del medio es un fichaje espurio (duplicado/error de
      -- reloj) — si se toma como egreso de un "corte", resta como no
      -- trabajado un tramo que en realidad sí se trabajó. Se descarta esa
      -- marca del medio y quedan sólo la 1ra y la última (2026-07-30).
      marcas_cnt AS (
        SELECT emp_key, fecha, COUNT(*) AS cnt
        FROM marcas
        GROUP BY emp_key, fecha
      ),
      marcas_filtradas AS (
        SELECT m.emp_key, m.fecha, m.mark_time
        FROM marcas m
        JOIN marcas_cnt mc ON mc.emp_key = m.emp_key AND mc.fecha = m.fecha
        WHERE NOT (
          mc.cnt = 3
          AND m.mark_time = (
            SELECT m2.mark_time FROM marcas m2
            WHERE m2.emp_key = m.emp_key AND m2.fecha = m.fecha
            ORDER BY m2.mark_time
            OFFSET 1 LIMIT 1
          )
        )
      ),
      -- Impar = INGRESO, par = EGRESO, por posición dentro del día (no por
      -- major/minor del reloj). Pedido de RRHH 2026-07-28.
      posn AS (
        SELECT emp_key, fecha, mark_time,
               ROW_NUMBER() OVER (PARTITION BY emp_key, fecha ORDER BY mark_time) AS posn,
               LAG(mark_time) OVER (PARTITION BY emp_key, fecha ORDER BY mark_time) AS prev_mark_time
        FROM marcas_filtradas
      ),
      ev AS (
        SELECT
          p.emp_key,
          p.fecha,
          d.devices,
          MIN(p.mark_time) FILTER (WHERE p.posn % 2 = 1) AS check_in,
          MAX(p.mark_time) FILTER (WHERE p.posn % 2 = 0) AS check_out,
          -- Minutos = suma de cada par (ingreso→egreso), no primer-a-último.
          -- Así un corte para almorzar (egreso→ingreso) no cuenta como trabajado.
          COALESCE(SUM(
            CASE WHEN p.posn % 2 = 0
              THEN GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (p.mark_time - p.prev_mark_time)) / 60))
              ELSE 0
            END
          ), 0)::int AS minutos,
          COUNT(*)::int AS eventos_dia
        FROM posn p
        JOIN devices_agg d ON d.emp_key = p.emp_key AND d.fecha = p.fecha
        GROUP BY p.emp_key, p.fecha, d.devices
      )
      SELECT
        a.employee_no,
        a.employee_name,
        a.departamento,
        a.sector,
        a.lugar,
        to_char(d.fecha, 'YYYY-MM-DD') AS fecha,
        ev.devices,
        COALESCE(am.check_in, ev.check_in)   AS check_in,
        COALESCE(am.check_out, ev.check_out) AS check_out,
        CASE
          WHEN am.check_in IS NOT NULL OR am.check_out IS NOT NULL THEN
            GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (
              COALESCE(am.check_out, ev.check_out) - COALESCE(am.check_in, ev.check_in)
            )) / 60))::int
          ELSE COALESCE(ev.minutos, 0)
        END AS minutos,
        COALESCE(ev.eventos_dia, 0) AS eventos_dia,
        (am.check_in IS NOT NULL OR am.check_out IS NOT NULL) AS ajustado,
        (fer.fecha IS NOT NULL) AS feriado,
        CASE
          WHEN ed.dias IS NOT NULL AND ed.dias <= 0 THEN NULL
          ELSE COALESCE(ed.estado, c.c_estado)
        END AS estado,
        CASE
          WHEN ed.dias IS NOT NULL AND ed.dias <= 0 THEN NULL
          ELSE COALESCE(ed.dias, c.c_dias)
        END AS dias,
        nd.novedad   AS novedad,
        nd.horas     AS horas,
        nd.novedades AS novedades
      FROM dias d
      CROSS JOIN act a
      LEFT JOIN ev ON ev.emp_key = a.employee_no AND ev.fecha = d.fecha
      LEFT JOIN asistencia.ajuste_manual am
        ON am.employee_no = a.employee_no AND am.fecha = d.fecha
      LEFT JOIN asistencia.feriado fer
        ON fer.fecha = d.fecha
      LEFT JOIN asistencia.estado_diario ed
        ON ed.employee_no = a.employee_no AND ed.fecha = d.fecha
      -- Arrastre de días: si no hay registro explícito para esta fecha, busca el
      -- origen (estado + días) explícito más reciente cuya ventana [fecha, fecha+dias-1]
      -- cubra el día actual, y calcula los días restantes (cuenta regresiva).
      LEFT JOIN LATERAL (
        SELECT ed2.estado AS c_estado,
               ed2.dias - (d.fecha - ed2.fecha) AS c_dias
        FROM asistencia.estado_diario ed2
        WHERE ed.estado IS NULL
          AND ed2.employee_no = a.employee_no
          AND ed2.dias IS NOT NULL
          AND ed2.fecha < d.fecha
          AND ed2.fecha + (ed2.dias - 1) >= d.fecha
        ORDER BY ed2.fecha DESC
        LIMIT 1
      ) c ON true
      LEFT JOIN asistencia.novedad_diaria nd
        ON nd.employee_no = a.employee_no AND nd.fecha = d.fecha
      ORDER BY a.employee_name NULLS LAST, d.fecha
      `,
      desde,
      hasta,
      ...(employee_no ? [employee_no] : []),
    );

    const fmt = (d: Date | null) => (d ? d.toISOString() : null);

    const out: Row[] = rows.map((r) => ({
      employee_no: r.employee_no,
      employee_name: r.employee_name ?? null,
      departamento: r.departamento ?? null,
      sector: r.sector ?? null,
      lugar: r.lugar ?? null,
      fecha: r.fecha,
      check_in: fmt(r.check_in),
      check_out: fmt(r.check_out),
      minutos: r.minutos,
      eventos_dia: r.eventos_dia,
      devices: r.devices ?? null,
      ajustado: r.ajustado === true,
      feriado: r.feriado === true,
      estado: r.estado ?? null,
      dias: r.dias ?? null,
      novedad: r.novedad ?? null,
      horas: r.horas ?? null,
      novedades: asItems(r.novedades),
    }));

    return NextResponse.json(out);
  } catch (e: any) {
    console.error("[resumen]", e);
    return NextResponse.json({ error: e?.message ?? "error" }, { status: 500 });
  }
}
