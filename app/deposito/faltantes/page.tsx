"use client";
import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import {
  Loader2,
  RefreshCw,
  AlertTriangle,
  AlertOctagon,
  Undo2,
  Check,
  X,
  PackageCheck,
  MapPin,
  Download,
} from "lucide-react";
import { InicioButton } from "@/components/ui/InicioButton";
import { exportarFaltantesExistencia } from "@/lib/deposito/exportFaltantesExistencia";
import { UsuarioActual } from "@/components/auth/UsuarioActual";
import { abrirPicker } from "@/components/ui/abrirPicker";

// ──────────────────────────────────────────────────────────────────────────────
// Faltantes — renglones pendientes del último día con registro (anterior a hoy).
//   PC      : tabla con vendedor + marcado por fila (verde/rojo).
//   Celular : pantalla completa, 1 artículo a la vez (detalles apilados),
//             Deshacer arriba · En existencia (verde) / Sin existencia (rojo) abajo.
//   Cada marca se guarda al instante en Postgres (preparado.faltante_existencia).
//   Exportar Excel (PC, header) = histórico del mes elegido, no el día en
//   pantalla — pega a GET /api/deposito/faltantes/historico?mes=YYYY-MM.
// ──────────────────────────────────────────────────────────────────────────────

// Mes actual ("YYYY-MM") — default del selector de exportación (se puede
// elegir cualquier otro mes, ej. julio, desde el mismo input).
function mesActual(): string {
  return new Date().toISOString().slice(0, 7);
}

interface Item {
  NroPedOrigen: number;
  NroRengOrigen: number;
  Ubicacion: number | string | null;
  CodArticulo: string;
  Nombre: string;
  CantPend: number; // ya neta de lo que venía en tránsito a central
  EnTransito?: number; // descontado por transferencia sucursal → central
  Cliente: number | string | null;
  Importe: number;
  TipoArticulo: string | null;
  Preparador: string | null;
  Linea: string | number | null;
  Proveedor: string | null;
  Vendedor: string | null;
}
type Estado = "pendiente" | "si" | "no" | "mal";
interface Mark {
  nroPedOrigen: number;
  nroRengOrigen: number;
  codArticulo: string;
  existencia: boolean | null;
  malFacturado: boolean | null;
  cantidad: number | null;
}
// Catálogo de novedades (preparado.faltante_novedad_tipo). Llega en la 1ra carga:
// se muestra el nombre, se guarda el id.
interface Tipo {
  id: number;
  nombre: string;
}

const keyOf = (it: { NroPedOrigen: number; NroRengOrigen: number }) =>
  `${it.NroPedOrigen}-${it.NroRengOrigen}`;
const fmtNum = (n: number) =>
  new Intl.NumberFormat("es-AR", { maximumFractionDigits: 2 }).format(n || 0);
const fmtAr = (s: string) => {
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(s || "");
  return m ? `${m[3]}/${m[2]}/${m[1]}` : s || "—";
};

