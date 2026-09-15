"use client";

import React from "react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  LineChart,
  Line,
  ComposedChart,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  LabelList,
  ReferenceLine,
} from "recharts";

// ─── Paleta (EVER WEAR · amarillo de marca + semánticos del mockup) ───────────
export const C = {
  surface: "#171717",
  surface2: "#1f1f1f",
  border: "#27272a",
  brand: "#facc15", // yellow-400
  green: "#3fb950",
  red: "#f85149",
  amber: "#e3b341",
  orange: "#f0883e",
  text: "#e6edf3",
  muted: "#8b949e",
} as const;

// Paleta secuencial para series/donas (marca primero)
export const PALETTE = [
  "#facc15",
  "#3fb950",
  "#f0883e",
  "#58a6ff",
  "#bc8cff",
  "#f85149",
  "#e3b341",
  "#56d4dd",
  "#db61a2",
  "#7ee787",
];

// ─── Formatos ────────────────────────────────────────────────────────────────
export const fmtArs = (n: number | null | undefined, dec = 0) =>
  n === null || n === undefined || !Number.isFinite(n)
    ? "—"
    : "$ " +
      n.toLocaleString("es-AR", {
        minimumFractionDigits: dec,
        maximumFractionDigits: dec,
      });

export const fmtUsd = (n: number | null | undefined, dec = 0) =>
  n === null || n === undefined || !Number.isFinite(n)
    ? "—"
    : "US$ " +
      n.toLocaleString("es-AR", {
        minimumFractionDigits: dec,
        maximumFractionDigits: dec,
      });

export const fmtNum = (n: number | null | undefined, dec = 0) =>
  n === null || n === undefined || !Number.isFinite(n)
    ? "—"
    : n.toLocaleString("es-AR", {
        maximumFractionDigits: dec,
        minimumFractionDigits: dec,
      });

export const fmtPct = (n: number | null | undefined, dec = 1) =>
  n === null || n === undefined || !Number.isFinite(n)
    ? "—"
    : n.toLocaleString("es-AR", { maximumFractionDigits: dec }) + " %";

// Abreviado para ejes/labels de gráfico ($1.257M, $219K)
export const fmtShort = (n: number | null | undefined, prefix = "$") => {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1e9)
    return `${prefix}${(n / 1e9).toLocaleString("es-AR", { maximumFractionDigits: 1 })}MM`;
  if (a >= 1e6)
    return `${prefix}${(n / 1e6).toLocaleString("es-AR", { maximumFractionDigits: 1 })}M`;
  if (a >= 1e3)
    return `${prefix}${(n / 1e3).toLocaleString("es-AR", { maximumFractionDigits: 0 })}K`;
  return `${prefix}${n.toLocaleString("es-AR", { maximumFractionDigits: 0 })}`;
};

export const fmtDate = (s: string | null | undefined) => {
  if (!s) return "—";
  // Fechas date-only (YYYY-MM-DD, ej. columnas DATE de Postgres) las parsea
  // JS como medianoche UTC; al formatear en es-AR (UTC-3) eso corre 1 día
  // para atrás. Se arma la fecha con componentes locales para evitar el shift.
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (dateOnly) {
    const [, y, m, d] = dateOnly;
    return new Date(Number(y), Number(m) - 1, Number(d)).toLocaleDateString("es-AR");
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : d.toLocaleDateString("es-AR");
};

export const fmtMes = (s: string) => {
  const m = /^(\d{4})-(\d{2})$/.exec(s);
  if (!m) return s;
  const meses = [
    "Ene",
    "Feb",
    "Mar",
    "Abr",
    "May",
    "Jun",
    "Jul",
    "Ago",
    "Sep",
    "Oct",
    "Nov",
    "Dic",
  ];
  return `${meses[+m[2] - 1]} ${m[1]}`;
};

// ─── PageTitle ───────────────────────────────────────────────────────────────
export function PageTitle({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="mb-5">
      <h2 className="text-yellow-400 font-bold text-xl uppercase tracking-wide">
        {title}
      </h2>
      {sub && <p className="text-zinc-500 text-sm mt-1">{sub}</p>}
    </div>
  );
}

// ─── SectionTitle (texto + línea divisoria, como el mockup) ───────────────────
export function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 mt-7 mb-3">
      <span className="text-[13px] font-semibold text-zinc-100">
        {children}
      </span>
      <span className="flex-1 h-px bg-zinc-800" />
    </div>
  );
}

