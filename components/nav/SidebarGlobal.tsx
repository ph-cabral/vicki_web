"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight, Star, X, GripVertical, Home } from "lucide-react";

// ──────────────────────────────────────────────────────────────────────────────
// Sidebar GLOBAL de la app (2026-08-27: antes vivía sólo en
// /compras). Se monta en app/layout.tsx, así que aparece en TODAS las vistas.
//
// Se abre por hover: está escondida fuera de pantalla y aparece cuando el mouse
// se acerca al borde izquierdo (franja invisible de 12px + pestaña con chevron
// como pista visual). Es un overlay fijo: no corre el layout de las páginas.
//
// En pantallas táctiles (matchMedia "(hover: none)") el hover no existe, así que
// se abre con gesto: deslizar el dedo desde el borde izquierdo (franja de 28px)
// la trae, y deslizar hacia la izquierda estando abierta la cierra. El panel
// sigue al dedo (transform en px, sin transición mientras dura el gesto) y al
// soltar cae al lado más cercano (mitad del ancho). Además, en mobile hay
// backdrop tocable y una X en la cabecera, porque no hay "mouse leave" que
// cierre. Los handlers de hover quedan desactivados en táctil para que el
// mouseleave sintético del tap no cierre el panel apenas se abre.
//
// Contenido:
//   1. "Mis accesos" — lo que el usuario marcó con la estrella, en SU orden
//      (drag & drop). Se guarda por usuario en everwear.usuario_acceso
//      (sql/usuario_acceso.sql + app/api/preferencias/accesos/route.ts).
//   2. Las vistas del MÓDULO en el que está parado (según el catálogo).
//
// (2026-09-04) Se sacó el botón "+ Agregar acceso" con su buscador: fijar/soltar
// queda sólo con la ⭐ de cada vista. El catálogo completo se sigue trayendo del
// endpoint porque de ahí sale el módulo actual y sus vistas.
//
// Marcar es preferencia, NO permiso: el catálogo lo arma el server ya filtrado
// por los permisos de la sesión.
//
// El drag&drop es HTML5 nativo (sin librería): la FILA entera es el draggable
// (la manija ⋮⋮ es sólo la pista visual) y el <Link> de adentro va con
// draggable={false}, si no el navegador arrastra el link. OJO: no sirve poner
// `draggable` según un useRef — el atributo tiene que estar antes del gesto y
// un ref no re-renderiza.
// ──────────────────────────────────────────────────────────────────────────────

interface Acceso {
  href: string;
  label: string;
}
interface CatalogoItem extends Acceso {
  grupo: string;
}

// Rutas donde no se muestra ni se puede abrir con el gesto:
//   · /login: no hay sesión todavía.
//   · vistas de PDA (picker y control de mostradores): el input tiene foco
//     permanente y el deslizamiento se usa para otras cosas; la sidebar
//     abierta por error tapaba el escaneo.
const OCULTA_EN = ["/login", "/picking/picker", "/mostradores/control"];

const estaOculta = (pathname: string) =>
  OCULTA_EN.some((p) => pathname === p || pathname.startsWith(p + "/"));

// Gesto táctil.
const ANCHO = 240; // w-60, en px: lo necesitamos como número para el arrastre
const BORDE = 28; // franja desde el borde izquierdo que arranca la apertura
const UMBRAL = 8; // px antes de decidir si el gesto es horizontal o vertical