export default function FaltantesPage() {
  const [items, setItems] = useState<Item[]>([]);
  const [fecha, setFecha] = useState("");
  const [estados, setEstados] = useState<Record<string, Estado>>({});
  const [tipos, setTipos] = useState<Tipo[]>([]); // catálogo de novedades
  const [novedades, setNovedades] = useState<Record<string, number | null>>({}); // novedad por renglón (id)
  const [cantidades, setCantidades] = useState<Record<string, number | null>>({}); // cantidad por renglón
  const [idx, setIdx] = useState(0); // puntero del flujo móvil
  const [undoStack, setUndoStack] = useState<
    { keys: string[]; prev: Record<string, Estado>; idx: number }[]
  >([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ubicArt, setUbicArt] = useState<string | null>(null); // artículo del modal de ubicaciones
  const [exitDir, setExitDir] = useState<"left" | "right" | "up" | null>(null); // tarjeta móvil saliendo
  const [transitioning, setTransitioning] = useState(false);
  const [mesExport, setMesExport] = useState(mesActual);
  const [exportLoading, setExportLoading] = useState(false);
  // Acumulado del mes en curso — DOS series, según la marca de la mesa:
  //   sinExistencia → faltante real (marcado "sin existencia")
  //   enExistencia  → no se cumplió habiendo stock (marcado "en existencia")
  // Lo pendiente y "mal facturado" no suman en ninguna. Las tablas las
  // registra/recalcula el propio endpoint — acá solo se lee para el header.
  interface MesResumenBloque {
    unidades: number;
    importe: number;
    articulos: number;
  }
  const [mesResumen, setMesResumen] = useState<{
    sinExistencia: MesResumenBloque;
    enExistencia: MesResumenBloque;
  } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const fRes = await fetch("/api/deposito/faltantes", {
        cache: "no-store",
      });
      const fj = await fRes.json().catch(() => ({}));
      if (!fRes.ok) throw new Error(fj.error || `HTTP ${fRes.status}`);
      const rows: Item[] = fj.rows ?? [];
      const fch: string = fj.fecha ?? "";
      setItems(rows);
      setFecha(fch);

      // Catálogo de novedades (no depende de la fecha).
      const tRes = await fetch("/api/deposito/faltantes/novedades", {
        cache: "no-store",
      });
      if (tRes.ok) {
        const tj = await tRes.json().catch(() => ({ tipos: [] }));
        setTipos((tj.tipos ?? []) as Tipo[]);
      }

      const est: Record<string, Estado> = {};
      const cant: Record<string, number | null> = {};
      const nov: Record<string, number | null> = {};
      if (fch) {
        const [cRes, nRes] = await Promise.all([
          fetch(`/api/deposito/faltantes/check?fecha=${fch}`, {
            cache: "no-store",
          }),
          fetch(`/api/deposito/faltantes/novedad?fecha=${fch}`, {
            cache: "no-store",
          }),
        ]);
        if (cRes.ok) {
          const cj = await cRes.json().catch(() => ({ rows: [] }));
          for (const m of (cj.rows ?? []) as Mark[]) {
            const k = `${m.nroPedOrigen}-${m.nroRengOrigen}`;
            if (m.malFacturado) est[k] = "mal";
            else if (typeof m.existencia === "boolean")
              est[k] = m.existencia ? "si" : "no";
            if (m.cantidad !== null && m.cantidad !== undefined)
              cant[k] = m.cantidad;
          }
        }
        if (nRes.ok) {
          const nj = await nRes.json().catch(() => ({ rows: [] }));
          for (const r of (nj.rows ?? []) as {
            nroPedOrigen: number;
            nroRengOrigen: number;
            novedadId: number | null;
          }[])
            nov[`${r.nroPedOrigen}-${r.nroRengOrigen}`] = r.novedadId;
        }
      }
      setEstados(est);
      setNovedades(nov);
      setCantidades(cant);
      setUndoStack([]);
      const first = rows.findIndex((r) => !est[keyOf(r)]);
      setIdx(first < 0 ? rows.length : first);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al cargar");
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // PC y celular leen el mismo `items` (misma consulta a ot-diferencias, que ya
  // excluye pedidos cancelados en Magnus). El "PC muestra cancelados / celular
  // no" que se reportó no es un filtro distinto entre vistas — es una pestaña
  // de PC dejada abierta muchas horas sin recargar: el celular se abre/recarga
  // seguido durante el día y ve la lista al día, mientras el PC se queda con
  // el snapshot de cuando cargó, incluyendo pedidos que se cancelaron después.
  // Fix: reconsultar solo (sin tocar el flujo/posición del celular) cada 3 min
  // y también al volver a la pestaña, para que ambas vistas converjan solas.
  const transitioningRef = useRef(transitioning);
  useEffect(() => {
    transitioningRef.current = transitioning;
  }, [transitioning]);
  useEffect(() => {
    const REFRESH_MS = 3 * 60 * 1000;
    const tick = () => {
      if (document.visibilityState === "visible" && !transitioningRef.current)
        load();
    };
    const id = window.setInterval(tick, REFRESH_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [load]);

  // Los 3 estados (si/no/mal facturado) son excluyentes entre sí: al marcar
  // uno se manda existencia + malFacturado juntos, así el otro campo se limpia
  // en el mismo POST (ver comentario en check/route.ts).
  const persistEstado = useCallback(
    (it: Item, estado: "si" | "no" | "mal") =>
      fetch("/api/deposito/faltantes/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fecha,
          nroPedOrigen: it.NroPedOrigen,
          nroRengOrigen: it.NroRengOrigen,
          codArticulo: it.CodArticulo,
          existencia: estado === "si" ? true : estado === "no" ? false : null,
          malFacturado: estado === "mal",
        }),
      }).catch(() => setError("No se pudo guardar la marca")),
    [fecha],
  );

  // Novedad por renglón (id del catálogo, o null = sin novedad). Guarda al instante.
  const saveNovedad = useCallback(
    (it: Item, novedadId: number | null) => {
      const k = keyOf(it);
      setNovedades((m) => ({ ...m, [k]: novedadId }));
      fetch("/api/deposito/faltantes/novedad", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fecha,
          nroPedOrigen: it.NroPedOrigen,
          nroRengOrigen: it.NroRengOrigen,
          codArticulo: it.CodArticulo,
          novedadId,
        }),
      }).catch(() => setError("No se pudo guardar la novedad"));
    },
    [fecha],
  );

  // Cantidad por renglón (número libre). Guarda al instante, independiente
  // de si ya se marcó existencia/sin existencia.
  const saveCantidad = useCallback(
    (it: Item, cantidad: number | null) => {
      const k = keyOf(it);
      setCantidades((m) => ({ ...m, [k]: cantidad }));
      fetch("/api/deposito/faltantes/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fecha,
          nroPedOrigen: it.NroPedOrigen,
          nroRengOrigen: it.NroRengOrigen,
          codArticulo: it.CodArticulo,
          cantidad,
        }),
      }).catch(() => setError("No se pudo guardar la cantidad"));
    },
    [fecha],
  );

  // Versiones "grupo" (PC): aplican el mismo valor a todos los renglones
  // agrupados por artículo — sigue guardando por (pedido, renglón) como antes.
  const saveCantidadGroup = useCallback(
    (group: Item[], cantidad: number | null) => {
      setCantidades((m) => {
        const n = { ...m };
        for (const it of group) n[keyOf(it)] = cantidad;
        return n;
      });
      for (const it of group) {
        fetch("/api/deposito/faltantes/check", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fecha,
            nroPedOrigen: it.NroPedOrigen,
            nroRengOrigen: it.NroRengOrigen,
            codArticulo: it.CodArticulo,
            cantidad,
          }),
        }).catch(() => setError("No se pudo guardar la cantidad"));
      }
    },
    [fecha],
  );

  const saveNovedadGroup = useCallback(
    (group: Item[], novedadId: number | null) => {
      setNovedades((m) => {
        const n = { ...m };
        for (const it of group) n[keyOf(it)] = novedadId;
        return n;
      });
      for (const it of group) {
        fetch("/api/deposito/faltantes/novedad", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fecha,
            nroPedOrigen: it.NroPedOrigen,
            nroRengOrigen: it.NroRengOrigen,
            codArticulo: it.CodArticulo,
            novedadId,
          }),
        }).catch(() => setError("No se pudo guardar la novedad"));
      }
    },
    [fecha],
  );

  // Celular: marca y avanza al siguiente. La tarjeta actual sale volando hacia
  // el costado (verde → derecha, rojo → izquierda) o hacia arriba (mal
  // facturado, violeta) y recién ahí avanza el puntero — así hay tiempo de
  // ver la animación antes de que cambie el dato.
  const mark = useCallback(
    (it: Item, estado: "si" | "no" | "mal") => {
      if (transitioning) return;
      const k = keyOf(it);
      setTransitioning(true);
      setExitDir(estado === "si" ? "right" : estado === "no" ? "left" : "up");
      const prev = estados[k] ?? "pendiente";
      setEstados((s) => ({ ...s, [k]: estado }));
      void persistEstado(it, estado);
      window.setTimeout(() => {
        setUndoStack((u) => [...u, { keys: [k], prev: { [k]: prev }, idx }]);
        setIdx((i) => Math.min(i + 1, items.length));
        setExitDir(null);
        setTransitioning(false);
      }, 260);
    },
    [estados, idx, items.length, persistEstado, transitioning],
  );

  // PC: marca todos los renglones de un artículo agrupado a la vez (un solo
  // chequeo de stock aplica a todos los pedidos pendientes de ese artículo).
  const markGroup = useCallback(
    (group: Item[], estado: "si" | "no" | "mal") => {
      const prev: Record<string, Estado> = {};
      const keys = group.map((it) => {
        const k = keyOf(it);
        prev[k] = estados[k] ?? "pendiente";
        return k;
      });
      setUndoStack((u) => [...u, { keys, prev, idx }]);
      setEstados((s) => {
        const n = { ...s };
        for (const k of keys) n[k] = estado;
        return n;
      });
      for (const it of group) void persistEstado(it, estado);
    },
    [estados, idx, persistEstado],
  );

  const undo = useCallback(() => {
    const last = undoStack[undoStack.length - 1];
    if (!last) return;
    setUndoStack((u) => u.slice(0, -1));
    setEstados((s) => {
      const n = { ...s };
      for (const k of last.keys) {
        const p = last.prev[k];
        if (p === "pendiente") delete n[k];
        else n[k] = p;
      }
      return n;
    });
    setIdx(last.idx);
    for (const k of last.keys) {
      const p = last.prev[k];
      const [ped, reng] = k.split("-").map(Number);
      const body =
        p === "pendiente"
          ? {
              method: "DELETE",
              payload: { fecha, nroPedOrigen: ped, nroRengOrigen: reng },
            }
          : {
              method: "POST",
              payload: {
                fecha,
                nroPedOrigen: ped,
                nroRengOrigen: reng,
                codArticulo: "",
                existencia: p === "si" ? true : p === "no" ? false : null,
                malFacturado: p === "mal",
              },
            };
      fetch("/api/deposito/faltantes/check", {
        method: body.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body.payload),
      }).catch(() => setError("No se pudo deshacer"));
    }
  }, [undoStack, fecha]);

  // Acumulado del mes: se recarga cuando cambia el día en pantalla (o sea,
  // después de cada load) porque esa misma llamada ya dejó el mes registrado.
  useEffect(() => {
    const mes = (fecha || new Date().toISOString().slice(0, 10)).slice(0, 7);
    let vivo = true;
    fetch(`/api/deposito/faltantes/mes?mes=${mes}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!vivo || (!j?.sinExistencia && !j?.enExistencia)) return;
        const bloque = (b: unknown): MesResumenBloque => {
          const r = (b as { resumen?: Record<string, number> })?.resumen ?? {};
          return {
            unidades: Number(r.unidades ?? 0),
            importe: Number(r.importe ?? 0),
            articulos: Number(r.articulos ?? 0),
          };
        };
        setMesResumen({
          sinExistencia: bloque(j.sinExistencia),
          enExistencia: bloque(j.enExistencia),
        });
      })
      .catch(() => {});
    return () => {
      vivo = false;
    };
  }, [fecha]);

  // Exportar Excel del mes elegido (histórico completo de marcas, no el día
  // que está en pantalla). Trae nombre/ubicación/cliente vía el join
  // best-effort con preparado.faltante_wms que hace el endpoint.
  const exportarMes = useCallback(async () => {
    setExportLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/deposito/faltantes/historico?mes=${mesExport}`,
        { cache: "no-store" },
      );
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      if (!j.rows?.length) {
        setError(`Sin marcas registradas en ${mesExport}`);
        return;
      }
      exportarFaltantesExistencia(j.rows, mesExport);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al exportar");
    } finally {
      setExportLoading(false);
    }
  }, [mesExport]);

  const counts = useMemo(() => {
    let si = 0,
      no = 0,
      mal = 0;
    for (const it of items) {
      const e = estados[keyOf(it)];
      if (e === "si") si++;
      else if (e === "no") no++;
      else if (e === "mal") mal++;
    }
    return {
      si,
      no,
      mal,
      pend: items.length - si - no - mal,
      total: items.length,
    };
  }, [items, estados]);

  // PC: agrupa los renglones por artículo — una fila por CodArticulo, sin
  // perder de vista a qué preparadores/clientes les faltó (se listan todos).
  const grupos = useMemo(() => {
    const map = new Map<string, Item[]>();
    for (const it of items) {
      const arr = map.get(it.CodArticulo);
      if (arr) arr.push(it);
      else map.set(it.CodArticulo, [it]);
    }
    return Array.from(map.values());
  }, [items]);

  const current = items[idx];
  const hay = items.length > 0;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <>
      {/* ════════════ CELULAR: pantalla completa, 1 artículo ════════════ */}
      <div className="md:hidden fixed inset-0 z-[60] flex flex-col bg-[#111111] text-white">
        <div className="h-14 shrink-0 flex items-center justify-between px-4 border-b border-zinc-800">
          <button
            onClick={undo}
            disabled={!undoStack.length || transitioning}
            className="btn-anim flex items-center gap-1.5 text-sm font-medium text-zinc-300 disabled:opacity-30 disabled:hover:scale-100 disabled:hover:translate-y-0 active:text-yellow-400"
          >
            <Undo2 size={18} /> Deshacer
          </button>
          <div className="text-right leading-tight">
            <div className="text-sm font-semibold text-yellow-400">
              {Math.min(counts.si + counts.no + counts.mal + 1, counts.total)}{" "}
              / {counts.total}
            </div>
            <div className="text-[11px] text-zinc-500">{fmtAr(fecha)}</div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading && !hay ? (
            <div className="h-full flex flex-col items-center justify-center gap-3 text-zinc-400">
              <Loader2 size={36} className="animate-spin text-yellow-400" />{" "}
              Cargando…
            </div>
          ) : !hay ? (
            <div className="h-full flex flex-col items-center justify-center gap-3 px-8 text-center text-zinc-400">
              <PackageCheck size={44} className="text-zinc-700" />
              {error ? error : "No hay faltantes para revisar."}
            </div>
          ) : !current ? (
            <div className="h-full flex flex-col items-center justify-center gap-3 px-8 text-center">
              <PackageCheck size={56} className="text-green-500" />
              <p className="text-lg font-semibold">Revisión completa</p>
              <p className="text-sm text-zinc-400">
                {counts.si} en existencia · {counts.no} sin existencia ·{" "}
                {counts.mal} mal facturado · {counts.total} total
              </p>
              <button
                onClick={undo}
                disabled={!undoStack.length}
                className="btn-anim mt-2 flex items-center gap-1.5 text-sm text-zinc-300 disabled:opacity-30"
              >
                <Undo2 size={16} /> Deshacer último
              </button>
            </div>
          ) : (
            <div
              key={keyOf(current)}
              className={
                exitDir === "right"
                  ? "card-out-right"
                  : exitDir === "left"
                    ? "card-out-left"
                    : exitDir === "up"
                      ? "card-out-up"
                      : "animate-in fade-in slide-in-from-bottom-2 duration-300"
              }
            >
              <CardDetalle
                it={current}
                estado={estados[keyOf(current)] ?? "pendiente"}
                cantidad={cantidades[keyOf(current)] ?? null}
                onCantidad={(v) => saveCantidad(current, v)}
                onUbic={() => setUbicArt(current.CodArticulo)}
              />
            </div>
          )}
        </div>

        {hay && current && (
          <div className="relative shrink-0">
            <div className="grid grid-cols-2 gap-px bg-zinc-800">
              <button
                onClick={() => mark(current, "si")}
                disabled={transitioning}
                className="h-24 flex flex-col items-center justify-center gap-1 bg-green-600 active:bg-green-700 active:scale-[0.97] text-white font-bold text-lg transition-transform duration-150 disabled:opacity-60"
              >
                <Check size={28} /> En existencia
              </button>
              <button
                onClick={() => mark(current, "no")}
                disabled={transitioning}
                className="h-24 flex flex-col items-center justify-center gap-1 bg-red-600 active:bg-red-700 active:scale-[0.97] text-white font-bold text-lg transition-transform duration-150 disabled:opacity-60"
              >
                <X size={28} /> Sin existencia
              </button>
            </div>
            {/* Tercera acción (más rara que si/no): círculo morado flotando
                en el medio, arriba de los dos botones grandes — no les come
                espacio pero queda igual de alcanzable con el pulgar. */}
            <button
              onClick={() => mark(current, "mal")}
              disabled={transitioning}
              title="Mal facturado"
              className="btn-anim absolute left-1/2 -top-7 -translate-x-1/2 z-10 w-14 h-14 rounded-full bg-purple-600 active:bg-purple-700 active:scale-[0.94] text-white flex items-center justify-center border-4 border-[#111111] shadow-lg shadow-black/50 disabled:opacity-60"
            >
              <AlertOctagon size={22} />
            </button>
          </div>
        )}
      </div>

      {/* ════════════ PC: tabla con vendedor + marcado por fila ════════════ */}
      <div className="hidden md:block min-h-screen bg-[#111111] text-white">
        {(loading || error) && (
          <div className="fixed bottom-6 right-6 z-[110] flex flex-col gap-2">
            {loading && (
              <div className="flex items-center gap-3 bg-[#1A1A1A] border border-yellow-400/40 rounded-xl px-5 py-3 text-sm text-zinc-200">
                <Loader2 size={16} className="animate-spin text-yellow-400" />{" "}
                Consultando la base…
              </div>
            )}
            {error && (
              <div className="flex items-center gap-3 bg-[#1A1A1A] border border-red-400/40 rounded-xl px-5 py-3 text-sm text-red-300">
                <AlertTriangle size={16} className="text-red-400" /> {error}
              </div>
            )}
          </div>
        )}

        <header className="sticky top-0 z-50 bg-[#1A1A1A] border-b-[3px] border-yellow-400 flex items-center justify-between px-8 h-16 gap-4">
          <div className="flex items-center gap-4">
            <InicioButton />
            <span className="font-bold text-yellow-400 text-2xl tracking-wide uppercase">
              EVER WEAR{" "}
              <span className="text-sm tracking-[3px] font-normal">S.A.</span>
            </span>
            <div className="w-px h-7 bg-yellow-400/30" />
            <span className="text-zinc-500 text-sm">
              Faltantes · {fmtAr(fecha)}
            </span>
          </div>
          <div className="flex items-center gap-4 text-sm">
            <span className="text-zinc-400">
              <b className="text-green-400">{counts.si}</b> en exist. ·{" "}
              <b className="text-red-400">{counts.no}</b> sin ·{" "}
              <b className="text-purple-400">{counts.mal}</b> mal fact. ·{" "}
              <b className="text-yellow-400">{counts.pend}</b> pend. ·{" "}
              <b className="text-zinc-200">{counts.total}</b> total
            </span>
            {mesResumen && (
              <span
                title={`Marcado SIN existencia en el mes (faltante real): ${fmtNum(mesResumen.sinExistencia.unidades)} unidades en ${fmtNum(mesResumen.sinExistencia.articulos)} artículos`}
                className="px-2.5 py-1 rounded-lg border border-red-400/40 bg-red-400/10 text-red-300 whitespace-nowrap"
              >
                Faltó: <b>{fmtNum(mesResumen.sinExistencia.unidades)}</b> u. ·{" "}
                <b>{fmtNum(mesResumen.sinExistencia.articulos)}</b> art.
              </span>
            )}
            {mesResumen && mesResumen.enExistencia.articulos > 0 && (
              <span
                title={`Marcado EN existencia pero no cumplido en el mes (falla de proceso, no de stock): ${fmtNum(mesResumen.enExistencia.unidades)} unidades en ${fmtNum(mesResumen.enExistencia.articulos)} artículos`}
                className="px-2.5 py-1 rounded-lg border border-zinc-600/50 bg-zinc-700/20 text-zinc-300 whitespace-nowrap"
              >
                No cumplido habiendo: <b>{fmtNum(mesResumen.enExistencia.unidades)}</b> u. ·{" "}
                <b>{fmtNum(mesResumen.enExistencia.articulos)}</b> art.
              </span>
            )}
            <button
              onClick={undo}
              disabled={!undoStack.length}
              title="Deshacer"
              className="btn-anim flex items-center gap-1.5 text-zinc-400 hover:text-yellow-400 disabled:opacity-30 disabled:hover:scale-100 disabled:hover:translate-y-0"
            >
              <Undo2 size={16} /> Deshacer
            </button>
            <button
              onClick={load}
              title="Refrescar"
              disabled={loading}
              className="btn-anim text-zinc-400 hover:text-yellow-400 p-2 disabled:opacity-40 disabled:hover:scale-100 disabled:hover:translate-y-0"
            >
              <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
            </button>
            <div className="w-px h-7 bg-yellow-400/30" />
            <input
              type="month"
              onClick={abrirPicker}
              value={mesExport}
              onChange={(e) => setMesExport(e.target.value)}
              title="Mes a exportar"
              className="bg-zinc-900 border border-zinc-700 rounded-lg px-2 py-1.5 text-xs text-zinc-100 outline-none focus:border-yellow-400 cursor-pointer"
            />
            <button
              onClick={exportarMes}
              disabled={exportLoading}
              title="Exportar Excel del mes (con/sin existencia)"
              className="btn-anim flex items-center gap-1.5 text-zinc-400 hover:text-yellow-400 disabled:opacity-40 disabled:hover:scale-100 disabled:hover:translate-y-0"
            >
              {exportLoading ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <Download size={16} />
              )}
              Exportar
            </button>
            <UsuarioActual />
          </div>
        </header>

        <main className="max-w-[1500px] mx-auto px-8 py-6">
          {!hay ? (
            <div className="flex flex-col items-center justify-center py-28 gap-3 text-center">
              {loading ? (
                <Loader2 size={40} className="text-yellow-400 animate-spin" />
              ) : (
                <PackageCheck size={44} className="text-zinc-700" />
              )}
              <p className="text-zinc-400 font-medium">
                {loading
                  ? "Consultando la base…"
                  : "No hay faltantes para revisar."}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-zinc-800">
              <table className="w-full text-sm">
                <thead className="bg-[#1A1A1A] text-zinc-400 sticky">
                  <tr className="text-left">
                    <th className="px-3 py-2.5 font-medium">Estado</th>
                    <th className="px-3 py-2.5 font-medium text-right">
                      Ubic.
                    </th>
                    <th className="px-3 py-2.5 font-medium">Cód.</th>
                    <th className="px-3 py-2.5 font-medium">Nombre</th>
                    <th className="px-3 py-2.5 font-medium text-right">
                      Cant.
                    </th>
                    <th className="px-3 py-2.5 font-medium">Cliente</th>
                    <th className="px-3 py-2.5 font-medium text-right">
                      Cantidad
                    </th>
                    {/* <th className="px-3 py-2.5 font-medium">Vendedor</th> */}
                    {/* <th className="px-3 py-2.5 font-medium text-right">Importe</th> */}
                    {/* <th className="px-3 py-2.5 font-medium">Tipo</th> */}
                    {/* <th className="px-3 py-2.5 font-medium">Línea</th> */}
                    <th className="px-3 py-2.5 font-medium">Preparador</th>
                    {/* <th className="px-3 py-2.5 font-medium">Proveedor</th> */}
                    <th className="px-3 py-2.5 font-medium">Novedad</th>
                    <th className="px-3 py-2.5 font-medium text-center">
                      Acción
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {grupos.map((group) => {
                    const first = group[0];
                    const allSi = group.every(
                      (it) => (estados[keyOf(it)] ?? "pendiente") === "si",
                    );
                    const allNo = group.every(
                      (it) => (estados[keyOf(it)] ?? "pendiente") === "no",
                    );
                    const allMal = group.every(
                      (it) => (estados[keyOf(it)] ?? "pendiente") === "mal",
                    );
                    const e: Estado = allSi
                      ? "si"
                      : allNo
                        ? "no"
                        : allMal
                          ? "mal"
                          : "pendiente";
                    const cantTotal = group.reduce(
                      (s, it) => s + (it.CantPend || 0),
                      0,
                    );
                    const ubicaciones = Array.from(
                      new Set(group.map((it) => String(it.Ubicacion ?? "—"))),
                    );
                    const preparadores = Array.from(
                      new Set(group.map((it) => it.Preparador || "—")),
                    );
                    const cantidadGrupo =
                      group
                        .map((it) => cantidades[keyOf(it)])
                        .find((v) => v !== null && v !== undefined) ?? null;
                    const novedadGrupo =
                      group
                        .map((it) => novedades[keyOf(it)])
                        .find((v) => v !== null && v !== undefined) ?? null;
                    return (
                      <tr
                        key={first.CodArticulo}
                        className={`border-t border-zinc-800/70 transition-colors duration-300 animate-in fade-in duration-300 ${
                          e === "si"
                            ? "bg-green-950/30"
                            : e === "no"
                              ? "bg-red-950/30"
                              : e === "mal"
                                ? "bg-purple-950/30"
                                : "hover:bg-zinc-900/50"
                        }`}
                      >
                        <td className="px-3 py-2">
                          <Pill e={e} />
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-zinc-300">
                          {ubicaciones.join(", ")}
                        </td>
                        <td className="px-3 py-2 font-mono text-zinc-300">
                          <button
                            onClick={() => setUbicArt(first.CodArticulo)}
                            title="Ver ubicaciones"
                            className="chip-anim inline-flex items-center gap-1 hover:text-yellow-400"
                          >
                            <MapPin size={13} className="text-zinc-500" />
                            {first.CodArticulo}
                          </button>
                        </td>
                        <td className="px-3 py-2 text-zinc-100">
                          {first.Nombre}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {fmtNum(cantTotal)}
                        </td>
                        <td className="px-3 py-2 text-zinc-300">
                          <div className="flex flex-col gap-0.5">
                            {group.map((it) => (
                              <span key={keyOf(it)} className="text-xs">
                                {it.Cliente ?? "—"}{" "}
                                <span className="text-zinc-500">
                                  ({fmtNum(it.CantPend)})
                                </span>
                                {(it.EnTransito ?? 0) > 0 && (
                                  <span
                                    className="ml-1 text-sky-400"
                                    title="Descontado: una sucursal lo transfirió a central y viene en el transporte"
                                  >
                                    +{fmtNum(it.EnTransito ?? 0)} en tránsito
                                  </span>
                                )}
                              </span>
                            ))}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-right">
                          <input
                            type="number"
                            inputMode="decimal"
                            value={cantidadGrupo ?? ""}
                            onChange={(ev) => {
                              const v = ev.target.value;
                              const val = v === "" ? null : Number(v);
                              setCantidades((m) => {
                                const n = { ...m };
                                for (const it of group) n[keyOf(it)] = val;
                                return n;
                              });
                            }}
                            onBlur={(ev) => {
                              const v = ev.target.value;
                              saveCantidadGroup(
                                group,
                                v === "" ? null : Number(v),
                              );
                            }}
                            className="w-20 bg-[#1f1f1f] border border-zinc-700 rounded-md px-2 py-1.5 text-sm text-right text-zinc-100 focus:border-yellow-400 outline-none"
                          />
                        </td>
                        {/* <td className="px-3 py-2 text-zinc-300">{it.Vendedor || "—"}</td> */}
                        {/* <td className="px-3 py-2 text-right tabular-nums text-zinc-300">
                          ${fmtNum(it.Importe)}
                        </td> */}
                        {/* <td className="px-3 py-2 text-zinc-400">{it.TipoArticulo || "—"}</td> */}
                        {/* <td className="px-3 py-2 text-zinc-400">{it.Linea ?? "—"}</td> */}
                        <td className="px-3 py-2 text-zinc-400">
                          <div className="flex flex-col gap-0.5">
                            {preparadores.map((p, i) => (
                              <span key={i} className="text-xs">
                                {p}
                              </span>
                            ))}
                          </div>
                        </td>
                        {/* <td className="px-3 py-2 text-zinc-400">{it.Proveedor || "—"}</td> */}
                        <td className="px-3 py-2">
                          <NovedadSelect
                            tipos={tipos}
                            value={novedadGrupo}
                            onChange={(id) => saveNovedadGroup(group, id)}
                          />
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex items-center justify-center gap-1.5">
                            <button
                              onClick={() => markGroup(group, "si")}
                              title="En existencia"
                              className={`btn-anim p-1.5 rounded-md border ${
                                e === "si"
                                  ? "bg-green-600 border-green-600 text-white"
                                  : "border-zinc-700 text-green-500 hover:bg-green-600/20"
                              }`}
                            >
                              <Check size={15} />
                            </button>
                            <button
                              onClick={() => markGroup(group, "no")}
                              title="Sin existencia"
                              className={`btn-anim p-1.5 rounded-md border ${
                                e === "no"
                                  ? "bg-red-600 border-red-600 text-white"
                                  : "border-zinc-700 text-red-500 hover:bg-red-600/20"
                              }`}
                            >
                              <X size={15} />
                            </button>
                            <button
                              onClick={() => markGroup(group, "mal")}
                              title="Mal facturado"
                              className={`btn-anim p-1.5 rounded-full border ${
                                e === "mal"
                                  ? "bg-purple-600 border-purple-600 text-white"
                                  : "border-zinc-700 text-purple-400 hover:bg-purple-600/20"
                              }`}
                            >
                              <AlertOctagon size={15} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </main>
      </div>

      {ubicArt && (
        <UbicacionesModal articulo={ubicArt} onClose={() => setUbicArt(null)} />
      )}
    </>
  );
}

// Modal: todas las ubicaciones del artículo (sin filtrar) con >1 unidad.
// Tabla sin encabezado: ubicación + cantidad. Para chequear si hay stock en
// otro rack antes de marcar "sin existencia".
function UbicacionesModal({
  articulo,
  onClose,
}: {
  articulo: string;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<{ Ubicacion: string; Cantidad: number }[]>(
    [],
  );
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let vivo = true;
    fetch(
      `/api/deposito/faltantes/ubicaciones?articulo=${encodeURIComponent(articulo)}`,
      { cache: "no-store" },
    )
      .then((r) => r.json())
      .then((j) => {
        if (vivo) setRows(j.rows ?? []);
      })
      .catch(() => {
        if (vivo) setRows([]);
      })
      .finally(() => {
        if (vivo) setLoading(false);
      });
    return () => {
      vivo = false;
    };
  }, [articulo]);
  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-4 animate-in fade-in duration-200"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm bg-[#1A1A1A] border border-zinc-700 rounded-xl overflow-hidden animate-in fade-in zoom-in-95 slide-in-from-bottom-2 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
          <span className="font-mono text-sm text-yellow-400">{articulo}</span>
          <button
            onClick={onClose}
            className="btn-anim text-zinc-400 hover:text-white"
          >
            <X size={18} />
          </button>
        </div>
        <div className="max-h-80 overflow-y-auto">
          {loading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="animate-spin text-zinc-500" />
            </div>
          ) : rows.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-zinc-500">
              Sin otras ubicaciones
            </p>
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className="border-b border-zinc-800/60">
                    <td className="px-4 py-2 text-zinc-200">{r.Ubicacion}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-zinc-300">
                      {fmtNum(r.Cantidad)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

function Pill({ e }: { e: Estado }) {
  if (e === "si")
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-green-600/20 text-green-400 px-2 py-0.5 text-xs font-medium">
        <Check size={12} /> En exist.
      </span>
    );
  if (e === "no")
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-red-600/20 text-red-400 px-2 py-0.5 text-xs font-medium">
        <X size={12} /> Sin exist.
      </span>
    );
  if (e === "mal")
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-purple-600/20 text-purple-400 px-2 py-0.5 text-xs font-medium">
        <AlertOctagon size={12} /> Mal facturado
      </span>
    );
  return (
    <span className="inline-flex rounded-full bg-zinc-700/40 text-zinc-400 px-2 py-0.5 text-xs">
      Pendiente
    </span>
  );
}

// Select de novedad: muestra el nombre, devuelve el id (o null = sin novedad).
function NovedadSelect({
  tipos,
  value,
  onChange,
  className,
}: {
  tipos: Tipo[];
  value: number | null;
  onChange: (id: number | null) => void;
  className?: string;
}) {
  return (
    <select
      value={value ?? ""}
      onChange={(e) =>
        onChange(e.target.value === "" ? null : Number(e.target.value))
      }
      className={
        className ??
        "w-full max-w-[210px] bg-[#1f1f1f] border border-zinc-700 rounded-md px-2 py-1.5 text-sm text-zinc-100 focus:border-yellow-400 outline-none cursor-pointer"
      }
    >
      <option value="">— Sin novedad —</option>
      {tipos.map((t) => (
        <option key={t.id} value={t.id}>
          {t.nombre}
        </option>
      ))}
    </select>
  );
}

function Row({
  label,
  value,
  big,
}: {
  label: string;
  value: React.ReactNode;
  big?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-zinc-800/70 py-2.5">
      <span className="text-xs uppercase tracking-wide text-zinc-500">
        {label}
      </span>
      <span
        className={`text-right ${big ? "text-2xl font-bold" : "text-base"} text-zinc-100`}
      >
        {value}
      </span>
    </div>
  );
}

function CardDetalle({
  it,
  estado,
  cantidad,
  onCantidad,
  onUbic,
}: {
  it: Item;
  estado: Estado;
  cantidad: number | null;
  onCantidad: (v: number | null) => void;
  onUbic: () => void;
}) {
  return (
    <div className="px-5 py-4">
      {estado !== "pendiente" && (
        <div className="mb-2">
          <Pill e={estado} />
        </div>
      )}
      <h2 className="text-2xl font-bold leading-tight text-white mb-1">
        {it.Nombre || "—"}
      </h2>
      <button
        onClick={onUbic}
        className="flex items-center gap-1.5 mb-3"
      >
        <MapPin size={14} className="text-zinc-500" />
        <span className="font-mono text-sm text-yellow-400">
          {it.CodArticulo}
        </span>
      </button>
      <div className="mb-4">
        <div className="text-xs uppercase tracking-wide text-zinc-500 mb-1.5">
          Cantidad
        </div>
        <input
          type="number"
          inputMode="decimal"
          defaultValue={cantidad ?? ""}
          onBlur={(ev) => {
            const v = ev.target.value;
            onCantidad(v === "" ? null : Number(v));
          }}
          className="w-full bg-[#1f1f1f] border border-zinc-700 rounded-lg px-3 py-3 text-base text-zinc-100 focus:border-yellow-400 outline-none"
        />
      </div>
      <Row label="Ubicación" value={it.Ubicacion ?? "—"} big />
      <Row label="Cant. pendiente" value={fmtNum(it.CantPend)} big />
      {(it.EnTransito ?? 0) > 0 && (
        <Row
          label="En tránsito (descontado)"
          value={
            <span className="text-sky-400">{fmtNum(it.EnTransito ?? 0)}</span>
          }
        />
      )}
      <Row label="Vendedor" value={it.Vendedor || "—"} />
      <Row label="Cliente" value={it.Cliente ?? "—"} />
      <Row label="Importe" value={`$${fmtNum(it.Importe)}`} />
      <Row label="Línea" value={it.Linea ?? "—"} />
      <Row label="Tipo artículo" value={it.TipoArticulo || "—"} />
      <Row label="Preparador" value={it.Preparador || "—"} />
      <Row label="Proveedor" value={it.Proveedor || "—"} />
    </div>
  );
}
