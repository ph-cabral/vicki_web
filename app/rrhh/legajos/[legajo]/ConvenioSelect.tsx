"use client";
import { useCallback, useEffect, useMemo, useState } from "react";

type Categoria = { id: number; nombre: string };
type Convenio = { id: number; nombre: string; categorias: Categoria[] };

/**
 * Convenio colectivo + categoría del legajo.
 *
 * El catálogo vive en la base (everwear.convenio / convenio_categoria) y llega
 * anidado en una sola consulta: cambiar de convenio filtra en memoria, sin ir al
 * server. La categoría depende del convenio, así que al cambiarlo se limpia.
 */
export function ConvenioSelect({
  convenioId,
  categoriaId,
  onChange,
}: {
  convenioId: number | null;
  categoriaId: number | null;
  onChange: (v: { convenioId: number | null; categoriaId: number | null }) => void;
}) {
  const [convenios, setConvenios] = useState<Convenio[]>([]);

  const cargar = useCallback(
    () =>
      fetch("/api/rrhh/convenios")
        .then((r) => r.json())
        .then((data) => setConvenios(Array.isArray(data) ? data : []))
        .catch(() => {}),
    []
  );

  useEffect(() => {
    cargar();
  }, [cargar]);

  const categorias = useMemo(
    () => convenios.find((c) => c.id === convenioId)?.categorias ?? [],
    [convenios, convenioId]
  );

  const agregarConvenio = async () => {
    const nombre = window.prompt("Nuevo convenio (ej: MERCANTIL, UOM):");
    if (!nombre?.trim()) return;
    try {
      const res = await fetch("/api/rrhh/convenios", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nombre: nombre.trim() }),
      });
      if (!res.ok) return;
      const nuevo: Convenio = await res.json();
      await cargar();
      onChange({ convenioId: nuevo.id, categoriaId: null });
    } catch {
      // silencioso: el selector simplemente no se actualiza
    }
  };

  const agregarCategoria = async () => {
    if (!convenioId) return;
    const nombre = window.prompt("Nueva categoría para este convenio:");
    if (!nombre?.trim()) return;
    try {
      const res = await fetch("/api/rrhh/convenios/categorias", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nombre: nombre.trim(), convenioId }),
      });
      if (!res.ok) return;
      const nueva: Categoria = await res.json();
      await cargar();
      onChange({ convenioId, categoriaId: nueva.id });
    } catch {
      // silencioso
    }
  };

  const selectCls =
    "h-9 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 text-sm text-zinc-100 outline-none focus:border-yellow-400";
  const btnCls =
    "h-9 shrink-0 rounded-md border border-zinc-700 px-2 text-sm text-zinc-300 hover:bg-zinc-800 hover:text-yellow-400 disabled:opacity-40 transition-colors";

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-zinc-400">Convenio</span>
        <div className="flex gap-1">
          <select
            className={selectCls}
            value={convenioId ?? ""}
            onChange={(e) =>
              // al cambiar el convenio la categoría deja de aplicar
              onChange({
                convenioId: e.target.value ? Number(e.target.value) : null,
                categoriaId: null,
              })
            }
          >
            <option value="">—</option>
            {convenios.map((c) => (
              <option key={c.id} value={c.id}>
                {c.nombre}
              </option>
            ))}
          </select>
          <button type="button" onClick={agregarConvenio} title="Agregar convenio" className={btnCls}>
            +
          </button>
        </div>
      </label>

      <label className="block">
        <span className="mb-1 block text-xs font-medium text-zinc-400">Categoría</span>
        <div className="flex gap-1">
          <select
            className={selectCls}
            value={categoriaId ?? ""}
            disabled={!convenioId}
            onChange={(e) =>
              onChange({
                convenioId,
                categoriaId: e.target.value ? Number(e.target.value) : null,
              })
            }
          >
            <option value="">{convenioId ? "—" : "elegí primero el convenio"}</option>
            {categorias.map((k) => (
              <option key={k.id} value={k.id}>
                {k.nombre}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={agregarCategoria}
            disabled={!convenioId}
            title="Agregar categoría a este convenio"
            className={btnCls}
          >
            +
          </button>
        </div>
      </label>
    </div>
  );
}
