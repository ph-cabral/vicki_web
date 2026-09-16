"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import {
  ArrowRightLeft,
  Delete,
  Mic,
  MicOff,
  Pause,
  Phone,
  PhoneIncoming,
  PhoneOff,
  PhoneOutgoing,
  Play,
  X,
} from "lucide-react";
import { toast } from "sonner";
import type { UA as JsSipUA } from "jssip";
import type { RTCSession } from "jssip/lib/RTCSession";

// ──────────────────────────────────────────────────────────────────────────────
// Softphone web (2026-09-16). Reemplaza al teléfono IP: el navegador se
// registra en Issabel como la extensión del usuario (WebRTC sobre WebSocket,
// librería JsSIP) y el audio sale por los auriculares/micrófono de la PC.
//
// - Modo "pagina" (el que se usa hoy): vista /sorteo/telefono, entra quien
//   tenga el módulo sorteo + esa vista. La llamada se corta al salir de la
//   vista o recargar (F5): el puesto tiene que dejar esa pestaña abierta.
// - Modo "flotante": botón abajo a la derecha; si se monta en app/layout.tsx
//   vive en todas las vistas sin cortar al navegar con <Link>. Hoy no se usa.
// - Credenciales: GET /api/telefonia/credenciales (204 = sin extensión
//   asignada en /admin/telefonia).
// - Una sola pestaña registrada por navegador (Web Locks): si Vicki está abierta
//   en varias pestañas, sólo una suena; al cerrarla, la siguiente toma el control.
// - El micrófono exige contexto seguro: con Vicki en http:// hace falta la
//   política de Chrome/Edge "OverrideSecurityRestrictionsOnInsecureOrigin"
//   (GPO), ver TELEFONIA.md.
// - DTMF por RFC2833 (dtmfmode=rfc2833 en la extensión).
// ──────────────────────────────────────────────────────────────────────────────

type Credenciales = {
  extension: string;
  clave: string;
  nombre: string;
  wsUrl: string;
  dominio: string;
};

type EstadoReg =
  | "cargando"
  | "oculto"
  | "inseguro"
  | "otraPestana"
  | "conectando"
  | "registrado"
  | "error";

type Llamada = {
  dir: "entrante" | "saliente";
  numero: string;
  nombre: string;
  fase: "sonando" | "llamando" | "en_curso";
  inicio: number | null;
  mute: boolean;
  hold: boolean;
};

type Reciente = { numero: string; nombre: string; dir: "entrante" | "saliente" | "perdida"; ts: number };

const LOCK = "vicki-softphone";
const RECIENTES_KEY = "vicki-softphone-recientes";
const OCULTO_EN = ["/login", "/picking/picker"];
const TECLAS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"];

function leerRecientes(): Reciente[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECIENTES_KEY) ?? "[]");
    return Array.isArray(v) ? v.slice(0, 15) : [];
  } catch {
    return [];
  }
}

function guardarReciente(r: Reciente) {
  try {
    const lista = [r, ...leerRecientes()].slice(0, 15);
    localStorage.setItem(RECIENTES_KEY, JSON.stringify(lista));
  } catch {
    /* sin storage: no pasa nada */
  }
}

