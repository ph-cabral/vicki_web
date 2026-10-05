"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Check,
  Download,
  Eye,
  EyeOff,
  Keyboard,
  Loader2,
  MessageSquare,
  ScanLine,
  Send,
  X,
} from "lucide-react";

// ──────────────────────────────────────────────────────────────────────────────
// Picking → Picker — vista para PDA (pública, sin sesión: el nombre del picker
// queda en localStorage).
//
// Misma mecánica que Mostradores → Control:
//   · el input de código queda SIEMPRE enfocado (se re-enfoca en scroll,
//     touchend, click, blur) y el teclado en pantalla arranca OCULTO
//     (inputMode="none") para escanear; tocar el input o el botón ⌨ lo muestra.
//   · escaneo → va DERECHO a la pantalla de cantidad. Se acepta el lector que
//     tipea el código + Enter/Tab, el que lo pega entero de golpe y el que lo
//     tipea rápido SIN sufijo (ráfaga < 60 ms entre caracteres + 150 ms quieto).
//     La detección del escaneo sigue activa aunque el teclado esté visible.
//     Si el campo tenía restos (un escaneo cortado, algo tocado), el escaneo
//     nuevo se toma desde donde arrancó la ráfaga y los restos se descartan.
//     El input está dentro de un <form>: el Enter que llega con el IME
//     componiendo (keyCode 229) igual lo dispara el submit implícito.
//     Si el foco se perdió, un keydown en cualquier lado lo devuelve al código.
//     Cantidad: teclado numérico PROPIO en pantalla (no depende del teclado
//     del sistema, que sin toque del usuario Android no siempre abre); el
//     input sigue aceptando teclas físicas. Enter o "Enviar pedido" y vuelve
//     al código limpio y enfocado.
//   · "Consulta al depósito" está ARRIBA de la pantalla de cantidad (no en la
//     de escaneo): la consulta sale con el código escaneado adelante.
// El atrás del PDA cierra la capa de arriba (consulta → cantidad → código).
//
// Datos: POST /api/picking/eventos (pedido) y POST /api/chat (consulta).
//
// Historial: la lista de abajo es el historial del picker de los últimos
// HISTORIAL_DIAS días (GET /api/picking/eventos/historial, por nombre), con
// scroll propio (la cabecera con el input queda fija) y un separador fuerte
// por día (sticky). Los rojos (s/e) se pueden ocultar de a uno o todos juntos
// ("Ocultar rojos"); los ids ocultos quedan en localStorage por picker y
// "Ver ocultos" los vuelve a mostrar atenuados. Los verdes no se ocultan.
// ──────────────────────────────────────────────────────────────────────────────

interface Reciente {
  id?: number; // picking_eventos.id (para seguir su estado)
  codigo: string;
  cantidad: number;
  hora: string;
  estado?: string; // "pendiente" | "pedido" | "s/e"
  nota?: string | null;
  dia?: string; // YYYY-MM-DD (hora AR)
}

const HISTORIAL_DIAS = 7;
const MAX_ITEMS = 300;

// Copia local del historial: se muestra al instante (y sin red) mientras
// llega el del servidor. Ítems viejos sin `dia` toman el del guardado.
const RECIENTES_KEY = "picker_recientes";
const hoy = () => new Date().toLocaleDateString("sv-SE");
const leerRecientes = (picker: string): Reciente[] => {
  try {
    const g = JSON.parse(localStorage.getItem(RECIENTES_KEY) ?? "null");
    if (!g || g.picker !== picker || !Array.isArray(g.items)) return [];
    return (g.items as Reciente[]).map((r) => (r.dia ? r : { ...r, dia: g.dia ?? hoy() }));
  } catch {
    return [];
  }
};

// Rojos que el picker sacó de la vista (ids de picking_eventos, por picker).
const OCULTOS_KEY = "picker_ocultos";
const leerOcultos = (picker: string): Set<number> => {
  try {
    const g = JSON.parse(localStorage.getItem(OCULTOS_KEY) ?? "null");
    return new Set(g && g.picker === picker && Array.isArray(g.ids) ? (g.ids as number[]) : []);
  } catch {
    return new Set();
  }
};

const DIAS_SEMANA = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const etiquetaDia = (dia: string) => {
  const [a, m, d] = dia.split("-").map(Number);
  const f = new Date(a, m - 1, d);
  const ddmm = `${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}`;
  const h = new Date();
  const dif = Math.round(
    (new Date(h.getFullYear(), h.getMonth(), h.getDate()).getTime() - f.getTime()) / 86400000,
  );
  const nombre = DIAS_SEMANA[f.getDay()];
  return dif === 0 ? `Hoy · ${nombre} ${ddmm}` : dif === 1 ? `Ayer · ${nombre} ${ddmm}` : `${nombre} ${ddmm}`;
};

const fmtCant = (n: number) => n.toLocaleString("es-AR", { maximumFractionDigits: 3 });

function vibrar(ms: number | number[]) {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* sin vibración */
  }
}

