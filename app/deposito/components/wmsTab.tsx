"use client";
import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Loader2, RefreshCw, AlertTriangle, PackageSearch, Users, Pause, Play, Clock,
} from "lucide-react";
import { ChartComboBarLine, C } from "./ui";
import { InicioButton } from "@/components/ui/InicioButton";
import { DateRangeField } from "@/components/ui/date-range-field";

const REFRESH_MS = 60_000;

// ──────────────────────────────────────────────────────────────────────────────
// Depósito WMS — OT (pedidos de Picking) por estado en un rango + carta por
// preparador con su desglose por estado. Datos del schema WMS, leídos en vivo vía
// /api/deposito/wms-estados (→ indicadores-api → WMS). Solo lectura.
// Por defecto trae el último día con OT ejecutada; el rango es ajustable.
//
// Migrado desde app/deposito/wms/page.tsx (2026-07-31) a un componente reusable:
// ahora vive como una de las 2 opciones del sidebar de /deposito/deposito.
// La ruta /deposito/wms redirige acá y se sacó del menú (ver gen-nav.mjs IGNORE).
// ──────────────────────────────────────────────────────────────────────────────

interface EstadoAgg {
  estado: number | null;
  label: string;
  bucket: string;
  cantidad: number;
  items: number;
}
interface OperarioAgg {
  operario: string;
  total: number;
  total_items: number;
  por_estado: Record<string, number>;
  items_por_estado: Record<string, number>;
}
interface Resumen {
  total_ot: number;
  total_items: number;
  operarios: number;
  en_espera: number;
  en_proceso: number;
  terminadas: number;
}

// Orden de visualización pedido: Pendiente → En proceso → Cumplido → Despacho → Tránsito.
const BUCKET_RANK: Record<string, number> = {
  espera: 0,
  proceso: 1,
  fin: 2,
  despacho: 3,
  transito: 4,
  otro: 5,
};
interface WmsData {
  fecha: string | null;
  desde: string | null;
  hasta: string | null;
  procesos: number[];
  estados: EstadoAgg[];
  por_operario: OperarioAgg[];
  resumen: Resumen;
}

// Pedidos por hora (8-18h) — vista en vivo de HOY, fuente Magnus.
interface HoraRow {
  hora: string;
  ingresados: number | null; // null = bucket futuro (todavía no arrancó)
  cerrados: number | null; // cerrados en Magnus
  cumplidos: number | null; // OT Picking cumplidas en el WMS por bucket (flujo)
  abiertos: number | null; // null = bucket futuro / sin foto ni reconstrucción
  // Gráfico 1: flujo de OT de picking que pasan a cada etapa por bloque de 15 min
  // (reconstruido desde las marcas de hora de la OT). null = bucket futuro.
  est_espera: number | null;
  est_proceso: number | null;
  est_cumplido: number | null;
  est_sin_asignar: number | null;
  // Gráfico snapshot: cuántas hay EN cada estado en el momento (suben/bajan).
  snap_espera: number | null; // en espera ahora
  snap_disponibles: number | null; // sin_asignar + en_proceso + en_espera (no cumplidas)
  snap_cumplido: number | null; // cumplidas ACUMULADO del día (solo crece)
  // Gráfico "Movimiento de pedidos" (solo pedidos con OT de Picking en WMS).
  mov_abiertos: number | null; // abiertos en Magnus (30d) no cumplidos en WMS
  mov_disponibles: number | null; // no cumplido EXCLUYENDO Mercaderia X Llegar
  mov_espera_merca: number | null; // OT del operario "Mercaderia X Llegar"
}
interface PedidosHoraData {
  fecha: string;
  rows: HoraRow[];
}

type Tone = "amber" | "yellow" | "green" | "orange" | "sky" | "neutral";
const bucketTone = (b: string): Tone =>
  b === "espera"
    ? "amber"
    : b === "proceso"
      ? "yellow"
      : b === "fin"
        ? "green"
        : b === "despacho"
          ? "orange"
          : b === "transito"
            ? "sky"
            : "neutral";

const TONE_TEXT: Record<Tone, string> = {
  amber: "text-amber-400",
  yellow: "text-yellow-400",
  green: "text-green-400",
  orange: "text-orange-400",
  sky: "text-sky-400",
  neutral: "text-zinc-300",
};
const TONE_BG: Record<Tone, string> = {
  amber: "bg-amber-400/10 border-amber-400/30",
  yellow: "bg-yellow-400/10 border-yellow-400/30",
  green: "bg-green-400/10 border-green-400/30",
  orange: "bg-orange-400/10 border-orange-400/30",
  sky: "bg-sky-400/10 border-sky-400/30",
  neutral: "bg-zinc-700/20 border-zinc-700",
};

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

