"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  Flag,
  Keyboard,
  Loader2,
  Lock,
  Play,
  RefreshCw,
  ScanLine,
  User,
} from "lucide-react";
import { InicioButton } from "@/components/ui/InicioButton";

// ──────────────────────────────────────────────────────────────────────────────
// Mostradores → Control — vista para PDA.
//
// Vista principal: los PATRONES mandados a control desde Administrar. Cada
// usuario TOMA uno (doble toque) y trabaja sólo ese: de a uno por usuario —
// para tomar otro tiene que finalizar el activo — y un patrón tomado por otro
// usuario aparece bloqueado ("Lo tiene X"). La regla la garantiza la base
// (índice único parcial en mostrador_control."tomadoPor").
//
// Conteo del patrón activo: un input queda siempre enfocado:
//   · escaneo  → el lector "tipea" el código + Enter; si coincide con un código
//                de artículo o de barras abre directo la carga de cantidad.
//   · escrito  → filtra la lista de abajo (código, barras o detalle, por
//                palabras); se toca el artículo para abrir la carga.
// Carga de cantidad: un solo input numérico enfocado (teclado numérico), Enter
// o "Guardar" y vuelve a la lista. Contar de nuevo un artículo reemplaza el
// valor. Conteo ciego: no se muestra el stock de sistema.
// El teclado en pantalla arranca OCULTO (inputMode="none") para que no tape la
// lista mientras se escanea; tocar el input o el botón del teclado lo muestra.
//
// Finalizar (sin botón): deslizar hacia la IZQUIERDA sobre el conteo trae desde
// la derecha una tarjeta "Finalizar" que sigue al dedo. Si se suelta pasada la
// mitad (o con envión) queda la pantalla "¿Finalizamos?" con el botón
// "Finalizar", que es la confirmación. Para salir sin finalizar: deslizar
// hacia la DERECHA o el atrás del PDA. El arrastre mueve el DOM directo (sin
// re-render de la lista) para que vaya fluido en el PDA.
//
// Datos: GET/POST /api/mostradores/conteo, POST /api/mostradores/tomar,
// POST /api/mostradores/finalizar.
// ──────────────────────────────────────────────────────────────────────────────

interface Barra {
  codigo: string;
  cant: number;
  envase: string;
}

interface Articulo {
  controlId: number;
  patron: string;
  cod: string;
  detalle: string;
  barras: Barra[];
  contado: number | null;
  contadoAt: string | null;
}

interface Patron {
  controlId: number;
  codigo: string;
  detalle: string;
  linea: string;
  total: number;
  contados: number;
  tomadoPorId: number | null;
  tomadoPor: string;
  tomadoAt: string | null;
}

interface ResultadoFin {
  patron?: string;
  anulado?: boolean; // patrón sin artículos para contar: se quitó de control
  contados?: number;
  sinContarConStock?: number;
  conDiferencia?: number;
  error?: string;
}

interface Seleccion {
  art: Articulo;
  barra: Barra | null; // código escaneado, si vino por lector
}

interface Arrastre {
  x: number;
  y: number;
  t: number;
  eje: "h" | "v" | null;
  dx: number;
  modo: "abrir" | "cerrar";
}

const MAX_FILAS = 120;
const ANIM_MS = 200;

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .trim();

const fmtCant = (n: number) => n.toLocaleString("es-AR", { maximumFractionDigits: 3 });

const claveArt = (a: Pick<Articulo, "controlId" | "cod">) => `${a.controlId}|${a.cod}`;

function vibrar(ms: number | number[]) {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* sin vibración */
  }
}

