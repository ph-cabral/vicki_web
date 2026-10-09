"use client";
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Loader2, RefreshCw, AlertTriangle, Pause, Play } from "lucide-react";
import { DateRangeField } from "@/components/ui/date-range-field";
import {
  BUCKET_RANK, bucketTone, TONE_TEXT,
  type EstadoAgg, type OperarioAgg, type Tone,
} from "./preparadoresWms";

// ──────────────────────────────────────────────────────────────────────────────
// Resumen WMS de /deposito/streaming (arriba de todo): KPIs de OT de Picking por
// estado (Total OT / Pendiente / En proceso / Cumplido / ... / Preparadores) con
// selector de rango (Hoy / Ayer / 7 días), indicador en vivo, pausa y refresco.
// Datos: /api/deposito/wms-estados (→ indicadores-api → WMS), solo lectura.
// Sin rango trae el último día con OT; la misma respuesta alimenta las cartas de
// "Preparadores con actividad" (una sola consulta por refresco, no dos).
// Antes vivía en /sistema/wms (se mudó el 2026-10-09).
// ──────────────────────────────────────────────────────────────────────────────

const REFRESH_MS = 60_000;

export interface WmsResumen {
  total_ot: number;
  total_items: number;
  operarios: number;
  en_espera: number;
  en_proceso: number;
  terminadas: number;
}
export interface WmsEstadosData {
  fecha: string | null;
  desde: string | null;
  hasta: string | null;
  estados: EstadoAgg[];
  por_operario: OperarioAgg[];
  resumen: WmsResumen;
}

const fmtNum = (n: number) =>
  new Intl.NumberFormat("es-AR", { maximumFractionDigits: 0 }).format(n || 0);
const fmtAr = (s: string | null) => {
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(s || "");
  return m ? `${m[3]}/${m[2]}/${m[1]}` : s || "—";
};
const isoLocal = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;