export function WmsTab() {
  const [data, setData] = useState<WmsData | null>(null);
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [auto, setAuto] = useState(true);
  const [lastFetch, setLastFetch] = useState<Date | null>(null);
  const [, setTick] = useState(0); // re-render del "hace Xs"

  // Pedidos por hora (8-18h) — sigue el mismo filtro desde/hasta de arriba;
  // sin filtro (recién entrando a la vista) muestra HOY en vivo.
  const [horaData, setHoraData] = useState<PedidosHoraData | null>(null);
  const [horaError, setHoraError] = useState<string | null>(null);

  // Mismos filtros desde/hasta que el resto de la vista ("" = hoy en vivo).
  const loadHora = useCallback(async (d: string, h: string) => {
    try {
      const qs = new URLSearchParams();
      if (d) qs.set("desde", d);
      if (h) qs.set("hasta", h || d);
      const res = await fetch(`/api/deposito/pedidos-hora?${qs.toString()}`, {
        cache: "no-store",
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setHoraData(j as PedidosHoraData);
      setHoraError(null);
    } catch (e) {
      setHoraError(e instanceof Error ? e.message : "Error al cargar pedidos por hora");
    }
  }, []);

  // Recarga cuando cambia el filtro desde/hasta (mismo rango que arriba).
  useEffect(() => {
    loadHora(desde, hasta);
  }, [desde, hasta, loadHora]);

  // Auto-refresh cada minuto (si está activado), con el filtro actual.
  useEffect(() => {
    if (!auto) return;
    const id = setInterval(() => loadHora(desde, hasta), REFRESH_MS);
    return () => clearInterval(id);
  }, [auto, desde, hasta, loadHora]);

  const load = useCallback(async (d: string, h: string) => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams();
      if (d) qs.set("desde", d);
      if (h) qs.set("hasta", h || d);
      const res = await fetch(`/api/deposito/wms-estados?${qs.toString()}`, {
        cache: "no-store",
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setData(j as WmsData);
      setLastFetch(new Date());
      // Sin rango elegido: fija los inputs al día que devolvió el backend.
      if (!d && j.desde) setDesde(j.desde as string);
      if (!h && j.hasta) setHasta(j.hasta as string);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al cargar");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  // Primera carga: sin rango → backend devuelve el último día con OT registrada.
  useEffect(() => {
    load("", "");
  }, [load]);

  // Auto-refresh cada minuto (si está activado), con el rango actual.
  useEffect(() => {
    if (!auto) return;
    const id = setInterval(() => load(desde, hasta), REFRESH_MS);
    return () => clearInterval(id);
  }, [auto, desde, hasta, load]);

  // Ticker de 1 s para el "actualizado hace Xs".
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const secsAgo = lastFetch
    ? Math.floor((Date.now() - lastFetch.getTime()) / 1000)
    : null;

  const hoy = isoLocal(new Date());
  const ayer = isoLocal(new Date(Date.now() - 864e5));
  const hace7 = isoLocal(new Date(Date.now() - 6 * 864e5));
  const horaEsHoy = !horaData?.fecha || horaData.fecha === hoy;

  const setRango = (d: string, h: string) => {
    setDesde(d);
    setHasta(h);
    load(d, h);
  };

  // Mapa estado→meta para etiquetar el desglose de cada preparador.
  const estadoMeta = useMemo(() => {
    const m = new Map<string, EstadoAgg>();
    (data?.estados ?? []).forEach((e) => m.set(String(e.estado), e));
    return m;
  }, [data]);

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
  const hayOps = (data?.por_operario?.length ?? 0) > 0;
  const primeraCarga = data === null && loading;
  const rangoLabel =
    desde && hasta && desde !== hasta
      ? `${fmtAr(desde)} → ${fmtAr(hasta)}`
      : fmtAr(desde || data?.fecha || null);

  return (
    <div className="min-h-screen bg-[#111111] text-white">
      {/* avisos flotantes */}
      {(loading || error) && (
        <div className="fixed bottom-6 right-6 z-[110] flex flex-col gap-2">
          {loading && (
            <div className="flex items-center gap-3 bg-[#1A1A1A] border border-yellow-400/40 rounded-xl px-5 py-3 text-sm text-zinc-200">
              <Loader2 size={16} className="animate-spin text-yellow-400" />
              Consultando el WMS…
            </div>
          )}
          {error && (
            <div className="flex items-center gap-3 bg-[#1A1A1A] border border-red-400/40 rounded-xl px-5 py-3 text-sm text-red-300">
              <AlertTriangle size={16} className="text-red-400" /> {error}
            </div>
          )}
        </div>
      )}

      {/* header */}
      <header className="sticky top-0 z-50 bg-[#1A1A1A] border-b-[3px] border-yellow-400 flex flex-wrap items-center justify-between px-4 md:px-8 py-3 gap-4">
        <div className="flex items-center gap-4">
          <InicioButton />
          <span className="font-bold text-yellow-400 text-xl md:text-2xl tracking-wide uppercase">
            EVER WEAR{" "}
            <span className="text-xs md:text-sm tracking-[3px] font-normal">S.A.</span>
          </span>
          <div className="w-px h-7 bg-yellow-400/30 hidden md:block" />
          <span className="text-zinc-500 text-sm hidden md:inline">
            Depósito WMS · {rangoLabel}
          </span>
        </div>
        <div className="flex items-center gap-2 md:gap-3 text-sm flex-wrap">
          <DateRangeField
            desde={desde}
            hasta={hasta}
            max={hoy}
            onChange={(d, h) => setRango(d, h)}
            align="end"
          />
          <button
            onClick={() => setRango(hoy, hoy)}
            className="px-2.5 py-1.5 rounded-md border border-zinc-700 text-zinc-300 hover:border-yellow-400 transition-colors"
          >
            Hoy
          </button>
          <button
            onClick={() => setRango(ayer, ayer)}
            className="px-2.5 py-1.5 rounded-md border border-zinc-700 text-zinc-300 hover:border-yellow-400 transition-colors"
          >
            Ayer
          </button>
          <button
            onClick={() => setRango(hace7, hoy)}
            className="px-2.5 py-1.5 rounded-md border border-zinc-700 text-zinc-300 hover:border-yellow-400 transition-colors"
          >
            7 días
          </button>
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
            {secsAgo === null
              ? "—"
              : secsAgo < 2
                ? "recién"
                : `hace ${secsAgo}s`}
          </span>
          <button
            onClick={() => setAuto((a) => !a)}
            title={auto ? "Pausar actualización automática" : "Reanudar (cada 60s)"}
            className="flex items-center gap-1.5 text-zinc-400 hover:text-yellow-400 transition-colors px-2 py-1.5 rounded-md border border-zinc-700"
          >
            {auto ? <Pause size={14} /> : <Play size={14} />}
          </button>
          <button
            onClick={() => load(desde, hasta)}
            title="Refrescar ahora"
            disabled={loading}
            className="text-zinc-400 hover:text-yellow-400 transition-colors p-2 disabled:opacity-40"
          >
            <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
      </header>

      {/* KPIs por estado */}
      {r && (
        <div className="max-w-[1500px] mx-auto px-4 md:px-8 pt-5">
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            <Stat
              label="Total OT"
              value={fmtNum(r.total_ot)}
              items={r.total_items}
              tone="yellow"
              big
            />
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
        </div>
      )}

      <main className="max-w-[1500px] mx-auto px-4 md:px-8 py-6">
        {/* Gráfico 1: desglose de estados del WMS por hora (en espera / en proceso / cumplido / sin asignar) */}
        <div className="mb-6">
          <div className="flex items-center gap-3 mb-3">
            <Clock size={16} className="text-yellow-400" />
            <span className="text-[13px] font-semibold text-zinc-100">
              Estados del WMS por hora — {horaEsHoy ? "hoy" : fmtAr(horaData?.fecha ?? null)} (8 a 18h)
            </span>
            <span className="text-zinc-600 text-[12px]">Fuente: WMS</span>
            <span className="flex-1 h-px bg-zinc-800" />
          </div>
          <div className="rounded-xl border border-zinc-800 bg-[#171717] p-3">
            {horaError && !horaData ? (
              <div className="flex items-center gap-2 py-10 justify-center text-red-300 text-sm">
                <AlertTriangle size={15} /> {horaError}
              </div>
            ) : (
              <ChartComboBarLine
                data={horaData?.rows ?? []}
                xKey="hora"
                height={220}
                angle={-60}
                bars={[{ key: "ingresados", name: "Ingresados", color: "#3f3f46" }]}
                lines={[
                  { key: "est_proceso", name: "En proceso", color: "#58a6ff" },
                  { key: "est_cumplido", name: "Cumplido", color: C.green },
                  { key: "est_sin_asignar", name: "Sin asignar", color: "#f0883e" },
                ]}
              />
            )}
          </div>
          <p className="text-[11px] text-zinc-600 mt-2 leading-relaxed">
            Barras = pedidos ingresados (registrados) en ese bloque de 15 min. Sin asignar y En
            proceso = cuántas OT de picking HAY en ese estado al cierre del bloque:
            Sin asignar = sin operario o Carossio Jose, con el pedido abierto en Magnus;
            En proceso = picking arrancado y sin terminar (sin contar Carossio, sin operario,
            Prioridad 1 ni Mercadería X Llegar). Cumplido = OT terminadas en ese bloque.{" "}
            {horaEsHoy
              ? "Eje 8-18h completo, historia del día desde las 8h; se actualiza cada 60s."
              : "Día completo (ya cerrado)."}
          </p>
        </div>

        {/* Gráfico 1b: SNAPSHOT — cuántas OT hay EN cada estado en el momento
            (espera y disponibles suben/bajan; cumplidos es acumulado del día). */}
        <div className="mb-6">
          <div className="flex items-center gap-3 mb-3">
            <Clock size={16} className="text-yellow-400" />
            <span className="text-[13px] font-semibold text-zinc-100">
              Movimiento de pedidos por hora — {horaEsHoy ? "hoy" : fmtAr(horaData?.fecha ?? null)} (8 a 18h)
            </span>
            <span className="text-zinc-600 text-[12px]">Fuente: Magnus + WMS</span>
            <span className="flex-1 h-px bg-zinc-800" />
          </div>
          <div className="rounded-xl border border-zinc-800 bg-[#171717] p-3">
            {horaError && !horaData ? (
              <div className="flex items-center gap-2 py-10 justify-center text-red-300 text-sm">
                <AlertTriangle size={15} /> {horaError}
              </div>
            ) : (
              <ChartComboBarLine
                data={horaData?.rows ?? []}
                xKey="hora"
                height={220}
                angle={-60}
                bars={[]}
                lines={[
                  { key: "mov_abiertos", name: "Abiertos", color: "#facc15" },
                  { key: "mov_disponibles", name: "Disponibles", color: "#58a6ff" },
                  { key: "snap_cumplido", name: "Cumplidos (acum.)", color: C.green },
                  { key: "mov_espera_merca", name: "En espera de mercadería", color: "#f0883e" },
                ]}
              />
            )}
          </div>
          <p className="text-[11px] text-zinc-600 mt-2 leading-relaxed">
            Solo pedidos que pasan al WMS (con OT de Picking), vinculados por Nº de
            pedido. <b>Abiertos</b> = pasaron a Abierto en Magnus (últimos 30 días)
            y todavía no están cumplidos en el WMS; se reconstruye por hora, sube al
            abrirse y baja al cumplirse. <b>Disponibles</b> = no cumplido (En espera
            + En proceso + Sin asignar), <i>sin</i> Mercadería X Llegar. <b>Cumplidos</b>{" "}
            = acumulado del día, solo crece. <b>En espera de mercadería</b> = pedidos
            del operario "Mercaderia X Llegar" (esperando stock). Disponibles y En
            espera de mercadería salen de la foto real cada 15 min.{" "}
            {horaEsHoy
              ? "Se van trazando hacia adelante a medida que pasa el día."
              : "Día completo (ya cerrado)."}
          </p>
        </div>

        {/* Gráfico 2: Cumplidos (WMS) vs Cerrados (Magnus) — misma vista, comparación */}
        <div className="mb-6">
          <div className="flex items-center gap-3 mb-3">
            <Clock size={16} className="text-yellow-400" />
            <span className="text-[13px] font-semibold text-zinc-100">
              Cumplidos (WMS) vs Cerrados (Magnus) por hora — {horaEsHoy ? "hoy" : fmtAr(horaData?.fecha ?? null)} (8 a 18h)
            </span>
            <span className="text-zinc-600 text-[12px]">Fuente: WMS + Magnus</span>
            <span className="flex-1 h-px bg-zinc-800" />
          </div>
          <div className="rounded-xl border border-zinc-800 bg-[#171717] p-3">
            {horaError && !horaData ? (
              <div className="flex items-center gap-2 py-10 justify-center text-red-300 text-sm">
                <AlertTriangle size={15} /> {horaError}
              </div>
            ) : (
              <ChartComboBarLine
                data={horaData?.rows ?? []}
                xKey="hora"
                height={220}
                angle={-60}
                bars={[{ key: "ingresados", name: "Ingresados", color: C.brand }]}
                lines={[
                  { key: "cumplidos", name: "Cumplidos (WMS)", color: C.green },
                  { key: "cerrados", name: "Cerrados (Magnus)", color: "#f0883e" },
                ]}
              />
            )}
          </div>
          <p className="text-[11px] text-zinc-600 mt-2 leading-relaxed">
            Compara cuántos pedidos se cumplieron en el WMS (picking terminado)
            contra cuántos se cerraron en Magnus, en cada bloque de 15 min.{" "}
            {horaEsHoy
              ? "Eje 8-18h completo; las líneas se van trazando hasta la hora actual."
              : "Día completo (ya cerrado)."}
          </p>
        </div>

        {primeraCarga ? (
          <div className="flex flex-col items-center justify-center py-28 gap-3 text-center">
            <Loader2 size={40} className="text-yellow-400 animate-spin" />
            <p className="text-zinc-400 font-medium">Consultando el WMS…</p>
          </div>
        ) : !hayOps ? (
          <div className="flex flex-col items-center justify-center py-28 gap-3 text-center">
            <PackageSearch size={44} className="text-zinc-700" />
            <p className="text-zinc-400 font-medium">
              {error
                ? "No se pudo leer el WMS."
                : "No hay OT para este rango."}
            </p>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-3 mb-4">
              <Users size={16} className="text-yellow-400" />
              <span className="text-[13px] font-semibold text-zinc-100">
                Preparadores con actividad
              </span>
              <span className="text-zinc-600 text-[12px]">
                {data!.por_operario.length} con al menos 1 OT
              </span>
              <span className="flex-1 h-px bg-zinc-800" />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
              {data!.por_operario.map((op) => (
                <div
                  key={op.operario}
                  className="rounded-xl border border-zinc-800 bg-[#171717] p-4"
                >
                  <div className="flex items-start justify-between gap-2 mb-3">
                    <div className="font-semibold text-zinc-100 leading-tight">
                      {op.operario}
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-2xl font-bold text-yellow-400 leading-none tabular-nums">
                        {fmtNum(op.total)}
                      </div>
                      <div className="text-[10px] uppercase tracking-wide text-zinc-600">
                        OT
                      </div>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {ordenEstados
                      .filter((e) => (op.por_estado[String(e.estado)] ?? 0) > 0)
                      .map((e) => {
                        const tone = bucketTone(e.bucket);
                        const k = String(e.estado);
                        return (
                          <div
                            key={k}
                            className={`rounded-md border px-2.5 py-1.5 ${TONE_BG[tone]}`}
                          >
                            <div className="flex items-baseline gap-1">
                              <span
                                className={`text-lg font-bold tabular-nums ${TONE_TEXT[tone]}`}
                              >
                                {fmtNum(op.por_estado[k] ?? 0)}
                              </span>
                              <span className="text-[11px] text-zinc-500 tabular-nums">
                                / {fmtNum(op.items_por_estado[k] ?? 0)} items
                              </span>
                            </div>
                            <div className="text-[10px] text-zinc-500 leading-tight">
                              {e.label}
                            </div>
                          </div>
                        );
                      })}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        <p className="text-[11px] text-zinc-600 mt-6 leading-relaxed">
          Pedidos = OT de Picking del WMS, contadas por su estado (OTEstado) según la
          fecha de ejecución del rango. Cada carta es un preparador (repositor asignado)
          con al menos una OT en el período, desglosado por estado. Lectura no bloqueante
          (READ UNCOMMITTED); no se escribe en el WMS. Por defecto se muestra el último
          día con OT ejecutada.
        </p>
      </main>
    </div>
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
      <div className="text-[11px] uppercase tracking-wide text-zinc-500 truncate">
        {label}
      </div>
      <div className="flex items-baseline gap-1.5">
        <span
          className={`${big ? "text-3xl" : "text-2xl"} font-bold tabular-nums ${TONE_TEXT[tone]}`}
        >
          {value}
        </span>
        {items !== undefined && (
          <span className="text-[12px] text-zinc-500 tabular-nums">
            / {fmtNum(items)} items
          </span>
        )}
      </div>
    </div>
  );
}
