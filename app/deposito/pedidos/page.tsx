"use client";
import { useState, useEffect, useMemo } from "react";
import {
  Users, CalendarDays, CalendarRange, Calendar, LayoutGrid,
  Loader2, RefreshCw, AlertTriangle,
  type LucideIcon,
} from "lucide-react";
import {
  ResponsiveContainer, ComposedChart, Bar, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, LabelList,
} from "recharts";
import {
  PageTitle, SectionTitle, Panel, KPI, Grid,
  fmtNum, C,
} from "../components/ui";
import { InicioButton } from "@/components/ui/InicioButton";
import { MonthRangePickerField } from "@/components/ui/date-range-field";
import { UsuarioActual } from "@/components/auth/UsuarioActual";
import { esFilaProductiva } from "@/lib/deposito/parseDeposito";
import {
  type Row, type Rec, type IngRec, type Gran,
  iso, bucketOf, parseRow, parseIng,
} from "../components/pedidosUtil";

// ──────────────────────────────────────────────────────────────────────────────
// Pedidos preparados — REAL (WMS Picking) vs Ingresados (pedidos registrados).
//   Preparado (OT) = filas de Picking de /api/deposito/wms con todos=true
//                    (MISMA consulta y MISMO recorte que /deposito -> los items
//                    cierran con el tab Picking de esa vista)
//                    La barra va APILADA en dos tramos segun [FECHA PEDIDO]
//                    (registracion del pedido en Magnus): "del periodo" = el pedido
//                    ingreso en el mismo bucket en que se preparo; "de dias
//                    anteriores" = arrastre. El total de la barra no cambia.
//   Ingresados     = pedidos registrados/día de /api/deposito/ingresados
//                    (comprobantes 10/70/100/210/310 con factura + 75 y 410, que
//                    por circuito nunca se facturan pero sí generan OT)
//   Controlado     = 3ª barra, lista para cuando exista la fuente (ver TODO)
//   % Eficiencia   = preparado / ingresado
// Día / Semana (lun→dom ISO) / Mes · Comparativa / Ítems.
// (2026-10-09) Individual, Reposición y En picking se quitaron; el ranking de
// preparadores + detalle pasó a la pestaña "Ranking preparadores" de /deposito
// (components/rankingPreparadores.tsx). Helpers en components/pedidosUtil.ts.
// ──────────────────────────────────────────────────────────────────────────────

type Vista = "comp" | "mat";

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
interface RankRow { op: string; ots: number; items: number }
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


export default function PedidosPreparadosPage() {
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");
  const [vista, setVista] = useState<Vista>("comp");
  const [gran, setGran] = useState<Gran>("sem");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [ingRows, setIngRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Default: últimos 3 meses calendario completos (el filtro ahora elige mes, no día).
  useEffect(() => {
    const t = new Date();
    setHasta(iso(new Date(t.getFullYear(), t.getMonth() + 1, 0)));
    setDesde(iso(new Date(t.getFullYear(), t.getMonth() - 2, 1)));
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

  const reload = () => { const h = hasta; setHasta(""); setTimeout(() => setHasta(h), 0); };

  // Matriz: ítems por operario × período (todos los operarios, ordenados por ítems)
  const matRows: MatRow[] = ranking
    .map((r) => {
      const m = perOpBucket.get(r.op);
      const vals = buckets.map((b) => m?.get(b.key)?.items ?? 0);
      return { op: r.op, vals, total: vals.reduce((a, v) => a + v, 0) };
    })
    .sort((a, b) => b.total - a.total);

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
            sub="Ingresados vs preparados (Picking) · Depósito Central" />
          <div className="flex items-center gap-2 flex-wrap mt-1 text-sm">
            <MonthRangePickerField
              desde={desde}
              hasta={hasta}
              onChange={(d, h) => {
                setDesde(d);
                setHasta(h);
              }}
              align="end"
              placeholder="Elegir meses"
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
            ]} />
          <Seg<Gran> val={gran} onChange={setGran}
            opts={[
              { v: "dia", label: "Diario", icon: CalendarDays },
              { v: "sem", label: "Semanal", icon: CalendarRange },
              { v: "mes", label: "Mensual", icon: Calendar },
            ]} />
        </div>
        </div>

        {!hayDatos ? (
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

          <p className="text-[11px] text-zinc-600 mt-6 leading-relaxed">
            La barra verde va apilada: tramo claro = pedidos ingresados en el mismo período; tramo oscuro = arrastre de períodos anteriores.
            Preparado (OT) = WMS Picking (1 fila = 1 OT). Ingresados = pedidos registrados/día (Magnus, comprobantes 10, 70, 75, 100,
            210, 310 y 410 — los 75 y 410 no se facturan, por eso no se les exige factura). Controlado: 3ª barra lista para cuando se
            defina la fuente. Semanas lunes→domingo (ISO). SQL en vivo.
          </p>
      </main>
    </div>
  );
}
