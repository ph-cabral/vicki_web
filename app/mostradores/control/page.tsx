"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, ArrowLeft, Check, Flag, Keyboard, Loader2, RefreshCw, ScanLine } from "lucide-react";
import { InicioButton } from "@/components/ui/InicioButton";

// ──────────────────────────────────────────────────────────────────────────────
// Mostradores → Control — vista para PDA.
//
// Lista SOLO los artículos de los patrones que mandó a control el administrador
// (se arranca y se termina patrón por patrón). Un input queda siempre enfocado:
//   · escaneo  → el lector "tipea" el código + Enter; si coincide con un código
//                de artículo o de barras abre directo la carga de cantidad.
//   · escrito  → filtra la lista de abajo (código, barras o detalle, por
//                palabras); se toca el artículo para abrir la carga.
// Carga de cantidad: un solo input numérico enfocado (teclado numérico), Enter
// o "Guardar" y vuelve a la lista. Contar de nuevo un artículo reemplaza el
// valor. Conteo ciego: no se muestra el stock de sistema.
//
// El teclado en pantalla arranca OCULTO (inputMode="none") para que no tape la
// lista mientras se escanea; tocar el input o el botón del teclado lo muestra.
//
// Finalizar: botón "Finalizar" del encabezado o deslizar de derecha a izquierda
// sobre la lista → tarjeta "Finalizar control" por patrón (doble toque para
// confirmar). Cierra el control y guarda código / controlado / sistema /
// diferencia / usuario en everwear.mostrador_control_detalle.
//
// Datos: GET/POST /api/mostradores/conteo, POST /api/mostradores/finalizar.
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
}

interface ResultadoFin {
  patron: string;
  contados: number;
  sinContarConStock: number;
  conDiferencia: number;
}

interface Seleccion {
  art: Articulo;
  barra: Barra | null; // código escaneado, si vino por lector
}

const MAX_FILAS = 120;

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

