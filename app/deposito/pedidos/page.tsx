"use client";
import { useState, useEffect, useMemo, useCallback } from "react";
import {
  Users, User, CalendarDays, CalendarRange, Calendar, LayoutGrid,
  Loader2, RefreshCw, AlertTriangle, PackageSearch, type LucideIcon,
} from "lucide-react";
import {
  ResponsiveContainer, ComposedChart, Bar, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, LabelList,
} from "recharts";
import {
  PageTitle, SectionTitle, Panel, KPI, Grid, ChartBar, ChartDonut, Table,
  fmtNum, fmtMes, C, Col, Tag,
} from "../components/ui";
import { InicioButton } from "@/components/ui/InicioButton";
import { DateRangeField } from "@/components/ui/date-range-field";
import { UsuarioActual } from "@/components/auth/UsuarioActual";
import { esFilaProductiva } from "@/lib/deposito/parseDeposito";

// ──────────────────────────────────────────────────────────────────────────────
// Pedidos preparados — REAL (WMS Picking) vs Ingresados (pedidos registrados).
//   Preparado (OT) = filas de Picking de /api/deposito/wms con todos=true
//                    (MISMA consulta y MISMO recorte que /deposito -> los items
//                    y el ranking cierran con el tab Picking de esa vista)
//                    La barra va APILADA en dos tramos segun [FECHA PEDIDO]
//                    (registracion del pedido en Magnus): "del periodo" = el pedido
//                    ingreso en el mismo bucket en que se preparo; "de dias
//                    anteriores" = arrastre. El total de la barra no cambia.
//   Ingresados     = pedidos registrados/día de /api/deposito/ingresados
//                    (comprobantes 10/70/100/210/310 con factura + 75 y 410, que
//                    por circuito nunca se facturan pero sí generan OT)
//   Controlado     = 3ª barra, lista para cuando exista la fuente (ver TODO)
//   % Eficiencia   = preparado / ingresado
// Día / Semana (lun→dom ISO) / Mes · Comparativa / Individual.
// ──────────────────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;
interface Rec { d: Date; dp: Date | null; op: string; items: number }
interface IngRec { d: Date; pedidos: number }
type Gran = "dia" | "sem" | "mes";
type Vista = "comp" | "ind" | "mat" | "rep";

const pad2 = (n: number) => String(n).padStart(2, "0");
const fmtDM = (d: Date) => `${d.getDate()}/${d.getMonth() + 1}`;
const clip = (s: string, n = 18) => (s.length > n ? s.slice(0, n) + "…" : s);
const iso = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

