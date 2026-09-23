"use client";
import { useState, useEffect, useMemo, useCallback } from "react";
import {
  Users, User, CalendarDays, CalendarRange, Calendar, LayoutGrid,
  Loader2, RefreshCw, AlertTriangle, PackageSearch, MapPin, X, ClipboardList,
  type LucideIcon,
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
import { MonthRangePickerField } from "@/components/ui/date-range-field";
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
type Vista = "comp" | "ind" | "mat" | "rep" | "pick";

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
interface OTDetalleRow {
  OTId: number;
  NroMovVenta: number | null;
  Operario: string;
}
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
  OTsDetalle: OTDetalleRow[];
}
interface OperarioRiesgoRow {
  Operario: string;
  Articulos: number;
  OTs: number;
  Pendiente: number;
}
interface ReposicionData {
  total: number;
  alerta: number;
  otDescartadas: number;
  otEsperaMercaderia: number;
  rows: ReposicionRow[];
  porOperario: OperarioRiesgoRow[];
}

// Modal de ubicaciones de un artículo — mismo patrón que /picking (reutiliza
// /api/deposito/faltantes/ubicaciones) pero además lista arriba las OT reales
// (ya excluido el buzón "Mercaderia X Llegar") que están esperando ese
// artículo, con el operario que la tiene asignada.
function UbicacionesModal({
  articulo,
  ots,
  onClose,
}: {
  articulo: string;
  ots: OTDetalleRow[];
  onClose: () => void;
}) {
  const [rows, setRows] = useState<{ Ubicacion: string; Cantidad: number }[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let vivo = true;
    fetch(`/api/deposito/faltantes/ubicaciones?articulo=${encodeURIComponent(articulo)}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => { if (vivo) setRows((j.rows ?? []).filter((r: any) => r.Cantidad > 0)); })
      .catch(() => { if (vivo) setRows([]); })
      .finally(() => { if (vivo) setLoading(false); });
    return () => { vivo = false; };
  }, [articulo]);
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-sm bg-[#1A1A1A] border border-zinc-700 rounded-xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
          <span className="font-mono text-sm text-yellow-400">{articulo}</span>
          <button onClick={onClose} className="text-zinc-400 hover:text-white">
            <X size={18} />
          </button>
        </div>

        {ots.length > 0 && (
          <div className="px-4 py-3 border-b border-zinc-800 bg-[#151515] max-h-36 overflow-y-auto">
            <p className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1.5">
              OT esperando este artículo
            </p>
            <div className="flex flex-col gap-1">
              {ots.map((o) => (
                <p key={o.OTId} className="text-xs text-zinc-300">
                  OT <span className="text-zinc-100 font-semibold">{o.NroMovVenta ?? o.OTId}</span>
                  {" · "}
                  <span className="text-zinc-400">{o.Operario}</span>
                </p>
              ))}
            </div>
          </div>
        )}

        <div className="max-h-80 overflow-y-auto">
          {loading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="animate-spin text-zinc-500" />
            </div>
          ) : rows.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-zinc-500">Sin otras ubicaciones</p>
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className="border-b border-zinc-800/60">
                    <td className="px-4 py-2 text-zinc-200">{r.Ubicacion}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-zinc-300">{fmtNum(r.Cantidad)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── En picking — cartel de armado. Por cada OT de Picking viva (ya asignada a
// un armador, la haya tomado o no), qué hay REALMENTE para tomar en la POSICIÓN
// de picking de cada renglón. Ojo: NO es lo mismo que el panel Reposición —
// ahí se compara la demanda contra el stock del depósito entero (detecta el
// faltante real de la empresa), acá contra el estante que el WMS le asignó al
// renglón, ya descontado lo que las OT anteriores en la cola tienen comprometido
// sobre esa misma posición (reparto FIFO). Un artículo puede tener 300.000 u en
// guardado y cero en el estante: eso es lo que esta vista muestra y la otra no.
// /api/deposito/picking-disponible
// ──────────────────────────────────────────────────────────────────────────
type SituacionPick = "faltante" | "reponer" | "repo_pedida" | "ok";

interface PickRow {
  CodArticulo: string;
  Nombre: string;
  Posicion: string;
  Pedido: number;
  EnPosicion: number;
  OtrasOT: number;
  Disponible: number;
  AReponer: number;
  RepoEnCamino: number;
  EnGuardado: number;
  EnPulmon: number;
  OtroPicking: number;
  EsPlaya: boolean;
  Situacion: SituacionPick;
}
interface PickOt {
  OTId: number;
  NroMovVenta: number | null;
  Cliente: string;
  Armador: string;
  Estado: string;
  Asignada?: boolean;
  SinOT?: boolean;
  Acopio?: boolean;
  Registrada: string;
  Renglones: number;
  ConProblema: number;
  Faltantes: number;
  rows: PickRow[];
}
interface PickData {
  generado: string;
  ventanaDias: number;
  resumen: {
    otsVivas: number;
    otsConProblema: number;
    faltanteReal: number;
    hayParaReponer: number;
    repoPedida: number;
    renglonesDescartados: number;
    renglonesEsperaMercaderia: number;
  };
  ots: PickOt[];
}

const SIT_META: Record<
  SituacionPick,
  { label: string; tone: "red" | "amber" | "neutral" | "green" }
> = {
  faltante:    { label: "No está en el depósito", tone: "red" },
  reponer:     { label: "Bajar de guardado",      tone: "amber" },
  repo_pedida: { label: "Reposición en camino",   tone: "neutral" },
  ok:          { label: "Alcanza",                tone: "green" },
};

function PickingDisponiblePanel() {
  const [data, setData] = useState<PickData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [soloFaltantes, setSoloFaltantes] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/deposito/picking-disponible`, { cache: "no-store" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setData(j as PickData);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al cargar");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  // Foto en vivo: se refresca sola cada 60s además del botón manual (mismo
  // criterio que el panel de Reposición).
  useEffect(() => {
    load();
    const interval = setInterval(load, 60000);
    return () => clearInterval(interval);
  }, [load]);

  const ots = useMemo(
    () => (data?.ots ?? []).filter((o) => !soloFaltantes || o.Faltantes > 0),
    [data, soloFaltantes],
  );
  const res = data?.resumen;

  const cols: Col<PickRow>[] = [
    {
      key: "CodArticulo",
      label: "Artículo",
      render: (r) => (
        <span className="font-mono text-zinc-200">
          {r.CodArticulo}
          {r.Nombre ? <span className="ml-2 font-sans text-zinc-500">{clip(r.Nombre, 34)}</span> : null}
        </span>
      ),
    },
    {
      key: "Posicion",
      label: "Posición",
      render: (r) => (
        <span className="inline-flex items-center gap-1 text-zinc-300">
          <MapPin size={12} className="text-zinc-600" />
          {r.Posicion}
        </span>
      ),
    },
    {
      key: "Disponible", label: "Disponible", num: true,
      render: (r) => (
        <span className={r.Disponible <= 0 ? "text-red-400" : "text-zinc-200"}>
          {fmtNum(r.Disponible)}
        </span>
      ),
    },
    { key: "Pedido", label: "Pedido", num: true, render: (r) => fmtNum(r.Pedido) },
    {
      key: "AReponer", label: "A reponer", num: true,
      render: (r) => (r.AReponer > 0 ? <Tag tone={SIT_META[r.Situacion].tone}>{fmtNum(r.AReponer)}</Tag> : "—"),
    },
    {
      key: "Situacion", label: "Situación",
      render: (r) => (
        <div className="flex flex-col gap-0.5">
          <Tag tone={SIT_META[r.Situacion].tone}>{SIT_META[r.Situacion].label}</Tag>
          <span className="text-[10px] text-zinc-600">
            {r.Situacion === "repo_pedida"
              ? `viene ${fmtNum(r.RepoEnCamino)}`
              : r.Situacion === "reponer"
                ? `${fmtNum(r.EnGuardado)} en guardado`
                : r.OtroPicking > 0
                    ? `${fmtNum(r.OtroPicking)} en otra posición de picking`
                    : r.EnPulmon > 0
                      ? `${fmtNum(r.EnPulmon)} a granel sin embolsar`
                      : r.EnGuardado > 0
                        ? `sólo ${fmtNum(r.EnGuardado)} en guardado`
                        : "sin stock en ningún lado"}
          </span>
        </div>
      ),
    },
    {
      key: "OtrasOT", label: "Ya comprometido", num: true,
      render: (r) => (r.OtrasOT > 0 ? <span className="text-amber-400">{fmtNum(r.OtrasOT)}</span> : "—"),
    },
  ];

  return (
    <>
      <div className="flex items-start justify-between gap-3 mb-3">
        <p className="text-[11px] text-zinc-600 leading-relaxed max-w-2xl">
          Foto en vivo contra todos los pedidos abiertos (CP1): OT de Picking asignadas o
          todavía sin armador, pedidos que el WMS aún no pasó a OT y vueltas de acopio 70/75
          con remito. Lo asignado tiene prioridad sobre lo que todavía no se tomó.
          Disponible = lo que hay en la posición que el WMS le asignó al renglón − lo que
          las OT anteriores en la cola ya tienen comprometido sobre esa misma posición
          (reparto FIFO: la OT más vieja tiene prioridad). El stock de la posición baja
          recién cuando el armador pickea, así que hasta ese momento dos pedidos pueden
          estar apuntados al mismo estante sin que nadie lo vea.
          {data ? ` Vueltas de acopio de los últimos ${data.ventanaDias} días.` : ""}
        </p>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => setSoloFaltantes((v) => !v)}
            className={`text-sm px-2.5 py-1.5 rounded-md border transition-colors ${
              soloFaltantes
                ? "border-red-400/50 text-red-400"
                : "border-zinc-700 text-zinc-400 hover:text-yellow-400"
            }`}
          >
            Sólo faltantes
          </button>
          <button onClick={load} disabled={loading}
            className="flex items-center gap-1.5 text-zinc-400 hover:text-yellow-400 transition-colors px-2.5 py-1.5 rounded-md border border-zinc-700 disabled:opacity-40 text-sm">
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Refrescar
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-red-400 text-sm mb-3">
          <AlertTriangle size={16} /> {error}
        </div>
      )}

      {res && (
        <Grid cols={4}>
          <KPI label="OT con problema" value={fmtNum(res.otsConProblema)} sub={`de ${fmtNum(res.otsVivas)} vivas`} accent={res.otsConProblema ? "amber" : "green"} />
          <KPI label="No está en el depósito" value={fmtNum(res.faltanteReal)} sub="renglones" accent={res.faltanteReal ? "red" : "green"} />
          <KPI label="Bajar de guardado" value={fmtNum(res.hayParaReponer)} sub="renglones sin OT de repo" accent="amber" />
          <KPI label="Reposición en camino" value={fmtNum(res.repoPedida)} sub="renglones ya cubiertos" accent="neutral" />
        </Grid>
      )}

      {loading && !data ? (
        <div className="flex justify-center py-20">
          <Loader2 size={36} className="text-yellow-400 animate-spin" />
        </div>
      ) : ots.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 gap-2 text-center">
          <ClipboardList size={40} className="text-zinc-700" />
          <p className="text-zinc-400 font-medium">
            {soloFaltantes ? "Ninguna OT con faltante real" : "Ninguna OT asignada con problemas de picking"}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-4 mt-4">
          {ots.map((o) => (
            <Panel
              key={o.OTId}
              title={
                <span className="flex items-center gap-2 flex-wrap">
                  <span className="text-zinc-100">Pedido {o.NroMovVenta ?? `OT ${o.OTId}`}</span>
                  <span className="text-zinc-500 font-normal">{clip(o.Cliente, 32)}</span>
                </span>
              }
              accent={
                <span className="flex items-center gap-2 flex-wrap justify-end">
                  {o.Acopio && <Tag tone="neutral">Acopio</Tag>}
                  <Tag tone="neutral">{o.Armador}</Tag>
                  <Tag tone={o.Estado === "En proceso" ? "yellow" : "neutral"}>{o.Estado}</Tag>
                  {o.Faltantes > 0 && <Tag tone="red">{o.Faltantes} sin stock</Tag>}
                  <span className="text-[10px] text-zinc-600">
                    {o.ConProblema} de {o.Renglones} renglones · {o.Registrada}
                  </span>
                </span>
              }
              bodyClass="p-0"
            >
              <Table<PickRow> cols={cols} rows={o.rows} max={60} empty="Sin renglones con problema" />
            </Panel>
          ))}
        </div>
      )}
    </>
  );
}

