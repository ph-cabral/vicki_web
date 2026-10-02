"use client";
import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Loader2, RefreshCw, AlertTriangle, Download, Plus, Pencil, X, Trash2, Search,
  CalendarRange, ArrowUpDown, ClipboardList, GripVertical, RotateCcw,
} from "lucide-react";
import * as XLSX from "xlsx";
import { InicioButton } from "@/components/ui/InicioButton";
import { UsuarioActual } from "@/components/auth/UsuarioActual";

// ──────────────────────────────────────────────────────────────────────────────
// /compras/planificacion — planificación de abastecimiento.
//   Cada usuario arma sus propios "botones" (reportes guardados en
//   preparado.compras_planificacion_reporte, solo los ve quien los creó): un
//   filtro de Línea / Rubro / Sub rubro / Sub sub rubro (Stk_Nivel1..4 de
//   Magnus; OR dentro de cada nivel, AND entre niveles) + N meses cerrados
//   hacia atrás (el rango se mueve solo con el calendario, la cantidad de
//   meses queda fija).
//   Al tocar un botón: por artículo, recomendado =
//     promedio vendido + faltante vivo − stock dep. 1 − OC pendiente (≥ 0).
//   Máximo / mínimo = mes más alto / mes más bajo con venta del rango (mismo
//   criterio que /compras/consumo).
//   Cantidad = input por fila, arranca en el recomendado; lo editado se guarda
//   en localStorage por reporte + rango y va al Excel.
//   Columnas reordenables arrastrando el encabezado; el orden se guarda en
//   localStorage (planificacion:cols) y el Excel sale en ese mismo orden.
//   Fuentes: /api/compras/planificacion/{reportes,niveles,datos}.
// ──────────────────────────────────────────────────────────────────────────────

interface Reporte {
  id: number;
  nombre: string;
  lineas: number[];
  rubros: number[];
  subRubros: number[];
  subSubRubros: number[];
  meses: number;
  orden: number;
}
interface Row {
  codigo: string;
  detalle: string | null;
  recomendado: number;
  promedio: number;
  vendido: number;
  maximo: number;
  minimo: number | null;
  stock: number;
  oc: number;
  faltante: number;
  proveedor: string | null;
}
interface Datos {
  reporte: Reporte;
  desde: string;
  hasta: string;
  ocDesde: string | null;
  faltanteWarn: boolean;
  total: number;
  rows: Row[];
}
interface Niveles {
  nombres: Record<"1" | "2" | "3" | "4", Record<string, string>>;
  combos: [number, number, number, number, number][];
}

const NIVELES = [
  { k: "lineas", n: 1, label: "Líneas" },
  { k: "rubros", n: 2, label: "Rubros" },
  { k: "subRubros", n: 3, label: "Sub rubros" },
  { k: "subSubRubros", n: 4, label: "Sub sub rubros" },
] as const;
type NivelKey = (typeof NIVELES)[number]["k"];

const fmtNum = (n: number) =>
  new Intl.NumberFormat("es-AR", { maximumFractionDigits: 2 }).format(n || 0);
const fmtAr = (s: string | null) => {
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(s || "");
  return m ? `${m[3]}/${m[2]}/${m[1]}` : s || "—";
};
const LS_KEY = "planificacion:sel";
const lsCantKey = (id: number, hasta: string) => `planificacion:cant:${id}:${hasta}`;
// Base de la columna Cantidad por reporte: "rec" = arranca en el recomendado,
// "cero" = se limpió con el tacho y todo arranca en 0 (persiste hasta restaurar).
const lsCantBaseKey = (id: number) => `planificacion:cantbase:${id}`;
type CantBase = "rec" | "cero";

type SortKey = keyof Row | "cantidad" | "cobertura";
const COLS: { k: SortKey; label: string; num: boolean; title?: string }[] = [
  { k: "codigo", label: "Código", num: false },
  { k: "detalle", label: "Detalle", num: false },
  { k: "proveedor", label: "Proveedor", num: false, title: "proveedor habitual del artículo; si no tiene, el de la última OC" },
  { k: "cantidad", label: "Cantidad", num: true, title: "cantidad a pedir — arranca en el recomendado, editable" },
  { k: "cobertura", label: "Cobertura (meses)", num: true, title: "(stock + OC pendiente + cantidad) / prom. vendido — meses que cubre lo que hay más lo que se pide (stock negativo cuenta 0)" },
  { k: "recomendado", label: "Recomendado", num: true, title: "promedio + faltante − stock − OC pendiente (mínimo 0, redondeado hacia arriba)" },
  { k: "promedio", label: "Prom. vendido", num: true, title: "unidades vendidas en el rango / meses" },
  { k: "maximo", label: "Máximo", num: true, title: "mes con más unidades vendidas del rango" },
  { k: "minimo", label: "Mínimo", num: true, title: "mes con menos unidades vendidas del rango (sin contar meses sin venta)" },
  { k: "stock", label: "Stock", num: true, title: "depósito 1 (central)" },
  { k: "oc", label: "OC pendiente", num: true, title: "saldo sin recibir de OC sin cerrar" },
  { k: "faltante", label: "Faltante", num: true, title: "faltante vivo en pedidos (mismo cálculo que /compras/faltantes)" },
];
const COL_BY = Object.fromEntries(COLS.map((c) => [c.k, c])) as Record<SortKey, (typeof COLS)[number]>;
const ORDEN_DEFAULT: SortKey[] = COLS.map((c) => c.k);
const LS_COLS = "planificacion:cols";