function isoWeek(d: Date) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - day + 3);
  const firstThu = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const w = 1 + Math.round((+t - +firstThu) / 86400000 / 7);
  return { year: t.getUTCFullYear(), week: w };
}
function mondayOf(d: Date) {
  const x = new Date(d);
  const day = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - day);
  x.setHours(0, 0, 0, 0);
  return x;
}
function bucketOf(d: Date, g: Gran): { key: string; sort: string; label: string } {
  if (g === "dia") { const k = iso(d); return { key: k, sort: k, label: fmtDM(d) }; }
  if (g === "mes") { const k = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`; return { key: k, sort: k, label: fmtMes(k) }; }
  const iw = isoWeek(d);
  const k = `${iw.year}-W${pad2(iw.week)}`;
  return { key: k, sort: k, label: `Sem ${iw.week} · ${fmtDM(mondayOf(d))}` };
}

const parseDMY = (v: unknown): Date | null => {
  const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(String(v ?? "").trim().split(" ")[0]);
  if (!m) return null;
  const d = new Date(+m[3], +m[2] - 1, +m[1]);
  return isNaN(d.getTime()) ? null : d;
};

function parseRow(r: Row): Rec | null {
  const d = parseDMY(r["FECHA EJECUCION"]);
  if (!d) return null;
  const op = String(r["OPERARIO"] ?? "").trim() || "(sin operario)";
  const items = parseInt(String(r["CANT. ITEM RECOLECTADOS"] ?? "0").replace(/[^0-9]/g, ""), 10) || 0;
  return { d, dp: parseDMY(r["FECHA PEDIDO"]), op, items };
}
function parseIng(r: Row): IngRec | null {
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(String(r["fecha"] ?? ""));
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  if (isNaN(d.getTime())) return null;
  return { d, pedidos: Number(r["pedidos"]) || 0 };
}

// Tramo de la barra verde que corresponde a pedidos ingresados en periodos anteriores.
const PREP_PREV = "#1c5c2c";

const tooltipStyle = { background: "#0d0d0d", border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12, color: C.text } as const;

// ─── Combinado: barras (Ingresados/Preparado/Controlado) + línea % Eficiencia ──
interface ComboRow { lbl: string; ing: number; prep: number; prepDia: number; prepPrev: number; ctrl: number; ef: number }
function ComboChart({ data, hasCtrl, maxEf, angle }: { data: ComboRow[]; hasCtrl: boolean; maxEf: number; angle: number }) {
  if (!data.length) return <div className="h-[340px] flex items-center justify-center text-zinc-700 text-xs">Sin datos</div>;
  return (
    <ResponsiveContainer width="100%" height={360}>
      <ComposedChart data={data} margin={{ top: 24, right: 8, left: 0, bottom: angle ? 52 : 20 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false} />
        <XAxis dataKey="lbl" stroke={C.border} tick={{ fontSize: 11, fill: C.muted }}
          angle={angle} textAnchor={angle ? "end" : "middle"} height={angle ? 60 : 24} interval={0} />
        <YAxis yAxisId="left" stroke={C.border} width={46} tick={{ fontSize: 11, fill: C.muted }}
          domain={[0, (dataMax: number) => Math.ceil(dataMax * 2 / 50) * 50]} />
        <YAxis yAxisId="right" orientation="right" domain={[0, maxEf]} stroke={C.border} width={44}
          tick={{ fontSize: 11, fill: C.muted }} tickFormatter={(v) => `${v}%`} />
        <Tooltip contentStyle={tooltipStyle}
          formatter={(value: number | string, name: string) =>
            name === "% Eficiencia" ? `${value}%` : fmtNum(Number(value))} />
        <Legend wrapperStyle={{ fontSize: 11, color: C.muted, paddingBottom: 6 }} />
        <Bar yAxisId="left" dataKey="ing" name="Pedidos Ingresados" fill="#d4d4d8" radius={[3, 3, 0, 0]} maxBarSize={46}>
          <LabelList dataKey="ing" position="top" fontSize={10} fill={C.muted} formatter={(v: number) => fmtNum(v)} />
        </Bar>
        <Bar yAxisId="left" stackId="prep" dataKey="prepDia" name="Preparado (OT) · del período"
          fill={C.green} maxBarSize={46} />
        <Bar yAxisId="left" stackId="prep" dataKey="prepPrev" name="Preparado (OT) · ingresado antes"
          fill={PREP_PREV} radius={[3, 3, 0, 0]} maxBarSize={46}>
          <LabelList dataKey="prep" position="top" fontSize={10} fill={C.green} formatter={(v: number) => fmtNum(v)} />
        </Bar>
        {hasCtrl && (
          <Bar yAxisId="left" dataKey="ctrl" name="Controlado" fill={C.brand} radius={[3, 3, 0, 0]} maxBarSize={46}>
            <LabelList dataKey="ctrl" position="top" fontSize={10} fill={C.brand} formatter={(v: number) => fmtNum(v)} />
          </Bar>
        )}
        <Line yAxisId="right" type="monotone" dataKey="ef" name="% Eficiencia" stroke={C.red} strokeWidth={2} dot={{ r: 3 }}>
          <LabelList dataKey="ef" position="top" fontSize={10} fill={C.red} formatter={(v: number) => `${v}%`} />
        </Line>
      </ComposedChart>
    </ResponsiveContainer>
  );
}

// ─── Toggle de botones ────────────────────────────────────────────────────────
function Seg<T extends string>({
  opts, val, onChange,
}: { opts: { v: T; label: string; icon: LucideIcon }[]; val: T; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex rounded-lg border border-zinc-700 overflow-hidden">
      {opts.map((o) => {
        const active = o.v === val;
        const Icon = o.icon;
        return (
          <button key={o.v} onClick={() => onChange(o.v)}
            className={`flex items-center gap-1.5 px-3.5 py-1.5 text-sm transition-colors ${
              active ? "bg-yellow-400 text-black font-semibold" : "bg-[#1f1f1f] text-zinc-400 hover:text-zinc-100"
            }`}>
            <Icon size={15} />{o.label}
          </button>
        );
      })}
    </div>
  );
}

// ─── Matriz Ítems × operario (filas = operarios, columnas = día/semana/mes) ────
interface MatRow { op: string; vals: number[]; total: number }
function MatrixItems({
  cols, rows, gShort,
}: { cols: { key: string; label: string }[]; rows: MatRow[]; gShort: string }) {
  const max = Math.max(1, ...rows.flatMap((r) => r.vals));
  const colTot = cols.map((_, i) => rows.reduce((a, r) => a + (r.vals[i] ?? 0), 0));
  const grand = rows.reduce((a, r) => a + r.total, 0);
  const nb = cols.length || 1;
  const thBase = "px-2.5 py-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500 whitespace-nowrap border-b border-zinc-800";
  return (
    <div className="rounded-lg bg-[#171717] border border-zinc-800 overflow-auto" style={{ maxHeight: 560 }}>
      <table className="text-[12px] border-separate" style={{ borderSpacing: 0 }}>
        <thead className="sticky top-0 z-20">
          <tr className="bg-[#1f1f1f]">
            <th className={`sticky left-0 z-30 bg-[#1f1f1f] text-left ${thBase}`}>Operario</th>
            {cols.map((c) => (
              <th key={c.key} className={`text-right ${thBase}`}>{c.label}</th>
            ))}
            <th className={`text-right bg-[#1f1f1f] text-yellow-500 ${thBase}`}>Total</th>
            <th className={`text-right bg-[#1f1f1f] ${thBase}`}>Ítems/{gShort}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.op} className="hover:bg-[#1f1f1f] transition-colors">
              <td className="sticky left-0 z-10 bg-[#171717] px-2.5 py-1.5 text-zinc-300 whitespace-nowrap border-b border-zinc-800/60">{r.op}</td>
              {r.vals.map((v, i) => (
                <td key={i} className="px-2.5 py-1.5 text-right tabular-nums border-b border-zinc-800/60"
                  style={{
                    background: v > 0 ? `rgba(250,204,21,${(0.06 + 0.34 * (v / max)).toFixed(3)})` : undefined,
                    color: v > 0 ? "#e6edf3" : "#3f3f46",
                  }}>
                  {v > 0 ? fmtNum(v) : "·"}
                </td>
              ))}
              <td className="px-2.5 py-1.5 text-right tabular-nums font-bold text-yellow-400 bg-[#171717] border-b border-zinc-800/60">{fmtNum(r.total)}</td>
              <td className="px-2.5 py-1.5 text-right tabular-nums text-zinc-400 bg-[#171717] border-b border-zinc-800/60">{fmtNum(r.total / nb, 1)}</td>
            </tr>
          ))}
          {!rows.length && (
            <tr><td colSpan={cols.length + 3} className="px-4 py-10 text-center text-zinc-600 text-sm">Sin datos de Picking en el rango</td></tr>
          )}
        </tbody>
        {rows.length > 0 && (
          <tfoot>
            <tr className="bg-[#1f1f1f]">
              <td className="sticky left-0 z-10 bg-[#1f1f1f] px-2.5 py-2 text-left font-semibold text-zinc-200 border-t border-zinc-700">TOTAL</td>
              {colTot.map((t, i) => (
                <td key={i} className="px-2.5 py-2 text-right tabular-nums font-semibold text-zinc-200 border-t border-zinc-700">{fmtNum(t)}</td>
              ))}
              <td className="px-2.5 py-2 text-right tabular-nums font-bold text-yellow-400 bg-[#1f1f1f] border-t border-zinc-700">{fmtNum(grand)}</td>
              <td className="px-2.5 py-2 text-right tabular-nums text-zinc-400 bg-[#1f1f1f] border-t border-zinc-700">{fmtNum(grand / nb, 1)}</td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

interface RankRow { op: string; ots: number; items: number }
interface BucketRow { lbl: string; ots: number; items: number }

// ─── Reposición — alerta en vivo: OT de Picking abiertas/en proceso cuyo
// stock del depósito central no alcanza para cubrir lo que todavía falta
// recolectar. Sin rango de fechas (no es historial, es la foto de ahora):
// /api/deposito/reposicion-ot.
// ──────────────────────────────────────────────────────────────────────────
interface ReposicionRow {
  CodArticulo: string;
  Nombre: string;
  Proveedor: string;
  Stock: number;
  Pendiente: number;
  Disponible: number;
  Reponer: number;
  OTs: number;
  Pedidos: number;
}
interface ReposicionData {
  total: number;
  alerta: number;
  otDescartadas: number;
  rows: ReposicionRow[];
}

function ReposicionOtPanel() {
  const [data, setData] = useState<ReposicionData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/deposito/reposicion-ot`, { cache: "no-store" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setData(j as ReposicionData);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al cargar");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const rows = useMemo(() => data?.rows ?? [], [data]);
  const enRiesgo = data?.alerta ?? 0;

  const cols: Col<ReposicionRow>[] = [
    { key: "CodArticulo", label: "Código" },
    { key: "Nombre", label: "Artículo" },
    { key: "Proveedor", label: "Proveedor" },
    { key: "Stock", label: "Stock central", num: true, render: (r) => fmtNum(r.Stock) },
    { key: "Pendiente", label: "Pendiente en OT", num: true, render: (r) => fmtNum(r.Pendiente) },
    {
      key: "Disponible", label: "Disponible", num: true,
      render: (r) => (
        <span className={r.Disponible < 0 ? "text-red-400 font-semibold" : "text-zinc-300"}>
          {fmtNum(r.Disponible)}
        </span>
      ),
    },
    {
      key: "Reponer", label: "A reponer", num: true,
      render: (r) => (r.Reponer > 0 ? <Tag tone="red">{fmtNum(r.Reponer)}</Tag> : "—"),
    },
    { key: "OTs", label: "OTs", num: true, render: (r) => fmtNum(r.OTs) },
    { key: "Pedidos", label: "Pedidos", num: true, render: (r) => fmtNum(r.Pedidos) },
  ];

  return (
    <>
      <div className="flex items-center justify-between gap-3 mb-3">
        <p className="text-[11px] text-zinc-600 leading-relaxed max-w-2xl">
          Foto en vivo (no es historial): por cada artículo con demanda sin recolectar en
          OT de Picking abiertas o en proceso, Disponible = Stock del depósito central −
          Pendiente en esas OT. Negativo = no va a haber suficiente cuando el operario
          pase a recolectar.
        </p>
        <button onClick={load} disabled={loading}
          className="flex items-center gap-1.5 text-zinc-400 hover:text-yellow-400 transition-colors px-2.5 py-1.5 rounded-md border border-zinc-700 disabled:opacity-40 text-sm shrink-0">
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Refrescar
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-3 bg-[#1A1A1A] border border-red-400/40 rounded-xl px-5 py-3 text-sm text-red-300 mb-5">
          <AlertTriangle size={16} className="text-red-400" /> {error}
        </div>
      )}

      {loading && !data ? (
        <div className="flex flex-col items-center justify-center py-24 gap-3 text-center">
          <Loader2 size={36} className="text-yellow-400 animate-spin" />
          <p className="text-zinc-400 font-medium">Consultando…</p>
        </div>
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 gap-3 text-center">
          <PackageSearch size={40} className="text-zinc-700" />
          <p className="text-zinc-400 font-medium">Sin faltantes proyectados en las OT abiertas.</p>
        </div>
      ) : (
        <>
          <Grid cols={4}>
            <KPI label="Artículos con demanda pendiente" value={fmtNum(data?.total ?? 0)} accent="neutral" />
            <KPI label="A reponer" value={fmtNum(enRiesgo)} sub="Disponible < 0" accent={enRiesgo > 0 ? "red" : "green"} />
            <KPI label="OT descartadas" value={fmtNum(data?.otDescartadas ?? 0)} sub="pedido Cancelado en Magnus" accent="neutral" />
            <KPI label="Unidades a reponer" value={fmtNum(rows.reduce((a, r) => a + r.Reponer, 0))} accent="amber" />
          </Grid>

          <SectionTitle>Artículos a reponer · ordenado por urgencia</SectionTitle>
          <Table<ReposicionRow> cols={cols} rows={rows} max={300} maxH={560} />
        </>
      )}
    </>
  );
}

export default function PedidosPreparadosPage() {
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");
  const [vista, setVista] = useState<Vista>("comp");
  const [gran, setGran] = useState<Gran>("sem");
  const [op, setOp] = useState("");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [ingRows, setIngRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = new Date();
    setHasta(iso(t));
    setDesde(iso(new Date(t.getFullYear(), t.getMonth(), t.getDate() - 70)));
  }, []);

  useEffect(() => {
    if (!desde || !hasta) return;
    let cancel = false;
    (async () => {
      setLoading(true); setError(null);
      const errs: string[] = [];
      try {
        const [wRes, iRes] = await Promise.all([
          fetch(`/api/deposito/wms?desde=${desde}&hasta=${hasta}&todos=true`, { cache: "no-store" }),
          fetch(`/api/deposito/ingresados?desde=${desde}&hasta=${hasta}`, { cache: "no-store" }),
        ]);
        const wj = (await wRes.json().catch(() => ({}))) as { rows?: Row[]; error?: string };
        if (!wRes.ok) throw new Error(wj.error || `WMS HTTP ${wRes.status}`);
        if (!cancel)
          setRows(
            (wj.rows ?? []).filter(
              (x) =>
                String(x["PROCESO"] ?? "") === "Picking" &&
                esFilaProductiva(x["OPERARIO"], x["PROCESO"]),
            ),
          );
        const ij = (await iRes.json().catch(() => ({}))) as { rows?: Row[]; error?: string };
        if (!iRes.ok) errs.push("Ingresados: " + (ij.error || `HTTP ${iRes.status}`));
        else if (!cancel) setIngRows(ij.rows ?? []);
      } catch (e) {
        errs.push(e instanceof Error ? e.message : "Error al cargar");
        if (!cancel) setRows([]);
      } finally {
        if (!cancel) { setError(errs.length ? errs.join(" · ") : null); setLoading(false); }
      }
    })();
    return () => { cancel = true; };
  }, [desde, hasta]);

  const recs = useMemo(() => (rows ?? []).map(parseRow).filter((x): x is Rec => x !== null), [rows]);
  const ingRecs = useMemo(() => ingRows.map(parseIng).filter((x): x is IngRec => x !== null), [ingRows]);
  const granLabel = gran === "mes" ? "mes" : gran === "sem" ? "semana" : "día";
  const gShort = gran === "mes" ? "mes" : gran === "sem" ? "sem" : "día";
  const angle = gran === "mes" ? 0 : -35;

  // Preparados: ranking + buckets + por operario/bucket
  const { ranking, buckets, perOpBucket, totOts, totItems } = useMemo(() => {
    const opTot = new Map<string, { ots: number; items: number }>();
    const bk = new Map<string, { key: string; label: string; sort: string; ots: number; items: number }>();
    const opBk = new Map<string, Map<string, { ots: number; items: number }>>();
    for (const r of recs) {
      const b = bucketOf(r.d, gran);
      const ot = opTot.get(r.op) ?? { ots: 0, items: 0 }; ot.ots++; ot.items += r.items; opTot.set(r.op, ot);
      const bb = bk.get(b.key) ?? { key: b.key, label: b.label, sort: b.sort, ots: 0, items: 0 }; bb.ots++; bb.items += r.items; bk.set(b.key, bb);
      let m = opBk.get(r.op); if (!m) { m = new Map(); opBk.set(r.op, m); }
      const c = m.get(b.key) ?? { ots: 0, items: 0 }; c.ots++; c.items += r.items; m.set(b.key, c);
    }
    const ranking: RankRow[] = [...opTot.entries()].map(([o, v]) => ({ op: o, ots: v.ots, items: v.items })).sort((a, b) => b.ots - a.ots);
    const buckets = [...bk.values()].sort((a, b) => a.sort.localeCompare(b.sort));
    return { ranking, buckets, perOpBucket: opBk, totOts: recs.length, totItems: recs.reduce((a, r) => a + r.items, 0) };
  }, [recs, gran]);

  // Combinado Ingresados vs Preparado (+ Controlado a futuro) por bucket
  const combo = useMemo<ComboRow[]>(() => {
    const map = new Map<string, { label: string; sort: string; ing: number; prep: number; prepDia: number; prepPrev: number; ctrl: number }>();
    const get = (k: string, label: string, sort: string) => {
      let o = map.get(k);
      if (!o) { o = { label, sort, ing: 0, prep: 0, prepDia: 0, prepPrev: 0, ctrl: 0 }; map.set(k, o); }
      return o;
    };
    for (const r of recs) {
      const b = bucketOf(r.d, gran);
      const o = get(b.key, b.label, b.sort);
      o.prep++;
      // "del período" = el pedido se registró en el MISMO bucket en que se preparó.
      // Sin fecha de pedido (OT fuera del snapshot) cuenta como arrastre.
      if (r.dp && bucketOf(r.dp, gran).key === b.key) o.prepDia++; else o.prepPrev++;
    }
    for (const r of ingRecs) { const b = bucketOf(r.d, gran); get(b.key, b.label, b.sort).ing += r.pedidos; }
    // TODO Controlado: cuando haya fuente (pedidos controlados/día), sumar get(...).ctrl
    return [...map.values()].sort((a, b) => a.sort.localeCompare(b.sort)).map((o) => ({
      lbl: o.label, ing: o.ing, prep: o.prep, prepDia: o.prepDia, prepPrev: o.prepPrev, ctrl: o.ctrl,
      ef: o.ing > 0 ? Math.round((o.prep / o.ing) * 1000) / 10 : 0,
    }));
  }, [recs, ingRecs, gran]);

  const totIng = ingRecs.reduce((a, r) => a + r.pedidos, 0);
  const efGlobal = totIng > 0 ? Math.round((totOts / totIng) * 1000) / 10 : 0;
  const hasCtrl = combo.some((c) => c.ctrl > 0);
  const maxEf = Math.max(100, ...combo.map((c) => c.ef));
  const maxEfAxis = Math.ceil(maxEf / 10) * 10;

  useEffect(() => {
    if (ranking.length && !ranking.some((r) => r.op === op)) setOp(ranking[0].op);
  }, [ranking, op]);

  const reload = () => { const h = hasta; setHasta(""); setTimeout(() => setHasta(h), 0); };

  // Matriz: ítems por operario × período (todos los operarios, ordenados por ítems)
  const matRows: MatRow[] = ranking
    .map((r) => {
      const m = perOpBucket.get(r.op);
      const vals = buckets.map((b) => m?.get(b.key)?.items ?? 0);
      return { op: r.op, vals, total: vals.reduce((a, v) => a + v, 0) };
    })
    .sort((a, b) => b.total - a.total);

  // Individual
  const suBuckets: BucketRow[] = buckets.map((b) => {
    const c = perOpBucket.get(op)?.get(b.key);
    return { lbl: b.label, ots: c?.ots ?? 0, items: c?.items ?? 0 };
  });
  const suOts = suBuckets.reduce((a, x) => a + x.ots, 0);
  const suItems = suBuckets.reduce((a, x) => a + x.items, 0);
  const promOts = buckets.length ? suOts / buckets.length : 0;
  const puesto = ranking.findIndex((r) => r.op === op) + 1;
  const aporte = [
    { name: clip(op), value: suOts, color: C.brand },
    { name: "Resto del equipo", value: Math.max(0, totOts - suOts), color: "#3f3f46" },
  ];

  const hayDatos = recs.length > 0 || ingRecs.length > 0;

  return (
    <div className="min-h-screen bg-[#111111] text-white">
      {(loading || error) && (
        <div className="fixed bottom-6 right-6 z-[110] flex flex-col gap-2">
          {loading && (
            <div className="flex items-center gap-3 bg-[#1A1A1A] border border-yellow-400/40 rounded-xl px-5 py-3 text-sm text-zinc-200">
              <Loader2 size={16} className="animate-spin text-yellow-400" /> Consultando la base…
            </div>
          )}
          {error && (
            <div className="flex items-center gap-3 bg-[#1A1A1A] border border-red-400/40 rounded-xl px-5 py-3 text-sm text-red-300">
              <AlertTriangle size={16} className="text-red-400" /> {error}
            </div>
          )}
        </div>
      )}

      <main className="max-w-7xl mx-auto px-4 py-6">
        <div className="flex items-center justify-between gap-3 mb-3">
          <InicioButton label="Inicio" iconSize={14} className="text-xs text-zinc-500 hover:text-yellow-400 transition-colors" />
          <UsuarioActual />
        </div>
        {/* Bloque pegajoso: título + rango de fechas + segmentadores.
            Esta vista no tiene <header> propio, asi que se ancla en top-0
            para que los filtros queden siempre visibles al scrollear. */}
        <div className="sticky top-0 z-40 -mx-4 px-4 pt-3 pb-2 mb-4 bg-[#111111]/95 backdrop-blur border-b border-zinc-800">
        <div className="flex items-start justify-between gap-4 flex-wrap mb-1">
          <PageTitle title="Pedidos preparados"
            sub="Ingresados vs preparados (Picking) y productividad por preparador · Depósito Central" />
          <div className="flex items-center gap-2 flex-wrap mt-1 text-sm">
            <DateRangeField
              desde={desde}
              hasta={hasta}
              onChange={(d, h) => {
                setDesde(d);
                setHasta(h);
              }}
              align="end"
            />
            <button onClick={reload} title="Refrescar" disabled={loading}
              className="text-zinc-400 hover:text-yellow-400 transition-colors p-2 disabled:opacity-40">
              <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <Seg<Vista> val={vista} onChange={setVista}
            opts={[
              { v: "comp", label: "Comparativa", icon: Users },
              { v: "mat", label: "Ítems", icon: LayoutGrid },
              { v: "ind", label: "Individual", icon: User },
              { v: "rep", label: "Reposición", icon: PackageSearch },
            ]} />
          {vista !== "rep" && (
          <Seg<Gran> val={gran} onChange={setGran}
            opts={[
              { v: "dia", label: "Diario", icon: CalendarDays },
              { v: "sem", label: "Semanal", icon: CalendarRange },
              { v: "mes", label: "Mensual", icon: Calendar },
            ]} />
          )}
          {vista === "ind" && (
            <select value={op} onChange={(e) => setOp(e.target.value)}
              className="bg-[#1f1f1f] border border-zinc-700 rounded-lg px-3 py-1.5 text-sm text-zinc-100 focus:border-yellow-400 outline-none cursor-pointer max-w-[200px]">
              {ranking.map((r) => <option key={r.op} value={r.op}>{r.op}</option>)}
            </select>
          )}
        </div>
        </div>

        {vista === "rep" ? (
          <ReposicionOtPanel />
        ) : !hayDatos ? (
          <div className="flex flex-col items-center justify-center py-28 gap-3 text-center">
            {loading ? <Loader2 size={40} className="text-yellow-400 animate-spin" />
              : <CalendarRange size={44} className="text-zinc-700" />}
            <p className="text-zinc-400 font-medium">
              {loading ? "Consultando la base…" : "Sin datos en el rango seleccionado"}
            </p>
            {!loading && <p className="text-zinc-600 text-sm">Ajustá Desde / Hasta y reintentá.</p>}
          </div>
        ) : vista === "comp" ? (
          <>
            <Grid cols={4}>
              <KPI label="Preparado (OTs)" value={fmtNum(totOts)} sub={`${buckets.length} ${granLabel}s`} accent="yellow" />
              <KPI label="Pedidos ingresados" value={fmtNum(totIng)} accent="neutral" />
              <KPI label="% Eficiencia" value={`${fmtNum(efGlobal, 1)} %`} sub="preparado / ingresado" accent={efGlobal >= 90 ? "green" : "amber"} />
              <KPI label="Ítems recolectados" value={fmtNum(totItems)} accent="green" />
            </Grid>

            <SectionTitle>Ingresos vs Preparados — por {granLabel}</SectionTitle>
            <Panel>
              <ComboChart data={combo} hasCtrl={hasCtrl} maxEf={maxEfAxis} angle={angle} />
            </Panel>

            <SectionTitle>
              Ranking de preparadores · <span className="text-yellow-400 font-bold">{fmtNum(totIng)}</span> pedidos ingresados en el período
            </SectionTitle>
            <Panel>
              <ChartBar data={ranking.map((r) => ({ op: clip(r.op), ots: r.ots }))} xKey="op"
                height={Math.max(220, ranking.length * 38)} horizontal colorByIndex
                series={[{ key: "ots", name: "OTs" }]} fmt={(n) => fmtNum(n)} showValues />
            </Panel>

            <SectionTitle>Detalle por preparador</SectionTitle>
            <Table<RankRow>
              cols={[
                { key: "op", label: "Preparador" },
                { key: "ots", label: "OTs", num: true, render: (r) => fmtNum(r.ots) },
                { key: "items", label: "Ítems", num: true, render: (r) => fmtNum(r.items) },
                { key: "otsb", label: `OTs/${granLabel}`, num: true, render: (r) => fmtNum(buckets.length ? r.ots / buckets.length : 0, 1) },
                { key: "ipo", label: "Ítems/OT", num: true, render: (r) => fmtNum(r.ots ? r.items / r.ots : 0, 1) },
              ]}
              rows={ranking} max={50} maxH={460}
            />
          </>
        ) : vista === "ind" ? (
          <>
            <Grid cols={4}>
              <KPI label="OTs en el período" value={fmtNum(suOts)} sub={`${buckets.length} ${granLabel}s`} accent="yellow" />
              <KPI label="Ítems recolectados" value={fmtNum(suItems)} accent="green" />
              <KPI label={`Prom. OTs / ${granLabel}`} value={fmtNum(promOts, 1)} accent="neutral" />
              <KPI label="Puesto en ranking" value={puesto > 0 ? `${puesto}º` : "—"} sub={`de ${ranking.length}`} accent="amber" />
            </Grid>

            <SectionTitle>Progreso de {op} — OTs por {granLabel}</SectionTitle>
            <Panel>
              <ChartBar data={suBuckets} xKey="lbl" height={300}
                series={[{ key: "ots", name: "OTs", color: C.brand }]} fmt={(n) => fmtNum(n)} angle={angle} showValues />
            </Panel>

            <SectionTitle>Ítems recolectados por {granLabel}</SectionTitle>
            <Panel>
              <ChartBar data={suBuckets} xKey="lbl" height={240}
                series={[{ key: "items", name: "Ítems", color: C.green }]} fmt={(n) => fmtNum(n)} angle={angle} showValues />
            </Panel>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4">
              <Panel title="Aporte al total del período" accent={`(${clip(op)})`}>
                <ChartDonut data={aporte} height={280} fmt={(n) => fmtNum(n)} />
              </Panel>
              <Panel title={`Detalle por ${granLabel}`} accent={`(${clip(op)})`}>
                <Table<BucketRow>
                  cols={[
                    { key: "lbl", label: granLabel },
                    { key: "ots", label: "OTs", num: true, render: (r) => fmtNum(r.ots) },
                    { key: "items", label: "Ítems", num: true, render: (r) => fmtNum(r.items) },
                    { key: "ipo", label: "Ítems/OT", num: true, render: (r) => fmtNum(r.ots ? r.items / r.ots : 0, 1) },
                  ]}
                  rows={suBuckets} max={60} maxH={320}
                />
              </Panel>
            </div>
          </>
        ) : (
          <>
            <Grid cols={4}>
              <KPI label="Ítems recolectados" value={fmtNum(totItems)} sub={`${buckets.length} ${granLabel}s`} accent="green" />
              <KPI label="Operarios" value={fmtNum(ranking.length)} accent="yellow" />
              <KPI label="Ítems / operario" value={fmtNum(ranking.length ? totItems / ranking.length : 0)} accent="neutral" />
              <KPI label={`Ítems / ${granLabel}`} value={fmtNum(buckets.length ? totItems / buckets.length : 0)} accent="amber" />
            </Grid>

            <SectionTitle>Ítems por operario · desglose por {granLabel}</SectionTitle>
            <MatrixItems cols={buckets} rows={matRows} gShort={gShort} />
            <p className="text-[11px] text-zinc-600 mt-3 leading-relaxed">
              Cada celda = ítems recolectados por ese operario en el {granLabel} (intensidad proporcional a la cantidad).
              Filas ordenadas por total de ítems. Cambiá Diario / Semanal / Mensual para ajustar el desglose, o Desde / Hasta para el rango.
            </p>
          </>
        )}

        {vista !== "rep" && (
          <p className="text-[11px] text-zinc-600 mt-6 leading-relaxed">
            La barra verde va apilada: tramo claro = pedidos ingresados en el mismo período; tramo oscuro = arrastre de períodos anteriores.
            Preparado (OT) = WMS Picking (1 fila = 1 OT). Ingresados = pedidos registrados/día (Magnus, comprobantes 10, 70, 75, 100,
            210, 310 y 410 — los 75 y 410 no se facturan, por eso no se les exige factura). Controlado: 3ª barra lista para cuando se
            defina la fuente. Semanas lunes→domingo (ISO). SQL en vivo.
          </p>
        )}
      </main>
    </div>
  );
}
