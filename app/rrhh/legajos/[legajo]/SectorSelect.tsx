"use client";
import { useEffect, useMemo, useState } from "react";

type Sector = { id: number; nombre: string };
type Area = { id: number; nombre: string; sectores: Sector[] };

export function SectorSelect({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (sectorId: number | null) => void;
}) {
  const [areas, setAreas] = useState<Area[]>([]);

  useEffect(() => {
    fetch("/api/rrhh/areas")
      .then((r) => r.json())
      .then(setAreas);
  }, []);

  // Área derivada del sector elegido
  const areaNombre = useMemo(() => {
    if (value == null) return "";
    return (
      areas.find((a) => a.sectores.some((s) => s.id === value))?.nombre ?? ""
    );
  }, [value, areas]);

  return (
    <div className="grid grid-cols-2 gap-3">
      <label className="text-sm text-zinc-300">
        Sector
        <select
          className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-100 outline-none focus:border-yellow-400"
          value={value ?? ""}
          onChange={(e) =>
            onChange(e.target.value ? Number(e.target.value) : null)
          }
        >
          <option value="">—</option>
          {areas.map((a) => (
            <optgroup key={a.id} label={a.nombre}>
              {a.sectores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.nombre}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>

      <label className="text-sm text-zinc-300">
        Área
        <input
          className="mt-1 w-full rounded-md border border-zinc-800 bg-zinc-800/60 px-2 py-1 text-zinc-500"
          value={areaNombre}
          disabled
          readOnly
        />
      </label>
    </div>
  );
}
