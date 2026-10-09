"use client";

import { useState } from "react";
import { AddMangueraModal } from "./components/AddMangueraModal";

export function AddButton() {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <>
      <button
        onClick={() => setIsOpen(true)}
        className="bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded-lg font-semibold flex items-center gap-2 transition-colors shadow-sm"
      >
        <span className="text-xl">+</span>
        <span>Agregar Rollo</span>
      </button>

      <AddMangueraModal
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        codigoPrellenado="" // Dejalo vacío o poné lógica para sugerir código
      />
    </>
  );
}