// Umbrales del lector: entre caracteres de una ráfaga, pausa que corta la
// ráfaga y pausa que marca el arranque de un escaneo nuevo sobre restos.
const RAFAGA_MS = 80;
const QUIETO_MS = 150;
const ARRANQUE_MS = 300;

const TECLAS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", ",", "0", "⌫"];

const empujar = (estado: Record<string, boolean>) => {
  try {
    window.history.pushState(estado, "");
  } catch {
    /* nada */
  }
};

// Puente JS que expone la app Android "EverWear Picker" (WebView).
type PuenteApp = { setPicker: (nombre: string) => void };
const puenteApp = (): PuenteApp | undefined =>
  typeof window === "undefined"
    ? undefined
    : (window as unknown as { EverWearApp?: PuenteApp }).EverWearApp;

export default function PickerPage() {
  const [listo, setListo] = useState(false); // ya se leyó localStorage
  const [pickerNombre, setPickerNombre] = useState<string | null>(null);
  const [nombreInput, setNombreInput] = useState("");

  const [codigo, setCodigo] = useState("");
  const [teclado, setTeclado] = useState(false);
  const [aviso, setAviso] = useState<{ tipo: "ok" | "error"; texto: string } | null>(null);
  const [recientes, setRecientes] = useState<Reciente[]>([]);
  const [ocultos, setOcultos] = useState<Set<number>>(() => new Set());
  const [verOcultos, setVerOcultos] = useState(false);

  // Carga de cantidad
  const [sel, setSel] = useState<string | null>(null); // código escaneado
  const [cantidad, setCantidad] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [errorCant, setErrorCant] = useState<string | null>(null);

  // Consulta al depósito
  const [chatAbierto, setChatAbierto] = useState(false);
  const [enApp, setEnApp] = useState(false);
  const [mensajeChat, setMensajeChat] = useState("");
  const [enviandoChat, setEnviandoChat] = useState(false);
  const [errorChat, setErrorChat] = useState<string | null>(null);

  const codigoRef = useRef<HTMLInputElement>(null);
  const cantRef = useRef<HTMLInputElement>(null);
  const avisoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abiertoEn = useRef(0);
  const previoRef = useRef(""); // valor del input en el evento anterior (para detectar pegado)
  // Lector que tipea sin Enter: hora del último carácter, si todo vino en ráfaga
  // y el timer que abre la cantidad cuando el input queda quieto.
  const ultimoCharEn = useRef(0);
  const rafagaRef = useRef(false);
  const rafagaTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inicioRafaga = useRef(0); // posición del input donde arrancó la ráfaga

  // Espejos para los listeners (se montan una vez y leen el valor actual).
  const selRef = useRef<string | null>(null);
  const chatRef = useRef(false);
  const nombreRef = useRef<string | null>(null);
  selRef.current = sel;
  chatRef.current = chatAbierto;
  nombreRef.current = pickerNombre;

  useEffect(() => {
    try {
      const n = localStorage.getItem("picker_nombre");
      if (n) {
        setPickerNombre(n);
        setRecientes(leerRecientes(n));
        setOcultos(leerOcultos(n));
      }
    } catch {
      /* sin storage */
    }
    setEnApp(!!puenteApp());
    setListo(true);
  }, []);

  // Dentro de la app Android (android/picker) le paso el nombre para que su
  // servicio escuche /api/picking/notificaciones de ese picker ("" = apagar).
  useEffect(() => {
    if (!listo) return;
    try {
      puenteApp()?.setPicker(pickerNombre ?? "");
    } catch {
      /* puente no disponible */
    }
  }, [listo, pickerNombre]);

  useEffect(() => {
    if (!listo || !pickerNombre) return;
    try {
      localStorage.setItem(
        RECIENTES_KEY,
        JSON.stringify({ dia: hoy(), picker: pickerNombre, items: recientes.slice(0, MAX_ITEMS) }),
      );
    } catch {
      /* sin storage */
    }
  }, [listo, pickerNombre, recientes]);

  // Ocultos: sólo se guardan los ids que siguen en el historial (no crece sin fin).
  useEffect(() => {
    if (!listo || !pickerNombre) return;
    try {
      const vivos = new Set(recientes.map((r) => r.id));
      const ids = [...ocultos].filter((id) => vivos.has(id) || recientes.length === 0);
      localStorage.setItem(OCULTOS_KEY, JSON.stringify({ picker: pickerNombre, ids }));
    } catch {
      /* sin storage */
    }
  }, [listo, pickerNombre, ocultos, recientes]);

  // Historial del servidor (últimos HISTORIAL_DIAS días): al entrar y cada vez
  // que la pantalla vuelve a estar visible. Se conservan los locales que el
  // servidor todavía no devuelve (recién enviados).
  useEffect(() => {
    if (!listo || !pickerNombre) return;
    let vivo = true;
    const cargar = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const res = await fetch(
          `/api/picking/eventos/historial?picker=${encodeURIComponent(pickerNombre)}&dias=${HISTORIAL_DIAS}`,
          { cache: "no-store" },
        );
        if (!res.ok || !vivo) return;
        const filas = (await res.json()) as {
          id: number;
          codigo: string;
          cantidad: number;
          estado: string;
          respuesta_nota: string | null;
          dia: string;
          hora: string;
        }[];
        if (!vivo || !Array.isArray(filas)) return;
        const delServidor: Reciente[] = filas.map((f) => ({
          id: f.id,
          codigo: f.codigo,
          cantidad: Number(f.cantidad),
          hora: f.hora,
          estado: f.estado,
          nota: f.respuesta_nota,
          dia: f.dia,
        }));
        const ids = new Set(delServidor.map((r) => r.id));
        setRecientes((prev) => {
          const sueltos = prev.filter((r) => !r.id || (!ids.has(r.id) && r.dia === hoy()));
          return [...sueltos, ...delServidor].slice(0, MAX_ITEMS);
        });
      } catch {
        /* sin red: queda la copia local */
      }
    };
    cargar();
    document.addEventListener("visibilitychange", cargar);
    return () => {
      vivo = false;
      document.removeEventListener("visibilitychange", cargar);
    };
  }, [listo, pickerNombre]);

  // Mientras haya enviados sin responder, consulto su estado cada 5 s (por PK,
  // los 20 más nuevos: el endpoint corta en 20).
  const idsPendientes = recientes
    .filter((r) => r.id && (!r.estado || r.estado === "pendiente"))
    .slice(0, 20)
    .map((r) => r.id)
    .join(",");
  useEffect(() => {
    if (!idsPendientes) return;
    let vivo = true;
    const consultar = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const res = await fetch(`/api/picking/eventos/estados?ids=${idsPendientes}`, { cache: "no-store" });
        if (!res.ok || !vivo) return;
        const filas = (await res.json()) as { id: number; estado: string; respuesta_nota: string | null }[];
        const porId = new Map(filas.map((f) => [f.id, f]));
        setRecientes((prev) => {
          let cambio = false;
          const next = prev.map((r) => {
            const f = r.id ? porId.get(r.id) : undefined;
            if (!f || (f.estado === r.estado && f.respuesta_nota === (r.nota ?? null))) return r;
            cambio = true;
            return { ...r, estado: f.estado, nota: f.respuesta_nota };
          });
          return cambio ? next : prev;
        });
      } catch {
        /* sin red: reintenta en el próximo tick */
      }
    };
    consultar();
    const t = setInterval(consultar, 5000);
    document.addEventListener("visibilitychange", consultar);
    return () => {
      vivo = false;
      clearInterval(t);
      document.removeEventListener("visibilitychange", consultar);
    };
  }, [idsPendientes]);

  const guardarNombre = () => {
    const n = nombreInput.trim();
    if (!n) return;
    try {
      localStorage.setItem("picker_nombre", n);
    } catch {
      /* sin storage */
    }
    setRecientes(leerRecientes(n));
    setOcultos(leerOcultos(n));
    setPickerNombre(n);
  };

  const cambiarNombre = () => {
    try {
      localStorage.removeItem("picker_nombre");
    } catch {
      /* sin storage */
    }
    setNombreInput("");
    setPickerNombre(null);
    setRecientes([]);
    setOcultos(new Set());
    setVerOcultos(false);
  };

  const ocultar = (ids: number[]) => {
    vibrar(20);
    setOcultos((prev) => new Set([...prev, ...ids]));
  };
  const mostrar = (id: number) => {
    vibrar(20);
    setOcultos((prev) => {
      const n = new Set(prev);
      n.delete(id);
      return n;
    });
  };

  const mostrarAviso = useCallback((tipo: "ok" | "error", texto: string, ms?: number) => {
    if (avisoTimer.current) clearTimeout(avisoTimer.current);
    setAviso({ tipo, texto });
    avisoTimer.current = setTimeout(() => setAviso(null), ms ?? (tipo === "ok" ? 2500 : 3500));
  }, []);

  // ── Atrás del PDA: cierra la capa de arriba ────────────────────────────────
  useEffect(() => {
    const onPop = () => {
      if (chatRef.current) setChatAbierto(false);
      else if (selRef.current) setSel(null);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // ── Foco permanente en el código ───────────────────────────────────────────
  const enfocar = useCallback(() => {
    if (selRef.current || chatRef.current || !nombreRef.current) return;
    const el = codigoRef.current;
    if (el && document.activeElement !== el) el.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (sel || chatAbierto || !pickerNombre) return;
    enfocar();
    const t = () => setTimeout(enfocar, 0);
    window.addEventListener("scroll", t, { passive: true });
    window.addEventListener("touchend", t, { passive: true });
    window.addEventListener("click", t);
    window.addEventListener("focus", t);
    window.addEventListener("pageshow", t);
    const onVis = () => {
      if (document.visibilityState === "visible") t();
    };
    document.addEventListener("visibilitychange", onVis);
    // Lector tipeando con el foco perdido: se enfoca el código en el keydown
    // (fase captura) y el carácter cae en el input.
    const onKey = () => {
      if (document.activeElement !== codigoRef.current) enfocar();
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pageshow", t);
      document.removeEventListener("visibilitychange", onVis);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", t);
      window.removeEventListener("touchend", t);
      window.removeEventListener("click", t);
      window.removeEventListener("focus", t);
    };
  }, [sel, chatAbierto, pickerNombre, enfocar]);

  const mostrarTeclado = useCallback(() => {
    if (teclado) return;
    setTeclado(true);
    // El teclado aparece recién al volver a enfocar con inputMode="text".
    requestAnimationFrame(() => {
      const el = codigoRef.current;
      if (!el) return;
      el.blur();
      el.focus({ preventScroll: true });
    });
  }, [teclado]);

  // ── Abrir / cerrar la carga de cantidad ────────────────────────────────────
  const abrir = useCallback((valor: string) => {
    const cod = valor.trim().toUpperCase();
    if (rafagaTimer.current) clearTimeout(rafagaTimer.current);
    rafagaTimer.current = null;
    if (!cod || selRef.current) return; // el Enter que sigue a un pegado no reabre
    selRef.current = cod;
    abiertoEn.current = Date.now();
    vibrar(40);
    setSel(cod);
    setCantidad("");
    setErrorCant(null);
    empujar({ pickerCant: true });
  }, []);

  const cerrar = useCallback(() => {
    if (window.history.state?.pickerCant) window.history.back();
    else setSel(null);
  }, []);

  // Al volver al código: input limpio, teclado oculto, foco listo para escanear.
  useEffect(() => {
    if (sel) {
      requestAnimationFrame(() => cantRef.current?.focus({ preventScroll: true }));
      return;
    }
    setCodigo("");
    previoRef.current = "";
    inicioRafaga.current = 0;
    rafagaRef.current = false;
    setTeclado(false);
    if (!chatRef.current) requestAnimationFrame(() => codigoRef.current?.focus({ preventScroll: true }));
  }, [sel]);

  // Lo que se abre con Enter/submit: si recién terminó una ráfaga de lector, sólo
  // lo que tipeó el lector (sin restos previos); si no, el campo entero.
  const abrirActual = () => {
    const valor = codigoRef.current?.value ?? "";
    const reciente = rafagaRef.current && Date.now() - ultimoCharEn.current < 500;
    const parte = reciente ? valor.slice(inicioRafaga.current) : "";
    abrir(parte.trim().length >= 3 ? parte : valor);
  };

  const onCodigoKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Enter (algunos lectores lo mandan con key "Unidentified" y keyCode 13) o
    // Tab como sufijo del lector: los dos abren la cantidad.
    const valor = e.currentTarget.value;
    if (e.key === "Enter" || e.keyCode === 13 || (e.key === "Tab" && valor.trim())) {
      e.preventDefault();
      abrirActual();
    } else if (e.key === "Escape") {
      setCodigo("");
      previoRef.current = "";
    }
  };

  const onCodigoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const nuevo = e.target.value;
    // Contra el valor del evento anterior (no el estado): un lector que tipea
    // rápido puede disparar varios eventos antes de re-renderizar.
    const previo = previoRef.current;
    const salto = nuevo.length - previo.length;
    const ahora = Date.now();
    const pausa = ahora - ultimoCharEn.current;
    const agrega = nuevo.startsWith(previo); // se sumó al final (lector / tipeo)
    // Arranque de ráfaga: campo vacío, o pausa larga con restos en el campo
    // (escaneo nuevo sobre lo que quedó). Sigue siendo ráfaga mientras cada
    // carácter llegue a < RAFAGA_MS del anterior (una persona no llega).
    if (previo === "" || (pausa > ARRANQUE_MS && agrega)) {
      rafagaRef.current = true;
      inicioRafaga.current = agrega ? previo.length : 0;
    } else {
      rafagaRef.current = rafagaRef.current && agrega && pausa < RAFAGA_MS;
    }
    ultimoCharEn.current = ahora;
    previoRef.current = nuevo;
    const desdeVacio = previo === "";
    setCodigo(nuevo);
    if (rafagaTimer.current) clearTimeout(rafagaTimer.current);
    rafagaTimer.current = null;
    // Lectores que "pegan" el código entero sin Enter. Con el teclado oculto
    // sólo puede venir del lector; con el teclado visible se exige además que
    // el campo estuviera vacío (una sugerencia del teclado reemplaza lo ya
    // tipeado, nunca llega a un campo vacío). Con restos en el campo se abre
    // sólo lo pegado.
    if (salto >= 4 && (!teclado || desdeVacio)) {
      abrir(agrega && !desdeVacio ? nuevo.slice(previo.length) : nuevo);
      return;
    }
    // Lectores que tipean sin sufijo: cuando la ráfaga se corta QUIETO_MS, se
    // abre lo que tipeó el lector (también con el teclado visible).
    const parte = nuevo.slice(inicioRafaga.current);
    if (rafagaRef.current && parte.trim().length >= 3) {
      rafagaTimer.current = setTimeout(() => {
        rafagaTimer.current = null;
        if (rafagaRef.current && codigoRef.current?.value === nuevo) abrir(parte);
      }, QUIETO_MS);
    }
  };

  useEffect(
    () => () => {
      if (rafagaTimer.current) clearTimeout(rafagaTimer.current);
    },
    [],
  );

  // Teclado numérico propio de la pantalla de cantidad.
  const tecla = (k: string) => {
    vibrar(12);
    setErrorCant(null);
    setCantidad((c) => {
      if (k === "⌫") return c.slice(0, -1);
      if (k === ",") return /[.,]/.test(c) ? c : (c || "0") + ",";
      if (c.length >= 9) return c;
      return c === "0" ? k : c + k;
    });
  };

  // ── Enviar pedido ──────────────────────────────────────────────────────────
  const enviar = async () => {
    if (!sel || enviando || !pickerNombre) return;
    const txt = cantidad.trim().replace(",", ".");
    // El Enter del lector puede caer en este input justo al abrirlo: se ignora.
    if (txt === "" && Date.now() - abiertoEn.current < 400) return;
    const n = txt === "" || (txt.match(/\./g)?.length ?? 0) > 1 ? NaN : Number(txt);
    if (!Number.isFinite(n) || n <= 0) {
      setErrorCant("Ingresá una cantidad");
      vibrar([80, 60, 80]);
      cantRef.current?.focus();
      return;
    }
    setEnviando(true);
    setErrorCant(null);
    try {
      const res = await fetch("/api/picking/eventos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ codigo: sel, cantidad: n, picker_nombre: pickerNombre }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(json?.error ?? "Error al enviar");
      }
      const creado = (await res.json().catch(() => null)) as { id?: number } | null;
      vibrar(40);
      const hora = new Date().toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
      setRecientes((prev) =>
        [{ id: creado?.id, codigo: sel, cantidad: n, hora, estado: "pendiente", dia: hoy() }, ...prev].slice(0, MAX_ITEMS),
      );
      mostrarAviso("ok", `✓ Pedido enviado ${sel} · ${fmtCant(n)}`);
      cerrar();
    } catch (e) {
      setErrorCant(e instanceof TypeError ? "Sin conexión" : e instanceof Error ? e.message : "Error al enviar");
      vibrar([80, 60, 80]);
      cantRef.current?.focus();
    } finally {
      setEnviando(false);
    }
  };

  // ── Consulta al depósito ───────────────────────────────────────────────────
  const abrirChat = () => {
    chatRef.current = true;
    cantRef.current?.blur();
    setErrorChat(null);
    setChatAbierto(true);
    empujar({ pickerChat: true });
  };

  const cerrarChat = useCallback(() => {
    if (window.history.state?.pickerChat) window.history.back();
    else setChatAbierto(false);
  }, []);

  // Al cerrar la consulta se vuelve a la cantidad del mismo código, enfocada.
  useEffect(() => {
    if (!chatAbierto && selRef.current)
      requestAnimationFrame(() => cantRef.current?.focus({ preventScroll: true }));
  }, [chatAbierto]);

  const enviarChat = async () => {
    if (!mensajeChat.trim() || !pickerNombre || enviandoChat) return;
    setEnviandoChat(true);
    setErrorChat(null);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          picker_nombre: pickerNombre,
          mensaje: sel ? `[${sel}] ${mensajeChat.trim()}` : mensajeChat.trim(),
        }),
      });
      if (!res.ok) throw new Error("No se pudo enviar la consulta");
      setMensajeChat("");
      vibrar(40);
      mostrarAviso("ok", "✓ Consulta enviada al depósito");
      cerrarChat();
    } catch (e) {
      setErrorChat(e instanceof TypeError ? "Sin conexión" : e instanceof Error ? e.message : "Error al enviar");
      vibrar([80, 60, 80]);
    } finally {
      setEnviandoChat(false);
    }
  };


  if (!listo) return <div className="min-h-[100dvh] bg-[#111111]" />;

  // Consulta al depósito (pantalla completa, se abre desde la cantidad).
  const consulta = chatAbierto ? (
        <div className="fixed inset-0 z-50 bg-[#111111] flex flex-col">
          <header className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800 bg-[#171717]">
            <MessageSquare className="h-5 w-5 text-emerald-400" />
            <div className="min-w-0">
              <h2 className="font-bold text-lg leading-tight">Consulta al depósito</h2>
              {sel && <p className="text-xs text-zinc-400 font-mono truncate">Código {sel}</p>}
            </div>
            <button type="button" onClick={cerrarChat} className="ml-auto p-1.5 text-zinc-400 active:text-yellow-400" title="Cerrar">
              <X className="h-6 w-6" />
            </button>
          </header>
          <div className="flex-1 flex flex-col gap-3 p-3">
            <textarea
              autoFocus
              value={mensajeChat}
              onChange={(e) => setMensajeChat(e.target.value)}
              placeholder="Escribí tu consulta…"
              className="flex-1 min-h-[8rem] rounded-lg bg-[#1f1f1f] border-2 border-zinc-700 focus:border-yellow-400 outline-none p-3 text-base text-white placeholder:text-zinc-600 resize-none"
            />
            {errorChat && (
              <div className="flex items-center gap-2 text-sm text-[#f85149] bg-[#f85149]/10 border border-[#f85149]/30 rounded px-3 py-2">
                <AlertCircle className="h-4 w-4 shrink-0" />
                {errorChat}
              </div>
            )}
            <button
              type="button"
              onClick={enviarChat}
              disabled={enviandoChat || !mensajeChat.trim()}
              className="w-full rounded-lg bg-yellow-400 active:bg-yellow-300 disabled:opacity-40 text-black font-bold text-lg py-4 flex items-center justify-center gap-2"
            >
              {enviandoChat ? <Loader2 className="h-5 w-5 animate-spin" /> : <Send className="h-5 w-5" />}
              Enviar
            </button>
          </div>
        </div>
  ) : null;

  // ════════════════════════════════════════════════════════════════════════════
  // Ingreso del nombre
  // ════════════════════════════════════════════════════════════════════════════
  if (!pickerNombre) {
    return (
      <div className="dark min-h-[100dvh] bg-[#111111] text-white flex flex-col items-center justify-center px-6">
        <div className="w-full max-w-sm space-y-6">
          <div className="text-center">
            <h1 className="text-2xl font-bold text-yellow-400 uppercase tracking-wide">Picking</h1>
            <p className="text-zinc-400 mt-2">¿Cómo te llamás?</p>
          </div>
          <input
            type="text"
            placeholder="Tu nombre"
            value={nombreInput}
            onChange={(e) => setNombreInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && guardarNombre()}
            autoFocus
            className="w-full rounded-lg bg-[#1f1f1f] border-2 border-zinc-700 focus:border-yellow-400 outline-none px-4 py-4 text-lg text-white placeholder:text-zinc-600"
          />
          <button
            type="button"
            onClick={guardarNombre}
            disabled={!nombreInput.trim()}
            className="w-full rounded-lg bg-yellow-400 active:bg-yellow-300 disabled:opacity-40 text-black font-bold text-lg py-4"
          >
            Entrar
          </button>
          {!enApp && <BotonDescargarApp />}
        </div>
      </div>
    );
  }

  // ════════════════════════════════════════════════════════════════════════════
  // Carga de cantidad
  // ════════════════════════════════════════════════════════════════════════════
  if (sel) {
    return (
      <div className="dark min-h-[100dvh] bg-[#111111] text-white flex flex-col">
        <header className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800 bg-[#171717]">
          <button
            type="button"
            onClick={cerrar}
            className="flex items-center gap-1 text-sm text-zinc-400 active:text-yellow-400 py-1 pr-2"
          >
            <ArrowLeft className="h-4 w-4" />
            Volver
          </button>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={abrirChat}
            className="ml-auto shrink-0 flex items-center gap-2 rounded-lg border-2 border-emerald-500/70 bg-emerald-500/10 active:bg-emerald-500/25 text-emerald-300 font-semibold text-sm px-3 py-2"
          >
            <MessageSquare className="h-4 w-4" />
            Consulta al depósito
          </button>
        </header>

        <form
          className="flex-1 flex flex-col gap-3 px-4 pt-3 pb-4"
          onSubmit={(e) => {
            e.preventDefault();
            enviar();
          }}
        >
          <div>
            <div className="text-xs text-zinc-500 uppercase tracking-wider">Código</div>
            <div className="text-3xl font-bold tabular-nums text-zinc-100 break-all">{sel}</div>
          </div>

          <input
            ref={cantRef}
            autoFocus
            type="text"
            inputMode="none"
            enterKeyHint="send"
            autoComplete="off"
            placeholder="Cantidad"
            value={cantidad}
            onChange={(e) => setCantidad(e.target.value.replace(/[^\d.,]/g, ""))}
            onKeyDown={(e) => {
              if (e.key === "Escape") cerrar();
            }}
            className="w-full rounded-lg bg-[#1f1f1f] border-2 border-yellow-400/70 focus:border-yellow-400 outline-none px-4 py-4 text-4xl font-bold text-center tabular-nums text-white placeholder:text-zinc-600"
          />

          {errorCant && (
            <div className="flex items-center gap-2 text-sm text-[#f85149] bg-[#f85149]/10 border border-[#f85149]/30 rounded px-3 py-2">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {errorCant}
            </div>
          )}

          <div className="grid grid-cols-3 gap-2">
            {TECLAS.map((k) => (
              <button
                key={k}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => tecla(k)}
                className={`rounded-lg border-2 py-3 text-3xl font-bold tabular-nums select-none ${
                  k === "⌫"
                    ? "border-zinc-700 bg-[#1f1f1f] text-zinc-300 active:bg-zinc-700"
                    : "border-zinc-700 bg-[#1f1f1f] text-white active:bg-yellow-400 active:text-black"
                }`}
              >
                {k}
              </button>
            ))}
          </div>

          <button
            type="submit"
            disabled={enviando}
            className="w-full rounded-lg bg-yellow-400 active:bg-yellow-300 disabled:opacity-60 text-black font-bold text-lg py-4 flex items-center justify-center gap-2"
          >
            {enviando ? <Loader2 className="h-5 w-5 animate-spin" /> : <Check className="h-5 w-5" />}
            Enviar pedido
          </button>
        </form>

        {consulta}
      </div>
    );
  }

  // ════════════════════════════════════════════════════════════════════════════
  // Vista principal: escaneo del código
  // ════════════════════════════════════════════════════════════════════════════
  // Historial agrupado por día (ya viene más nuevo primero).
  const rojosVisibles = recientes.filter((r) => r.estado === "s/e" && r.id && !ocultos.has(r.id));
  const cantOcultos = recientes.filter((r) => r.id && ocultos.has(r.id)).length;
  const visibles = verOcultos ? recientes : recientes.filter((r) => !(r.id && ocultos.has(r.id)));
  const porDia: { dia: string; items: Reciente[] }[] = [];
  for (const r of visibles) {
    const d = r.dia ?? hoy();
    const ult = porDia[porDia.length - 1];
    if (ult && ult.dia === d) ult.items.push(r);
    else porDia.push({ dia: d, items: [r] });
  }

  // Cabecera fija (input) y la lista con scroll propio: el historial se
  // recorre sin mover el campo de escaneo.
  return (
    <div className="dark h-[100dvh] overflow-hidden bg-[#111111] text-white flex flex-col">
      <div className="shrink-0 z-10 bg-[#111111] border-b border-zinc-800">
        <header className="flex items-center gap-2 px-3 py-2">
          <div className="min-w-0 flex-1">
            <h1 className="text-yellow-400 font-bold text-lg uppercase tracking-wide leading-tight">Picking</h1>
            <p className="text-xs text-zinc-400 truncate">{pickerNombre}</p>
          </div>
        </header>

        <form
          className="flex items-center gap-2 px-3 pb-2"
          onSubmit={(e) => {
            e.preventDefault();
            abrirActual();
          }}
        >
          <div className="relative flex-1">
            <ScanLine className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-zinc-500 pointer-events-none" />
            <input
              ref={codigoRef}
              autoFocus
              type="text"
              inputMode={teclado ? "text" : "none"}
              enterKeyHint="next"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="characters"
              spellCheck={false}
              placeholder="Escaneá o escribí el código"
              value={codigo}
              onChange={onCodigoChange}
              onKeyDown={onCodigoKey}
              onPointerDown={mostrarTeclado}
              onBlur={() => setTimeout(enfocar, 60)}
              className="w-full rounded-lg bg-[#1f1f1f] border-2 border-zinc-700 focus:border-yellow-400 outline-none pl-10 pr-3 py-3 text-lg font-mono uppercase text-white placeholder:normal-case placeholder:font-sans placeholder:text-zinc-600"
            />
          </div>
          {codigo.trim() ? (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => abrir(codigo)}
              className="p-3 rounded-lg border-2 border-yellow-400 bg-yellow-400 text-black"
              title="Cargar cantidad"
            >
              <ArrowRight className="h-5 w-5" />
            </button>
          ) : (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => (teclado ? setTeclado(false) : mostrarTeclado())}
              className={`p-3 rounded-lg border-2 ${teclado ? "border-yellow-400 text-yellow-400" : "border-zinc-700 text-zinc-400"}`}
              title={teclado ? "Ocultar teclado" : "Mostrar teclado"}
            >
              <Keyboard className="h-5 w-5" />
            </button>
          )}
        </form>

        {aviso && (
          <div
            className={`mx-3 mb-2 rounded px-3 py-2 text-sm font-medium ${
              aviso.tipo === "ok"
                ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/40"
                : "bg-[#f85149]/15 text-[#f85149] border border-[#f85149]/40"
            }`}
          >
            {aviso.texto}
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
        {recientes.length === 0 ? (
          <div className="py-12 text-center text-zinc-500">
            <ScanLine className="h-10 w-10 mx-auto mb-3 text-zinc-700" />
            Escaneá el código del producto que necesitás.
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 px-3 pt-2 pb-2">
              <div className="text-xs text-zinc-500 uppercase tracking-wider mr-auto">
                Historial · {HISTORIAL_DIAS} días
              </div>
              {rojosVisibles.length > 0 && (
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => ocultar(rojosVisibles.map((r) => r.id as number))}
                  className="flex items-center gap-1.5 rounded-lg border-2 border-red-500/70 bg-red-500/10 active:bg-red-500/25 text-red-300 font-semibold text-xs px-2.5 py-1.5"
                >
                  <EyeOff className="h-3.5 w-3.5" />
                  Ocultar rojos ({rojosVisibles.length})
                </button>
              )}
              {cantOcultos > 0 && (
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setVerOcultos((v) => !v)}
                  className={`flex items-center gap-1.5 rounded-lg border-2 font-semibold text-xs px-2.5 py-1.5 ${
                    verOcultos
                      ? "border-yellow-400 text-yellow-400 bg-yellow-400/10"
                      : "border-zinc-700 text-zinc-400 active:bg-zinc-800"
                  }`}
                >
                  <Eye className="h-3.5 w-3.5" />
                  {verOcultos ? "Esconder" : "Ver"} ocultos ({cantOcultos})
                </button>
              )}
            </div>

            {porDia.length === 0 && (
              <div className="py-8 text-center text-sm text-zinc-500">Todo oculto. Tocá “Ver ocultos” para verlos.</div>
            )}

            {porDia.map((g) => (
              <section key={g.dia} className="mb-3">
                {/* Separador de día: barra amarilla fija arriba mientras se recorre ese día */}
                <div className="sticky top-0 z-[1] bg-yellow-400 text-black border-y-4 border-black px-3 py-1.5 flex items-center gap-2 shadow-[0_4px_8px_rgba(0,0,0,0.6)]">
                  <span className="font-extrabold uppercase tracking-wide text-sm">{etiquetaDia(g.dia)}</span>
                  <span className="ml-auto text-xs font-bold tabular-nums">{g.items.length}</span>
                </div>
                <ul className="divide-y divide-zinc-800/70 px-3 pt-1">
                  {g.items.map((r, i) => {
                    // verde = con existencia (pedido), rojo = sin existencia, gris = esperando respuesta
                    const ok = r.estado === "pedido";
                    const sinEx = r.estado === "s/e";
                    const oculto = !!r.id && ocultos.has(r.id);
                    return (
                      <li
                        key={`${r.id ?? r.codigo}-${r.hora}-${i}`}
                        className={`py-2 px-2 -mx-2 rounded ${
                          ok ? "bg-emerald-950/60" : sinEx ? "bg-red-950/60" : ""
                        } ${oculto ? "opacity-40" : ""}`}
                      >
                        <div className="flex items-center gap-3">
                          {ok ? (
                            <Check className="h-4 w-4 text-emerald-400 shrink-0" />
                          ) : sinEx ? (
                            <X className="h-4 w-4 text-red-400 shrink-0" />
                          ) : (
                            <Loader2 className="h-4 w-4 text-zinc-500 shrink-0 animate-spin" />
                          )}
                          <span
                            className={`font-mono font-semibold break-all flex-1 ${
                              ok ? "text-emerald-200" : sinEx ? "text-red-200" : "text-zinc-100"
                            }`}
                          >
                            {r.codigo}
                          </span>
                          <span
                            className={`tabular-nums font-bold ${
                              ok ? "text-emerald-300" : sinEx ? "text-red-300" : "text-zinc-300"
                            }`}
                          >
                            {fmtCant(r.cantidad)}
                          </span>
                          <span className="text-xs text-zinc-500 tabular-nums">{r.hora}</span>
                          {sinEx && r.id && (
                            <button
                              type="button"
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() => (oculto ? mostrar(r.id as number) : ocultar([r.id as number]))}
                              className="-my-1 -mr-1 p-2 rounded text-red-300/80 active:bg-red-500/25"
                              title={oculto ? "Volver a mostrar" : "Ocultar"}
                            >
                              {oculto ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                            </button>
                          )}
                        </div>
                        {r.nota && (
                          <div className={`text-xs mt-0.5 pl-7 ${sinEx ? "text-red-300/80" : "text-emerald-300/80"}`}>
                            {r.nota}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </>
        )}

      <div className="px-3 pt-2 pb-4 space-y-3">
        <div className="rounded-lg bg-[#171717] border border-zinc-800 p-3 space-y-1.5">
          <p className="text-xs text-zinc-500 font-semibold uppercase tracking-wider">Notificaciones</p>
          {enApp ? (
            <p className="text-sm text-emerald-400">Activas en esta app (con sonido aunque esté cerrada).</p>
          ) : (
            <>
              <p className="text-sm text-zinc-400">Instalá la app EverWear Picker para recibir las respuestas.</p>
              <BotonDescargarApp />
            </>
          )}
        </div>
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={cambiarNombre}
          className="w-full text-xs text-zinc-500 active:text-zinc-300 underline"
        >
          Cambiar nombre
        </button>
      </div>
      </div>
    </div>
  );
}

// Descarga del APK (sólo se muestra fuera de la app: el WebView no maneja descargas).
function BotonDescargarApp() {
  return (
    <a
      href="/apk/everwear-picker.apk"
      download="everwear-picker.apk"
      type="application/vnd.android.package-archive"
      onMouseDown={(e) => e.preventDefault()}
      className="flex w-full items-center justify-center gap-2 rounded-lg border-2 border-yellow-400 text-yellow-400 active:bg-yellow-400/10 font-bold py-3"
    >
      <Download className="h-5 w-5" />
      Descargar app
    </a>
  );
}
