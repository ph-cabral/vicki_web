"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Check,
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
//     Cantidad: un único input enfocado con el teclado numérico ABIERTO
//     (VirtualKeyboard API, virtualkeyboardpolicy="manual"); Enter o
//     "Enviar pedido" y vuelve al código limpio y enfocado.
//   · "Consulta al depósito" está ARRIBA de la pantalla de cantidad (no en la
//     de escaneo): la consulta sale con el código escaneado adelante.
// El atrás del PDA cierra la capa de arriba (consulta → cantidad → código).
//
// Datos: POST /api/picking/eventos (pedido) y POST /api/chat (consulta).
// ──────────────────────────────────────────────────────────────────────────────

interface Reciente {
  codigo: string;
  cantidad: number;
  hora: string;
}

const fmtCant = (n: number) => n.toLocaleString("es-AR", { maximumFractionDigits: 3 });

function vibrar(ms: number | number[]) {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* sin vibración */
  }
}

// Teclado en pantalla por API (Chrome Android): el input de cantidad lleva
// virtualkeyboardpolicy="manual" y se le pide el teclado al enfocarlo, porque un
// focus() disparado por el escaneo (no por un toque) no lo abre solo.
const mostrarTecladoVirtual = () => {
  try {
    (navigator as Navigator & { virtualKeyboard?: { show: () => void } }).virtualKeyboard?.show();
  } catch {
    /* sin API: queda el comportamiento normal del navegador */
  }
};

const empujar = (estado: Record<string, boolean>) => {
  try {
    window.history.pushState(estado, "");
  } catch {
    /* nada */
  }
};

