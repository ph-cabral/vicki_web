"use client";

/**
 * Pestaña "Lentitud y errores" de /sistema/bloqueos.
 *
 * Registro de todo lo que anduvo mal en SRV-SQL2 aunque no haya armado una
 * cadena de bloqueo:
 *   · LENTA      consulta que tardó >= 5 s (PESADA = lee mucho / CPU → mala
 *                consulta; ESPERANDO = tardó por bloqueo, disco, red o cliente)
 *   · CANCELADA  el cliente la cortó (timeout de Magnus/WMS o cancelar)
 *   · ERROR      errores graves (recursos, disco, red, lock timeout, víctima
 *                de deadlock)
 *   · DEADLOCK   interbloqueo resuelto por el motor (una sesión perdió)
 *   · BLOQUEO    episodios del watchdog (ver pestaña Bloqueos)
 *
 * Fuente: sesión XE vicki_lentitud → vicki.lentitud_evento (paso 2 del job
 * del watchdog, cada 20 s). Ver indicadores-api/bloqueos.py → fetch_lentitud.
 */

import { Fragment, useCallback, useEffect, useRef, useState } from "react";

const REFRESCO_MS = 30_000;

type Tipo = "LENTA" | "CANCELADA" | "ERROR" | "DEADLOCK" | "BLOQUEO";

type Evento = {
  id: number;
  cuando: string;
  tipo: Tipo;
  base: string | null;
  host: string | null;
  programa: string | null;
  duracion_ms: number | null;
  cpu_ms: number | null;
  lecturas: number | null;
  lecturas_fisicas: number | null;
  filas: number | null;
  objeto: string | null;
  sql_texto: string | null;
  error_numero: number | null;
  severidad: number | null;
  mensaje: string | null;
  causa: "PESADA" | "ESPERANDO" | null;
};

type Top = {
  clave: string;
  veces: number;
  total_seg: number;
  prom_ms: number;
  max_ms: number;
  lecturas_prom: number | null;
  cpu_prom_ms: number | null;
  equipos: number;
  ultima: string;
  base: string | null;
  objeto: string | null;
  sql_texto: string | null;
  pesadas: number;
};

type Ahora = {
  spid: number;
  base: string | null;
  host: string | null;
  programa: string | null;
  estado: string | null;
  comando: string | null;
  seg: number;
  cpu_ms: number;
  lecturas: number;
  espera_tipo: string | null;
  bloqueada_por: number;
  memoria_kb: number;
  sql_texto: string | null;
};

type Respuesta = {
  dias: number;
  instalado: boolean;
  mensaje?: string;
  sesion_activa?: boolean;
  leido_en?: string | null;
  ahora: Ahora[];
  resumen: Partial<Record<Tipo, number>>;
  eventos: Evento[];
  top: Top[];
};

const TIPOS: { k: Tipo; label: string; chip: string }[] = [
  { k: "LENTA", label: "Lentas", chip: "bg-amber-500/15 text-amber-300 border-amber-500/30" },
  { k: "CANCELADA", label: "Cortadas / timeout", chip: "bg-orange-500/15 text-orange-300 border-orange-500/30" },
  { k: "BLOQUEO", label: "Bloqueos", chip: "bg-red-500/15 text-red-300 border-red-500/30" },
  { k: "DEADLOCK", label: "Deadlocks", chip: "bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/30" },
  { k: "ERROR", label: "Errores", chip: "bg-rose-500/15 text-rose-300 border-rose-500/30" },
];
const CHIP = Object.fromEntries(TIPOS.map((t) => [t.k, t.chip])) as Record<Tipo, string>;

