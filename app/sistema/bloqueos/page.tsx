"use client";

/**
 * /sistema/bloqueos — sala de situación de los cuelgues de Magnus.
 *
 * Qué resuelve: cuando "se cuelga la base" casi siempre es una sola sesión del
 * cliente de Magnus con una transacción abierta (SERIALIZABLE, cursor API de
 * una pantalla) que encadena decenas de sesiones detrás. Encontrar esa cabeza
 * a mano lleva varios minutos con la empresa parada.
 *
 * Acá la cabeza ya está identificada y lo único que queda es decidir: matarla
 * o esperar. Todo lo demás —detección, foto de la cadena, registro— lo hace
 * solo el job de SQL Agent "VICKI - Watchdog bloqueos" (cada minuto) más el SP
 * de detección que dispara esta misma pantalla al refrescar.
 *
 * Ver indicadores-api/bloqueos.py y ever/sql/magnus_watchdog_bloqueos.sql.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { InicioButton } from "@/components/ui/InicioButton";
import { UsuarioActual } from "@/components/auth/UsuarioActual";

const REFRESCO_MS = 10_000;

const AISLAMIENTO: Record<number, string> = {
  0: "sin especificar",
  1: "READ UNCOMMITTED",
  2: "READ COMMITTED",
  3: "REPEATABLE READ",
  4: "SERIALIZABLE",
  5: "SNAPSHOT",
};

type Victima = {
  cabeza: number;
  spid: number;
  espera_seg: number;
  espera_tipo: string | null;
  nivel: number;
  recurso: string | null;
  host: string | null;
  login: string | null;
  programa: string | null;
  comando: string | null;
};

type Cabeza = {
  spid: number;
  bloqueados: number;
  espera_max_seg: number;
  login: string | null;
  host: string | null;
  programa: string | null;
  estado_sesion: string | null;
  transacciones_abiertas: number | null;
  aislamiento: number | null;
  episodio_id: number | null;
  detectado_en: string | null;
  tran_desde: string | null;
  ultimo_sql: string | null;
  objetos: { tabla: string; locks: number; modo: string }[];
  accion: string | null;
  accion_usuario: string | null;
  muestras: number | null;
  victimas: Victima[];
  accionable: boolean;
  califica: boolean;
};

type Estado = {
  ahora: string;
  hay_bloqueo: boolean;
  bloqueados_total: number;
  umbral: { bloqueados: number; espera_seg: number };
  cabezas: Cabeza[];
};

type Episodio = {
  id: number;
  detectado_en: string;
  cerrado_en: string | null;
  duracion_seg: number;
  spid_cabeza: number;
  host_cabeza: string | null;
  login_cabeza: string | null;
  programa_cabeza: string | null;
  aislamiento: number | null;
  bloqueados_max: number;
  espera_max_seg: number;
  estado: string;
  accion: string | null;
  accion_usuario: string | null;
  accion_detalle: string | null;
  objetos: { tabla: string; locks: number; modo: string }[];
};

type Historial = {
  resumen: {
    episodios: number;
    matados: number;
    solos: number;
    peor_bloqueados: number;
    peor_espera_seg: number;
  };
  episodios: Episodio[];
};

function duracion(seg: number | null | undefined) {
  if (seg == null) return "—";
  if (seg < 60) return `${seg}s`;
  const m = Math.floor(seg / 60);
  const s = seg % 60;
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function desdeHace(iso: string | null | undefined) {
  if (!iso) return null;
  const t = new Date(iso.replace(" ", "T")).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((Date.now() - t) / 1000));
}

function hora(iso: string | null | undefined) {
  if (!iso) return "—";
  return iso.replace("T", " ").slice(0, 19);
}

const ESTADO_CHIP: Record<string, string> = {
  ABIERTO: "bg-red-500/15 text-red-300 border-red-500/30",
  MATADO: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  RESUELTO_SOLO: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  DEJADO: "bg-sky-500/15 text-sky-300 border-sky-500/30",
};

export default function BloqueosPage() {
  const [estado, setEstado] = useState<Estado | null>(null);
  const [historial, setHistorial] = useState<Historial | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(true);
  const [confirmar, setConfirmar] = useState<number | null>(null);
  const [ejecutando, setEjecutando] = useState(false);
  const [aviso, setAviso] = useState<{ ok: boolean; texto: string } | null>(null);
  const [abierto, setAbierto] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cargar = useCallback(async () => {
    try {
      const r = await fetch("/api/sistema/bloqueos", { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error ?? "Error al consultar");
      setEstado(j);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al consultar");
    } finally {
      setCargando(false);
    }
  }, []);

  const cargarHistorial = useCallback(async () => {
    try {
      const r = await fetch("/api/sistema/bloqueos/historial?dias=30&limite=50", {
        cache: "no-store",
      });
      if (r.ok) setHistorial(await r.json());
    } catch {
      /* el historial es secundario: si falla, la pantalla sigue viva */
    }
  }, []);

  // Refresco continuo. setTimeout encadenado en vez de setInterval para que
  // una consulta lenta no apile pedidos sobre la base.
  useEffect(() => {
    let vivo = true;
    const loop = async () => {
      await cargar();
      if (!vivo) return;
      timer.current = setTimeout(loop, REFRESCO_MS);
    };
    loop();
    cargarHistorial();
    return () => {
      vivo = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [cargar, cargarHistorial]);

  async function accionar(episodioId: number, accion: "matar" | "dejar") {
    setEjecutando(true);
    setAviso(null);
    try {
      const r = await fetch("/api/sistema/bloqueos/accion", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accion, episodioId }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error ?? "No se pudo ejecutar");
      setAviso({ ok: Boolean(j?.ok), texto: j?.mensaje ?? "Listo" });
      setConfirmar(null);
      await cargar();
      await cargarHistorial();
    } catch (e) {
      setAviso({
        ok: false,
        texto: e instanceof Error ? e.message : "No se pudo ejecutar",
      });
    } finally {
      setEjecutando(false);
    }
  }

  const hayBloqueo = Boolean(estado?.hay_bloqueo);

  return (
    <div className="dark min-h-screen bg-[#111111] text-white p-4 md:p-6 space-y-5">
      {/* Encabezado */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex items-center gap-3">
          <InicioButton />
          <div>
            <h1 className="text-yellow-400 font-bold uppercase tracking-wide text-lg">
              Bloqueos de la base
            </h1>
            <p className="text-zinc-500 text-sm">
              Magnus · SRV-SQL2 · se revisa solo cada 10 segundos
            </p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-right text-xs text-zinc-500">
            <div>Última lectura: {hora(estado?.ahora)}</div>
            <div>
              Umbral de episodio: {estado?.umbral?.bloqueados ?? 3} sesiones ·{" "}
              {estado?.umbral?.espera_seg ?? 20}s
            </div>
          </div>
          <button
            onClick={() => cargar()}
            title="Refrescar ahora"
            className="rounded-md border border-zinc-700 p-2 text-zinc-300 hover:bg-zinc-800 hover:text-yellow-400"
          >
            <RefreshCw className={`h-4 w-4 ${cargando ? "animate-spin" : ""}`} />
          </button>
          <UsuarioActual />
        </div>
      </div>

      {/* Semáforo */}
      <div
        className={`rounded-lg border px-5 py-4 ${
          hayBloqueo
            ? "border-red-500/40 bg-red-500/10"
            : "border-emerald-500/30 bg-emerald-500/5"
        }`}
      >
        {cargando ? (
          <span className="text-zinc-400">Consultando…</span>
        ) : error ? (
          <span className="text-red-300">{error}</span>
        ) : hayBloqueo ? (
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-3xl font-bold text-red-300">
              {estado?.bloqueados_total}
            </span>
            <span className="text-red-200">
              sesiones frenadas por {estado?.cabezas.length}{" "}
              {estado?.cabezas.length === 1 ? "sesión" : "sesiones"}
            </span>
          </div>
        ) : (
          <div className="flex items-baseline gap-3">
            <span className="text-2xl font-bold text-emerald-300">Sin bloqueos</span>
            <span className="text-zinc-400 text-sm">
              Ninguna sesión está esperando a otra.
            </span>
          </div>
        )}
      </div>

      {aviso && (
        <div
          className={`rounded-md border px-4 py-2 text-sm ${
            aviso.ok
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
              : "border-red-500/30 bg-red-500/10 text-red-200"
          }`}
        >
          {aviso.texto}
        </div>
      )}

      {/* Una tarjeta por cabeza de cadena */}
      {estado?.cabezas.map((c) => {
        const tranSeg = desdeHace(c.tran_desde);
        const serializable = c.aislamiento === 4;
        return (
          <div
            key={c.spid}
            className="rounded-lg border border-zinc-800 bg-[#171717] overflow-hidden"
          >
            <div className="bg-[#1f1f1f] px-5 py-3 flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <span className="text-yellow-400 font-bold uppercase tracking-wide">
                  {c.host ?? "sin host"}
                </span>
                <span className="text-zinc-500 text-xs">SPID {c.spid}</span>
                <span className="text-red-300 text-sm font-semibold">
                  frena a {c.bloqueados}
                </span>
                <span className="text-zinc-400 text-sm">
                  la peor espera {duracion(c.espera_max_seg)}
                </span>
              </div>

              <div className="flex items-center gap-2">
                {!c.accionable ? (
                  <span className="text-xs text-zinc-500">
                    {c.califica
                      ? "registrando episodio…"
                      : "por debajo del umbral — todavía no es episodio"}
                  </span>
                ) : confirmar === c.episodio_id ? (
                  <>
                    <span className="text-xs text-red-300">
                      ¿Matar la sesión {c.spid} de {c.host}? Pierde lo que tenga sin
                      guardar.
                    </span>
                    <button
                      disabled={ejecutando}
                      onClick={() => accionar(c.episodio_id!, "matar")}
                      className="rounded-md bg-red-500 px-3 py-1.5 text-sm font-semibold text-black hover:bg-red-400 disabled:opacity-50"
                    >
                      {ejecutando ? "Matando…" : "Sí, matar"}
                    </button>
                    <button
                      disabled={ejecutando}
                      onClick={() => setConfirmar(null)}
                      className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800"
                    >
                      Cancelar
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      onClick={() => setConfirmar(c.episodio_id!)}
                      className="rounded-md bg-yellow-400 px-3 py-1.5 text-sm font-semibold text-black hover:bg-yellow-300"
                    >
                      Matar sesión
                    </button>
                    <button
                      disabled={ejecutando || c.accion === "DEJAR"}
                      onClick={() => accionar(c.episodio_id!, "dejar")}
                      className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800 hover:text-yellow-400 disabled:opacity-50"
                    >
                      {c.accion === "DEJAR" ? "Esperando" : "Dejar"}
                    </button>
                  </>
                )}
              </div>
            </div>

            <div className="px-5 py-4 grid gap-4 md:grid-cols-3">
              <div className="space-y-1 text-sm">
                <Dato k="Usuario SQL" v={c.login} />
                <Dato k="Programa" v={c.programa} />
                <Dato k="Estado" v={c.estado_sesion} />
                <Dato
                  k="Aislamiento"
                  v={AISLAMIENTO[c.aislamiento ?? -1] ?? String(c.aislamiento ?? "—")}
                  tono={serializable ? "alerta" : undefined}
                />
              </div>
              <div className="space-y-1 text-sm">
                <Dato
                  k="Transacción abierta"
                  v={tranSeg != null ? `hace ${duracion(tranSeg)}` : "—"}
                  tono={tranSeg != null && tranSeg > 300 ? "alerta" : undefined}
                />
                <Dato k="Transacciones" v={c.transacciones_abiertas} />
                <Dato k="Episodio" v={c.episodio_id ? `#${c.episodio_id}` : "—"} />
                <Dato k="Detectado" v={hora(c.detectado_en)} />
              </div>
              <div className="text-sm">
                <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">
                  Tablas que retiene
                </div>
                <div className="flex flex-wrap gap-1">
                  {c.objetos?.length ? (
                    c.objetos.map((o) => (
                      <span
                        key={o.tabla}
                        className="rounded border border-amber-500/30 bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-300"
                      >
                        {o.tabla} · {o.locks} {o.modo}
                      </span>
                    ))
                  ) : (
                    <span className="text-zinc-600">—</span>
                  )}
                </div>
              </div>
            </div>

            {c.ultimo_sql && (
              <div className="px-5 pb-4">
                <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">
                  Último comando de la cabeza
                </div>
                <pre className="max-h-32 overflow-auto rounded bg-[#0d0d0d] border border-zinc-800 p-3 text-[11px] text-zinc-400 whitespace-pre-wrap">
                  {c.ultimo_sql}
                </pre>
              </div>
            )}

            {/* Cadena */}
            <div className="border-t border-zinc-800/60">
              <button
                onClick={() => setAbierto(abierto === c.spid ? null : c.spid)}
                className="w-full px-5 py-2 text-left text-xs uppercase tracking-wider text-zinc-500 hover:text-yellow-400"
              >
                {abierto === c.spid ? "Ocultar" : "Ver"} las {c.victimas.length}{" "}
                sesiones frenadas
              </button>
              {abierto === c.spid && (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-[#1f1f1f] text-[10px] uppercase tracking-wider text-zinc-500">
                      <tr>
                        <th className="px-4 py-2 text-left">SPID</th>
                        <th className="px-4 py-2 text-left">Equipo</th>
                        <th className="px-4 py-2 text-left">Programa</th>
                        <th className="px-4 py-2 text-right">Espera</th>
                        <th className="px-4 py-2 text-left">Tipo</th>
                        <th className="px-4 py-2 text-left">Comando</th>
                      </tr>
                    </thead>
                    <tbody>
                      {c.victimas.map((v) => (
                        <tr
                          key={v.spid}
                          className="border-t border-zinc-800/60 hover:bg-[#1f1f1f]"
                        >
                          <td className="px-4 py-1.5 text-zinc-400">{v.spid}</td>
                          <td className="px-4 py-1.5 text-zinc-200">
                            {v.host ?? "—"}
                          </td>
                          <td className="px-4 py-1.5 text-zinc-500 truncate max-w-[220px]">
                            {v.programa ?? "—"}
                          </td>
                          <td className="px-4 py-1.5 text-right text-red-300">
                            {duracion(v.espera_seg)}
                          </td>
                          <td className="px-4 py-1.5 text-zinc-500">
                            {v.espera_tipo ?? "—"}
                          </td>
                          <td className="px-4 py-1.5 text-zinc-500 truncate max-w-[320px]">
                            {v.comando ?? "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        );
      })}

      {/* Historial */}
      <div className="rounded-lg border border-zinc-800 bg-[#171717] overflow-hidden">
        <div className="bg-[#1f1f1f] px-5 py-3 flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800">
          <span className="text-yellow-400 font-bold uppercase tracking-wide text-sm">
            Últimos 30 días
          </span>
          {historial?.resumen && (
            <span className="text-xs text-zinc-400">
              {historial.resumen.episodios} episodios ·{" "}
              {historial.resumen.matados} con KILL · {historial.resumen.solos} se
              destrabaron solos · peor: {historial.resumen.peor_bloqueados} sesiones
              frenadas
            </span>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-[#1f1f1f] text-[10px] uppercase tracking-wider text-zinc-500">
              <tr>
                <th className="px-4 py-2 text-left">Cuándo</th>
                <th className="px-4 py-2 text-left">Equipo (cabeza)</th>
                <th className="px-4 py-2 text-right">Frenó a</th>
                <th className="px-4 py-2 text-right">Peor espera</th>
                <th className="px-4 py-2 text-right">Duró</th>
                <th className="px-4 py-2 text-left">Cómo terminó</th>
                <th className="px-4 py-2 text-left">Quién</th>
              </tr>
            </thead>
            <tbody>
              {historial?.episodios?.length ? (
                historial.episodios.map((e) => (
                  <tr
                    key={e.id}
                    className="border-t border-zinc-800/60 hover:bg-[#1f1f1f]"
                  >
                    <td className="px-4 py-1.5 text-zinc-400">
                      {hora(e.detectado_en)}
                    </td>
                    <td className="px-4 py-1.5 text-zinc-200">
                      {e.host_cabeza ?? "—"}{" "}
                      <span className="text-zinc-600">({e.spid_cabeza})</span>
                    </td>
                    <td className="px-4 py-1.5 text-right text-zinc-300">
                      {e.bloqueados_max}
                    </td>
                    <td className="px-4 py-1.5 text-right text-zinc-300">
                      {duracion(e.espera_max_seg)}
                    </td>
                    <td className="px-4 py-1.5 text-right text-zinc-300">
                      {duracion(e.duracion_seg)}
                    </td>
                    <td className="px-4 py-1.5">
                      <span
                        className={`rounded border px-2 py-0.5 text-[11px] ${
                          ESTADO_CHIP[e.estado] ??
                          "bg-zinc-500/15 text-zinc-300 border-zinc-500/30"
                        }`}
                      >
                        {e.estado.replace("_", " ").toLowerCase()}
                      </span>
                    </td>
                    <td className="px-4 py-1.5 text-zinc-500">
                      {e.accion_usuario ?? "—"}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={7} className="px-4 py-6 text-center text-zinc-600">
                    Sin episodios registrados en el período.
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

function Dato({
  k,
  v,
  tono,
}: {
  k: string;
  v: string | number | null | undefined;
  tono?: "alerta";
}) {
  return (
    <div className="flex gap-2">
      <span className="text-[10px] uppercase tracking-wider text-zinc-500 w-36 shrink-0 pt-0.5">
        {k}
      </span>
      <span
        className={tono === "alerta" ? "text-red-300 font-medium" : "text-zinc-200"}
      >
        {v ?? "—"}
      </span>
    </div>
  );
}
