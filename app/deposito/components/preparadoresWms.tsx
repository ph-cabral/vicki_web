"use client";
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Loader2, AlertTriangle, Users, PackageSearch } from "lucide-react";

// ──────────────────────────────────────────────────────────────────────────────
// Preparadores con actividad — una carta por preparador con sus OT de Picking
// del WMS desglosadas por estado (Pendiente / En proceso / Cumplido, con items).
// Datos: /api/deposito/wms-estados (→ indicadores-api → WMS), solo lectura.
// Sin `dia` (o dia = hoy) trae el último día con OT ejecutada; con otro día,
// ese día. Refresca cada 60 s. Vive arriba de /deposito/deposito (antes era
// parte de la vista WMS, hoy en /sistema/wms, que conserva el resto).
// ──────────────────────────────────────────────────────────────────────────────

export interface EstadoAgg {
  estado: number | null;
  label: string;
  bucket: string;
  cantidad: number;
  items: number;
}
export interface OperarioAgg {
  operario: string;
  total: number;
  total_items: number;
  por_estado: Record<string, number>;
  items_por_estado: Record<string, number>;
}
// Orden de visualización: Pendiente → En proceso → Cumplido → Despacho → Tránsito.
export const BUCKET_RANK: Record<string, number> = {
  espera: 0,
  proceso: 1,
  fin: 2,
  despacho: 3,
  transito: 4,
  otro: 5,
};

export type Tone = "amber" | "yellow" | "green" | "orange" | "sky" | "neutral";
export const bucketTone = (b: string): Tone =>
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

export const TONE_TEXT: Record<Tone, string> = {
  amber: "text-amber-400",
  yellow: "text-yellow-400",
  green: "text-green-400",
  orange: "text-orange-400",
  sky: "text-sky-400",
  neutral: "text-zinc-300",
};
export const TONE_BG: Record<Tone, string> = {
  amber: "bg-amber-400/10 border-amber-400/30",
  yellow: "bg-yellow-400/10 border-yellow-400/30",
  green: "bg-green-400/10 border-green-400/30",
  orange: "bg-orange-400/10 border-orange-400/30",
  sky: "bg-sky-400/10 border-sky-400/30",
  neutral: "bg-zinc-700/20 border-zinc-700",
};

interface Data {
  fecha: string | null;
  desde: string | null;
  hasta: string | null;
  estados: EstadoAgg[];
  por_operario: OperarioAgg[];
}

const REFRESH_MS = 60_000;
const fmtNum = (n: number) =>
  new Intl.NumberFormat("es-AR", { maximumFractionDigits: 0 }).format(n || 0);
const fmtAr = (s: string | null) => {
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(s || "");
  return m ? `${m[3]}/${m[2]}/${m[1]}` : s || "—";
};

/** `dia` = "" → último día con OT; "YYYY-MM-DD" → ese día. */
export function PreparadoresWms({ dia = "", refreshKey = 0 }: { dia?: string; refreshKey?: number }) {
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const enVuelo = useRef(false);

  const load = useCallback(async (d: string) => {
    if (enVuelo.current) return;
    enVuelo.current = true;
    try {
      const qs = new URLSearchParams();
      if (d) {
        qs.set("desde", d);
        qs.set("hasta", d);
      }
      const res = await fetch(`/api/deposito/wms-estados?${qs.toString()}`, { cache: "no-store" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setData(j as Data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al cargar");
    } finally {
      enVuelo.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    load(dia);
    const id = setInterval(() => {
      if (!document.hidden) load(dia);
    }, REFRESH_MS);
    return () => clearInterval(id);
  }, [dia, refreshKey, load]);

  const ordenEstados = useMemo(
    () =>
      [...(data?.estados ?? [])].sort(
        (a, b) =>
          (BUCKET_RANK[a.bucket] ?? 9) - (BUCKET_RANK[b.bucket] ?? 9) ||
          (a.estado ?? 99) - (b.estado ?? 99),
      ),
    [data],
  );
  const ops = data?.por_operario ?? [];

  return (
    <section>
      <div className="flex items-center gap-3 mb-4">
        <Users size={16} className="text-yellow-400" />
        <span className="text-[13px] font-semibold text-zinc-100">Preparadores con actividad</span>
        <span className="text-zinc-600 text-[12px]">
          {data ? `${ops.length} con al menos 1 OT · ${fmtAr(data.fecha ?? data.desde)}` : "WMS"}
        </span>
        <span className="flex-1 h-px bg-zinc-800" />
      </div>

      {error && (
        <div className="flex items-center gap-3 bg-[#1A1A1A] border border-red-400/40 rounded-xl px-5 py-3 text-sm text-red-300 mb-4">
          <AlertTriangle size={16} className="text-red-400" /> {error}
        </div>
      )}

      {loading && !data ? (
        <div className="flex items-center justify-center py-12 gap-3 text-zinc-400">
          <Loader2 size={22} className="text-yellow-400 animate-spin" /> Consultando el WMS…
        </div>
      ) : ops.length === 0 ? (
        <div className="flex items-center justify-center py-10 gap-3 text-zinc-500">
          <PackageSearch size={22} className="text-zinc-700" />
          {error ? "No se pudo leer el WMS." : "No hay OT para este día."}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {ops.map((op) => (
            <div key={op.operario} className="rounded-xl border border-zinc-800 bg-[#171717] p-4">
              <div className="flex items-start justify-between gap-2 mb-3">
                <div className="font-semibold text-zinc-100 leading-tight">{op.operario}</div>
                <div className="text-right shrink-0">
                  <div className="text-2xl font-bold text-yellow-400 leading-none tabular-nums">
                    {fmtNum(op.total)}
                  </div>
                  <div className="text-[10px] uppercase tracking-wide text-zinc-600">OT</div>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {ordenEstados
                  .filter((e) => (op.por_estado[String(e.estado)] ?? 0) > 0)
                  .map((e) => {
                    const tone = bucketTone(e.bucket);
                    const k = String(e.estado);
                    return (
                      <div key={k} className={`rounded-md border px-2.5 py-1.5 ${TONE_BG[tone]}`}>
                        <div className="flex items-baseline gap-1">
                          <span className={`text-lg font-bold tabular-nums ${TONE_TEXT[tone]}`}>
                            {fmtNum(op.por_estado[k] ?? 0)}
                          </span>
                          <span className="text-[11px] text-zinc-500 tabular-nums">
                            / {fmtNum(op.items_por_estado[k] ?? 0)} items
                          </span>
                        </div>
                        <div className="text-[10px] text-zinc-500 leading-tight">{e.label}</div>
                      </div>
                    );
                  })}
              </div>
            </div>
          ))}
        </div>
      )}
      <p className="text-[11px] text-zinc-600 mt-3 leading-relaxed">
        OT de Picking del WMS por estado (OTEstado) según la fecha de ejecución. Cada carta es un
        preparador con al menos una OT en el día. Lectura no bloqueante; no se escribe en el WMS.
      </p>
    </section>
  );
}