function seg(ms: number | null | undefined) {
  if (ms == null) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function num(n: number | null | undefined) {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)} k`;
  return String(n);
}

function hora(iso: string | null | undefined) {
  return iso ? iso.replace("T", " ").slice(0, 19) : "—";
}

export default function Lentitud() {
  const [dias, setDias] = useState(7);
  const [tipo, setTipo] = useState<Tipo | null>(null);
  const [data, setData] = useState<Respuesta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(true);
  const [abierto, setAbierto] = useState<number | null>(null);
  const [abiertoTop, setAbiertoTop] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cargar = useCallback(async () => {
    try {
      const qs = new URLSearchParams({ dias: String(dias), limite: "200" });
      if (tipo) qs.set("tipo", tipo);
      const r = await fetch(`/api/sistema/bloqueos/lentitud?${qs}`, { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error ?? "Error al consultar");
      setData(j);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al consultar");
    } finally {
      setCargando(false);
    }
  }, [dias, tipo]);

  useEffect(() => {
    let vivo = true;
    setCargando(true);
    const loop = async () => {
      await cargar();
      if (!vivo) return;
      timer.current = setTimeout(loop, REFRESCO_MS);
    };
    loop();
    return () => {
      vivo = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [cargar]);

  const res = data?.resumen ?? {};

  return (
    <div className="space-y-5">
      {error && (
        <div className="rounded-md border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-200">
          {error}
        </div>
      )}
      {data && !data.instalado && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm text-amber-200">
          {data.mensaje}
        </div>
      )}
      {data?.instalado && data.sesion_activa === false && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm text-amber-200">
          La sesión de captura vicki_lentitud está detenida: no se están registrando eventos nuevos.
        </div>
      )}

      {/* Filtros + resumen por tipo */}
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={dias}
          onChange={(e) => setDias(Number(e.target.value))}
          className="rounded-md border border-zinc-700 bg-[#171717] px-2 py-1.5 text-sm text-zinc-200"
        >
          {[1, 7, 30, 60].map((d) => (
            <option key={d} value={d}>
              {d === 1 ? "Último día" : `Últimos ${d} días`}
            </option>
          ))}
        </select>
        <button
          onClick={() => setTipo(null)}
          className={`rounded border px-3 py-1 text-xs ${
            tipo === null
              ? "border-yellow-500/60 text-yellow-300 bg-yellow-500/10"
              : "border-zinc-700 text-zinc-400 hover:bg-zinc-800"
          }`}
        >
          Todo · {Object.values(res).reduce((a, b) => a + (b ?? 0), 0)}
        </button>
        {TIPOS.map((t) => (
          <button
            key={t.k}
            onClick={() => setTipo(tipo === t.k ? null : t.k)}
            className={`rounded border px-3 py-1 text-xs ${
              tipo === t.k ? t.chip : "border-zinc-700 text-zinc-400 hover:bg-zinc-800"
            }`}
          >
            {t.label} · {res[t.k] ?? 0}
          </button>
        ))}
        <span className="ml-auto text-xs text-zinc-500">
          {cargando ? "Consultando…" : `Capturado hasta ${hora(data?.leido_en)}`} · lenta ≥ 5 s ·
          cortada ≥ 2 s
        </span>
      </div>

      {/* Ahora */}
      <div className="rounded-lg border border-zinc-800 bg-[#171717] overflow-hidden">
        <div className="bg-[#1f1f1f] px-5 py-3 border-b border-zinc-800 flex items-center justify-between">
          <span className="text-yellow-400 font-bold uppercase tracking-wide text-sm">
            Corriendo ahora hace más de 5 s
          </span>
          <span className="text-xs text-zinc-500">{data?.ahora?.length ?? 0}</span>
        </div>
        {data?.ahora?.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-[#1f1f1f] text-[10px] uppercase tracking-wider text-zinc-500">
                <tr>
                  <th className="px-4 py-2 text-left">SPID</th>
                  <th className="px-4 py-2 text-left">Equipo</th>
                  <th className="px-4 py-2 text-left">Base</th>
                  <th className="px-4 py-2 text-right">Lleva</th>
                  <th className="px-4 py-2 text-right">CPU</th>
                  <th className="px-4 py-2 text-right">Lecturas</th>
                  <th className="px-4 py-2 text-left">Esperando</th>
                  <th className="px-4 py-2 text-left">Consulta</th>
                </tr>
              </thead>
              <tbody>
                {data.ahora.map((a) => (
                  <tr key={a.spid} className="border-t border-zinc-800/60 hover:bg-[#1f1f1f]">
                    <td className="px-4 py-1.5 text-zinc-400">{a.spid}</td>
                    <td className="px-4 py-1.5 text-zinc-200">{a.host ?? "—"}</td>
                    <td className="px-4 py-1.5 text-zinc-500">{a.base ?? "—"}</td>
                    <td className="px-4 py-1.5 text-right text-amber-300">{seg(a.seg * 1000)}</td>
                    <td className="px-4 py-1.5 text-right text-zinc-300">{seg(a.cpu_ms)}</td>
                    <td className="px-4 py-1.5 text-right text-zinc-300">{num(a.lecturas)}</td>
                    <td className="px-4 py-1.5 text-zinc-500">
                      {a.bloqueada_por ? (
                        <span className="text-red-300">bloqueada por {a.bloqueada_por}</span>
                      ) : (
                        a.espera_tipo ?? "CPU"
                      )}
                    </td>
                    <td className="px-4 py-1.5 text-zinc-500 truncate max-w-[420px]" title={a.sql_texto ?? ""}>
                      {a.sql_texto ?? a.comando ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="px-5 py-4 text-sm text-zinc-600">Nada corriendo hace más de 5 s.</div>
        )}
      </div>

      {/* Top consultas */}
      {(tipo === null || tipo === "LENTA") && (
        <div className="rounded-lg border border-zinc-800 bg-[#171717] overflow-hidden">
          <div className="bg-[#1f1f1f] px-5 py-3 border-b border-zinc-800">
            <span className="text-yellow-400 font-bold uppercase tracking-wide text-sm">
              Consultas que más tiempo costaron
            </span>
            <span className="ml-3 text-xs text-zinc-500">
              misma consulta con cualquier parámetro · pesada = lee mucho o quema CPU
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-[#1f1f1f] text-[10px] uppercase tracking-wider text-zinc-500">
                <tr>
                  <th className="px-4 py-2 text-right">Veces</th>
                  <th className="px-4 py-2 text-right">Total</th>
                  <th className="px-4 py-2 text-right">Prom.</th>
                  <th className="px-4 py-2 text-right">Máx.</th>
                  <th className="px-4 py-2 text-right">Lecturas prom.</th>
                  <th className="px-4 py-2 text-right">Equipos</th>
                  <th className="px-4 py-2 text-left">Tipo</th>
                  <th className="px-4 py-2 text-left">Consulta</th>
                </tr>
              </thead>
              <tbody>
                {data?.top?.length ? (
                  data.top.map((t) => (
                    <Fragment key={t.clave}>
                      <tr
                        onClick={() => setAbiertoTop(abiertoTop === t.clave ? null : t.clave)}
                        className="border-t border-zinc-800/60 hover:bg-[#1f1f1f] cursor-pointer"
                      >
                        <td className="px-4 py-1.5 text-right text-zinc-200">{t.veces}</td>
                        <td className="px-4 py-1.5 text-right text-amber-300">{seg(t.total_seg * 1000)}</td>
                        <td className="px-4 py-1.5 text-right text-zinc-300">{seg(t.prom_ms)}</td>
                        <td className="px-4 py-1.5 text-right text-zinc-300">{seg(t.max_ms)}</td>
                        <td className="px-4 py-1.5 text-right text-zinc-300">{num(t.lecturas_prom)}</td>
                        <td className="px-4 py-1.5 text-right text-zinc-400">{t.equipos}</td>
                        <td className="px-4 py-1.5 text-xs">
                          {t.pesadas * 2 >= t.veces ? (
                            <span className="text-rose-300">pesada</span>
                          ) : (
                            <span className="text-zinc-500">esperando</span>
                          )}
                        </td>
                        <td className="px-4 py-1.5 text-zinc-500 truncate max-w-[420px]">
                          {t.objeto ? <span className="text-zinc-300">{t.objeto} · </span> : null}
                          {t.sql_texto ?? "—"}
                        </td>
                      </tr>
                      {abiertoTop === t.clave && (
                        <tr className="bg-[#141414]">
                          <td colSpan={8} className="px-5 py-3">
                            <div className="text-xs text-zinc-500 mb-1">
                              {t.base ?? ""} · última {hora(t.ultima)} · CPU prom. {seg(t.cpu_prom_ms)}
                            </div>
                            <pre className="whitespace-pre-wrap break-all text-xs text-zinc-300">
                              {t.sql_texto}
                            </pre>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))
                ) : (
                  <tr>
                    <td colSpan={8} className="px-4 py-6 text-center text-zinc-600">
                      Sin consultas lentas registradas en el período.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Registro */}
      <div className="rounded-lg border border-zinc-800 bg-[#171717] overflow-hidden">
        <div className="bg-[#1f1f1f] px-5 py-3 border-b border-zinc-800">
          <span className="text-yellow-400 font-bold uppercase tracking-wide text-sm">Registro</span>
          <span className="ml-3 text-xs text-zinc-500">últimos 200 · click para ver el detalle</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-[#1f1f1f] text-[10px] uppercase tracking-wider text-zinc-500">
              <tr>
                <th className="px-4 py-2 text-left">Cuándo</th>
                <th className="px-4 py-2 text-left">Qué</th>
                <th className="px-4 py-2 text-left">Equipo</th>
                <th className="px-4 py-2 text-right">Duró</th>
                <th className="px-4 py-2 text-right">Lecturas</th>
                <th className="px-4 py-2 text-left">Detalle</th>
              </tr>
            </thead>
            <tbody>
              {data?.eventos?.length ? (
                data.eventos.map((e) => (
                  <Fragment key={e.id}>
                    <tr
                      onClick={() => setAbierto(abierto === e.id ? null : e.id)}
                      className="border-t border-zinc-800/60 hover:bg-[#1f1f1f] cursor-pointer"
                    >
                      <td className="px-4 py-1.5 text-zinc-400 whitespace-nowrap">{hora(e.cuando)}</td>
                      <td className="px-4 py-1.5 whitespace-nowrap">
                        <span className={`rounded border px-2 py-0.5 text-[11px] ${CHIP[e.tipo]}`}>
                          {e.tipo.toLowerCase()}
                        </span>
                        {e.causa && (
                          <span
                            className={`ml-2 text-[11px] ${
                              e.causa === "PESADA" ? "text-rose-300" : "text-zinc-500"
                            }`}
                          >
                            {e.causa.toLowerCase()}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-1.5 text-zinc-200">{e.host ?? "—"}</td>
                      <td className="px-4 py-1.5 text-right text-zinc-300">{seg(e.duracion_ms)}</td>
                      <td className="px-4 py-1.5 text-right text-zinc-300">{num(e.lecturas)}</td>
                      <td className="px-4 py-1.5 text-zinc-500 truncate max-w-[460px]">
                        {e.tipo === "ERROR"
                          ? `${e.error_numero ?? ""} · ${e.mensaje ?? ""}`
                          : e.tipo === "BLOQUEO"
                            ? e.mensaje
                            : (e.objeto ? `${e.objeto} · ` : "") + (e.sql_texto ?? "—")}
                      </td>
                    </tr>
                    {abierto === e.id && (
                      <tr className="bg-[#141414]">
                        <td colSpan={6} className="px-5 py-3 space-y-1">
                          <div className="text-xs text-zinc-500">
                            {[
                              e.base,
                              e.programa,
                              e.cpu_ms != null ? `CPU ${seg(e.cpu_ms)}` : null,
                              e.lecturas_fisicas != null ? `lecturas de disco ${num(e.lecturas_fisicas)}` : null,
                              e.filas != null ? `${num(e.filas)} filas` : null,
                              e.severidad != null ? `severidad ${e.severidad}` : null,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </div>
                          {e.mensaje && e.tipo !== "BLOQUEO" && (
                            <div className="text-xs text-rose-200">{e.mensaje}</div>
                          )}
                          {e.tipo === "BLOQUEO" && (
                            <div className="text-xs text-zinc-400">
                              {e.mensaje} — detalle en la pestaña Bloqueos
                            </div>
                          )}
                          <pre className="whitespace-pre-wrap break-all text-xs text-zinc-300">
                            {e.sql_texto ?? "—"}
                          </pre>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))
              ) : (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-zinc-600">
                    Sin eventos registrados en el período.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