export default function ControlStockPage() {
  const [patrones, setPatrones] = useState<Patron[]>([]);
  const [articulos, setArticulos] = useState<Articulo[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [busqueda, setBusqueda] = useState("");
  const [teclado, setTeclado] = useState(false); // teclado en pantalla del buscador
  const [aviso, setAviso] = useState<{ tipo: "ok" | "error"; texto: string } | null>(null);

  const [sel, setSel] = useState<Seleccion | null>(null);
  const [cantidad, setCantidad] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [errorCant, setErrorCant] = useState<string | null>(null);

  // Finalizar control
  const [fin, setFin] = useState(false);
  const [confirmar, setConfirmar] = useState<number | null>(null); // controlId esperando 2º toque
  const [finalizando, setFinalizando] = useState<number | null>(null);
  const [errorFin, setErrorFin] = useState<string | null>(null);
  const [resultado, setResultado] = useState<ResultadoFin | null>(null);
  const confirmarTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toqueIni = useRef<{ x: number; y: number } | null>(null);

  const buscarRef = useRef<HTMLInputElement>(null);
  const cantRef = useRef<HTMLInputElement>(null);
  const selRef = useRef<Seleccion | null>(null);
  selRef.current = sel;
  const finRef = useRef(false);
  finRef.current = fin;
  const avisoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Datos ──────────────────────────────────────────────────────────────────
  const cargar = useCallback(async () => {
    setCargando(true);
    setError(null);
    try {
      const res = await fetch("/api/mostradores/conteo", { cache: "no-store" });
      const json = (await res.json().catch(() => null)) as
        | { patrones?: Patron[]; articulos?: Articulo[]; error?: string }
        | null;
      if (!res.ok || !json) throw new Error(json?.error ?? `HTTP ${res.status}`);
      setPatrones(json.patrones ?? []);
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

  // ── Foco permanente en el buscador ─────────────────────────────────────────
  const enfocar = useCallback(() => {
    if (selRef.current || finRef.current) return;
    const el = buscarRef.current;
    if (el && document.activeElement !== el) el.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (sel || fin) return;
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
  }, [sel, fin, enfocar]);

  const mostrarAviso = useCallback((tipo: "ok" | "error", texto: string) => {
    if (avisoTimer.current) clearTimeout(avisoTimer.current);
    setAviso({ tipo, texto });
    avisoTimer.current = setTimeout(() => setAviso(null), tipo === "ok" ? 2000 : 3500);
  }, []);

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
    // El botón "atrás" del PDA vuelve a la lista en vez de salir de la página.
    try {
      window.history.pushState({ mostradorCant: true }, "");
    } catch {
      /* nada */
    }
  }, []);

  const cerrar = useCallback(() => {
    if (window.history.state?.mostradorCant) window.history.back();
    else setSel(null);
  }, []);

  useEffect(() => {
    const onPop = () => {
      setSel(null);
      setFin(false);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Al volver a la lista: buscador limpio, teclado oculto, foco listo para escanear.
  useEffect(() => {
    if (sel) {
      requestAnimationFrame(() => cantRef.current?.focus());
      return;
    }
    setBusqueda("");
    setTeclado(false);
    requestAnimationFrame(() => buscarRef.current?.focus({ preventScroll: true }));
  }, [sel]);

  // ── Finalizar control ──────────────────────────────────────────────────────
  const abrirFin = useCallback(() => {
    setFin(true);
    setConfirmar(null);
    setErrorFin(null);
    setResultado(null);
    buscarRef.current?.blur();
    try {
      window.history.pushState({ mostradorFin: true }, "");
    } catch {
      /* nada */
    }
  }, []);

  const cerrarFin = useCallback(() => {
    if (window.history.state?.mostradorFin) window.history.back();
    else setFin(false);
  }, []);

  // Al volver de la tarjeta: foco listo para escanear.
  useEffect(() => {
    if (fin) return;
    setConfirmar(null);
    requestAnimationFrame(() => buscarRef.current?.focus({ preventScroll: true }));
  }, [fin]);

  const finalizar = async (p: Patron) => {
    if (finalizando !== null) return;
    // Primer toque arma la confirmación; el segundo (dentro de 4 s) finaliza.
    if (confirmar !== p.controlId) {
      setConfirmar(p.controlId);
      vibrar(30);
      if (confirmarTimer.current) clearTimeout(confirmarTimer.current);
      confirmarTimer.current = setTimeout(() => setConfirmar(null), 4000);
      return;
    }
    if (confirmarTimer.current) clearTimeout(confirmarTimer.current);
    setConfirmar(null);
    setFinalizando(p.controlId);
    setErrorFin(null);
    try {
      const res = await fetch("/api/mostradores/finalizar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ controlId: p.controlId }),
      });
      const json = (await res.json().catch(() => null)) as (ResultadoFin & { error?: string }) | null;
      if (!res.ok || !json) {
        if (res.status === 409) cargar();
        throw new Error(json?.error ?? `HTTP ${res.status}`);
      }
      vibrar([40, 60, 40]);
      setResultado({
        patron: json.patron ?? p.codigo,
        contados: json.contados ?? 0,
        sinContarConStock: json.sinContarConStock ?? 0,
        conDiferencia: json.conDiferencia ?? 0,
      });
      // El patrón cerrado sale de la lista.
      setPatrones((prev) => prev.filter((x) => x.controlId !== p.controlId));
      setArticulos((prev) => prev.filter((a) => a.controlId !== p.controlId));
      cargar();
    } catch (e) {
      setErrorFin(e instanceof Error ? e.message : "No se pudo finalizar");
      vibrar([80, 60, 80]);
    } finally {
      setFinalizando(null);
    }
  };

  // Deslizar de derecha a izquierda sobre la lista abre "Finalizar control".
  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    toqueIni.current = e.touches.length === 1 ? { x: t.clientX, y: t.clientY } : null;
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const ini = toqueIni.current;
    toqueIni.current = null;
    if (!ini || !patrones.length) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - ini.x;
    const dy = t.clientY - ini.y;
    if (dx < -80 && Math.abs(dy) < Math.abs(dx) * 0.6) abrirFin();
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
      mostrarAviso("ok", `${sel.art.cod} · ${fmtCant(json.cantidad ?? n)}`);
      cerrar();
    } catch (e) {
      setErrorCant(e instanceof Error ? e.message : "No se pudo guardar");
      vibrar([80, 60, 80]);
      cantRef.current?.focus();
    } finally {
      setGuardando(false);
    }
  };

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
  // Vista: finalizar control
  // ════════════════════════════════════════════════════════════════════════════
  if (fin) {
    return (
      <div className="dark min-h-[100dvh] bg-[#111111] text-white flex flex-col">
        <header className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800 bg-[#171717]">
          <button
            type="button"
            onClick={cerrarFin}
            className="flex items-center gap-1 text-sm text-zinc-400 active:text-yellow-400 py-1 pr-2"
          >
            <ArrowLeft className="h-4 w-4" />
            Volver
          </button>
          <span className="ml-auto text-yellow-400 font-bold text-sm uppercase tracking-wide">Finalizar control</span>
        </header>

        <div className="flex-1 flex flex-col gap-3 px-3 pt-3 pb-6">
          {resultado && (
            <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-3">
              <div className="flex items-center gap-2 text-emerald-300 font-bold text-lg">
                <Check className="h-5 w-5" />
                Patrón {resultado.patron} finalizado
              </div>
              <div className="mt-2 text-sm text-zinc-300 space-y-0.5">
                <div>
                  Contados: <b className="tabular-nums text-zinc-100">{resultado.contados}</b>
                </div>
                {resultado.sinContarConStock > 0 && (
                  <div>
                    Sin contar con stock en sistema (registrados en 0):{" "}
                    <b className="tabular-nums text-zinc-100">{resultado.sinContarConStock}</b>
                  </div>
                )}
                <div>
                  Con diferencia:{" "}
                  <b className={`tabular-nums ${resultado.conDiferencia ? "text-[#f85149]" : "text-emerald-300"}`}>
                    {resultado.conDiferencia}
                  </b>
                </div>
              </div>
            </div>
          )}

          {errorFin && (
            <div className="flex items-center gap-2 text-sm text-[#f85149] bg-[#f85149]/10 border border-[#f85149]/30 rounded px-3 py-2">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {errorFin}
            </div>
          )}

          {patrones.map((p) => {
            const sinContar = p.total - p.contados;
            const armado = confirmar === p.controlId;
            const enCurso = finalizando === p.controlId;
            return (
              <div key={p.controlId} className="rounded-lg border border-zinc-700 bg-[#1a1a1a] px-4 py-3">
                <div className="text-xl font-bold text-zinc-100 tabular-nums">Patrón {p.codigo}</div>
                <div className="text-sm text-zinc-300 leading-snug">{p.detalle || "—"}</div>
                {p.linea && <div className="text-xs text-zinc-500 mt-0.5">{p.linea}</div>}

                <div className="mt-3 flex items-end gap-4">
                  <div>
                    <div className="text-xs text-zinc-500 uppercase">Contados</div>
                    <div className="text-2xl font-bold tabular-nums">
                      <span className={p.contados === p.total ? "text-emerald-400" : "text-zinc-100"}>{p.contados}</span>
                      <span className="text-zinc-500 text-lg">/{p.total}</span>
                    </div>
                  </div>
                  {sinContar > 0 && (
                    <div>
                      <div className="text-xs text-zinc-500 uppercase">Sin contar</div>
                      <div className="text-2xl font-bold tabular-nums text-amber-400">{sinContar}</div>
                    </div>
                  )}
                </div>

                {sinContar > 0 && p.contados > 0 && (
                  <div className="mt-3 text-xs rounded border border-amber-500/40 bg-amber-500/10 text-amber-300 px-3 py-2">
                    Los sin contar que tengan stock en sistema se guardan con controlado 0.
                  </div>
                )}

                <button
                  type="button"
                  disabled={p.contados === 0 || finalizando !== null}
                  onClick={() => finalizar(p)}
                  className={`mt-3 w-full rounded-lg font-bold text-lg py-4 flex items-center justify-center gap-2 disabled:opacity-50 ${
                    armado ? "bg-[#f85149] active:bg-[#ff6a63] text-white" : "bg-yellow-400 active:bg-yellow-300 text-black"
                  }`}
                >
                  {enCurso ? <Loader2 className="h-5 w-5 animate-spin" /> : <Flag className="h-5 w-5" />}
                  {p.contados === 0 ? "Nada contado todavía" : armado ? "Tocá de nuevo para confirmar" : "Finalizar control"}
                </button>
              </div>
            );
          })}

          {!patrones.length && !resultado && (
            <div className="py-12 text-center text-zinc-500">No hay patrones en control.</div>
          )}

          {(resultado || !patrones.length) && (
            <button
              type="button"
              onClick={cerrarFin}
              className="w-full rounded-lg border-2 border-zinc-700 text-zinc-200 font-semibold py-3"
            >
              Volver a la lista
            </button>
          )}
        </div>
      </div>
    );
  }

  // ════════════════════════════════════════════════════════════════════════════
  // Vista: lista de artículos a controlar
  // ════════════════════════════════════════════════════════════════════════════
  const visibles = filtrados.slice(0, MAX_FILAS);
  const ocultos = filtrados.length - visibles.length;

  return (
    <div className="dark min-h-[100dvh] bg-[#111111] text-white" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
      <div className="sticky top-0 z-10 bg-[#111111] border-b border-zinc-800">
        <header className="flex items-center gap-2 px-3 pt-2">
          <InicioButton label="" iconSize={16} className="text-zinc-500 active:text-yellow-400" />
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
          {patrones.length > 0 && (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={abrirFin}
              className="flex items-center gap-1 rounded-md border border-yellow-400/60 text-yellow-400 active:bg-yellow-400/10 px-2 py-1 text-xs font-bold uppercase"
              title="Finalizar control (o deslizá hacia la izquierda)"
            >
              <Flag className="h-3.5 w-3.5" />
              Finalizar
            </button>
          )}
        </header>

        {patrones.length > 0 && (
          <div className="px-3 pt-1 text-xs text-zinc-500 truncate">
            {patrones.map((p) => `${p.codigo} ${p.detalle}`).join(" · ")}
          </div>
        )}

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

        {aviso && (
          <div
            className={`mx-3 mb-2 rounded px-3 py-2 text-sm font-medium ${
              aviso.tipo === "ok"
                ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/40"
                : "bg-[#f85149]/15 text-[#f85149] border border-[#f85149]/40"
            }`}
          >
            {aviso.tipo === "ok" ? "✓ Guardado " : ""}
            {aviso.texto}
          </div>
        )}
      </div>

      {error && (
        <div className="m-3 flex items-center gap-2 text-sm text-[#f85149] bg-[#f85149]/10 border border-[#f85149]/30 rounded px-3 py-2">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {cargando && !articulos.length && (
        <div className="py-12 text-center text-zinc-500">
          <Loader2 className="h-5 w-5 animate-spin inline mr-2" />
          Cargando…
        </div>
      )}

      {!cargando && !error && !patrones.length && (
        <div className="py-12 px-6 text-center text-zinc-500">No hay patrones mandados a control.</div>
      )}

      {!cargando && patrones.length > 0 && !filtrados.length && (
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
    </div>
  );
}