function BarraAvance({ valor, total }: { valor: number; total: number }) {
  const pct = total > 0 ? Math.min(100, (valor * 100) / total) : 0;
  return (
    <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden">
      <div
        className={`h-full rounded-full ${valor >= total && total > 0 ? "bg-emerald-400" : "bg-yellow-400"}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export default function ControlStockPage() {
  const [patrones, setPatrones] = useState<Patron[]>([]);
  const [activoId, setActivoId] = useState<number | null>(null);
  const [articulos, setArticulos] = useState<Articulo[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [enConteo, setEnConteo] = useState(false); // vista de conteo del patrón activo
  const [tomando, setTomando] = useState<number | null>(null);
  const [confirmarTomar, setConfirmarTomar] = useState<number | null>(null);
  const tomarTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [busqueda, setBusqueda] = useState("");
  const [teclado, setTeclado] = useState(false); // teclado en pantalla del buscador
  const [aviso, setAviso] = useState<{ tipo: "ok" | "error"; texto: string } | null>(null);

  const [sel, setSel] = useState<Seleccion | null>(null);
  const [cantidad, setCantidad] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [errorCant, setErrorCant] = useState<string | null>(null);

  // Finalizar control (tarjeta deslizable)
  const [fin, setFin] = useState(false);
  const [finalizando, setFinalizando] = useState(false);
  const [errorFin, setErrorFin] = useState<string | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const arrastre = useRef<Arrastre | null>(null);
  const animando = useRef(false);
  const limpiarOverlay = useRef(false);
  const ignorarPop = useRef(0);

  const buscarRef = useRef<HTMLInputElement>(null);
  const cantRef = useRef<HTMLInputElement>(null);
  const selRef = useRef<Seleccion | null>(null);
  selRef.current = sel;
  const finRef = useRef(false);
  finRef.current = fin;
  const conteoRef = useRef(false);
  conteoRef.current = enConteo;
  const finalizandoRef = useRef(false);
  finalizandoRef.current = finalizando;
  const avisoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activo = useMemo(() => patrones.find((p) => p.controlId === activoId) ?? null, [patrones, activoId]);

  // ── Datos ──────────────────────────────────────────────────────────────────
  const cargar = useCallback(async () => {
    setCargando(true);
    setError(null);
    try {
      const res = await fetch("/api/mostradores/conteo", { cache: "no-store" });
      const json = (await res.json().catch(() => null)) as
        | { patrones?: Patron[]; activoId?: number | null; articulos?: Articulo[]; error?: string }
        | null;
      if (!res.ok || !json) throw new Error(json?.error ?? `HTTP ${res.status}`);
      setPatrones(json.patrones ?? []);
      setActivoId(json.activoId ?? null);
      setArticulos(json.articulos ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo cargar");
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => {
    cargar();
    const onVis = () => {
      if (document.visibilityState === "visible" && !selRef.current && !finRef.current) cargar();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [cargar]);

  // Si el patrón activo dejó de estarlo (se finalizó en otro lado), vuelve a la lista.
  useEffect(() => {
    if (!cargando && enConteo && !activo) {
      setEnConteo(false);
      setFin(false);
    }
  }, [cargando, enConteo, activo]);

  // Código escaneado (artículo o cualquiera de sus barras) → artículo.
  const porCodigo = useMemo(() => {
    const m = new Map<string, { art: Articulo; barra: Barra | null }>();
    for (const a of articulos) {
      m.set(norm(a.cod), { art: a, barra: null });
      for (const b of a.barras) {
        const k = norm(b.codigo);
        if (!m.has(k) || b.cant > 1) m.set(k, { art: a, barra: b.cant > 1 ? b : null });
      }
    }
    return m;
  }, [articulos]);

  const indice = useMemo(
    () => articulos.map((a) => ({ a, txt: norm(`${a.cod} ${a.detalle} ${a.barras.map((b) => b.codigo).join(" ")}`) })),
    [articulos],
  );

  const filtrados = useMemo(() => {
    const tokens = norm(busqueda).split(/\s+/).filter(Boolean);
    const lista = tokens.length ? indice.filter(({ txt }) => tokens.every((t) => txt.includes(t))).map(({ a }) => a) : articulos;
    // Sin contar primero: a medida que se cuentan bajan al final.
    return [...lista].sort((x, y) => Number(x.contado !== null) - Number(y.contado !== null));
  }, [busqueda, indice, articulos]);

  const total = articulos.length;
  const contados = useMemo(() => articulos.filter((a) => a.contado !== null).length, [articulos]);

  // ── Avisos ─────────────────────────────────────────────────────────────────
  const mostrarAviso = useCallback((tipo: "ok" | "error", texto: string, ms?: number) => {
    if (avisoTimer.current) clearTimeout(avisoTimer.current);
    setAviso({ tipo, texto });
    avisoTimer.current = setTimeout(() => setAviso(null), ms ?? (tipo === "ok" ? 2000 : 3500));
  }, []);

  // ── Navegación (el atrás del PDA cierra la capa de arriba) ─────────────────
  const empujar = (estado: Record<string, boolean>) => {
    try {
      window.history.pushState(estado, "");
    } catch {
      /* nada */
    }
  };

  useEffect(() => {
    const onPop = () => {
      if (ignorarPop.current > 0) {
        ignorarPop.current -= 1;
        return;
      }
      if (selRef.current) setSel(null);
      else if (finRef.current) setFin(false);
      else if (conteoRef.current) setEnConteo(false);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const abrirConteo = useCallback(() => {
    setEnConteo(true);
    empujar({ mostradorConteo: true });
  }, []);

  const cerrarConteo = useCallback(() => {
    if (window.history.state?.mostradorConteo) window.history.back();
    else setEnConteo(false);
  }, []);

  // ── Tomar un patrón (doble toque) ──────────────────────────────────────────
  const tomar = async (p: Patron) => {
    if (tomando !== null) return;
    if (activo) {
      vibrar([80, 60, 80]);
      mostrarAviso("error", `Finalizá el patrón ${activo.codigo} antes de tomar otro`);
      return;
    }
    if (confirmarTomar !== p.controlId) {
      setConfirmarTomar(p.controlId);
      vibrar(30);
      if (tomarTimer.current) clearTimeout(tomarTimer.current);
      tomarTimer.current = setTimeout(() => setConfirmarTomar(null), 4000);
      return;
    }
    if (tomarTimer.current) clearTimeout(tomarTimer.current);
    setConfirmarTomar(null);
    setTomando(p.controlId);
    try {
      const res = await fetch("/api/mostradores/tomar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ controlId: p.controlId }),
      });
      const json = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);
      vibrar(40);
      await cargar();
      abrirConteo();
    } catch (e) {
      vibrar([80, 60, 80]);
      mostrarAviso("error", e instanceof Error ? e.message : "No se pudo tomar el patrón", 4500);
      cargar();
    } finally {
      setTomando(null);
    }
  };

  // ── Foco permanente en el buscador (sólo en el conteo) ─────────────────────
  const enfocar = useCallback(() => {
    if (selRef.current || finRef.current || !conteoRef.current) return;
    const el = buscarRef.current;
    if (el && document.activeElement !== el) el.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (sel || fin || !enConteo) return;
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
  }, [sel, fin, enConteo, enfocar]);

  const mostrarTeclado = useCallback(() => {
    if (teclado) return;
    setTeclado(true);
    // El teclado aparece recién al volver a enfocar con inputMode="text".
    requestAnimationFrame(() => {
      const el = buscarRef.current;
      if (!el) return;
      el.blur();
      el.focus({ preventScroll: true });
    });
  }, [teclado]);

  // ── Abrir / cerrar la carga de cantidad ────────────────────────────────────
  const abrir = useCallback((art: Articulo, barra: Barra | null) => {
    setSel({ art, barra });
    setCantidad("");
    setErrorCant(null);
    empujar({ mostradorCant: true });
  }, []);

  const cerrar = useCallback(() => {
    if (window.history.state?.mostradorCant) window.history.back();
    else setSel(null);
  }, []);

  // Al volver a la lista: buscador limpio, teclado oculto, foco listo para escanear.
  useEffect(() => {
    if (sel) {
      requestAnimationFrame(() => cantRef.current?.focus());
      return;
    }
    setBusqueda("");
    setTeclado(false);
    if (conteoRef.current && !finRef.current) {
      requestAnimationFrame(() => buscarRef.current?.focus({ preventScroll: true }));
    }
  }, [sel, enConteo]);

  // ── Finalizar: tarjeta que entra deslizando ────────────────────────────────
  const abrirFin = useCallback(() => {
    setFin(true);
    setErrorFin(null);
    buscarRef.current?.blur();
    vibrar(30);
    empujar({ mostradorFin: true });
  }, []);

  const cerrarFin = useCallback(() => {
    if (window.history.state?.mostradorFin) window.history.back();
    else setFin(false);
  }, []);

  // Al terminar la animación del arrastre, la posición final la toma la clase;
  // recién ahí se sacan los estilos en línea (si no, parpadea).
  useLayoutEffect(() => {
    if (!limpiarOverlay.current) return;
    limpiarOverlay.current = false;
    const el = overlayRef.current;
    if (el) {
      el.style.transition = "";
      el.style.transform = "";
    }
  }, [fin]);

  // Al volver de la tarjeta: foco listo para escanear.
  useEffect(() => {
    if (fin || !conteoRef.current) return;
    requestAnimationFrame(() => buscarRef.current?.focus({ preventScroll: true }));
  }, [fin]);

  const vistaConteo = enConteo && !!activo && !sel;

  useEffect(() => {
    if (!vistaConteo) return;
    const ancho = () => window.innerWidth || 360;

    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1 || animando.current || finalizandoRef.current) {
        arrastre.current = null;
        return;
      }
      const t = e.touches[0];
      arrastre.current = {
        x: t.clientX,
        y: t.clientY,
        t: performance.now(),
        eje: null,
        dx: 0,
        modo: finRef.current ? "cerrar" : "abrir",
      };
    };

    const onMove = (e: TouchEvent) => {
      const d = arrastre.current;
      if (!d) return;
      const t = e.touches[0];
      const dx = t.clientX - d.x;
      const dy = t.clientY - d.y;
      if (d.eje === null) {
        if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
        const horizontal = Math.abs(dx) > Math.abs(dy) * 1.2;
        const sentido = d.modo === "abrir" ? dx < 0 : dx > 0;
        d.eje = horizontal && sentido ? "h" : "v";
        if (d.eje === "h" && overlayRef.current) overlayRef.current.style.transition = "none";
      }
      if (d.eje !== "h") return;
      if (e.cancelable) e.preventDefault();
      d.dx = dx;
      const el = overlayRef.current;
      if (!el) return;
      const w = ancho();
      const x = d.modo === "abrir" ? Math.max(0, w + dx) : Math.max(0, dx);
      el.style.transform = `translate3d(${x}px,0,0)`;
    };

    const onEnd = () => {
      const d = arrastre.current;
      arrastre.current = null;
      if (!d || d.eje !== "h") return;
      const el = overlayRef.current;
      if (!el) return;
      const w = ancho();
      const dist = Math.abs(d.dx);
      const vel = dist / Math.max(1, performance.now() - d.t);
      const pasa = dist > w * 0.4 || (dist > 60 && vel > 0.6);
      const quedaAbierto = d.modo === "abrir" ? pasa : !pasa;
      el.style.transition = `transform ${ANIM_MS}ms ease-out`;
      el.style.transform = `translate3d(${quedaAbierto ? 0 : w}px,0,0)`;
      animando.current = true;
      setTimeout(() => {
        animando.current = false;
        if (quedaAbierto === finRef.current) {
          // Volvió a donde estaba: nada cambia.
          el.style.transition = "";
          el.style.transform = "";
          return;
        }
        limpiarOverlay.current = true;
        if (quedaAbierto) abrirFin();
        else cerrarFin();
      }, ANIM_MS + 10);
    };

    window.addEventListener("touchstart", onStart, { passive: true });
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend", onEnd);
    window.addEventListener("touchcancel", onEnd);
    return () => {
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
      window.removeEventListener("touchcancel", onEnd);
    };
  }, [vistaConteo, abrirFin, cerrarFin]);

  const finalizar = async () => {
    if (!activo || finalizando) return;
    setFinalizando(true);
    setErrorFin(null);
    try {
      const res = await fetch("/api/mostradores/finalizar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ controlId: activo.controlId }),
      });
      const json = (await res.json().catch(() => null)) as ResultadoFin | null;
      if (!res.ok || !json) {
        if (res.status === 409) cargar();
        throw new Error(json?.error ?? `HTTP ${res.status}`);
      }
      vibrar([40, 60, 40]);
      const partes = [`${json.contados ?? contados} contados`];
      if (json.conDiferencia) partes.push(`${json.conDiferencia} con diferencia`);
      mostrarAviso(
        "ok",
        json.anulado
          ? `✓ Patrón ${json.patron ?? activo.codigo} quitado de control · no tenía artículos para contar`
          : `✓ Patrón ${json.patron ?? activo.codigo} finalizado · ${partes.join(" · ")}`,
        6000,
      );
      // Vuelve a la lista de patrones: saca del historial la tarjeta y el conteo.
      const pasos = window.history.state?.mostradorFin ? 2 : window.history.state?.mostradorConteo ? 1 : 0;
      setFin(false);
      setEnConteo(false);
      setActivoId(null);
      setArticulos([]);
      setPatrones((prev) => prev.filter((x) => x.controlId !== activo.controlId));
      if (pasos) {
        ignorarPop.current += 1;
        window.history.go(-pasos);
      }
      cargar();
    } catch (e) {
      setErrorFin(e instanceof Error ? e.message : "No se pudo finalizar");
      vibrar([80, 60, 80]);
    } finally {
      setFinalizando(false);
    }
  };

  // ── Escaneo / búsqueda ─────────────────────────────────────────────────────
  const resolver = useCallback(
    (valor: string, porLector: boolean) => {
      const v = norm(valor);
      if (!v) return;
      const exacto = porCodigo.get(v);
      if (exacto) {
        vibrar(40);
        abrir(exacto.art, exacto.barra);
        return;
      }
      if (!porLector && filtrados.length === 1) {
        abrir(filtrados[0], null);
        return;
      }
      if (porLector) {
        vibrar([80, 60, 80]);
        mostrarAviso("error", `${valor.trim()} no está en el patrón en control`);
        setBusqueda("");
      }
    },
    [porCodigo, filtrados, abrir, mostrarAviso],
  );

  const onBuscarKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      // Con el teclado en pantalla oculto, lo que llega con Enter es del lector.
      resolver(busqueda, !teclado);
    } else if (e.key === "Escape") {
      setBusqueda("");
    }
  };

  const onBuscarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const nuevo = e.target.value;
    const salto = nuevo.length - busqueda.length;
    setBusqueda(nuevo);
    // Lectores que "pegan" el código entero sin Enter: si entró de golpe y
    // coincide exacto, se abre igual.
    if (salto >= 4 && porCodigo.has(norm(nuevo))) resolver(nuevo, true);
  };

  // ── Guardar ────────────────────────────────────────────────────────────────
  const guardar = async () => {
    if (!sel || guardando) return;
    // Coma o punto como decimal (el teclado numérico del PDA trae uno u otro).
    const txt = cantidad.trim().replace(",", ".");
    const n = txt === "" || (txt.match(/\./g)?.length ?? 0) > 1 ? NaN : Number(txt);
    if (!Number.isFinite(n) || n < 0) {
      setErrorCant("Ingresá una cantidad");
      vibrar([80, 60, 80]);
      cantRef.current?.focus();
      return;
    }
    setGuardando(true);
    setErrorCant(null);
    try {
      const res = await fetch("/api/mostradores/conteo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ controlId: sel.art.controlId, codArticulo: sel.art.cod, cantidad: n }),
      });
      const json = (await res.json().catch(() => null)) as
        | { cantidad?: number; contadoAt?: string; error?: string }
        | null;
      if (!res.ok || !json) {
        if (res.status === 409) cargar(); // el patrón se cerró o cambió
        throw new Error(json?.error ?? `HTTP ${res.status}`);
      }
      const k = claveArt(sel.art);
      const eraNuevo = sel.art.contado === null;
      setArticulos((prev) =>
        prev.map((a) => (claveArt(a) === k ? { ...a, contado: json.cantidad ?? n, contadoAt: json.contadoAt ?? null } : a)),
      );
      if (eraNuevo) {
        setPatrones((prev) => prev.map((p) => (p.controlId === sel.art.controlId ? { ...p, contados: p.contados + 1 } : p)));
      }
      vibrar(40);
      mostrarAviso("ok", `✓ Guardado ${sel.art.cod} · ${fmtCant(json.cantidad ?? n)}`);
      cerrar();
    } catch (e) {
      setErrorCant(e instanceof Error ? e.message : "No se pudo guardar");
      vibrar([80, 60, 80]);
      cantRef.current?.focus();
    } finally {
      setGuardando(false);
    }
  };

  const avisoEl = aviso && (
    <div
      className={`mx-3 mb-2 rounded px-3 py-2 text-sm font-medium ${
        aviso.tipo === "ok"
          ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/40"
          : "bg-[#f85149]/15 text-[#f85149] border border-[#f85149]/40"
      }`}
    >
      {aviso.texto}
    </div>
  );

  const errorEl = error && (
    <div className="m-3 flex items-center gap-2 text-sm text-[#f85149] bg-[#f85149]/10 border border-[#f85149]/30 rounded px-3 py-2">
      <AlertCircle className="h-4 w-4 shrink-0" />
      {error}
    </div>
  );

  // ════════════════════════════════════════════════════════════════════════════
  // Vista: carga de cantidad
  // ════════════════════════════════════════════════════════════════════════════
  if (sel) {
    const a = sel.art;
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
          <span className="ml-auto text-yellow-400 font-bold text-sm uppercase tracking-wide">Control stock</span>
        </header>

        <form
          className="flex-1 flex flex-col gap-4 px-4 pt-4"
          onSubmit={(e) => {
            e.preventDefault();
            guardar();
          }}
        >
          <div>
            <div className="text-2xl font-bold tabular-nums text-zinc-100 break-all">{a.cod}</div>
            <div className="text-base text-zinc-300 leading-snug mt-1">{a.detalle || "—"}</div>
            <div className="text-xs text-zinc-500 mt-1">Patrón {a.patron}</div>
          </div>

          {sel.barra && (
            <div className="text-sm rounded border border-sky-500/40 bg-sky-500/10 text-sky-300 px-3 py-2">
              Escaneaste {sel.barra.envase || "un envase"} ×{sel.barra.cant}. Cargá las unidades.
            </div>
          )}

          {a.contado !== null && (
            <div className="text-sm rounded border border-emerald-500/40 bg-emerald-500/10 text-emerald-300 px-3 py-2">
              Ya contado: <b className="tabular-nums">{fmtCant(a.contado)}</b>. Lo que cargues lo reemplaza.
            </div>
          )}

          <input
            ref={cantRef}
            autoFocus
            type="text"
            inputMode="decimal"
            enterKeyHint="done"
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

          <button
            type="submit"
            disabled={guardando}
            className="w-full rounded-lg bg-yellow-400 active:bg-yellow-300 disabled:opacity-60 text-black font-bold text-lg py-4 flex items-center justify-center gap-2"
          >
            {guardando ? <Loader2 className="h-5 w-5 animate-spin" /> : <Check className="h-5 w-5" />}
            Guardar
          </button>
        </form>
      </div>
    );
  }

  // ════════════════════════════════════════════════════════════════════════════
  // Vista principal: patrones mandados a control
  // ════════════════════════════════════════════════════════════════════════════
  if (!enConteo || !activo) {
    const otros = patrones.filter((p) => p.controlId !== activoId);
    return (
      <div className="dark min-h-[100dvh] bg-[#111111] text-white">
        <div className="sticky top-0 z-10 bg-[#111111] border-b border-zinc-800">
          <header className="flex items-center gap-2 px-3 py-2">
            <InicioButton label="" iconSize={16} className="text-zinc-500 active:text-yellow-400" />
            <h1 className="text-yellow-400 font-bold text-lg uppercase tracking-wide">Control stock</h1>
            <span className="ml-auto text-xs text-zinc-500 tabular-nums">
              {patrones.length} {patrones.length === 1 ? "patrón" : "patrones"}
            </span>
            <button
              type="button"
              onClick={cargar}
              disabled={cargando}
              className="p-1.5 text-zinc-400 active:text-yellow-400"
              title="Recargar"
            >
              <RefreshCw className={`h-4 w-4 ${cargando ? "animate-spin" : ""}`} />
            </button>
          </header>
          {avisoEl}
        </div>

        {errorEl}

        {cargando && !patrones.length && (
          <div className="py-12 text-center text-zinc-500">
            <Loader2 className="h-5 w-5 animate-spin inline mr-2" />
            Cargando…
          </div>
        )}

        {!cargando && !error && !patrones.length && (
          <div className="py-12 px-6 text-center text-zinc-500">No hay patrones mandados a control.</div>
        )}

        {activo && (
          <section className="px-3 pt-3">
            <div className="text-[11px] uppercase tracking-wide text-zinc-500 mb-1.5">Tu patrón activo</div>
            <button
              type="button"
              onClick={abrirConteo}
              className="w-full text-left rounded-lg border-2 border-yellow-400 bg-yellow-400/5 active:bg-yellow-400/10 px-4 py-3"
            >
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-xl font-bold tabular-nums text-zinc-100">Patrón {activo.codigo}</div>
                  <div className="text-sm text-zinc-300 leading-snug line-clamp-2">{activo.detalle || "—"}</div>
                  {activo.linea && <div className="text-xs text-zinc-500 mt-0.5 truncate">{activo.linea}</div>}
                </div>
                <span className="shrink-0 flex items-center gap-1 rounded-md bg-yellow-400 text-black text-sm font-bold px-3 py-2">
                  <Play className="h-4 w-4" />
                  Seguir
                </span>
              </div>
              <div className="mt-3">
                <BarraAvance valor={activo.contados} total={activo.total} />
                <div className="mt-1 text-xs tabular-nums text-zinc-400">
                  {activo.total > 0
                    ? `${activo.contados} de ${activo.total} artículos contados`
                    : "Sin artículos para contar — entrá para quitarlo de control"}
                </div>
              </div>
            </button>
            {otros.length > 0 && (
              <div className="mt-2 flex items-center gap-1.5 text-xs text-zinc-500">
                <Lock className="h-3.5 w-3.5" />
                Finalizá este patrón para tomar otro.
              </div>
            )}
          </section>
        )}

        {otros.length > 0 && (
          <section className="px-3 pt-4 pb-6">
            {activo && <div className="text-[11px] uppercase tracking-wide text-zinc-500 mb-1.5">En control</div>}
            <ul className="flex flex-col gap-2">
              {otros.map((p) => {
                const deOtro = p.tomadoPorId !== null;
                const bloqueado = deOtro || !!activo;
                const armado = confirmarTomar === p.controlId;
                const enCurso = tomando === p.controlId;
                return (
                  <li key={p.controlId}>
                    <button
                      type="button"
                      onClick={() => (deOtro ? undefined : tomar(p))}
                      disabled={deOtro || tomando !== null}
                      className={`w-full text-left rounded-lg border px-4 py-3 ${
                        armado
                          ? "border-yellow-400 bg-yellow-400/10"
                          : bloqueado
                            ? "border-zinc-800 bg-[#161616] opacity-60"
                            : "border-zinc-700 bg-[#1a1a1a] active:bg-[#222]"
                      }`}
                    >
                      <div className="flex items-start gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="text-lg font-bold tabular-nums text-zinc-100">Patrón {p.codigo}</div>
                          <div className="text-sm text-zinc-300 leading-snug line-clamp-2">{p.detalle || "—"}</div>
                          {p.linea && <div className="text-xs text-zinc-500 mt-0.5 truncate">{p.linea}</div>}
                          <div className="mt-1 text-xs tabular-nums text-zinc-500">
                            {p.contados > 0 ? `${p.contados} de ${p.total} contados` : `${p.total} artículos`}
                          </div>
                        </div>
                        <div className="shrink-0 self-center">
                          {deOtro ? (
                            <span className="flex items-center gap-1 text-xs text-zinc-400 max-w-[8rem] text-right">
                              <User className="h-3.5 w-3.5 shrink-0" />
                              <span className="truncate">Lo tiene {p.tomadoPor}</span>
                            </span>
                          ) : activo ? (
                            <Lock className="h-4 w-4 text-zinc-600" />
                          ) : (
                            <span
                              className={`flex items-center gap-1 rounded-md text-sm font-bold px-3 py-2 ${
                                armado ? "bg-yellow-400 text-black" : "border border-yellow-400/60 text-yellow-400"
                              }`}
                            >
                              {enCurso && <Loader2 className="h-4 w-4 animate-spin" />}
                              {armado ? "Tocá de nuevo" : "Tomar"}
                            </span>
                          )}
                        </div>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </div>
    );
  }

  // ════════════════════════════════════════════════════════════════════════════
  // Vista: conteo del patrón activo (+ tarjeta "Finalizar" deslizable encima)
  // ════════════════════════════════════════════════════════════════════════════
  const visibles = filtrados.slice(0, MAX_FILAS);
  const ocultos = filtrados.length - visibles.length;
  const sinContar = total - contados;

  return (
    <div className="dark min-h-[100dvh] bg-[#111111] text-white" style={{ touchAction: "pan-y" }}>
      <div className="sticky top-0 z-10 bg-[#111111] border-b border-zinc-800">
        <header className="flex items-center gap-2 px-3 pt-2">
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={cerrarConteo}
            className="p-1 -ml-1 text-zinc-400 active:text-yellow-400"
            title="Patrones"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <h1 className="text-yellow-400 font-bold text-lg uppercase tracking-wide">Control stock</h1>
          <span className="ml-auto text-sm tabular-nums text-zinc-400">
            <b className={contados === total && total > 0 ? "text-emerald-400" : "text-zinc-100"}>{contados}</b>/{total}
          </span>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={cargar}
            disabled={cargando}
            className="p-1.5 text-zinc-400 active:text-yellow-400"
            title="Recargar"
          >
            <RefreshCw className={`h-4 w-4 ${cargando ? "animate-spin" : ""}`} />
          </button>
        </header>

        <div className="px-3 pt-1 flex items-center gap-2 text-xs">
          <span className="min-w-0 flex-1 truncate text-zinc-400">
            <b className="text-zinc-200 tabular-nums">{activo.codigo}</b> {activo.detalle}
          </span>
          <span className="shrink-0 flex items-center text-zinc-600">
            <ChevronLeft className="h-3.5 w-3.5" />
            deslizá para finalizar
          </span>
        </div>

        <div className="flex items-center gap-2 px-3 py-2">
          <div className="relative flex-1">
            <ScanLine className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-zinc-500 pointer-events-none" />
            <input
              ref={buscarRef}
              autoFocus
              type="text"
              inputMode={teclado ? "text" : "none"}
              enterKeyHint="search"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="characters"
              spellCheck={false}
              placeholder="Escaneá o escribí código / detalle"
              value={busqueda}
              onChange={onBuscarChange}
              onKeyDown={onBuscarKey}
              onPointerDown={mostrarTeclado}
              onBlur={() => setTimeout(enfocar, 60)}
              className="w-full rounded-lg bg-[#1f1f1f] border-2 border-zinc-700 focus:border-yellow-400 outline-none pl-10 pr-3 py-3 text-lg text-white placeholder:text-zinc-600"
            />
          </div>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => (teclado ? setTeclado(false) : mostrarTeclado())}
            className={`p-3 rounded-lg border-2 ${teclado ? "border-yellow-400 text-yellow-400" : "border-zinc-700 text-zinc-400"}`}
            title={teclado ? "Ocultar teclado" : "Mostrar teclado"}
          >
            <Keyboard className="h-5 w-5" />
          </button>
        </div>

        {avisoEl}
      </div>

      {errorEl}

      {cargando && !articulos.length && (
        <div className="py-12 text-center text-zinc-500">
          <Loader2 className="h-5 w-5 animate-spin inline mr-2" />
          Cargando…
        </div>
      )}

      {/* Patrón sin artículos para contar (todos dados de baja y sin stock):
          no hay nada que escanear ni forma de deslizar a finalizar (pide ≥1
          contado) → botón para quitarlo de control y liberar al usuario. */}
      {!cargando && !error && !articulos.length && (
        <div className="py-10 px-6 text-center">
          <AlertCircle className="h-8 w-8 text-amber-400 mx-auto mb-3" />
          <div className="text-zinc-200 font-semibold">Este patrón no tiene artículos para contar</div>
          <div className="text-sm text-zinc-500 mt-1">Todos sus artículos están dados de baja y sin stock.</div>
          {errorFin && <div className="text-sm text-red-400 mt-3">{errorFin}</div>}
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={finalizar}
            disabled={finalizando}
            className="mt-5 w-full rounded-lg bg-yellow-400 text-black font-bold py-3 disabled:opacity-60"
          >
            {finalizando ? "Quitando…" : "Quitar de control"}
          </button>
        </div>
      )}

      {!cargando && articulos.length > 0 && !filtrados.length && (
        <div className="py-12 px-6 text-center text-zinc-500">Sin coincidencias para “{busqueda}”.</div>
      )}

      <ul className="divide-y divide-zinc-800/70">
        {visibles.map((a) => {
          const ok = a.contado !== null;
          return (
            <li key={claveArt(a)}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => abrir(a, null)}
                className={`w-full text-left px-3 py-3 flex items-center gap-3 active:bg-[#1f1f1f] ${ok ? "bg-emerald-500/5" : ""}`}
              >
                <div className="min-w-0 flex-1">
                  <div className={`font-semibold tabular-nums ${ok ? "text-emerald-300" : "text-zinc-100"}`}>{a.cod}</div>
                  <div className="text-sm text-zinc-400 leading-snug line-clamp-2">{a.detalle || "—"}</div>
                </div>
                {ok && (
                  <div className="shrink-0 flex items-center gap-1 text-emerald-400 font-bold text-lg tabular-nums">
                    <Check className="h-4 w-4" />
                    {fmtCant(a.contado as number)}
                  </div>
                )}
              </button>
            </li>
          );
        })}
      </ul>

      {ocultos > 0 && (
        <div className="py-4 px-3 text-center text-xs text-zinc-500">
          {ocultos} artículos más — escribí para filtrar.
        </div>
      )}

      {/* Tarjeta "Finalizar": vive fuera de pantalla a la derecha; el arrastre
          la mueve con estilos en línea y la clase fija la posición final. */}
      <div
        ref={overlayRef}
        aria-hidden={!fin}
        style={{ touchAction: "none" }}
        className={`fixed inset-0 z-40 flex flex-col bg-[#161616] border-l-4 border-yellow-400 shadow-[-16px_0_32px_rgba(0,0,0,0.7)] transition-transform duration-200 ease-out ${
          fin ? "translate-x-0" : "translate-x-full pointer-events-none"
        }`}
      >
        {!fin ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-4 px-6">
            <div className="h-20 w-20 rounded-full border-2 border-yellow-400 flex items-center justify-center">
              <Flag className="h-9 w-9 text-yellow-400" />
            </div>
            <div className="text-yellow-400 text-3xl font-extrabold uppercase tracking-widest">Finalizar</div>
            <div className="text-sm text-zinc-500 tabular-nums">Patrón {activo.codigo}</div>
          </div>
        ) : (
          <>
            <div className="flex-1 flex flex-col items-center justify-center gap-3 px-6 text-center">
              <div className="text-4xl font-extrabold text-zinc-100">¿Finalizamos?</div>
              <div className="text-sm text-zinc-500 tabular-nums">
                Patrón {activo.codigo} · {contados} de {total} contados
              </div>
              {contados > 0 && sinContar > 0 && (
                <div className="mt-2 max-w-xs text-xs rounded border border-amber-500/40 bg-amber-500/10 text-amber-300 px-3 py-2">
                  {sinContar} sin contar: los que tengan stock en sistema se guardan con controlado 0.
                </div>
              )}
            </div>
            <div className="px-4 pb-6 flex flex-col gap-3">
              {errorFin && (
                <div className="flex items-center gap-2 text-sm text-[#f85149] bg-[#f85149]/10 border border-[#f85149]/30 rounded px-3 py-2">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  {errorFin}
                </div>
              )}
              {contados === 0 && (
                <div className="text-center text-sm text-zinc-500">Todavía no contaste ningún artículo.</div>
              )}
              <button
                type="button"
                disabled={contados === 0 || finalizando}
                onClick={finalizar}
                className="w-full rounded-lg bg-yellow-400 active:bg-yellow-300 disabled:opacity-50 text-black font-bold text-xl py-5 flex items-center justify-center gap-2"
              >
                {finalizando ? <Loader2 className="h-5 w-5 animate-spin" /> : <Flag className="h-5 w-5" />}
                Finalizar
              </button>
              <div className="flex items-center justify-center gap-1 text-xs text-zinc-600">
                Deslizá a la derecha para volver
                <ChevronRight className="h-3.5 w-3.5" />
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
