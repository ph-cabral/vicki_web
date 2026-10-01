"use client";
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Loader2, TrendingUp } from "lucide-react";
import {
  ResponsiveContainer,
  ComposedChart,
  Bar,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  LabelList,
} from "recharts";

// ──────────────────────────────────────────────────────────────────────────
// Gráfico "Venta por mes" del dashboard /ventas (2026-10-01; antes en /ventas/vendedor): los últimos 12
// meses (el mes en curso, parcial, al final) en $ o en unidades, apilado por
// línea o como un solo total. Así cada vendedor ve cómo se mueve su venta de
// un mes a otro y en qué líneas.
//
// El alcance lo resuelve el SERVIDOR (ver app/api/ventas/vendedor/
// serie-mensual/route.ts): un no-admin siempre ve SOLO lo suyo — el
// `vendedor` que se mande se ignora —; un admin ve toda la empresa, o el
// vendedor elegido en el filtro del header de /ventas, que llega por la prop `vendedor`
// ("" = todos). Por eso acá no hay ningún selector propio: se reusa el del
// header y el gráfico no puede quedar desincronizado de los rankings.
// ──────────────────────────────────────────────────────────────────────────

interface LineaSerie {
  linea: string;
  unidades: number[];
  monto: number[];
}
interface RespSerie {
  meses: string[]; // "YYYY-MM", 12, el último es el mes en curso (parcial)
  mesActual: string;
  lineas: LineaSerie[]; // ya ordenadas por $ desc
  totalUnidades: number[];
  totalMonto: number[];
}
type Metrica = "pesos" | "unidades";
type Vista = "lineas" | "total";

// Cuántas líneas se dibujan por separado; el resto se junta en "Otras".
const TOP_LINEAS = 6;
const COLORES = ["#facc15", "#3fb950", "#58a6ff", "#f0883e", "#bc8cff", "#f85149"];
const COLOR_OTRAS = "#6b7280";
const COLOR_TOTAL = "#facc15";
const GRID = "#27272a";
const MUTED = "#8b949e";
const MESES_ABR = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];

const fmtNum = (n: number) =>
  new Intl.NumberFormat("es-AR", { maximumFractionDigits: 0 }).format(n || 0);
const fmtMoney = (n: number) =>
  new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    maximumFractionDigits: 0,
  }).format(n || 0);
// Eje Y compacto: 12,5 M / 850 mil / 3,2 mil M
function fmtCompacto(n: number): string {
  const a = Math.abs(n);
  const f = (x: number, d = 1) =>
    new Intl.NumberFormat("es-AR", { maximumFractionDigits: d }).format(x);
  if (a >= 1e9) return `${f(n / 1e9)} mil M`;
  if (a >= 1e6) return `${f(n / 1e6)} M`;
  if (a >= 1e3) return `${f(n / 1e3, 0)} mil`;
  return f(n, 0);
}
const labelMes = (ym: string) => {
  const [a, m] = ym.split("-");
  return `${MESES_ABR[Number(m) - 1] ?? m} ${a.slice(2)}`;
};

const tooltipStyle = {
  background: "#0d0d0d",
  border: `1px solid ${GRID}`,
  borderRadius: 8,
  fontSize: 12,
  color: "#e6edf3",
} as const;

