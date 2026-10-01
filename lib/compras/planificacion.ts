// /compras/planificacion — tipos y acceso a los reportes guardados por usuario
// (preparado.compras_planificacion_reporte, ver sql/compras_planificacion_reporte.sql).
//
// Todo acceso filtra por "usuarioId" = uid de la sesión: un usuario nunca lee
// ni edita los botones de otro (ni siendo ADMIN — la vista es personal).
import { prisma } from "@/lib/prisma";

export interface PlanifReporte {
  id: number;
  nombre: string;
  lineas: number[];
  rubros: number[];
  subRubros: number[];
  subSubRubros: number[];
  meses: number;
  orden: number;
}

export interface PlanifReporteIn {
  nombre: string;
  lineas: number[];
  rubros: number[];
  subRubros: number[];
  subSubRubros: number[];
  meses: number;
}

export const TABLA_FALTA_MSG =
  "Falta aplicar sql/compras_planificacion_reporte.sql en Postgres";

/** ¿El error de Postgres es "la tabla no existe"? (42P01) */
export function esTablaFaltante(e: unknown): boolean {
  const s = String((e as { message?: string })?.message ?? e);
  return s.includes("42P01") || /does not exist/i.test(s);
}

const ints = (v: unknown): number[] =>
  Array.isArray(v)
    ? [...new Set(v.map((x) => Number(x)).filter((n) => Number.isInteger(n) && n >= 0))].sort(
        (a, b) => a - b,
      )
    : [];

/** Valida/normaliza el body del modal. Devuelve string = mensaje de error. */
export function parseReporteIn(body: unknown): PlanifReporteIn | string {
  const b = (body ?? {}) as Record<string, unknown>;
  const nombre = String(b.nombre ?? "").trim().slice(0, 120);
  if (!nombre) return "Poné un nombre al reporte";
  const meses = Number(b.meses);
  if (!Number.isInteger(meses) || meses < 1 || meses > 36) return "Meses: entre 1 y 36";
  const r: PlanifReporteIn = {
    nombre,
    lineas: ints(b.lineas),
    rubros: ints(b.rubros),
    subRubros: ints(b.subRubros),
    subSubRubros: ints(b.subSubRubros),
    meses,
  };
  if (!r.lineas.length && !r.rubros.length && !r.subRubros.length && !r.subSubRubros.length)
    return "Elegí al menos una línea, rubro, sub rubro o sub sub rubro";
  return r;
}

type Raw = {
  id: number;
  nombre: string;
  lineas: number[] | null;
  rubros: number[] | null;
  subRubros: number[] | null;
  subSubRubros: number[] | null;
  meses: number;
  orden: number;
};
const mapRaw = (r: Raw): PlanifReporte => ({
  id: Number(r.id),
  nombre: r.nombre,
  lineas: r.lineas ?? [],
  rubros: r.rubros ?? [],
  subRubros: r.subRubros ?? [],
  subSubRubros: r.subSubRubros ?? [],
  meses: Number(r.meses),
  orden: Number(r.orden),
});

export async function listarReportes(uid: number): Promise<PlanifReporte[]> {
  const raw = await prisma.$queryRaw<Raw[]>`
    SELECT id, nombre, lineas, rubros, "subRubros", "subSubRubros", meses, orden
    FROM preparado.compras_planificacion_reporte
    WHERE "usuarioId" = ${uid}
    ORDER BY orden, id
  `;
  return raw.map(mapRaw);
}

export async function leerReporte(uid: number, id: number): Promise<PlanifReporte | null> {
  const raw = await prisma.$queryRaw<Raw[]>`
    SELECT id, nombre, lineas, rubros, "subRubros", "subSubRubros", meses, orden
    FROM preparado.compras_planificacion_reporte
    WHERE "usuarioId" = ${uid} AND id = ${id}
  `;
  return raw[0] ? mapRaw(raw[0]) : null;
}

/** N meses CERRADOS hacia atrás (sin el mes en curso, que está incompleto y
 *  bajaría el promedio). Ej. hoy 2026-10-01, N=6 → 2026-04-01 .. 2026-09-30.
 *  "Hoy" en hora Argentina (UTC-3) aunque el server corra en UTC. */
export function rangoMeses(meses: number, ahora = Date.now()): { desde: string; hasta: string } {
  const ar = new Date(ahora - 3 * 3600 * 1000);
  const y = ar.getUTCFullYear();
  const m = ar.getUTCMonth(); // 0-based
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return {
    desde: iso(new Date(Date.UTC(y, m - meses, 1))),
    hasta: iso(new Date(Date.UTC(y, m, 0))), // último día del mes anterior
  };
}

export const hoyAR = (ahora = Date.now()) =>
  new Date(ahora - 3 * 3600 * 1000).toISOString().slice(0, 10);