export default function PickerPage() {
  const [listo, setListo] = useState(false); // ya se leyó localStorage
  const [pickerNombre, setPickerNombre] = useState<string | null>(null);
  const [nombreInput, setNombreInput] = useState("");

  const [codigo, setCodigo] = useState("");
  const [teclado, setTeclado] = useState(false);
  const [aviso, setAviso] = useState<{ tipo: "ok" | "error"; texto: string } | null>(null);
  const [recientes, setRecientes] = useState<Reciente[]>([]);

  // Carga de cantidad
  const [sel, setSel] = useState<string | null>(null); // código escaneado
  const [cantidad, setCantidad] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [errorCant, setErrorCant] = useState<string | null>(null);

  // Consulta al depósito
  const [chatAbierto, setChatAbierto] = useState(false);
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
      if (n) setPickerNombre(n);
    } catch {
      /* sin storage */
    }
    setListo(true);
  }, []);

  const guardarNombre = () => {
    const n = nombreInput.trim();
    if (!n) return;
    try {
      localStorage.setItem("picker_nombre", n);
    } catch {
      /* sin storage */
    }
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
    return () => {
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
      requestAnimationFrame(() => {
        cantRef.current?.focus();
        mostrarTecladoVirtual();
      });
      return;
    }
    setCodigo("");
    previoRef.current = "";
    setTeclado(false);
    if (!chatRef.current) requestAnimationFrame(() => codigoRef.current?.focus({ preventScroll: true }));
  }, [sel]);

  const onCodigoKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Enter (algunos lectores lo mandan con key "Unidentified" y keyCode 13) o
    // Tab como sufijo del lector: los dos abren la cantidad.
    const valor = e.currentTarget.value;
    if (e.key === "Enter" || e.keyCode === 13 || (e.key === "Tab" && valor.trim())) {
      e.preventDefault();
      abrir(valor);
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
    // Ráfaga: arrancó desde vacío y cada carácter llegó a < 60 ms del anterior
    // (velocidad de lector; una persona tipeando nunca llega).
    rafagaRef.current = previoRef.current === "" ? true : rafagaRef.current && ahora - ultimoCharEn.current < 60;
    ultimoCharEn.current = ahora;
    previoRef.current = nuevo;
    const desdeVacio = previo === "";
    setCodigo(nuevo);
    if (rafagaTimer.current) clearTimeout(rafagaTimer.current);
    rafagaTimer.current = null;
    // Lectores que "pegan" el código entero sin Enter. Con el teclado oculto
    // sólo puede venir del lector; con el teclado visible se exige además que
    // el campo estuviera vacío (una sugerencia del teclado reemplaza lo ya
    // tipeado, nunca llega a un campo vacío). Así escanear abre la cantidad
    // aunque el picker haya tocado el campo antes.
    if (salto >= 4 && (!teclado || desdeVacio)) {
      abrir(nuevo);
      return;
    }
    // Lectores que tipean sin sufijo: cuando la ráfaga se corta 150 ms, se abre
    // (también con el teclado visible: tocando la pantalla nadie baja de 60 ms).
    if (rafagaRef.current && nuevo.trim().length >= 3) {
      rafagaTimer.current = setTimeout(() => {
        rafagaTimer.current = null;
        if (rafagaRef.current && codigoRef.current?.value === nuevo) abrir(nuevo);
      }, 150);
    }
  };

  useEffect(
    () => () => {
      if (rafagaTimer.current) clearTimeout(rafagaTimer.current);
    },
    [],
  );

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
      vibrar(40);
      const hora = new Date().toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
      setRecientes((prev) => [{ codigo: sel, cantidad: n, hora }, ...prev].slice(0, 8));
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
      requestAnimationFrame(() => {
        cantRef.current?.focus();
        mostrarTecladoVirtual();
      });
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

  const topic = `everwear-picking-${pickerNombre?.toLowerCase().replace(/\s+/g, "-")}`;

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
          className="flex-1 flex flex-col gap-4 px-4 pt-4"
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
            inputMode="numeric"
            enterKeyHint="send"
            autoComplete="off"
            {...({ virtualkeyboardpolicy: "manual" } as Record<string, string>)}
            onFocus={mostrarTecladoVirtual}
            onClick={mostrarTecladoVirtual}
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
  return (
    <div className="dark min-h-[100dvh] bg-[#111111] text-white flex flex-col">
      <div className="sticky top-0 z-10 bg-[#111111] border-b border-zinc-800">
        <header className="flex items-center gap-2 px-3 py-2">
          <div className="min-w-0 flex-1">
            <h1 className="text-yellow-400 font-bold text-lg uppercase tracking-wide leading-tight">Picking</h1>
            <p className="text-xs text-zinc-400 truncate">{pickerNombre}</p>
          </div>
        </header>

        <div className="flex items-center gap-2 px-3 pb-2">
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
        </div>

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

      <div className="flex-1 px-3 py-3">
        {recientes.length === 0 ? (
          <div className="py-12 text-center text-zinc-500">
            <ScanLine className="h-10 w-10 mx-auto mb-3 text-zinc-700" />
            Escaneá el código del producto que necesitás.
          </div>
        ) : (
          <>
            <div className="text-xs text-zinc-500 uppercase tracking-wider mb-1">Enviados recién</div>
            <ul className="divide-y divide-zinc-800/70">
              {recientes.map((r, i) => (
                <li key={`${r.codigo}-${r.hora}-${i}`} className="py-2 flex items-center gap-3">
                  <Check className="h-4 w-4 text-emerald-400 shrink-0" />
                  <span className="font-mono font-semibold text-zinc-100 break-all flex-1">{r.codigo}</span>
                  <span className="tabular-nums font-bold text-emerald-300">{fmtCant(r.cantidad)}</span>
                  <span className="text-xs text-zinc-500 tabular-nums">{r.hora}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <div className="px-3 pb-4 space-y-3">
        <div className="rounded-lg bg-[#171717] border border-zinc-800 p-3 space-y-1.5">
          <p className="text-xs text-zinc-500 font-semibold uppercase tracking-wider">Notificaciones</p>
          <p className="text-sm text-zinc-400">
            Instalá{" "}
            <a
              href="https://ntfy.sh"
              target="_blank"
              rel="noopener noreferrer"
              onMouseDown={(e) => e.preventDefault()}
              className="text-yellow-400 underline"
            >
              ntfy
            </a>{" "}
            y suscribite a:
          </p>
          <div className="rounded bg-[#1f1f1f] px-3 py-1.5 font-mono text-sm text-emerald-400 break-all">{topic}</div>
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
  );
}
