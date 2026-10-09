"use client";

import { useState } from "react";
import { cortarMangueraAction } from "../actions";

interface CortarMangueraProps {
  id: number;
  codigo: string;
  personalId?: number;
  disabled?: boolean;
}

export function CortarManguera({
  id,
  codigo,
  personalId,
  disabled,
}: CortarMangueraProps) {
  const [metros, setMetros] = useState<number>(0);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (metros <= 0 || !personalId) return;

    setLoading(true);
    try {
      await cortarMangueraAction(id, metros * -1, personalId);
      setMetros(0);
    } catch (error) {
      alert(error instanceof Error ? error.message : "Error al cortar");
    } finally {
      setLoading(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="flex items-center gap-2 justify-start"
    >
      <input
        type="number"
        min="0.1"
        step="0.1"
        value={metros || ""}
        onChange={(e) => setMetros(e.target.valueAsNumber || 0)}
        placeholder="Metros"
        disabled={disabled || loading}
        className={`w-20 px-2 py-1 text-sm border rounded text-left
          [appearance:textfield]
          [&::-webkit-outer-spin-button]:appearance-none
          [&::-webkit-inner-spin-button]:appearance-none
          [&::-webkit-outer-spin-button]:m-0
          [&::-webkit-inner-spin-button]:m-0
          ${disabled ? "bg-gray-100 text-gray-400 cursor-not-allowed" : ""}
        `}
      />
    </form>
  );
}