export function SidebarGlobal() {
  const [open, setOpen] = useState(false);
  const [accesos, setAccesos] = useState<Acceso[]>([]);
  const [catalogo, setCatalogo] = useState<CatalogoItem[]>([]);
  const [cargado, setCargado] = useState(false);
  const [habilitada, setHabilitada] = useState(true); // 401 ⇒ se esconde
  const [drag, setDrag] = useState<number | null>(null);
  const [sobre, setSobre] = useState<number | null>(null);
  const pathname = usePathname();
  const oculta = estaOculta(pathname);

  // Se carga una sola vez, y recién cuando la sidebar se abre por primera vez.
  useEffect(() => {
    if (!open || cargado) return;
    setCargado(true);
    fetch("/api/preferencias/accesos")
      .then(async (r) => {
        if (r.status === 401) {
          setHabilitada(false);
          return null;
        }
        return r.ok ? r.json() : null;
      })
      .then((d) => {
        if (!d) return;
        setAccesos(d.accesos ?? []);
        setCatalogo(d.catalogo ?? []);
      })
      .catch(() => {});
  }, [open, cargado]);

  const cerrar = useCallback(() => {
    setOpen(false);
    setDrag(null);
    setSobre(null);
  }, []);

  // Los listeners táctiles se montan una sola vez: llegan a cerrar() por ref.
  const cerrarRef = useRef(cerrar);
  cerrarRef.current = cerrar;

  // ── Gesto táctil ──────────────────────────────────────────────────────────
  const [tactil, setTactil] = useState(false);
  const [arrastre, setArrastre] = useState<number | null>(null); // px visibles
  const arrastreRef = useRef<number | null>(null);
  const gesto = useRef<{ x0: number; y0: number; abierta: boolean; eje: "x" | "y" | null } | null>(
    null,
  );
  const abiertaRef = useRef(open);
  abiertaRef.current = open;

  useEffect(() => {
    const mq = window.matchMedia("(hover: none)");
    const sync = () => setTactil(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  const fijarArrastre = useCallback((v: number | null) => {
    arrastreRef.current = v;
    setArrastre(v);
  }, []);

  // Al entrar a una ruta sin sidebar se cierra (si no, quedaba el scroll del
  // body bloqueado por el efecto de abajo).
  useEffect(() => {
    if (oculta) cerrarRef.current();
  }, [oculta]);

  useEffect(() => {
    if (!tactil || oculta) return;

    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      const abierta = abiertaRef.current;
      if (!abierta && t.clientX > BORDE) return; // sólo desde el borde
      gesto.current = { x0: t.clientX, y0: t.clientY, abierta, eje: null };
    };

    const onMove = (e: TouchEvent) => {
      const g = gesto.current;
      if (!g || e.touches.length !== 1) return;
      const t = e.touches[0];
      const dx = t.clientX - g.x0;
      const dy = t.clientY - g.y0;
      if (g.eje === null) {
        if (Math.abs(dx) < UMBRAL && Math.abs(dy) < UMBRAL) return;
        // Vertical ⇒ es scroll de la página / del nav: soltamos el gesto.
        if (Math.abs(dy) >= Math.abs(dx)) {
          gesto.current = null;
          return;
        }
        g.eje = "x";
      }
      if (e.cancelable) e.preventDefault(); // frena el scroll horizontal del navegador
      const base = g.abierta ? ANCHO : 0;
      fijarArrastre(Math.max(0, Math.min(ANCHO, base + dx)));
    };

    const onEnd = () => {
      gesto.current = null;
      const x = arrastreRef.current;
      if (x === null) return;
      fijarArrastre(null);
      if (x > ANCHO / 2) setOpen(true);
      else cerrarRef.current();
    };

    document.addEventListener("touchstart", onStart, { passive: true });
    document.addEventListener("touchmove", onMove, { passive: false });
    document.addEventListener("touchend", onEnd);
    document.addEventListener("touchcancel", onEnd);
    return () => {
      document.removeEventListener("touchstart", onStart);
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onEnd);
      document.removeEventListener("touchcancel", onEnd);
    };
  }, [tactil, oculta, fijarArrastre]);

  // Con la sidebar abierta en mobile no se scrollea lo de atrás.
  useEffect(() => {
    if (!tactil || !open) return;
    const previo = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previo;
    };
  }, [tactil, open]);

  const fijado = useCallback(
    (href: string) => accesos.some((a) => a.href === href),
    [accesos],
  );

  // Optimista: la estrella responde al toque y después se persiste.
  const toggle = useCallback(
    async (href: string, label: string) => {
      const estaba = accesos.some((a) => a.href === href);
      setAccesos((prev) =>
        estaba ? prev.filter((a) => a.href !== href) : [...prev, { href, label }],
      );
      try {
        const r = estaba
          ? await fetch(`/api/preferencias/accesos?href=${encodeURIComponent(href)}`, {
              method: "DELETE",
            })
          : await fetch("/api/preferencias/accesos", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ href }),
            });
        if (!r.ok) throw new Error();
      } catch {
        setAccesos((prev) =>
          estaba ? [...prev, { href, label }] : prev.filter((a) => a.href !== href),
        );
      }
    },
    [accesos],
  );

  // Guarda el orden nuevo (lista completa de hrefs). Silencioso: si falla, se
  // corrige en la próxima carga.
  const persistirOrden = useCallback((lista: Acceso[]) => {
    fetch("/api/preferencias/accesos", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hrefs: lista.map((a) => a.href) }),
    }).catch(() => {});
  }, []);

  const soltar = useCallback(
    (destino: number) => {
      setDrag(null);
      setSobre(null);
      if (drag === null || drag === destino) return;
      setAccesos((prev) => {
        const lista = [...prev];
        const [movido] = lista.splice(drag, 1);
        lista.splice(destino, 0, movido);
        persistirOrden(lista);
        return lista;
      });
    },
    [drag, persistirOrden],
  );

  // Módulo en el que está parado: el ítem del catálogo cuyo href es el prefijo
  // más largo del pathname actual.
  const moduloActual = useMemo(() => {
    let mejor: CatalogoItem | null = null;
    for (const c of catalogo) {
      if (pathname === c.href || pathname.startsWith(c.href + "/")) {
        if (!mejor || c.href.length > mejor.href.length) mejor = c;
      }
    }
    return mejor?.grupo ?? null;
  }, [catalogo, pathname]);

  const vistasModulo = useMemo(
    () => (moduloActual ? catalogo.filter((c) => c.grupo === moduloActual) : []),
    [catalogo, moduloActual],
  );

  if (!habilitada || oculta) return null;

  // Mientras dura el gesto el panel va en px y sin transición; si no, manda `open`.
  const arrastrando = arrastre !== null;
  const visible = arrastrando ? arrastre! : open ? ANCHO : 0;

  return (
    <>
      {/* Franja invisible pegada al borde izquierdo: acercar el mouse abre */}
      <div
        className="fixed left-0 top-0 h-full w-3 z-[120]"
        onMouseEnter={() => {
          if (!tactil) setOpen(true);
        }}
      />

      {/* Backdrop: sólo táctil. Se oscurece a la par del gesto. */}
      {tactil && visible > 0 && (
        <div
          onClick={cerrar}
          aria-hidden
          className="fixed inset-0 z-[125] bg-black"
          style={{
            opacity: (visible / ANCHO) * 0.55,
            transition: arrastrando ? "none" : "opacity 200ms ease-out",
          }}
        />
      )}

      {/* Pestaña siempre visible (pista de que hay sidebar) */}
      <button
        onMouseEnter={() => {
          if (!tactil) setOpen(true);
        }}
        onClick={() => setOpen(true)}
        aria-label="Abrir menú"
        className={`fixed left-0 top-1/2 -translate-y-1/2 z-[120] flex items-center justify-center
          w-5 h-16 rounded-r-lg bg-[#1A1A1A] border border-l-0 border-yellow-400/40
          text-yellow-400 transition-opacity duration-200 ${visible > 0 ? "opacity-0 pointer-events-none" : "opacity-80"}`}
      >
        <ChevronRight size={14} />
      </button>

      <aside
        onMouseLeave={() => {
          if (!tactil && drag === null) cerrar();
        }}
        style={{
          transform: `translateX(${visible - ANCHO}px)`,
          transition: arrastrando ? "none" : undefined,
        }}
        className="fixed left-0 top-0 h-full w-60 z-[130] bg-[#161616] border-r border-zinc-800
          flex flex-col transition-transform duration-200 ease-out shadow-2xl shadow-black/60"
      >
        <div className="h-16 flex items-center border-b border-zinc-800">
          <Link
            href="/"
            onClick={cerrar}
            className="flex-1 min-w-0 h-full flex items-center gap-2.5 px-5 hover:bg-zinc-900/60 transition-colors"
          >
            <Home size={18} className="text-yellow-400 shrink-0" />
            <span className="font-bold text-yellow-400 uppercase tracking-wide text-sm truncate">
              {moduloActual ?? "EverWear"}
            </span>
          </Link>
          {/* En táctil no hay mouseleave que cierre: X explícita. */}
          <button
            onClick={cerrar}
            aria-label="Cerrar menú"
            className="md:hidden shrink-0 mr-2 p-2 rounded-lg text-zinc-500 hover:text-zinc-100
              hover:bg-zinc-800/60 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto py-3 px-2 space-y-1">
          {/* ── Mis accesos ── */}
          <div className="px-3 pt-1 pb-1.5 text-[10px] uppercase tracking-wider text-zinc-600 font-semibold">
            Mis accesos
          </div>
          {accesos.length === 0 && (
            <p className="px-3 pb-1 text-[11px] leading-snug text-zinc-600">
              Vacío. Tocá la{" "}
              <Star size={11} className="inline -mt-0.5 text-yellow-400/70" /> de cualquier vista
              para fijarla acá.
            </p>
          )}
          {accesos.map(({ href, label }, i) => (
            <ItemNav
              key={`fav-${href}`}
              href={href}
              label={label}
              activo={pathname === href}
              fijado
              onToggle={() => toggle(href, label)}
              onNavegar={cerrar}
              arrastrable
              arrastrando={drag === i}
              marcado={sobre === i && drag !== null && drag !== i}
              onDragStart={() => setDrag(i)}
              onDragEnter={() => setSobre(i)}
              onDrop={() => soltar(i)}
              onDragEnd={() => {
                setDrag(null);
                setSobre(null);
              }}
            />
          ))}
          {accesos.length > 1 && (
            <p className="px-3 pt-1 text-[10px] text-zinc-700">Arrastrá ⋮⋮ para ordenar</p>
          )}

          {/* ── Vistas del módulo actual ── */}
          {vistasModulo.length > 0 && (
            <>
              <div className="h-px bg-zinc-800 mx-3 my-2" />
              <div className="px-3 pb-1.5 text-[10px] uppercase tracking-wider text-zinc-600 font-semibold">
                {moduloActual}
              </div>
              {vistasModulo.map(({ href, label }) => (
                <ItemNav
                  key={href}
                  href={href}
                  label={label}
                  activo={pathname === href}
                  fijado={fijado(href)}
                  onToggle={() => toggle(href, label)}
                  onNavegar={cerrar}
                />
              ))}
            </>
          )}

        </nav>

        <div className="px-5 py-3 border-t border-zinc-800 text-[11px] text-zinc-600">
          EVER WEAR S.A.
        </div>
      </aside>
    </>
  );
}