/** Orden guardado → válido: descarta claves que ya no existen y agrega al
 *  final las columnas nuevas que no estaban cuando se guardó. */
function sanearOrden(v: unknown): SortKey[] {
  const ok = Array.isArray(v) ? (v.filter((k) => k in COL_BY) as SortKey[]) : [];
  const uniq = [...new Set(ok)];
  return [...uniq, ...ORDEN_DEFAULT.filter((k) => !uniq.includes(k))];
}

export default function PlanificacionPage() {
  const [reportes, setReportes] = useState<Reporte[]>([]);
  const [tablaWarn, setTablaWarn] = useState<string | null>(null);
  const [selId, setSelId] = useState<number | null>(null);
  const [datos, setDatos] = useState<Datos | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [niveles, setNiveles] = useState<Niveles | null>(null);
  const [modal, setModal] = useState<{ rep: Reporte | null } | null>(null);
  const [buscar, setBuscar] = useState("");
  const [soloRec, setSoloRec] = useState(false);
  const [sort, setSort] = useState<{ k: SortKey; dir: 1 | -1 }>({ k: "recomendado", dir: -1 });
  // Orden de columnas (drag & drop sobre el encabezado).
  const [orden, setOrden] = useState<SortKey[]>(ORDEN_DEFAULT);
  const [dragK, setDragK] = useState<SortKey | null>(null);
  const [overK, setOverK] = useState<SortKey | null>(null);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_COLS);
      if (raw) setOrden(sanearOrden(JSON.parse(raw)));
    } catch {}
  }, []);
  const guardarOrden = (o: SortKey[]) => {
    setOrden(o);
    try {
      if (o.join() === ORDEN_DEFAULT.join()) localStorage.removeItem(LS_COLS);
      else localStorage.setItem(LS_COLS, JSON.stringify(o));
    } catch {}
  };
  const moverCol = (from: SortKey, to: SortKey) => {
    if (from === to) return;
    const o = orden.filter((k) => k !== from);
    o.splice(o.indexOf(to) + (orden.indexOf(from) < orden.indexOf(to) ? 1 : 0), 0, from);
    guardarOrden(o);
  };
  const ordenAlterado = orden.join() !== ORDEN_DEFAULT.join();

  // Cantidades editadas a mano (codigo → valor). Lo no editado = base
  // (recomendado, o 0 si se limpió la columna con el tacho).
  const [cantEdit, setCantEdit] = useState<Record<string, number>>({});
  const [cantBase, setCantBase] = useState<CantBase>("rec");
  const cantKey = datos ? lsCantKey(datos.reporte.id, datos.hasta) : null;
  const cantBaseKey = datos ? lsCantBaseKey(datos.reporte.id) : null;

  useEffect(() => {
    if (!cantKey) {
      setCantEdit({});
      return;
    }
    try {
      setCantEdit(JSON.parse(localStorage.getItem(cantKey) || "{}") || {});
    } catch {
      setCantEdit({});
    }
  }, [cantKey]);

  useEffect(() => {
    if (!cantBaseKey) {
      setCantBase("rec");
      return;
    }
    try {
      setCantBase(localStorage.getItem(cantBaseKey) === "cero" ? "cero" : "rec");
    } catch {
      setCantBase("rec");
    }
  }, [cantBaseKey]);

  const baseDe = useCallback((r: Row) => (cantBase === "cero" ? 0 : r.recomendado), [cantBase]);

  const cantidadDe = useCallback(
    (r: Row) => (r.codigo in cantEdit ? cantEdit[r.codigo] : baseDe(r)),
    [cantEdit, baseDe],
  );

  // Meses de cobertura: (stock + OC + cantidad) / promedio. null = sin venta en el rango.
  const coberturaDe = useCallback(
    (r: Row): number | null =>
      r.promedio > 0 ? (Math.max(r.stock, 0) + r.oc + cantidadDe(r)) / r.promedio : null,
    [cantidadDe],
  );

  const guardarEdits = (next: Record<string, number>) => {
    setCantEdit(next);
    try {
      if (!cantKey) return;
      if (Object.keys(next).length) localStorage.setItem(cantKey, JSON.stringify(next));
      else localStorage.removeItem(cantKey);
    } catch {}
  };

  const setCantidad = (r: Row, v: string) => {
    const n = Math.max(0, Math.round(Number(v) || 0));
    const next = { ...cantEdit };
    if (n === baseDe(r)) delete next[r.codigo];
    else next[r.codigo] = n;
    guardarEdits(next);
  };

  /** Tacho: toda la columna a 0 (persistente). Con base "cero" el botón
   *  restaura el recomendado. En ambos casos se descartan las ediciones. */
  const alternarBaseCantidad = () => {
    const nueva: CantBase = cantBase === "cero" ? "rec" : "cero";
    setCantBase(nueva);
    try {
      if (cantBaseKey) {
        if (nueva === "cero") localStorage.setItem(cantBaseKey, "cero");
        else localStorage.removeItem(cantBaseKey);
      }
    } catch {}
    guardarEdits({});
  };

  const cargarReportes = useCallback(async () => {
    try {
      const res = await fetch("/api/compras/planificacion/reportes", { cache: "no-store" });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error);
      setReportes(j.reportes ?? []);
      setTablaWarn(j.tablaWarn ?? null);
      return (j.reportes ?? []) as Reporte[];
    } catch (e) {
      setError((e as Error).message || "No se pudieron leer los reportes");
      return [];
    }
  }, []);

  useEffect(() => {
    cargarReportes().then((rs) => {
      let prev: number | null = null;
      try {
        prev = Number(localStorage.getItem(LS_KEY)) || null;
      } catch {}
      if (prev && rs.some((r) => r.id === prev)) setSelId(prev);
      else if (rs[0]) setSelId(rs[0].id);
    });
    fetch("/api/compras/planificacion/niveles", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => j && setNiveles(j))
      .catch(() => {});
  }, [cargarReportes]);

  const cargarDatos = useCallback(async (id: number, fresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/compras/planificacion/datos?id=${id}${fresh ? "&fresh=1" : ""}`, {
        cache: "no-store",
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setDatos(j);
    } catch (e) {
      setDatos(null);
      setError((e as Error).message || "No se pudo calcular el reporte");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selId == null) {
      setDatos(null);
      return;
    }
    try {
      localStorage.setItem(LS_KEY, String(selId));
    } catch {}
    cargarDatos(selId);
  }, [selId, cargarDatos]);

  const visibles = useMemo(() => {
    if (!datos) return [];
    const q = buscar.trim().toLowerCase();
    let rs = datos.rows;
    if (soloRec) rs = rs.filter((r) => r.recomendado > 0 || cantidadDe(r) > 0);
    if (q)
      rs = rs.filter(
        (r) =>
          r.codigo.toLowerCase().includes(q) ||
          (r.detalle || "").toLowerCase().includes(q) ||
          (r.proveedor || "").toLowerCase().includes(q),
      );
    const { k, dir } = sort;
    const val = (r: Row) =>
      k === "cantidad"
        ? cantidadDe(r)
        : k === "cobertura"
          ? coberturaDe(r) ?? Number.POSITIVE_INFINITY
          : k === "minimo"
            ? r.minimo ?? 0
            : r[k] ?? "";
    return [...rs].sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      if (typeof va === "number" && typeof vb === "number") {
        if (va === vb) return 0;
        if (va === Number.POSITIVE_INFINITY) return 1; // sin venta siempre al final
        if (vb === Number.POSITIVE_INFINITY) return -1;
        return (va - vb) * dir;
      }
      return String(va).localeCompare(String(vb), "es") * dir;
    });
  }, [datos, buscar, soloRec, sort, cantidadDe, coberturaDe]);

  const nombreNivel = useCallback(
    (n: 1 | 2 | 3 | 4, id: number) => niveles?.nombres[String(n) as "1"]?.[String(id)] ?? `#${id}`,
    [niveles],
  );

  const resumenFiltro = (r: Reporte) =>
    NIVELES.filter((nv) => r[nv.k].length)
      .map((nv) => `${nv.label}: ${r[nv.k].map((id) => nombreNivel(nv.n, id)).join(", ")}`)
      .join(" · ");

  const exportar = useCallback(() => {
    if (!datos || !visibles.length) return;
    const valorXls = (r: Row, k: SortKey): string | number =>
      k === "cantidad"
        ? cantidadDe(r)
        : k === "cobertura"
          ? (() => {
              const c = coberturaDe(r);
              return c == null ? "" : Math.round(c * 10) / 10;
            })()
          : k === "detalle" ? r.detalle || "" : k === "proveedor" ? r.proveedor || "" : k === "minimo" ? r.minimo ?? "" : r[k];
    const filas = visibles.map((r) => {
      const o: Record<string, string | number> = {};
      for (const k of orden) o[COL_BY[k].label] = valorXls(r, k);
      o[`Vendido ${datos.desde} a ${datos.hasta}`] = r.vendido;
      return o;
    });
    const ws = XLSX.utils.json_to_sheet(filas);
    ws["!cols"] = Object.keys(filas[0]).map((c) => ({ wch: c === "Detalle" ? 45 : c === "Proveedor" ? 35 : Math.max(12, c.length + 2) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Planificación");
    XLSX.writeFile(wb, `planificacion_${datos.reporte.nombre.replace(/[^\w-]+/g, "_")}_${datos.hasta}.xlsx`);
  }, [datos, visibles, cantidadDe, coberturaDe, orden]);

  const tot = useMemo(
    () => ({
      conRec: visibles.filter((r) => r.recomendado > 0).length,
      rec: visibles.reduce((s, r) => s + r.recomendado, 0),
      cant: visibles.reduce((s, r) => s + cantidadDe(r), 0),
    }),
    [visibles, cantidadDe],
  );

  const celda = (r: Row, k: SortKey) => {
    switch (k) {
      case "codigo":
        return <td key={k} className="px-2 py-1.5 font-mono text-yellow-400 whitespace-nowrap">{r.codigo}</td>;
      case "detalle":
        return <td key={k} className="px-2 py-1.5">{r.detalle || "—"}</td>;
      case "proveedor":
        return <td key={k} className="px-2 py-1.5 text-zinc-300 whitespace-nowrap">{r.proveedor || "—"}</td>;
      case "cantidad":
        return (
          <td key={k} className="px-2 py-1 text-right">
            <input
              type="number"
              min={0}
              step={1}
              inputMode="numeric"
              value={cantidadDe(r)}
              onChange={(e) => setCantidad(r, e.target.value)}
              onFocus={(e) => e.target.select()}
              className={`w-20 bg-zinc-900 border rounded px-1.5 py-0.5 text-right tabular-nums outline-none focus:border-yellow-400 ${
                r.codigo in cantEdit ? "border-yellow-400/60 text-yellow-300" : "border-zinc-700 text-zinc-100"
              }`}
            />
          </td>
        );
      case "cobertura": {
        const c = coberturaDe(r);
        return (
          <td
            key={k}
            className={`px-2 py-1.5 text-right tabular-nums ${
              c == null ? "text-zinc-600" : c < 1 ? "text-red-400" : c < 2 ? "text-yellow-300" : "text-zinc-300"
            }`}
          >
            {c == null ? "—" : new Intl.NumberFormat("es-AR", { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(c)}
          </td>
        );
      }
      case "recomendado":
        return (
          <td
            key={k}
            className={`px-2 py-1.5 text-right tabular-nums font-semibold ${r.recomendado > 0 ? "text-green-400" : "text-zinc-600"}`}
          >
            {fmtNum(r.recomendado)}
          </td>
        );
      case "promedio":
        return <td key={k} className="px-2 py-1.5 text-right tabular-nums">{fmtNum(r.promedio)}</td>;
      case "maximo":
        return <td key={k} className="px-2 py-1.5 text-right tabular-nums text-orange-400">{r.maximo ? fmtNum(r.maximo) : "—"}</td>;
      case "minimo":
        return <td key={k} className="px-2 py-1.5 text-right tabular-nums text-sky-400">{r.minimo != null ? fmtNum(r.minimo) : "—"}</td>;
      case "stock":
        return (
          <td key={k} className={`px-2 py-1.5 text-right tabular-nums ${r.stock < 0 ? "text-red-400" : "text-zinc-300"}`}>
            {fmtNum(r.stock)}
          </td>
        );
      case "oc":
        return <td key={k} className="px-2 py-1.5 text-right tabular-nums text-sky-300">{r.oc ? fmtNum(r.oc) : "—"}</td>;
      case "faltante":
        return <td key={k} className="px-2 py-1.5 text-right tabular-nums text-red-400">{r.faltante ? fmtNum(r.faltante) : "—"}</td>;
      default:
        return <td key={k} className="px-2 py-1.5 text-right tabular-nums">{fmtNum(Number(r[k as keyof Row]) || 0)}</td>;
    }
  };

  const onGuardado = async (id: number | null) => {
    setModal(null);
    const rs = await cargarReportes();
    if (id && rs.some((r) => r.id === id)) {
      if (id === selId) cargarDatos(id);
      else setSelId(id);
    } else if (!rs.some((r) => r.id === selId)) {
      setSelId(rs[0]?.id ?? null);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-4 sm:p-6">
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <InicioButton />
        <h1 className="text-lg font-semibold flex items-center gap-2">
          <ClipboardList size={18} className="text-yellow-400" />
          Planificación de abastecimiento
        </h1>
        <div className="ml-auto flex items-center gap-2">
          <UsuarioActual />
        </div>
      </div>

      {tablaWarn && (
        <div className="mb-3 flex items-center gap-2 text-amber-400 text-xs">
          <AlertTriangle size={14} /> {tablaWarn}
        </div>
      )}

      {/* Botones del usuario */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        {reportes.map((r) => {
          const activo = r.id === selId;
          return (
            <div
              key={r.id}
              className={`flex items-center rounded-lg border text-sm ${
                activo ? "border-yellow-400 bg-yellow-400/10" : "border-zinc-700 hover:border-zinc-500"
              }`}
            >
              <button
                onClick={() => (activo ? cargarDatos(r.id) : setSelId(r.id))}
                title={resumenFiltro(r)}
                className={`px-3 py-1.5 font-medium ${activo ? "text-yellow-300" : "text-zinc-200"}`}
              >
                {r.nombre}
                <span className="ml-2 text-[10px] text-zinc-500">{r.meses}m</span>
              </button>
              <button
                onClick={() => setModal({ rep: r })}
                title="Editar"
                className="px-2 py-1.5 border-l border-zinc-700 text-zinc-500 hover:text-yellow-400"
              >
                <Pencil size={13} />
              </button>
            </div>
          );
        })}
        <button
          onClick={() => setModal({ rep: null })}
          disabled={!!tablaWarn}
          className="btn-anim flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-dashed border-zinc-600 text-zinc-400 hover:border-yellow-400 hover:text-yellow-400 text-sm disabled:opacity-40"
        >
          <Plus size={14} /> Nuevo reporte
        </button>
      </div>

      {!reportes.length && !tablaWarn && (
        <div className="text-zinc-500 text-sm py-10 text-center">
          Todavía no armaste ningún reporte. Tocá <b>Nuevo reporte</b> para elegir líneas / rubros y la cantidad de meses.
        </div>
      )}

      {error && (
        <div className="mb-3 flex items-center gap-2 text-red-400 text-sm">
          <AlertTriangle size={15} /> {error}
        </div>
      )}

      {selId != null && (datos || loading) && (
        <>
          <div className="flex flex-wrap items-center gap-3 mb-3 text-xs text-zinc-400">
            {datos && (
              <>
                <span className="flex items-center gap-1.5">
                  <CalendarRange size={14} className="text-yellow-400" />
                  {fmtAr(datos.desde)} → {fmtAr(datos.hasta)} ({datos.reporte.meses} meses cerrados)
                </span>
                <span className="text-zinc-500 truncate max-w-[50ch]" title={resumenFiltro(datos.reporte)}>
                  {resumenFiltro(datos.reporte)}
                </span>
                <span>
                  <b className="text-yellow-400">{tot.conRec}</b> art. a reponer ·{" "}
                  <b className="text-zinc-200">{fmtNum(tot.rec)}</b> u. rec. ·{" "}
                  <b className="text-zinc-200">{fmtNum(tot.cant)}</b> u. a pedir · {visibles.length}/{datos.total} art.
                </span>
              </>
            )}
            <div className="ml-auto flex items-center gap-2">
              <div className="flex items-center gap-1.5 bg-zinc-900 border border-zinc-700 rounded-lg px-2 py-1">
                <Search size={13} className="text-zinc-500" />
                <input
                  value={buscar}
                  onChange={(e) => setBuscar(e.target.value)}
                  placeholder="código o detalle"
                  className="bg-transparent outline-none text-xs w-40"
                />
              </div>
              <button
                onClick={() => setSoloRec((v) => !v)}
                className={`chip-anim px-3 py-1.5 rounded-md border text-xs ${
                  soloRec ? "bg-yellow-400/15 border-yellow-400 text-yellow-300" : "border-zinc-700 text-zinc-400"
                }`}
              >
                Solo a reponer
              </button>
              {ordenAlterado && (
                <button
                  onClick={() => guardarOrden(ORDEN_DEFAULT)}
                  title="Volver al orden original de columnas"
                  className="btn-anim flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-zinc-700 text-zinc-400 hover:border-yellow-400 hover:text-yellow-400 text-xs"
                >
                  <RotateCcw size={13} /> Columnas
                </button>
              )}
              <button
                onClick={exportar}
                disabled={!visibles.length}
                className="btn-anim flex items-center gap-2 px-3 py-1.5 rounded-md border border-zinc-700 text-zinc-300 hover:border-yellow-400 hover:text-yellow-400 text-xs disabled:opacity-40"
              >
                <Download size={14} /> Excel
              </button>
              <button
                onClick={() => selId && cargarDatos(selId, true)}
                className="btn-anim flex items-center gap-2 px-3 py-1.5 rounded-md border border-zinc-700 text-zinc-300 hover:border-yellow-400 hover:text-yellow-400 text-xs"
              >
                {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                Actualizar
              </button>
            </div>
          </div>

          {datos?.faltanteWarn && (
            <div className="mb-3 flex items-center gap-2 text-amber-400 text-xs">
              <AlertTriangle size={14} /> No se pudo calcular el faltante en pedidos — la columna Faltante queda en 0.
            </div>
          )}

          <div className="overflow-x-auto rounded-lg border border-zinc-800">
            <table className="w-full text-xs">
              <thead className="bg-zinc-900 text-zinc-400 sticky top-0">
                <tr>
                  {orden.map((k) => {
                    const c = COL_BY[k];
                    return (
                      <th
                        key={k}
                        title={`${c.title ? c.title + " · " : ""}arrastrá para mover la columna`}
                        draggable
                        onDragStart={(e) => {
                          setDragK(k);
                          e.dataTransfer.effectAllowed = "move";
                          e.dataTransfer.setData("text/plain", k);
                        }}
                        onDragOver={(e) => {
                          if (!dragK) return;
                          e.preventDefault();
                          if (overK !== k) setOverK(k);
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          if (dragK) moverCol(dragK, k);
                          setDragK(null);
                          setOverK(null);
                        }}
                        onDragEnd={() => {
                          setDragK(null);
                          setOverK(null);
                        }}
                        onClick={() =>
                          setSort((s) => ({ k, dir: s.k === k ? (s.dir === 1 ? -1 : 1) : c.num ? -1 : 1 }))
                        }
                        className={`group px-2 py-2 cursor-pointer select-none whitespace-nowrap ${c.num ? "text-right" : "text-left"} ${
                          sort.k === k ? "text-yellow-400" : ""
                        } ${dragK === k ? "opacity-40" : ""} ${
                          overK === k && dragK && dragK !== k
                            ? orden.indexOf(dragK) < orden.indexOf(k)
                              ? "shadow-[inset_-2px_0_0_0_#facc15]"
                              : "shadow-[inset_2px_0_0_0_#facc15]"
                            : ""
                        }`}
                      >
                        <GripVertical size={11} className="inline mr-0.5 opacity-0 group-hover:opacity-50 cursor-grab" />
                        {k === "cantidad" && datos && (
                          <button
                            type="button"
                            draggable={false}
                            onClick={(e) => {
                              e.stopPropagation();
                              alternarBaseCantidad();
                            }}
                            title={
                              cantBase === "cero"
                                ? "Volver a cargar la columna con el recomendado"
                                : "Limpiar la columna: todas las cantidades en 0"
                            }
                            className={`inline-flex align-middle mr-1.5 p-0.5 rounded hover:bg-zinc-800 ${
                              cantBase === "cero" ? "text-yellow-400 hover:text-yellow-300" : "text-zinc-500 hover:text-red-400"
                            }`}
                          >
                            {cantBase === "cero" ? <RotateCcw size={12} /> : <Trash2 size={12} />}
                          </button>
                        )}
                        {c.label}
                        <ArrowUpDown size={11} className="inline ml-1 opacity-50" />
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody className={loading ? "opacity-50" : ""}>
                {visibles.map((r) => (
                  <tr key={r.codigo} className="border-t border-zinc-800 hover:bg-zinc-900/60">
                    {orden.map((k) => celda(r, k))}
                  </tr>
                ))}
                {!loading && datos && visibles.length === 0 && (
                  <tr>
                    <td colSpan={COLS.length} className="px-2 py-6 text-center text-zinc-500">
                      Sin artículos con venta, stock, OC o faltante para este filtro.
                    </td>
                  </tr>
                )}
                {loading && !datos && (
                  <tr>
                    <td colSpan={COLS.length} className="px-2 py-10 text-center text-zinc-500">
                      <Loader2 size={18} className="animate-spin inline mr-2" /> Calculando…
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {modal && (
        <ModalReporte
          rep={modal.rep}
          niveles={niveles}
          onClose={() => setModal(null)}
          onSaved={onGuardado}
        />
      )}
    </div>
  );
}

// ── Modal alta / edición ─────────────────────────────────────────────────────
function ModalReporte({
  rep,
  niveles,
  onClose,
  onSaved,
}: {
  rep: Reporte | null;
  niveles: Niveles | null;
  onClose: () => void;
  onSaved: (id: number | null) => void;
}) {
  const [nombre, setNombre] = useState(rep?.nombre ?? "");
  const [meses, setMeses] = useState(rep?.meses ?? 6);
  const [sel, setSel] = useState<Record<NivelKey, number[]>>({
    lineas: rep?.lineas ?? [],
    rubros: rep?.rubros ?? [],
    subRubros: rep?.subRubros ?? [],
    subSubRubros: rep?.subSubRubros ?? [],
  });
  const [busca, setBusca] = useState<Record<NivelKey, string>>({
    lineas: "", rubros: "", subRubros: "", subSubRubros: "",
  });
  const [guardando, setGuardando] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  // Opciones en cascada: cada nivel muestra solo lo que existe dentro de lo ya
  // elegido en los niveles de ARRIBA, con la cantidad de artículos resultante.
  const opciones = useMemo(() => {
    const out: Record<NivelKey, { id: number; nombre: string; cant: number }[]> = {
      lineas: [], rubros: [], subRubros: [], subSubRubros: [],
    };
    if (!niveles) return out;
    NIVELES.forEach((nv, idx) => {
      const cont = new Map<number, number>();
      for (const c of niveles.combos) {
        let ok = true;
        for (let j = 0; j < idx; j++) {
          const lista = sel[NIVELES[j].k];
          if (lista.length && !lista.includes(c[j])) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        cont.set(c[idx], (cont.get(c[idx]) ?? 0) + c[4]);
      }
      // Lo ya elegido siempre se ve (aunque cambie un nivel de arriba), para
      // poder destildarlo.
      for (const id of sel[nv.k]) if (!cont.has(id)) cont.set(id, 0);
      const nombres = niveles.nombres[String(nv.n) as "1"] ?? {};
      out[nv.k] = [...cont.entries()]
        .map(([id, cant]) => ({ id, cant, nombre: nombres[String(id)] ?? (id === 0 ? "(sin asignar)" : `#${id}`) }))
        .sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
    });
    return out;
  }, [niveles, sel]);

  const cantArticulos = useMemo(() => {
    if (!niveles) return null;
    let n = 0;
    for (const c of niveles.combos) {
      if (NIVELES.every((nv, j) => !sel[nv.k].length || sel[nv.k].includes(c[j]))) n += c[4];
    }
    return n;
  }, [niveles, sel]);

  const toggle = (k: NivelKey, id: number) =>
    setSel((s) => ({ ...s, [k]: s[k].includes(id) ? s[k].filter((x) => x !== id) : [...s[k], id] }));

  const guardar = async () => {
    setGuardando(true);
    setErr(null);
    try {
      const res = await fetch(
        rep ? `/api/compras/planificacion/reportes/${rep.id}` : "/api/compras/planificacion/reportes",
        {
          method: rep ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ nombre, meses, ...sel }),
        },
      );
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      onSaved(rep ? rep.id : j.id ?? null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setGuardando(false);
    }
  };

  const borrar = async () => {
    if (!rep) return;
    setGuardando(true);
    setErr(null);
    try {
      const res = await fetch(`/api/compras/planificacion/reportes/${rep.id}`, { method: "DELETE" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      onSaved(null);
    } catch (e) {
      setErr((e as Error).message);
      setGuardando(false);
    }
  };

  const [confirmaBorrar, setConfirmaBorrar] = useState(false);
  const haySeleccion = NIVELES.some((nv) => sel[nv.k].length);

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-3" onMouseDown={onClose}>
      <div
        className="bg-zinc-950 border border-zinc-700 rounded-xl w-full max-w-6xl max-h-[92vh] flex flex-col"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-zinc-800">
          <h2 className="font-semibold">{rep ? "Editar reporte" : "Nuevo reporte"}</h2>
          <button onClick={onClose} className="ml-auto text-zinc-500 hover:text-zinc-200">
            <X size={18} />
          </button>
        </div>

        <div className="px-4 py-3 flex flex-wrap items-end gap-4 border-b border-zinc-800">
          <label className="text-xs text-zinc-400 flex flex-col gap-1">
            Nombre del botón
            <input
              autoFocus
              value={nombre}
              onChange={(e) => setNombre(e.target.value)}
              maxLength={120}
              placeholder="Ej. Mangueras Yaco"
              className="bg-zinc-900 border border-zinc-700 rounded-lg px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-yellow-400 w-64"
            />
          </label>
          <label className="text-xs text-zinc-400 flex flex-col gap-1">
            Meses hacia atrás
            <div className="flex items-center gap-1">
              {[3, 6, 12].map((m) => (
                <button
                  key={m}
                  onClick={() => setMeses(m)}
                  className={`px-2.5 py-1.5 rounded-md border text-xs ${
                    meses === m ? "border-yellow-400 text-yellow-300 bg-yellow-400/10" : "border-zinc-700 text-zinc-400"
                  }`}
                >
                  {m}
                </button>
              ))}
              <input
                type="number"
                min={1}
                max={36}
                value={meses}
                onChange={(e) => setMeses(Math.max(1, Math.min(36, Number(e.target.value) || 1)))}
                className="bg-zinc-900 border border-zinc-700 rounded-lg px-2 py-1.5 text-sm w-16 outline-none focus:border-yellow-400"
              />
            </div>
          </label>
          <span className="text-[11px] text-zinc-500 pb-2">
            meses cerrados, sin el mes en curso · {cantArticulos != null ? `${fmtNum(cantArticulos)} artículos en el filtro` : ""}
          </span>
        </div>

        <div className="flex-1 overflow-hidden grid grid-cols-1 md:grid-cols-4 gap-3 p-4 min-h-0">
          {NIVELES.map((nv) => {
            const q = busca[nv.k].trim().toLowerCase();
            const ops = opciones[nv.k].filter((o) => !q || o.nombre.toLowerCase().includes(q));
            return (
              <div key={nv.k} className="flex flex-col min-h-0 border border-zinc-800 rounded-lg">
                <div className="px-2 py-2 border-b border-zinc-800 flex items-center gap-2">
                  <span className="text-xs font-semibold text-zinc-300">{nv.label}</span>
                  {sel[nv.k].length > 0 && (
                    <button
                      onClick={() => setSel((s) => ({ ...s, [nv.k]: [] }))}
                      className="ml-auto text-[10px] text-zinc-500 hover:text-red-400"
                    >
                      limpiar ({sel[nv.k].length})
                    </button>
                  )}
                </div>
                <input
                  value={busca[nv.k]}
                  onChange={(e) => setBusca((b) => ({ ...b, [nv.k]: e.target.value }))}
                  placeholder="buscar…"
                  className="mx-2 mt-2 bg-zinc-900 border border-zinc-700 rounded-md px-2 py-1 text-xs outline-none focus:border-yellow-400"
                />
                <div className="flex-1 overflow-y-auto p-1 min-h-[160px] max-h-[48vh]">
                  {!niveles && (
                    <div className="text-center text-zinc-500 text-xs py-6">
                      <Loader2 size={14} className="animate-spin inline" />
                    </div>
                  )}
                  {ops.map((o) => {
                    const on = sel[nv.k].includes(o.id);
                    return (
                      <label
                        key={o.id}
                        className={`flex items-center gap-2 px-2 py-1 rounded cursor-pointer text-xs ${
                          on ? "bg-yellow-400/10 text-yellow-200" : "text-zinc-300 hover:bg-zinc-900"
                        }`}
                      >
                        <input type="checkbox" checked={on} onChange={() => toggle(nv.k, o.id)} className="accent-yellow-400" />
                        <span className="flex-1 truncate" title={o.nombre}>{o.nombre}</span>
                        <span className="text-[10px] text-zinc-500 tabular-nums">{o.cant}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        <div className="px-4 py-3 border-t border-zinc-800 flex items-center gap-3">
          {rep &&
            (confirmaBorrar ? (
              <span className="flex items-center gap-2 text-xs">
                ¿Borrar “{rep.nombre}”?
                <button onClick={borrar} disabled={guardando} className="px-2 py-1 rounded bg-red-600 text-white">
                  Sí, borrar
                </button>
                <button onClick={() => setConfirmaBorrar(false)} className="px-2 py-1 rounded border border-zinc-700">
                  No
                </button>
              </span>
            ) : (
              <button
                onClick={() => setConfirmaBorrar(true)}
                className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-red-400"
              >
                <Trash2 size={13} /> Borrar
              </button>
            ))}
          {err && <span className="text-xs text-red-400">{err}</span>}
          <div className="ml-auto flex items-center gap-2">
            <button onClick={onClose} className="px-3 py-1.5 rounded-md border border-zinc-700 text-zinc-300 text-sm">
              Cancelar
            </button>
            <button
              onClick={guardar}
              disabled={guardando || !nombre.trim() || !haySeleccion}
              className="px-4 py-1.5 rounded-md bg-yellow-400 text-zinc-950 font-semibold text-sm disabled:opacity-40 flex items-center gap-2"
            >
              {guardando && <Loader2 size={14} className="animate-spin" />}
              Guardar
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
