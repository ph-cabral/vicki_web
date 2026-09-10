"use client";
import { useCallback, useEffect, useState } from "react";

type Lugar = { id: number; nombre: string };

export function LugarSelect({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (lugarId: number | null) => void;
}) {
  const [lugares, setLugares] = useState<Lugar[]>([]);

  const cargar = useCallback(() => {
    fetch("/api/rrhh/lugares")
      .then((r) => r.json())
      .then(setLugares)
      .catch(() => {});
  }, []);

  useEffect(() => {
    cargar();
  }, [cargar]);

  const agregarLugar = async () => {
    const nombre = window.prompt("Nuevo lugar (ej: Oficina, Depósito, Fábrica):");
    if (!nombre || !nombre.trim()) return;
    try {
      const res = await fetch("/api/rrhh/lugares", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nombre: nombre.trim() }),
      });
      if (!res.ok) return;
      const nuevo: Lugar = await res.json();
      cargar();
      onChange(nuevo.id);
    } catch {
      // silencioso: el select simplemente no se actualiza
    }
  };

  return (
    <label className="text-sm text-zinc-300">
      Lugar
      <div className="mt-1 flex gap-1">
        <select
          className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-100 outline-none focus:border-yellow-400"
          value={value ?? ""}
          onChange={(e) =>
            onChange(e.target.value ? Number(e.target.value) : null)
          }
        >
          <option value="">—</option>
          {lugares.map((l) => (
            <option key={l.id} value={l.id}>
              {l.nombre}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={agregarLugar}
          title="Agregar lugar nuevo"
          className="shrink-0 rounded-md border border-zinc-700 px-2 text-sm text-zinc-300 hover:bg-zinc-800 hover:text-yellow-400 transition-colors"
        >
          +
        </button>
      </div>
    </label>
  );
}
