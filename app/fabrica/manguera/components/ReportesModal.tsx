"use client";

import { useState } from "react";
import RankingCortes from "./reportes/RankingCortes";

type Vista = "ranking-cortes";

const VISTAS: { key: Vista; label: string; emoji: string }[] = [
  { key: "ranking-cortes", label: "Ranking Cortes", emoji: "🏆" },
  // Agregá más acá después
];

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

export default function ReportesModal({ isOpen, onClose }: Props) {
  const [vistaActiva, setVistaActiva] = useState<Vista>("ranking-cortes");

  if (!isOpen) return null;

  const renderVista = () => {
    switch (vistaActiva) {
      case "ranking-cortes":
        return <RankingCortes />;
      default:
        return null;
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-3xl max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <h2 className="text-xl font-bold text-gray-800">📊 Reportes</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-2xl leading-none"
          >
            ×
          </button>
        </div>

        <div className="flex gap-2 px-6 py-3 border-b bg-gray-50 overflow-x-auto">
          {VISTAS.map((v) => (
            <button
              key={v.key}
              onClick={() => setVistaActiva(v.key)}
              className={`px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-colors ${
                vistaActiva === v.key
                  ? "bg-blue-600 text-white"
                  : "bg-white text-gray-600 hover:bg-gray-100 border"
              }`}
            >
              {v.emoji} {v.label}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-auto px-6 py-4">
          {renderVista()}
        </div>
      </div>
    </div>
  );
}
