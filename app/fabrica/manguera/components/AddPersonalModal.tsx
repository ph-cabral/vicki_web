"use client";

import { useState, useTransition } from "react";
import { addPersonalAction } from "../actions";

export function AddPersonalModal({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  const [isPending, startTransition] = useTransition();
  const [nombre, setNombre] = useState("");
  const [dni, setDni] = useState("");

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const formData = new FormData();
    formData.set("nombre", nombre);
    formData.set("dni", dni);

    startTransition(async () => {
      await addPersonalAction(formData);
      setNombre("");
      setDni("");
      onClose();
    });
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6 w-full max-w-sm mx-4">
        <h2 className="text-lg font-bold mb-4">Agregar Personal</h2>
        <form onSubmit={handleSubmit} className="space-y-3">
          <input
            type="text"
            placeholder="Nombre *"
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            required
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 outline-none text-gray-900"
          />
          <input
            type="text"
            placeholder="DNI (opcional)"
            value={dni}
            onChange={(e) => setDni(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 outline-none text-gray-900"
          />
          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 text-gray-900"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={isPending || !nombre.trim()}
              className="flex-1 px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg disabled:opacity-50"
            >
              {isPending ? "Guardando..." : "Guardar"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