// Fila de la sidebar: manija (sólo en "Mis accesos") + link + estrella.
// La estrella se ve tenue siempre y se prende al hover; NO navega
// (preventDefault + stopPropagation: es un <button> adentro de un <Link>).
function ItemNav({
  href,
  label,
  activo,
  fijado,
  onToggle,
  onNavegar,
  arrastrable,
  arrastrando,
  marcado,
  onDragStart,
  onDragEnter,
  onDrop,
  onDragEnd,
}: {
  href: string;
  label: string;
  activo: boolean;
  fijado: boolean;
  onToggle: () => void;
  onNavegar: () => void;
  arrastrable?: boolean;
  arrastrando?: boolean;
  marcado?: boolean;
  onDragStart?: () => void;
  onDragEnter?: () => void;
  onDrop?: () => void;
  onDragEnd?: () => void;
}) {
  return (
    <div
      className={`group relative rounded-lg transition-colors ${arrastrando ? "opacity-40" : ""} ${
        marcado ? "ring-1 ring-yellow-400/60" : ""
      }`}
      draggable={!!arrastrable}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        onDragStart?.();
      }}
      onDragOver={(e) => {
        if (arrastrable) e.preventDefault();
      }}
      onDragEnter={() => onDragEnter?.()}
      onDrop={(e) => {
        e.preventDefault();
        onDrop?.();
      }}
      onDragEnd={() => onDragEnd?.()}
    >
      <Link
        href={href}
        draggable={false}
        onClick={onNavegar}
        className={`flex items-center gap-2 ${arrastrable ? "pl-1" : "pl-3"} pr-9 py-2.5 rounded-lg border text-sm font-medium transition-colors ${
          activo
            ? "bg-yellow-400/10 border-yellow-400/40 text-yellow-400"
            : "border-transparent text-zinc-400 hover:text-zinc-100 hover:border-zinc-700"
        }`}
      >
        {arrastrable && (
          <span
            title="Arrastrar para ordenar"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            className="shrink-0 cursor-grab active:cursor-grabbing text-zinc-700 group-hover:text-zinc-500"
          >
            <GripVertical size={14} />
          </span>
        )}
        <span className="truncate">{label}</span>
      </Link>
      <button
        title={fijado ? "Quitar de Mis accesos" : "Fijar en Mis accesos"}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onToggle();
        }}
        className={`absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded transition-opacity ${
          fijado
            ? "opacity-100 text-yellow-400"
            : "opacity-40 group-hover:opacity-100 text-zinc-500 hover:text-yellow-400"
        }`}
      >
        <Star size={14} fill={fijado ? "currentColor" : "none"} />
      </button>
    </div>
  );
}