// ─── Panel (card con título opcional + divisor) ───────────────────────────────
export function Panel({
  title,
  accent,
  action,
  children,
  className = "",
  bodyClass = "p-4",
}: {
  title?: React.ReactNode;
  accent?: React.ReactNode;
  /** Control alineado a la derecha del encabezado (ej. botón "Objetivo"). */
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClass?: string;
}) {
  return (
    <div
      className={`rounded-lg bg-[#171717] border border-zinc-800 ${className}`}
    >
      {title && (
        <div className="px-4 pt-4 pb-2 mb-1 border-b border-zinc-800 mx-4 flex items-center justify-between gap-3">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
            {title}{" "}
            {accent && (
              <span className="text-yellow-400 normal-case">{accent}</span>
            )}
          </h3>
          {action}
        </div>
      )}
      <div className={bodyClass}>{children}</div>
    </div>
  );
}

// ─── KPI ─────────────────────────────────────────────────────────────────────
type Accent = "yellow" | "green" | "red" | "amber" | "neutral";
const ACCENT_TEXT: Record<Accent, string> = {
  yellow: "text-yellow-400",
  green: "text-green-400",
  red: "text-red-400",
  amber: "text-amber-400",
  neutral: "text-zinc-100",
};
export function KPI({
  label,
  value,
  sub,
  accent = "yellow",
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: Accent;
}) {
  return (
    <div className="rounded-lg bg-[#171717] border border-zinc-800 px-4 py-3.5">
      <p className="text-[11px] uppercase tracking-wider text-zinc-500">
        {label}
      </p>
      <p
        className={`text-[22px] leading-none font-bold mt-1.5 ${ACCENT_TEXT[accent]}`}
      >
        {value}
      </p>
      {sub && (
        <p className="text-[11px] text-zinc-600 mt-1.5 leading-tight">{sub}</p>
      )}
    </div>
  );
}

// ─── Grid ────────────────────────────────────────────────────────────────────
export function Grid({
  children,
  cols = 3,
}: {
  children: React.ReactNode;
  cols?: 2 | 3 | 4 | 5 | 6;
}) {
  const c =
    cols === 2
      ? "sm:grid-cols-2"
      : cols === 4
        ? "sm:grid-cols-2 lg:grid-cols-4"
        : cols === 5
          ? "sm:grid-cols-3 lg:grid-cols-5"
          : cols === 6
            ? "sm:grid-cols-3 lg:grid-cols-6"
            : "sm:grid-cols-2 lg:grid-cols-3";
  return <div className={`grid grid-cols-1 ${c} gap-3`}>{children}</div>;
}

// ─── StatBox (cajas de % con tono, ej. buckets de plazo) ──────────────────────
type Tone = "green" | "amber" | "orange" | "red" | "yellow" | "neutral";
const TONE_BG: Record<Tone, string> = {
  green: "bg-green-400/10 border-green-400/30",
  amber: "bg-amber-400/10 border-amber-400/30",
  orange: "bg-orange-400/10 border-orange-400/30",
  red: "bg-red-400/10 border-red-400/30",
  yellow: "bg-yellow-400/10 border-yellow-400/30",
  neutral: "bg-zinc-700/20 border-zinc-700",
};
const TONE_TEXT: Record<Tone, string> = {
  green: "text-green-400",
  amber: "text-amber-400",
  orange: "text-orange-400",
  red: "text-red-400",
  yellow: "text-yellow-400",
  neutral: "text-zinc-300",
};
export function StatBox({
  big,
  label,
  value,
  tone = "neutral",
}: {
  big: string;
  label: string;
  value?: string;
  tone?: Tone;
}) {
  return (
    <div className={`rounded-md border px-2 py-2 text-center ${TONE_BG[tone]}`}>
      <div className={`text-lg font-bold ${TONE_TEXT[tone]}`}>{big}</div>
      <div className="text-[10px] text-zinc-500 mt-0.5">{label}</div>
      {value && <div className={`text-[11px] ${TONE_TEXT[tone]}`}>{value}</div>}
    </div>
  );
}

