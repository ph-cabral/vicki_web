// Helpers compartidos entre /deposito/pedidos (Comparativa / Ítems) y la
// pestaña "Ranking preparadores" de /deposito: parseo de filas WMS Picking e
// Ingresados y agrupación por día / semana (lun→dom ISO) / mes.
import { fmtMes } from "./ui";

export type Row = Record<string, unknown>;
export interface Rec { d: Date; dp: Date | null; op: string; items: number }
export interface IngRec { d: Date; pedidos: number }
export type Gran = "dia" | "sem" | "mes";

export const pad2 = (n: number) => String(n).padStart(2, "0");
export const fmtDM = (d: Date) => `${d.getDate()}/${d.getMonth() + 1}`;
export const clip = (s: string, n = 18) => (s.length > n ? s.slice(0, n) + "…" : s);
export const iso = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

export function isoWeek(d: Date) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - day + 3);
  const firstThu = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const w = 1 + Math.round((+t - +firstThu) / 86400000 / 7);
  return { year: t.getUTCFullYear(), week: w };
}
export function mondayOf(d: Date) {
  const x = new Date(d);
  const day = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - day);
  x.setHours(0, 0, 0, 0);
  return x;
}
export function bucketOf(d: Date, g: Gran): { key: string; sort: string; label: string } {
  if (g === "dia") { const k = iso(d); return { key: k, sort: k, label: fmtDM(d) }; }
  if (g === "mes") { const k = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`; return { key: k, sort: k, label: fmtMes(k) }; }
  const iw = isoWeek(d);
  const k = `${iw.year}-W${pad2(iw.week)}`;
  return { key: k, sort: k, label: `Sem ${iw.week} · ${fmtDM(mondayOf(d))}` };
}

export const parseDMY = (v: unknown): Date | null => {
  const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(String(v ?? "").trim().split(" ")[0]);
  if (!m) return null;
  const d = new Date(+m[3], +m[2] - 1, +m[1]);
  return isNaN(d.getTime()) ? null : d;
};

export function parseRow(r: Row): Rec | null {
  const d = parseDMY(r["FECHA EJECUCION"]);
  if (!d) return null;
  const op = String(r["OPERARIO"] ?? "").trim() || "(sin operario)";
  const items = parseInt(String(r["CANT. ITEM RECOLECTADOS"] ?? "0").replace(/[^0-9]/g, ""), 10) || 0;
  return { d, dp: parseDMY(r["FECHA PEDIDO"]), op, items };
}
export function parseIng(r: Row): IngRec | null {
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(String(r["fecha"] ?? ""));
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  if (isNaN(d.getTime())) return null;
  return { d, pedidos: Number(r["pedidos"]) || 0 };
}