function ReposicionOtPanel() {
  const [data, setData] = useState<ReposicionData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ubic, setUbic] = useState<{ codigo: string; ots: OTDetalleRow[] } | null>(null);

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

  // Foto en vivo: se refresca sola cada 60s además del botón manual.
  useEffect(() => {
    load();
    const interval = setInterval(load, 60000);
    return () => clearInterval(interval);
  }, [load]);

  const rows = useMemo(() => data?.rows ?? [], [data]);

  const cols: Col<ReposicionRow>[] = [
    {
      key: "CodArticulo", label: "Código",
      render: (r) => (
        <button
          onClick={() => setUbic({ codigo: r.CodArticulo, ots: r.OTsDetalle ?? [] })}
          title="Ver ubicaciones"
          className="inline-flex items-center gap-1 font-mono hover:text-yellow-400"
        >
          <MapPin size={13} className="text-zinc-500" />
          {r.CodArticulo}
        </button>
      ),
    },
    { key: "Nombre", label: "Artículo" },
    { key: "Pendiente", label: "En picking", num: true, render: (r) => fmtNum(r.Pendiente) },
    {
      key: "Stock", label: "Stock central", num: true,
      render: (r) => (r.Stock <= 0 ? <Tag tone="red">{fmtNum(r.Stock)}</Tag> : fmtNum(r.Stock)),
    },
    {
      key: "Reponer", label: "A reponer", num: true,
      render: (r) => (r.Reponer > 0 ? <Tag tone="red">{fmtNum(r.Reponer)}</Tag> : "—"),
    },
    { key: "OTs", label: "OT", num: true, render: (r) => fmtNum(r.OTs) },
    { key: "Pedidos", label: "Pedidos", num: true, render: (r) => fmtNum(r.Pedidos) },
  ];

  const opCols: Col<OperarioRiesgoRow>[] = [
    { key: "Operario", label: "Operario" },
    { key: "Articulos", label: "Artículos en riesgo", num: true, render: (r) => <Tag tone="red">{fmtNum(r.Articulos)}</Tag> },
    { key: "OTs", label: "OTs afectadas", num: true, render: (r) => fmtNum(r.OTs) },
    { key: "Pendiente", label: "Unidades propias pendientes", num: true, render: (r) => fmtNum(r.Pendiente) },
  ];
  const porOperario = data?.porOperario ?? [];

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
          <SectionTitle>👷 Desglose por operario · artículos en riesgo en sus OT abiertas</SectionTitle>
          <Table<OperarioRiesgoRow>
            cols={opCols}
            rows={porOperario}
            maxH={320}
            empty="Ningún operario tiene artículos en riesgo entre sus OT abiertas."
          />

          <SectionTitle>Artículos a reponer · ordenado por urgencia</SectionTitle>
          <Table<ReposicionRow>
            cols={cols} rows={rows} max={300} maxH={560}
            rowClassName={(r) => (r.Stock <= 0 ? "bg-red-400/10" : "")}
          />

          <p className="text-[11px] text-zinc-600 mt-3 leading-relaxed">
            El desglose por operario cuenta solo los artículos que YA están en riesgo (Reponer &gt; 0);
            "Unidades propias pendientes" es lo que ese operario todavía tiene que recolectar de esos
            artículos en sus propias OT (el stock es compartido, así que puede no alcanzar para todos
            los operarios con ese artículo pendiente). Las OT del buzón "Mercadería X Llegar" no se
            cuentan en ningún lado de este tablero: ya se sabe que están esperando mercadería, así que
            no aportan a la demanda ni aparecen como operario.
          </p>
        </>
      )}

      {ubic && (
        <UbicacionesModal articulo={ubic.codigo} ots={ubic.ots} onClose={() => setUbic(null)} />
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
              { v: "ind", label: "Individual", icon: User },
              { v: "rep", label: "Reposición", icon: PackageSearch },
              { v: "pick", label: "En picking", icon: ClipboardList },
            ]} />
          {vista !== "rep" && vista !== "pick" && (
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
        ) : vista === "pick" ? (
          <PickingDisponiblePanel />
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