// ─── Tag (pill de estado/riesgo) ──────────────────────────────────────────────
const TAG: Record<Tone, string> = {
  green: "bg-green-400/15 text-green-400",
  amber: "bg-amber-400/15 text-amber-400",
  orange: "bg-orange-400/15 text-orange-400",
  red: "bg-red-400/15 text-red-400",
  yellow: "bg-yellow-400/15 text-yellow-400",
  neutral: "bg-zinc-700/40 text-zinc-400",
};
export function Tag({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: Tone;
}) {
  return (
    <span
      className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold ${TAG[tone]}`}
    >
      {children}
    </span>
  );
}

// ─── Progress bar ─────────────────────────────────────────────────────────────
export function Progress({
  label,
  pct,
  value,
  tone = "yellow",
  labelMin = 160,
}: {
  label: string;
  pct: number;
  value?: string;
  tone?: Tone;
  labelMin?: number;
}) {
  const bar: Record<Tone, string> = {
    green: "bg-green-400",
    amber: "bg-amber-400",
    orange: "bg-orange-400",
    red: "bg-red-400",
    yellow: "bg-yellow-400",
    neutral: "bg-zinc-500",
  };
  return (
    <div className="flex items-center gap-2 mb-2">
      <div
        className="text-[11px] text-zinc-500 truncate"
        style={{ minWidth: labelMin }}
      >
        {label}
      </div>
      <div className="flex-1 h-1.5 bg-[#1f1f1f] rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full ${bar[tone]}`}
          style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
        />
      </div>
      {value && (
        <div
          className={`text-[11px] tabular-nums text-right ${TONE_TEXT[tone]}`}
          style={{ minWidth: 80 }}
        >
          {value}
        </div>
      )}
    </div>
  );
}

// ─── Alert ────────────────────────────────────────────────────────────────────
export function Alert({
  tone = "yellow",
  children,
}: {
  tone?: Tone;
  children: React.ReactNode;
}) {
  const m: Record<Tone, string> = {
    green: "bg-green-400/10 border-green-400/30 text-green-400",
    amber: "bg-amber-400/10 border-amber-400/30 text-amber-400",
    orange: "bg-orange-400/10 border-orange-400/30 text-orange-400",
    red: "bg-red-400/10 border-red-400/30 text-red-400",
    yellow: "bg-yellow-400/10 border-yellow-400/30 text-yellow-300",
    neutral: "bg-zinc-700/20 border-zinc-700 text-zinc-300",
  };
  return (
    <div
      className={`rounded-md border px-3.5 py-2.5 text-[12px] flex items-start gap-2 ${m[tone]}`}
    >
      {children}
    </div>
  );
}