export default function SerieMensual({ vendedor }: { vendedor: string }) {
  const [resp, setResp] = useState<RespSerie | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [metrica, setMetrica] = useState<Metrica>("pesos");
  const [vista, setVista] = useState<Vista>("lineas");

  useEffect(() => {
    let cancelado = false;
    setLoading(true);
    setError(null);
    const qs = vendedor ? `?vendedor=${encodeURIComponent(vendedor)}` : "";
    fetch(`/api/ventas/vendedor/serie-mensual${qs}`, { cache: "no-store" })
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
        return j as RespSerie;
      })
      .then((j) => {
        if (!cancelado) setResp(j);
      })
      .catch((e) => {
        if (!cancelado) setError(e instanceof Error ? e.message : "Error al cargar la serie mensual");
      })
      .finally(() => {
        if (!cancelado) setLoading(false);
      });
    return () => {
      cancelado = true;
    };
  }, [vendedor]);

  const campo = metrica === "pesos" ? "monto" : "unidades";
  const fmt = metrica === "pesos" ? fmtMoney : fmtNum;

  // Series a dibujar: top-N líneas por la métrica elegida + "Otras". El orden
  // del back es por $, así que se reordena acá cuando la métrica es unidades.
  const { datos, series } = useMemo(() => {
    if (!resp || !resp.meses.length) return { datos: [], series: [] as string[] };
    const ordenadas = [...resp.lineas].sort(
      (a, b) => b[campo].reduce((s, x) => s + x, 0) - a[campo].reduce((s, x) => s + x, 0),
    );
    const top = ordenadas.slice(0, TOP_LINEAS);
    const resto = ordenadas.slice(TOP_LINEAS);
    const nombres = top.map((l) => l.linea);
    if (resto.length) nombres.push("Otras");
    const total = metrica === "pesos" ? resp.totalMonto : resp.totalUnidades;
    const filas = resp.meses.map((ym, i) => {
      const fila: Record<string, number | string> = {
        ym,
        lbl: labelMes(ym) + (ym === resp.mesActual ? "*" : ""),
        Total: total[i] ?? 0,
      };
      for (const l of top) fila[l.linea] = l[campo][i] ?? 0;
      if (resto.length) fila["Otras"] = resto.reduce((s, l) => s + (l[campo][i] ?? 0), 0);
      return fila;
    });
    return { datos: filas, series: nombres };
  }, [resp, campo, metrica]);

  const vacio = !loading && !error && (!resp || !resp.lineas.length);
  const hayParcial = !!resp && resp.meses.includes(resp.mesActual);

  const botonera = <T extends string>(
    valor: T,
    opciones: [T, string][],
    onChange: (v: T) => void,
  ) => (
    <div className="inline-flex rounded-md border border-zinc-700 overflow-hidden text-xs divide-x divide-zinc-700">
      {opciones.map(([v, txt]) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          className={`px-2.5 py-1.5 font-semibold transition-colors md:text-sm ${
            valor === v ? "bg-yellow-400 text-black" : "text-zinc-300 hover:bg-zinc-800"
          }`}
        >
          {txt}
        </button>
      ))}
    </div>
  );

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/40">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-zinc-800">
        <TrendingUp size={16} className="text-yellow-400 shrink-0" />
        <h2 className="text-sm md:text-base font-semibold text-zinc-100">Venta por mes</h2>
        {loading && <Loader2 size={14} className="animate-spin text-zinc-500" />}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {botonera<Vista>(vista, [["lineas", "Por línea"], ["total", "Total"]], setVista)}
          {botonera<Metrica>(metrica, [["pesos", "$"], ["unidades", "Unidades"]], setMetrica)}
        </div>
      </div>

      <div className={`px-2 md:px-4 py-3 transition-opacity ${loading ? "opacity-50" : ""}`}>
        {error ? (
          <div className="flex items-center gap-3 px-3 py-6 text-sm text-red-300">
            <AlertTriangle size={16} className="text-red-400" /> {error}
          </div>
        ) : vacio ? (
          <div className="h-[200px] flex items-center justify-center text-zinc-500 text-sm">
            Sin ventas registradas en los últimos 12 meses.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={340}>
            <ComposedChart data={datos} margin={{ top: 22, right: 8, left: 0, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
              <XAxis dataKey="lbl" stroke={GRID} tick={{ fontSize: 11, fill: MUTED }} interval={0} />
              <YAxis
                stroke={GRID}
                width={62}
                tick={{ fontSize: 11, fill: MUTED }}
                tickFormatter={(v) => fmtCompacto(Number(v))}
              />
              <Tooltip
                contentStyle={tooltipStyle}
                cursor={{ fill: "rgba(255,255,255,0.04)" }}
                formatter={(value: number | string, name: string) => [fmt(Number(value)), name]}
                labelFormatter={(lbl: string) =>
                  lbl.endsWith("*") ? `${lbl.slice(0, -1)} (mes en curso, parcial)` : lbl
                }
                itemSorter={(item) => -Math.abs(Number(item.value) || 0)}
              />
              {vista === "lineas" ? (
                <>
                  <Legend wrapperStyle={{ fontSize: 11, color: MUTED, paddingTop: 6 }} />
                  {series.map((nombre, i) => (
                    <Bar
                      key={nombre}
                      dataKey={nombre}
                      stackId="venta"
                      fill={nombre === "Otras" ? COLOR_OTRAS : COLORES[i % COLORES.length]}
                      maxBarSize={48}
                    />
                  ))}
                </>
              ) : (
                <Bar dataKey="Total" name="Total" fill={COLOR_TOTAL} radius={[3, 3, 0, 0]} maxBarSize={48}>
                  <LabelList
                    dataKey="Total"
                    position="top"
                    fontSize={10}
                    fill={MUTED}
                    formatter={(v: number) => fmtCompacto(v)}
                  />
                </Bar>
              )}
            </ComposedChart>
          </ResponsiveContainer>
        )}
        {hayParcial && !error && !vacio && (
          <p className="px-2 pb-1 text-[11px] text-zinc-500">
            * Mes en curso, parcial. Venta neta de notas de crédito con artículo; las bonificaciones por
            concepto no se asignan a una línea y no están en el gráfico.
          </p>
        )}
      </div>
    </section>
  );
}