/** Estado compartido: rango + fetch de wms-estados + auto-refresh cada 60 s. */
export function useWmsEstados() {
  const [data, setData] = useState<WmsEstadosData | null>(null);
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [auto, setAuto] = useState(true);
  const [lastFetch, setLastFetch] = useState<Date | null>(null);
  const enVuelo = useRef(false);

  const load = useCallback(async (d: string, h: string) => {
    if (enVuelo.current) return;
    enVuelo.current = true;
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (d) qs.set("desde", d);
      if (h || d) qs.set("hasta", h || d);
      const res = await fetch(`/api/deposito/wms-estados?${qs.toString()}`, {
        cache: "no-store",
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setData(j as WmsEstadosData);
      setLastFetch(new Date());
      setError(null);
      // Sin rango elegido: fija los inputs al día que devolvió el backend.
      if (!d && j.desde) setDesde(j.desde as string);
      if (!h && j.hasta) setHasta(j.hasta as string);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al cargar");
    } finally {
      enVuelo.current = false;
      setLoading(false);
    }
  }, []);

  // Primera carga: sin rango → backend devuelve el último día con OT.
  useEffect(() => {
    load("", "");
  }, [load]);

  useEffect(() => {
    if (!auto) return;
    const id = setInterval(() => {
      if (!document.hidden) load(desde, hasta);
    }, REFRESH_MS);
    return () => clearInterval(id);
  }, [auto, desde, hasta, load]);

  const setRango = useCallback(
    (d: string, h: string) => {
      setDesde(d);
      setHasta(h);
      enVuelo.current = false;
      load(d, h);
    },
    [load],
  );

  return {
    data, desde, hasta, loading, error, auto, setAuto, lastFetch,
    setRango, reload: () => load(desde, hasta),
  };
}
export type WmsEstadosCtl = ReturnType<typeof useWmsEstados>;

export function WmsResumenBar({ ctl }: { ctl: WmsEstadosCtl }) {
  const { data, desde, hasta, loading, error, auto, setAuto, lastFetch, setRango, reload } = ctl;
  const [, setTick] = useState(0); // re-render del "hace Xs"
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const secsAgo = lastFetch ? Math.floor((Date.now() - lastFetch.getTime()) / 1000) : null;
  const hoy = isoLocal(new Date());
  const ayer = isoLocal(new Date(Date.now() - 864e5));
  const hace7 = isoLocal(new Date(Date.now() - 6 * 864e5));

  const r = data?.resumen;
  const ordenEstados = useMemo(
    () =>
      [...(data?.estados ?? [])].sort(
        (a, b) =>
          (BUCKET_RANK[a.bucket] ?? 9) - (BUCKET_RANK[b.bucket] ?? 9) ||
          (a.estado ?? 99) - (b.estado ?? 99),
      ),
    [data],
  );
  const rangoLabel =
    desde && hasta && desde !== hasta
      ? `${fmtAr(desde)} → ${fmtAr(hasta)}`
      : fmtAr(desde || data?.fecha || null);

  const btn =
    "px-2.5 py-1.5 rounded-md border border-zinc-700 text-zinc-300 hover:border-yellow-400 transition-colors";

  return (
    <section className="mb-8">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <span className="text-zinc-500 text-sm">Depósito WMS · {rangoLabel}</span>
        <div className="flex items-center gap-2 md:gap-3 text-sm flex-wrap">
          <DateRangeField
            desde={desde}
            hasta={hasta}
            max={hoy}
            onChange={(d, h) => setRango(d, h)}
            align="end"
          />
          <button onClick={() => setRango(hoy, hoy)} className={btn}>Hoy</button>
          <button onClick={() => setRango(ayer, ayer)} className={btn}>Ayer</button>
          <button onClick={() => setRango(hace7, hoy)} className={btn}>7 días</button>
          <span
            className="flex items-center gap-1.5 text-zinc-500 text-[12px] tabular-nums"
            title={lastFetch ? `Última actualización: ${lastFetch.toLocaleTimeString("es-AR")}` : ""}
          >
            <span className="relative flex h-2 w-2">
              {auto && (
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400/70" />
              )}
              <span
                className={`relative inline-flex rounded-full h-2 w-2 ${auto ? "bg-green-400" : "bg-zinc-500"}`}
              />
            </span>
            {secsAgo === null ? "—" : secsAgo < 2 ? "recién" : `hace ${secsAgo}s`}
          </span>
          <button
            onClick={() => setAuto(!auto)}
            title={auto ? "Pausar actualización automática" : "Reanudar (cada 60s)"}
            className="flex items-center gap-1.5 text-zinc-400 hover:text-yellow-400 transition-colors px-2 py-1.5 rounded-md border border-zinc-700"
          >
            {auto ? <Pause size={14} /> : <Play size={14} />}
          </button>
          <button
            onClick={reload}
            title="Refrescar ahora"
            disabled={loading}
            className="text-zinc-400 hover:text-yellow-400 transition-colors p-2 disabled:opacity-40"
          >
            <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-3 bg-[#1A1A1A] border border-red-400/40 rounded-xl px-5 py-3 text-sm text-red-300 mb-4">
          <AlertTriangle size={16} className="text-red-400" /> {error}
        </div>
      )}

      {r ? (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <Stat label="Total OT" value={fmtNum(r.total_ot)} items={r.total_items} tone="yellow" big />
          {ordenEstados.map((e) => (
            <Stat
              key={String(e.estado)}
              label={e.label}
              value={fmtNum(e.cantidad)}
              items={e.items}
              tone={bucketTone(e.bucket)}
            />
          ))}
          <Stat label="Preparadores" value={fmtNum(r.operarios)} tone="neutral" />
        </div>
      ) : (
        loading && (
          <div className="flex items-center gap-3 text-zinc-400 text-sm py-4">
            <Loader2 size={18} className="text-yellow-400 animate-spin" /> Consultando el WMS…
          </div>
        )
      )}
    </section>
  );
}

function Stat({
  label,
  value,
  items,
  tone = "neutral",
  big = false,
}: {
  label: string;
  value: string;
  items?: number;
  tone?: Tone;
  big?: boolean;
}) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-[#1A1A1A] px-4 py-3">
      <div className="text-[11px] uppercase tracking-wide text-zinc-500 truncate">{label}</div>
      <div className="flex items-baseline gap-1.5">
        <span className={`${big ? "text-3xl" : "text-2xl"} font-bold tabular-nums ${TONE_TEXT[tone]}`}>
          {value}
        </span>
        {items !== undefined && (
          <span className="text-[12px] text-zinc-500 tabular-nums">/ {fmtNum(items)} items</span>
        )}
      </div>
    </div>
  );
}