// ─── Tabla genérica ───────────────────────────────────────────────────────────
export interface Col<T> {
  key: string;
  label: React.ReactNode;
  num?: boolean;
  render?: (row: T) => React.ReactNode;
  className?: string;
}
export function Table<T>({
  cols,
  rows,
  max = 200,
  empty = "Sin datos",
  maxH,
  rowClassName,
}: {
  cols: Col<T>[];
  rows: T[];
  max?: number;
  empty?: string;
  maxH?: number;
  rowClassName?: (row: T) => string;
}) {
  const shown = rows.slice(0, max);
  return (
    <div
      className="rounded-lg bg-[#171717] border border-zinc-800 overflow-auto"
      style={maxH ? { maxHeight: maxH } : undefined}
    >
      <table className="w-full text-[12px]">
        <thead className="sticky top-0 z-10">
          <tr className="bg-[#1f1f1f]">
            {cols.map((c) => (
              <th
                key={c.key}
                className={`px-2.5 py-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500 whitespace-nowrap border-b border-zinc-800 ${c.num ? "text-right" : "text-left"}`}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((row, i) => (
            <tr
              key={i}
              className={`border-b border-zinc-800/60 hover:bg-[#1f1f1f] transition-colors ${rowClassName ? rowClassName(row) : ""}`}
            >
              {cols.map((c) => (
                <td
                  key={c.key}
                  className={`px-2.5 py-1.5 whitespace-nowrap ${c.num ? "text-right tabular-nums text-zinc-200" : "text-zinc-300"} ${c.className ?? ""}`}
                >
                  {c.render
                    ? c.render(row)
                    : String((row as Record<string, unknown>)[c.key] ?? "—")}
                </td>
              ))}
            </tr>
          ))}
          {shown.length === 0 && (
            <tr>
              <td
                colSpan={cols.length}
                className="px-4 py-8 text-center text-zinc-600 text-sm"
              >
                {empty}
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {rows.length > max && (
        <div className="px-3 py-1.5 text-[11px] text-zinc-600 border-t border-zinc-800">
          Mostrando {max} de {rows.length}
        </div>
      )}
    </div>
  );
}

// ─── Charts (recharts, tema oscuro EVER WEAR) ─────────────────────────────────
const AXIS = { fontSize: 11, fill: C.muted };
const tooltipStyle = {
  background: "#0d0d0d",
  border: `1px solid ${C.border}`,
  borderRadius: 8,
  fontSize: 12,
  color: C.text,
} as const;
// Recharts pisa el color del texto de cada ítem con el color de la serie
// (barra/línea/porción) y el del label no trae color por default — ambos
// quedaban casi invisibles sobre el fondo casi negro del tooltip. Se fuerza
// blanco/claro en los dos.
const tooltipLabelStyle = { color: C.text } as const;
const tooltipItemStyle = { color: C.text } as const;

export type Serie = {
  key: string;
  name: string;
  color?: string;
  stackId?: string;
};

// Tick propio: <text> con estilo inline y sin <tspan> → ningún CSS lo oculta.
function AxisTick({
  x = 0,
  y = 0,
  payload,
  pos = "bottom",
  angle = 0,
  format,
}: {
  x?: number;
  y?: number;
  payload?: { value: number | string };
  pos?: "bottom" | "left";
  angle?: number;
  format?: (v: number | string) => string;
}) {
  const v = payload ? (format ? format(payload.value) : payload.value) : "";
  const style = { fill: C.muted, fontSize: AXIS.fontSize } as const;
  if (pos === "left")
    return (
      <text x={x} y={y} dx={-4} dy={4} textAnchor="end" style={style}>
        {v}
      </text>
    );
  return (
    <text
      x={x}
      y={y}
      dy={angle ? 6 : 14}
      textAnchor={angle ? "end" : "middle"}
      transform={angle ? `rotate(${angle} ${x} ${y})` : undefined}
      style={style}
    >
      {v}
    </text>
  );
}

/**
 * Línea horizontal de referencia sobre las barras (objetivos del ranking de
 * operarios de /deposito, 2026-09-09). `y` va en la unidad del eje, no en la
 * unidad de carga.
 */
export type RefLinea = { y: number; label: string; color: string };

export function ChartBar({
  data,
  xKey,
  series,
  height = 220,
  horizontal = false,
  fmt = (n) => fmtShort(n),
  angle,
  showValues = false,
  colorByIndex = false,
  refLines,
  insideValues = false,
  topLabelKey,
  topLabelFmt,
}: {
  data: unknown[];
  xKey: string;
  series: Serie[];
  height?: number;
  horizontal?: boolean;
  fmt?: (n: number) => string;
  angle?: number;
  showValues?: boolean;
  colorByIndex?: boolean;
  refLines?: RefLinea[];
  /** Valor de cada serie IMPRESO DENTRO de la barra (arriba, alto contraste). */
  insideValues?: boolean;
  /** Campo extra (no es una serie graficada) impreso ARRIBA de la barra —
   * ej. cantidad de OT/pedidos distintos, cuando la barra en sí mide items. */
  topLabelKey?: string;
  topLabelFmt?: (n: number) => string;
}) {
  if (!data.length) return <Empty h={height} />;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart
        data={data}
        layout={horizontal ? "vertical" : "horizontal"}
        margin={{
          top: 28,
          right: 12,
          left: horizontal ? 8 : 0,
          bottom: horizontal ? 4 : angle ? 60 : 26,
        }}
      >
        <CartesianGrid
          strokeDasharray="3 3"
          stroke={C.border}
          vertical={!horizontal}
          horizontal={horizontal ? false : true}
        />
        {horizontal ? (
          <>
            <XAxis
              type="number"
              stroke={C.border}
              tick={<AxisTick pos="bottom" format={(v) => fmt(Number(v))} />}
            />
            <YAxis
              type="category"
              dataKey={xKey}
              stroke={C.border}
              width={140}
              tick={<AxisTick pos="left" />}
            />
          </>
        ) : (
          <>
            <XAxis
              dataKey={xKey}
              stroke={C.border}
              tick={false}
              height={angle ? 60 : 26}
              interval={0}
            />
            <YAxis
              stroke={C.border}
              width={52}
              tick={<AxisTick pos="left" format={(v) => fmt(Number(v))} />}
              /* Con líneas de referencia el eje tiene que llegar hasta la más
                 alta: si el objetivo queda por encima de la barra más grande,
                 recharts lo recortaría y la línea no se vería. */
              domain={
                refLines?.length
                  ? [0, (max: number) => Math.max(max, ...refLines.map((r) => r.y)) * 1.08]
                  : undefined
              }
            />
          </>
        )}
        <Tooltip
          contentStyle={tooltipStyle}
          labelStyle={tooltipLabelStyle}
          itemStyle={tooltipItemStyle}
          cursor={{ fill: "rgba(250,204,21,.06)" }}
          formatter={(v: unknown) => fmt(Number(v))}
        />
        {/* {series.length > 1 && (
          <Legend wrapperStyle={{ fontSize: 11, color: C.muted }} />
        )} */}
        {series.length > 1 && (
          <Legend
            verticalAlign="top"
            align="center"
            height={28}
            wrapperStyle={{ fontSize: 11, color: C.muted, paddingBottom: 8 }}
          />
        )}
        {series.map((s, i) => (
          <Bar
            key={s.key}
            dataKey={s.key}
            name={s.name}
            stackId={s.stackId}
            fill={s.color ?? PALETTE[i % PALETTE.length]}
            radius={
              s.stackId ? 0 : ([3, 3, 0, 0] as [number, number, number, number])
            }
          >
            {colorByIndex && series.length === 1 &&
              data.map((_, idx) => (
                <Cell key={`c-${idx}`} fill={PALETTE[idx % PALETTE.length]} />
              ))}
            {/* {showValues && (
              <LabelList
                dataKey={s.key}
                position={horizontal ? "right" : "top"}
                formatter={(v: unknown) => fmt(Number(v))}
                style={{ fontSize: 11, fontWeight: 700, fill: C.text }}
              />
            )} */}
            {(showValues || s.stackId) && (
              <LabelList
                dataKey={s.key}
                position={s.stackId ? "center" : horizontal ? "right" : "top"}
                formatter={(v: unknown) =>
                  Number(v) > 0 ? fmt(Number(v)) : ""
                }
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  fill: s.stackId ? "#0d1117" : C.text,
                }}
              />
            )}
            {!horizontal && i === 0 && (
              <LabelList
                dataKey={xKey}
                position="bottom"
                angle={angle ?? 0}
                offset={angle ? 18 : 8}
                style={{ fontSize: 11, fill: C.muted }}
              />
            )}
            {insideValues && (
              <LabelList
                dataKey={s.key}
                position={horizontal ? "insideRight" : "insideTop"}
                formatter={(v: unknown) => (Number(v) > 0 ? fmt(Number(v)) : "")}
                style={{ fontSize: 10, fontWeight: 700, fill: "#0d1117" }}
              />
            )}
            {topLabelKey && i === 0 && (
              <LabelList
                dataKey={topLabelKey}
                position={horizontal ? "right" : "top"}
                formatter={(v: unknown) =>
                  Number(v) > 0
                    ? topLabelFmt
                      ? topLabelFmt(Number(v))
                      : fmtNum(Number(v))
                    : ""
                }
                style={{ fontSize: 11, fontWeight: 700, fill: C.muted }}
              />
            )}
          </Bar>
        ))}
        {/* Las líneas van DESPUÉS de las <Bar> para que se dibujen encima. */}
        {!horizontal &&
          refLines?.map((r) => (
            <ReferenceLine
              key={r.label}
              y={r.y}
              stroke={r.color}
              strokeWidth={2}
              strokeDasharray="6 4"
              ifOverflow="extendDomain"
              label={{
                value: `${r.label} ${fmt(r.y)}`,
                position: "insideTopRight",
                fill: r.color,
                fontSize: 10,
                fontWeight: 700,
              }}
            />
          ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

// Mini bar chart por mes — último mes resaltado (evolución por operario)
export function ChartEvol({
  data,
  xKey,
  yKey,
  height = 150,
  fmt = (n) => fmtNum(n),
  max,
}: {
  data: Record<string, unknown>[];
  xKey: string;
  yKey: string;
  height?: number;
  fmt?: (n: number) => string;
  max?: number;
}) {
  if (!data.length) return <Empty h={height} />;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 18, right: 8, left: 0, bottom: 22 }}>
        <CartesianGrid
          strokeDasharray="3 3"
          stroke={C.border}
          vertical={false}
        />
        <XAxis
          dataKey={xKey}
          tick={false}
          axisLine={false}
          height={20}
          interval={0}
        />
        <YAxis hide domain={max ? [0, max] : undefined} />
        <Bar dataKey={yKey} radius={[3, 3, 0, 0]} isAnimationActive={false}>
          {data.map((_, i) => (
            <Cell
              key={i}
              fill={i === data.length - 1 ? "#facc15" : "#9ca3af"}
            />
          ))}
          <LabelList
            dataKey={yKey}
            position="top"
            formatter={(v: unknown) => fmt(Number(v))}
            style={{ fontSize: 10, fontWeight: 700, fill: C.text }}
          />
          <LabelList
            dataKey={xKey}
            position="bottom"
            offset={6}
            style={{ fontSize: 10, fill: C.muted }}
          />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

export function ChartLine({
  data,
  xKey,
  series,
  height = 220,
  fmt = (n) => fmtShort(n),
}: {
  data: unknown[];
  xKey: string;
  series: Serie[];
  height?: number;
  fmt?: (n: number) => string;
}) {
  if (!data.length) return <Empty h={height} />;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
        <XAxis dataKey={xKey} tick={AXIS} stroke={C.border} />
        <YAxis
          tick={AXIS}
          stroke={C.border}
          tickFormatter={(v) => fmt(Number(v))}
          width={52}
        />
        <Tooltip
          contentStyle={tooltipStyle}
          labelStyle={tooltipLabelStyle}
          itemStyle={tooltipItemStyle}
          formatter={(v: unknown) => fmt(Number(v))}
        />
        {series.length > 1 && (
          <Legend wrapperStyle={{ fontSize: 11, color: C.muted }} />
        )}
        {series.map((s, i) => (
          <Line
            key={s.key}
            type="monotone"
            dataKey={s.key}
            name={s.name}
            stroke={s.color ?? PALETTE[i % PALETTE.length]}
            strokeWidth={2}
            dot={{ r: 2 }}
            activeDot={{ r: 4 }}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

// Barras + líneas combinadas (ej. ingresados por hora + backlog abierto/cerrado).
export function ChartComboBarLine({
  data,
  xKey,
  bars,
  lines,
  height = 240,
  angle = 0,
}: {
  data: unknown[];
  xKey: string;
  bars: Serie[];
  lines: Serie[];
  height?: number;
  angle?: number;
}) {
  if (!data.length) return <Empty h={height} />;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart
        data={data}
        margin={{ top: 24, right: 12, left: 0, bottom: angle ? 46 : 22 }}
      >
        <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false} />
        <XAxis
          dataKey={xKey}
          stroke={C.border}
          tick={{ fontSize: 11, fill: C.muted }}
          angle={angle}
          textAnchor={angle ? "end" : "middle"}
          height={angle ? 46 : 24}
          interval={0}
        />
        <YAxis
          stroke={C.border}
          width={36}
          tick={{ fontSize: 11, fill: C.muted }}
          allowDecimals={false}
        />
        <Tooltip
          contentStyle={tooltipStyle}
          labelStyle={tooltipLabelStyle}
          itemStyle={tooltipItemStyle}
          formatter={(v: unknown) => fmtNum(Number(v))}
        />
        <Legend
          verticalAlign="top"
          align="center"
          height={28}
          wrapperStyle={{ fontSize: 11, color: C.muted, paddingBottom: 6 }}
        />
        {bars.map((s, i) => (
          <Bar
            key={s.key}
            dataKey={s.key}
            name={s.name}
            fill={s.color ?? PALETTE[i % PALETTE.length]}
            radius={[3, 3, 0, 0]}
            maxBarSize={36}
          />
        ))}
        {lines.map((s, i) => (
          <Line
            key={s.key}
            type="monotone"
            dataKey={s.key}
            name={s.name}
            stroke={s.color ?? PALETTE[(bars.length + i) % PALETTE.length]}
            strokeWidth={2}
            dot={{ r: 3 }}
            activeDot={{ r: 5 }}
          />
        ))}
      </ComposedChart>
    </ResponsiveContainer>
  );
}

export function ChartDonut({
  data,
  height = 220,
  fmt = (n) => fmtShort(n),
}: {
  data: { name: string; value: number; color?: string }[];
  height?: number;
  fmt?: (n: number) => string;
}) {
  const clean = data.filter((d) => d.value > 0);
  if (!clean.length) return <Empty h={height} />;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <PieChart>
        <Pie
          data={clean}
          dataKey="value"
          nameKey="name"
          cx="50%"
          cy="50%"
          innerRadius="55%"
          outerRadius="80%"
          paddingAngle={2}
          stroke={C.surface}
        >
          {clean.map((d, i) => (
            <Cell key={i} fill={d.color ?? PALETTE[i % PALETTE.length]} />
          ))}
        </Pie>
        <Tooltip
          contentStyle={tooltipStyle}
          labelStyle={tooltipLabelStyle}
          itemStyle={tooltipItemStyle}
          formatter={(v: unknown) => fmt(Number(v))}
        />
        <Legend wrapperStyle={{ fontSize: 11, color: C.muted }} />
      </PieChart>
    </ResponsiveContainer>
  );
}

function Empty({ h }: { h: number }) {
  return (
    <div
      className="flex items-center justify-center text-zinc-700 text-xs"
      style={{ height: h }}
    >
      Sin datos para graficar
    </div>
  );
}