function mmss(seg: number) {
  const m = Math.floor(seg / 60);
  const s = seg % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// Timbre generado con WebAudio (sin archivos estáticos).
function crearTimbre() {
  let ctx: AudioContext | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  const sonar = () => {
    if (!ctx) return;
    const t = ctx.currentTime;
    for (const [ini, fin] of [
      [0, 0.4],
      [0.6, 1.0],
    ]) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = 440;
      o.connect(g);
      g.connect(ctx.destination);
      g.gain.setValueAtTime(0.0001, t + ini);
      g.gain.exponentialRampToValueAtTime(0.25, t + ini + 0.02);
      g.gain.setValueAtTime(0.25, t + fin - 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + fin);
      o.start(t + ini);
      o.stop(t + fin);
    }
  };
  return {
    start() {
      if (timer) return;
      try {
        ctx = ctx ?? new AudioContext();
        ctx.resume().catch(() => {});
        sonar();
        timer = setInterval(sonar, 3000);
      } catch {
        /* sin audio */
      }
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

export function Softphone({ modo = "flotante" }: { modo?: "flotante" | "pagina" }) {
  const enPagina = modo === "pagina";
  const pathname = usePathname();
  const [estado, setEstado] = useState<EstadoReg>("cargando");
  const [detalleError, setDetalleError] = useState("");
  const [cred, setCred] = useState<Credenciales | null>(null);
  const [abierto, setAbierto] = useState(false);
  const [numero, setNumero] = useState("");
  const [llamada, setLlamada] = useState<Llamada | null>(null);
  const [segundos, setSegundos] = useState(0);
  const [transferir, setTransferir] = useState(false);
  const [destinoTransf, setDestinoTransf] = useState("");
  const [recientes, setRecientes] = useState<Reciente[]>([]);

  const uaRef = useRef<JsSipUA | null>(null);
  const sesionRef = useRef<RTCSession | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const timbreRef = useRef<ReturnType<typeof crearTimbre> | null>(null);
  const llamadaRef = useRef<Llamada | null>(null);
  llamadaRef.current = llamada;

  const oculto = !enPagina && OCULTO_EN.some((p) => pathname === p || pathname?.startsWith(p + "/"));

  // 1) Credenciales. Se reintenta al cambiar de ruta mientras no haya (p.ej.
  //    recién logueado), sin volver a pedirlas una vez obtenidas.
  useEffect(() => {
    if (oculto || cred) return;
    let cancel = false;
    fetch("/api/telefonia/credenciales", { cache: "no-store" })
      .then(async (r) => {
        if (cancel) return;
        if (r.status === 200) {
          setCred(await r.json());
          return;
        }
        if (r.status === 500) {
          const d = await r.json().catch(() => ({}));
          setDetalleError(d?.error ?? "Error de configuración");
          setEstado("error");
          return;
        }
        setEstado("oculto");
      })
      .catch(() => !cancel && setEstado("oculto"));
    return () => {
      cancel = true;
    };
  }, [pathname, oculto, cred]);

  useEffect(() => {
    setRecientes(leerRecientes());
  }, []);

  const finLlamada = useCallback((motivo?: string) => {
    timbreRef.current?.stop();
    const l = llamadaRef.current;
    if (l) {
      const perdida = l.dir === "entrante" && l.fase === "sonando";
      guardarReciente({
        numero: l.numero,
        nombre: l.nombre,
        dir: perdida ? "perdida" : l.dir,
        ts: Date.now(),
      });
      setRecientes(leerRecientes());
    }
    sesionRef.current = null;
    setLlamada(null);
    setTransferir(false);
    setDestinoTransf("");
    if (audioRef.current) audioRef.current.srcObject = null;
    if (motivo) toast.message(motivo);
  }, []);

  const conectarAudio = useCallback((pc: RTCPeerConnection) => {
    pc.addEventListener("track", (ev) => {
      const a = audioRef.current;
      if (!a) return;
      a.srcObject = ev.streams[0] ?? new MediaStream([ev.track]);
      a.play().catch(() => {});
    });
  }, []);

  const engancharSesion = useCallback(
    (session: RTCSession, originator: "local" | "remote") => {
      sesionRef.current = session;
      if (session.connection) conectarAudio(session.connection as unknown as RTCPeerConnection);
      session.on("peerconnection", (e: any) => conectarAudio(e.peerconnection));

      session.on("progress", () => {
        if (originator === "local") setLlamada((l) => (l ? { ...l, fase: "llamando" } : l));
      });
      session.on("confirmed", () => {
        timbreRef.current?.stop();
        setLlamada((l) => (l ? { ...l, fase: "en_curso", inicio: Date.now() } : l));
      });
      session.on("hold", () => setLlamada((l) => (l ? { ...l, hold: true } : l)));
      session.on("unhold", () => setLlamada((l) => (l ? { ...l, hold: false } : l)));
      session.on("ended", () => finLlamada());
      session.on("failed", (e: any) => {
        const causa: string = e?.cause ?? "";
        const silencioso = ["Canceled", "Rejected", "Terminated", "Busy"].includes(causa) && e?.originator === "local";
        const textos: Record<string, string> = {
          Busy: "Ocupado",
          Rejected: "Rechazada",
          Unavailable: "No disponible",
          "Not Found": "Número inexistente",
          "User Denied Media Access": "El navegador no dio permiso al micrófono",
          "No Answer": "No atendió",
          Canceled: "Llamada cancelada",
          "Connection Error": "Sin conexión con la central",
        };
        finLlamada(silencioso ? undefined : textos[causa] ?? (causa ? `Llamada terminada: ${causa}` : undefined));
      });
    },
    [conectarAudio, finLlamada],
  );

  // 2) Registro en Issabel, sólo en una pestaña a la vez.
  useEffect(() => {
    if (!cred) return;
    if (typeof window === "undefined") return;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setEstado("inseguro");
      return;
    }

    let vivo = true;
    let liberar: (() => void) | null = null;
    const abort = new AbortController();
    timbreRef.current = crearTimbre();

    const arrancar = async () => {
      const JsSIP = await import("jssip");
      if (!vivo) return;
      JsSIP.debug.disable();
      setEstado("conectando");
      const socket = new JsSIP.WebSocketInterface(cred.wsUrl);
      const ua = new JsSIP.UA({
        sockets: [socket],
        uri: `sip:${cred.extension}@${cred.dominio}`,
        password: cred.clave,
        display_name: cred.nombre,
        register: true,
        session_timers: false,
        user_agent: "Vicki Softphone",
      });
      uaRef.current = ua;

      ua.on("registered", () => {
        setEstado("registrado");
        setDetalleError("");
      });
      ua.on("unregistered", () => vivo && setEstado("conectando"));
      ua.on("disconnected", () => vivo && setEstado("conectando"));
      ua.on("registrationFailed", (e: any) => {
        setEstado("error");
        setDetalleError(
          e?.cause === "Authentication Error"
            ? "Clave de la extensión incorrecta"
            : e?.cause === "Connection Error"
              ? "No se puede conectar con la central"
              : `No registra: ${e?.cause ?? "error"}`,
        );
      });

      ua.on("newRTCSession", (e: any) => {
        const session: RTCSession = e.session;
        if (e.originator === "remote") {
          if (sesionRef.current) {
            session.terminate({ status_code: 486, reason_phrase: "Busy Here" });
            return;
          }
          const numeroRem = session.remote_identity?.uri?.user ?? "";
          const nombreRem = session.remote_identity?.display_name ?? "";
          engancharSesion(session, "remote");
          setLlamada({
            dir: "entrante",
            numero: numeroRem,
            nombre: nombreRem,
            fase: "sonando",
            inicio: null,
            mute: false,
            hold: false,
          });
          setAbierto(true);
          timbreRef.current?.start();
          try {
            if ("Notification" in window && Notification.permission === "granted" && document.hidden) {
              const n = new Notification("Llamada entrante", {
                body: nombreRem ? `${nombreRem} (${numeroRem})` : numeroRem,
                tag: "vicki-softphone",
              });
              n.onclick = () => {
                window.focus();
                n.close();
              };
            }
          } catch {
            /* sin notificaciones */
          }
        } else {
          engancharSesion(session, "local");
        }
      });

      ua.start();

      return new Promise<void>((resolve) => {
        liberar = () => {
          try {
            sesionRef.current?.terminate();
          } catch {
            /* ya cortada */
          }
          try {
            ua.stop();
          } catch {
            /* ya parado */
          }
          uaRef.current = null;
          resolve();
        };
        if (!vivo) liberar();
      });
    };

    const locks = (navigator as any).locks;
    if (locks?.request) {
      locks
        .query()
        .then((s: any) => {
          if (vivo && s?.held?.some((l: any) => l.name === LOCK)) setEstado("otraPestana");
        })
        .catch(() => {});
      locks.request(LOCK, { signal: abort.signal }, () => arrancar()).catch(() => {});
    } else {
      arrancar();
    }

    const alCerrar = () => liberar?.();
    window.addEventListener("pagehide", alCerrar);

    return () => {
      vivo = false;
      window.removeEventListener("pagehide", alCerrar);
      abort.abort();
      timbreRef.current?.stop();
      liberar?.();
    };
  }, [cred, engancharSesion]);

  // Cronómetro.
  useEffect(() => {
    if (llamada?.fase !== "en_curso" || !llamada.inicio) {
      setSegundos(0);
      return;
    }
    const ini = llamada.inicio;
    setSegundos(Math.floor((Date.now() - ini) / 1000));
    const t = setInterval(() => setSegundos(Math.floor((Date.now() - ini) / 1000)), 1000);
    return () => clearInterval(t);
  }, [llamada?.fase, llamada?.inicio]);

  // Pedir permiso de notificaciones la primera vez que se abre el panel.
  useEffect(() => {
    if (!abierto && !enPagina) return;
    try {
      if ("Notification" in window && Notification.permission === "default") {
        Notification.requestPermission().catch(() => {});
      }
    } catch {
      /* nada */
    }
  }, [abierto, enPagina]);

  const opcionesMedia = {
    mediaConstraints: { audio: true, video: false },
    pcConfig: { iceServers: [] as RTCIceServer[] },
    rtcOfferConstraints: { offerToReceiveAudio: true, offerToReceiveVideo: false },
  };

  function llamar(destino?: string) {
    const n = (destino ?? numero).replace(/[^\d*#+]/g, "");
    const ua = uaRef.current;
    if (!n || !ua || estado !== "registrado" || sesionRef.current) return;
    setLlamada({ dir: "saliente", numero: n, nombre: "", fase: "llamando", inicio: null, mute: false, hold: false });
    try {
      ua.call(`sip:${n}@${cred!.dominio}`, opcionesMedia as any);
      setNumero("");
    } catch (e: any) {
      finLlamada(e?.message ?? "No se pudo llamar");
    }
  }

  function atender() {
    timbreRef.current?.stop();
    try {
      sesionRef.current?.answer(opcionesMedia as any);
    } catch (e: any) {
      finLlamada(e?.message ?? "No se pudo atender");
    }
  }

  function cortar() {
    const s = sesionRef.current;
    if (!s) return;
    try {
      if (llamada?.dir === "entrante" && llamada.fase === "sonando") {
        s.terminate({ status_code: 486, reason_phrase: "Busy Here" });
      } else {
        s.terminate();
      }
    } catch {
      finLlamada();
    }
  }

  function tecla(t: string) {
    if (llamada?.fase === "en_curso") {
      try {
        sesionRef.current?.sendDTMF(t, { transportType: "RFC2833" } as any);
      } catch {
        /* nada */
      }
      return;
    }
    setNumero((n) => (n + t).slice(0, 20));
  }

  function toggleMute() {
    const s = sesionRef.current;
    if (!s || !llamada) return;
    if (llamada.mute) s.unmute({ audio: true });
    else s.mute({ audio: true });
    setLlamada({ ...llamada, mute: !llamada.mute });
  }

  function toggleHold() {
    const s = sesionRef.current;
    if (!s || !llamada) return;
    if (llamada.hold) s.unhold();
    else s.hold();
  }

  function hacerTransferencia() {
    const d = destinoTransf.replace(/[^\d*#+]/g, "");
    const s = sesionRef.current;
    if (!d || !s) return;
    try {
      s.refer(`sip:${d}@${cred!.dominio}`);
      toast.success(`Transferida a ${d}`);
      setTransferir(false);
    } catch (e: any) {
      toast.error(e?.message ?? "No se pudo transferir");
    }
  }

  if (enPagina && estado === "oculto") {
    return (
      <div className="mx-auto w-full max-w-sm rounded-xl border border-zinc-800 bg-[#161616] px-4 py-6 text-center text-zinc-300">
        <Phone className="mx-auto mb-2 size-6 text-zinc-500" />
        <div className="font-medium text-zinc-100">No tenés una extensión asignada</div>
        <div className="mt-1 text-sm text-zinc-400">Un administrador la asigna en Administración › Telefonía.</div>
      </div>
    );
  }
  if (oculto || estado === "cargando" || estado === "oculto") return null;

  const punto =
    estado === "registrado"
      ? "bg-emerald-500"
      : estado === "error" || estado === "inseguro"
        ? "bg-red-500"
        : "bg-amber-400";

  const textoEstado: Record<EstadoReg, string> = {
    cargando: "",
    oculto: "",
    inseguro: "Micrófono bloqueado por el navegador (falta la política de sitio seguro)",
    otraPestana: "Activo en otra pestaña de Vicki",
    conectando: "Conectando con la central…",
    registrado: "Listo para llamar",
    error: detalleError || "Error",
  };

  const sonando = llamada?.dir === "entrante" && llamada.fase === "sonando";

  return (
    <>
      <audio ref={audioRef} autoPlay className="hidden" />

      {/* Botón flotante */}
      {!enPagina && (
      <button
        type="button"
        onClick={() => setAbierto((a) => !a)}
        title={`Teléfono · Ext. ${cred?.extension ?? ""} · ${textoEstado[estado]}`}
        className={`fixed bottom-4 right-4 z-[110] flex size-12 items-center justify-center rounded-full
          border border-zinc-700 bg-[#161616] text-zinc-100 shadow-lg transition hover:bg-zinc-800
          ${sonando ? "animate-bounce bg-emerald-600 hover:bg-emerald-500" : ""}
          ${llamada && !sonando ? "bg-emerald-700 hover:bg-emerald-600" : ""}`}
      >
        {sonando ? <PhoneIncoming className="size-5" /> : <Phone className="size-5" />}
        <span className={`absolute right-0.5 top-0.5 size-3 rounded-full border-2 border-[#161616] ${punto}`} />
      </button>
      )}

      {(abierto || enPagina) && (
        <div
          className={
            enPagina
              ? "mx-auto w-full max-w-sm rounded-xl border border-zinc-800 bg-[#161616] text-zinc-100 shadow-2xl"
              : "fixed bottom-20 right-4 z-[110] w-72 rounded-xl border border-zinc-800 bg-[#161616] text-zinc-100 shadow-2xl"
          }
        >
          {/* Cabecera */}
          <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2">
            <span className={`size-2 rounded-full ${punto}`} />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">Ext. {cred?.extension}</div>
              <div className="truncate text-[11px] text-zinc-400" title={textoEstado[estado]}>
                {textoEstado[estado]}
              </div>
            </div>
            {!enPagina && (
              <button
                type="button"
                onClick={() => setAbierto(false)}
                className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
              >
                <X className="size-4" />
              </button>
            )}
          </div>

          {llamada ? (
            <div className="flex flex-col items-center gap-3 px-3 py-4">
              <div className="text-xs uppercase tracking-wide text-zinc-400">
                {sonando
                  ? "Llamada entrante"
                  : llamada.fase === "llamando"
                    ? "Llamando…"
                    : llamada.hold
                      ? "En espera"
                      : "En llamada"}
              </div>
              <div className="text-center">
                <div className="text-2xl font-semibold tabular-nums">{llamada.numero || "Desconocido"}</div>
                {llamada.nombre && <div className="text-sm text-zinc-400">{llamada.nombre}</div>}
              </div>
              {llamada.fase === "en_curso" && (
                <div className="font-mono text-sm tabular-nums text-zinc-300">{mmss(segundos)}</div>
              )}

              {sonando ? (
                <div className="flex gap-6 pt-2">
                  <button
                    type="button"
                    onClick={cortar}
                    className="flex size-14 items-center justify-center rounded-full bg-red-600 hover:bg-red-500"
                    title="Rechazar"
                  >
                    <PhoneOff className="size-6" />
                  </button>
                  <button
                    type="button"
                    onClick={atender}
                    className="flex size-14 animate-pulse items-center justify-center rounded-full bg-emerald-600 hover:bg-emerald-500"
                    title="Atender"
                  >
                    <Phone className="size-6" />
                  </button>
                </div>
              ) : (
                <>
                  {llamada.fase === "en_curso" && (
                    <div className="grid w-full grid-cols-3 gap-2">
                      <BotonAccion activo={llamada.mute} onClick={toggleMute} titulo={llamada.mute ? "Activar mic" : "Silenciar"}>
                        {llamada.mute ? <MicOff className="size-4" /> : <Mic className="size-4" />}
                      </BotonAccion>
                      <BotonAccion activo={llamada.hold} onClick={toggleHold} titulo={llamada.hold ? "Retomar" : "Espera"}>
                        {llamada.hold ? <Play className="size-4" /> : <Pause className="size-4" />}
                      </BotonAccion>
                      <BotonAccion activo={transferir} onClick={() => setTransferir((t) => !t)} titulo="Transferir">
                        <ArrowRightLeft className="size-4" />
                      </BotonAccion>
                    </div>
                  )}

                  {transferir && (
                    <div className="flex w-full gap-2">
                      <input
                        autoFocus
                        value={destinoTransf}
                        onChange={(e) => setDestinoTransf(e.target.value.replace(/[^\d*#+]/g, ""))}
                        onKeyDown={(e) => e.key === "Enter" && hacerTransferencia()}
                        placeholder="Transferir a…"
                        className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm outline-none focus:border-zinc-500"
                      />
                      <button
                        type="button"
                        onClick={hacerTransferencia}
                        className="rounded-md bg-zinc-700 px-2.5 text-sm hover:bg-zinc-600"
                      >
                        Pasar
                      </button>
                    </div>
                  )}

                  {llamada.fase === "en_curso" && !transferir && <Teclado onTecla={tecla} chico />}

                  <button
                    type="button"
                    onClick={cortar}
                    className="flex size-14 items-center justify-center rounded-full bg-red-600 hover:bg-red-500"
                    title="Cortar"
                  >
                    <PhoneOff className="size-6" />
                  </button>
                </>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-3 px-3 py-3">
              <div className="flex items-center gap-1">
                <input
                  autoFocus
                  value={numero}
                  onChange={(e) => setNumero(e.target.value.replace(/[^\d*#+]/g, ""))}
                  onKeyDown={(e) => e.key === "Enter" && llamar()}
                  placeholder="Número o interno"
                  className="min-w-0 flex-1 bg-transparent px-1 text-center text-xl font-semibold tabular-nums outline-none placeholder:text-sm placeholder:font-normal placeholder:text-zinc-500"
                />
                {numero && (
                  <button
                    type="button"
                    onClick={() => setNumero((n) => n.slice(0, -1))}
                    className="rounded p-1 text-zinc-400 hover:text-zinc-100"
                    title="Borrar"
                  >
                    <Delete className="size-4" />
                  </button>
                )}
              </div>

              <Teclado onTecla={tecla} />

              <div className="flex justify-center">
                <button
                  type="button"
                  onClick={() => llamar()}
                  disabled={!numero || estado !== "registrado"}
                  className="flex size-14 items-center justify-center rounded-full bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40"
                  title="Llamar"
                >
                  <Phone className="size-6" />
                </button>
              </div>

              {recientes.length > 0 && (
                <div className="border-t border-zinc-800 pt-2">
                  <div className="mb-1 text-[11px] uppercase tracking-wide text-zinc-500">Recientes</div>
                  <div className="max-h-36 overflow-y-auto">
                    {recientes.map((r) => (
                      <button
                        key={r.ts}
                        type="button"
                        onClick={() => llamar(r.numero)}
                        disabled={estado !== "registrado"}
                        className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-sm hover:bg-zinc-800 disabled:opacity-50"
                        title={`Llamar a ${r.numero}`}
                      >
                        {r.dir === "saliente" ? (
                          <PhoneOutgoing className="size-3.5 text-zinc-400" />
                        ) : (
                          <PhoneIncoming className={`size-3.5 ${r.dir === "perdida" ? "text-red-400" : "text-zinc-400"}`} />
                        )}
                        <span className="flex-1 truncate tabular-nums">
                          {r.numero}
                          {r.nombre && <span className="ml-1 text-zinc-500">{r.nombre}</span>}
                        </span>
                        <span className="text-[11px] text-zinc-500">
                          {new Date(r.ts).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </>
  );
}

function Teclado({ onTecla, chico }: { onTecla: (t: string) => void; chico?: boolean }) {
  return (
    <div className="grid w-full grid-cols-3 gap-1.5">
      {TECLAS.map((t) => (
        <button
          key={t}
          type="button"
          onClick={() => onTecla(t)}
          className={`rounded-lg bg-zinc-800/70 font-medium tabular-nums hover:bg-zinc-700 active:bg-zinc-600
            ${chico ? "py-1.5 text-sm" : "py-2.5 text-lg"}`}
        >
          {t}
        </button>
      ))}
    </div>
  );
}

function BotonAccion({
  activo,
  onClick,
  titulo,
  children,
}: {
  activo: boolean;
  onClick: () => void;
  titulo: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={titulo}
      className={`flex flex-col items-center gap-0.5 rounded-lg py-2 text-[11px]
        ${activo ? "bg-zinc-200 text-zinc-900" : "bg-zinc-800/70 text-zinc-200 hover:bg-zinc-700"}`}
    >
      {children}
      {titulo}
    </button>
  );
}
