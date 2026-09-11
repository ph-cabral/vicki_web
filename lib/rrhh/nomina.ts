// lib/rrhh/nomina.ts
// Extrae el detalle de costo de nómina desde el Excel de "pago de sueldos"
// que sube RRHH (mismo archivo que hoy alimenta la pestaña Nómina, tipo
// "sueldos" en parseXlsx.ts) para guardarlo en la base (ver
// app/api/rrhh/nomina/route.ts).
//
// Reglas (pedidas por RRHH, 2026-09-11):
//  · La posición de las columnas puede variar, pero NO el nombre — y el
//    nombre puede venir en mayúsculas o minúsculas indistintamente. Por eso
//    se busca por nombre normalizado (sin acentos, case-insensitive), igual
//    que el resto de lib/rrhh/aggregations.ts.
//  · El costo de cada persona es SIEMPRE Costos + Bono (si la columna Bono no
//    existe ese mes, como en los meses sin bono, queda Costos solo).
//  · Sólo se toma la primera hoja del archivo — eso ya lo garantiza
//    parseXlsxFile() en parseXlsx.ts: la firma "sueldos" no fija un nombre de
//    hoja, así que cae siempre a `wb.SheetNames[0]` sin importar cómo se
//    llame (hoy "Sheet1", pero da igual si lo cambian).
//
// El desglose por área (Viajantes/Mostradores/Administración/...) NO se
// calcula acá: se guarda el legajo de cada fila tal cual viene en el Excel y
// el cruce contra legajo.codigo -> sector -> area se hace en el GET del API
// route, así el desglose siempre refleja el organigrama ACTUAL aunque cambie
// después de cargado el mes.

import type { ParsedFile } from "./parseXlsx";

export interface NominaFila {
  legajo: string;
  nombre: string;
  neto: number;
  bono: number;
  costos: number;
  /** costos + bono — el número que se sube a barras/línea del gráfico. */
  total: number;
  banco: string;
  /** Columna "Liquidación" del Excel (ej. "Comercio Agosto 2026", convenio/UTA) — informativo. */
  liquidacion: string;
}

export interface NominaExtraida {
  filas: NominaFila[];
  totalCosto: number;
  cantEmpleados: number;
}

type ErrorExtraccion = { error: string };

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim();
}

/** Primera columna del archivo que matchee alguno de los candidatos (case/acentos insensitive). */
function findCol(file: ParsedFile, candidates: string[]): string | null {
  const cands = candidates.map(normalize);
  for (const col of file.columns) {
    if (cands.includes(normalize(col))) return col;
  }
  for (const col of file.columns) {
    const c = normalize(col);
    if (cands.some((cand) => c.includes(cand))) return col;
  }
  return null;
}

function toNumber(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const cleaned = v.replace(/[^\d.,-]/g, "").replace(/\./g, "").replace(",", ".");
    const n = parseFloat(cleaned);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function esLegajoValido(v: unknown): boolean {
  if (v == null) return false;
  const s = String(v).trim();
  if (s === "" || s === "0" || s === "—" || s === "-") return false;
  const su = s.toUpperCase();
  if (su === "S/N" || su === "N/A") return false;
  return true;
}

/**
 * Extrae las filas de costo de nómina de un ParsedFile tipo "sueldos".
 * Devuelve `{ error }` si faltan columnas imprescindibles (Legajo o Costos) —
 * sin esas dos no hay ni con quién cruzar el área ni qué sumar.
 */
export function extraerNomina(file: ParsedFile): NominaExtraida | ErrorExtraccion {
  const colLegajo = findCol(file, ["Nro. de Legajo", "LEGAJO", "NRO LEGAJO", "NÚMERO DE LEGAJO", "LEG."]);
  const colNombre = findCol(file, ["Apellido y Nombre", "NOMBRE"]);
  const colNeto = findCol(file, ["Neto"]);
  const colBono = findCol(file, ["Bono"]);
  const colCostos = findCol(file, ["Costos", "Costo"]);
  const colBanco = findCol(file, ["Bancos", "Banco"]);
  const colLiquidacion = findCol(file, ["Liquidación", "Liquidacion"]);

  if (!colLegajo) return { error: "No se encontró la columna 'Nro. de Legajo' en el Excel." };
  if (!colCostos) return { error: "No se encontró la columna 'Costos' en el Excel." };

  const filas: NominaFila[] = [];
  for (const r of file.rows) {
    const legajoRaw = r[colLegajo];
    if (!esLegajoValido(legajoRaw)) continue; // fila sin legajo válido (subtotal, fila vacía, etc.)

    const costos = toNumber(r[colCostos]);
    const bono = colBono ? toNumber(r[colBono]) : 0;

    filas.push({
      legajo: String(legajoRaw).trim(),
      nombre: colNombre ? String(r[colNombre] ?? "").trim() : "",
      neto: colNeto ? toNumber(r[colNeto]) : 0,
      bono,
      costos,
      total: costos + bono,
      banco: colBanco ? String(r[colBanco] ?? "").trim() : "",
      liquidacion: colLiquidacion ? String(r[colLiquidacion] ?? "").trim() : "",
    });
  }

  if (filas.length === 0) return { error: "No se encontró ninguna fila con Legajo válido en el Excel." };

  const totalCosto = filas.reduce((acc, f) => acc + f.total, 0);

  return { filas, totalCosto, cantEmpleados: filas.length };
}

export function esErrorExtraccion(v: NominaExtraida | ErrorExtraccion): v is ErrorExtraccion {
  return "error" in v;
}

// ── Meses "en cuadrilla" (grilla de 12 meses para el modal de guardado) ──────

export const NOMBRES_MES = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
] as const;

export function mesId(anio: number, mesIdx0: number): string {
  return `${anio}-${String(mesIdx0 + 1).padStart(2, "0")}`;
}

export function labelMes(mesId: string): string {
  const [anio, mm] = mesId.split("-");
  const idx = Number(mm) - 1;
  return `${NOMBRES_MES[idx] ?? mm} ${anio}`;
}
