"use client";

import { useState, useEffect, useRef } from "react"; // Agregá useEffect y useRef
import { addMangueraAction } from "../actions";

export function AddMangueraModal({
  isOpen,
  onClose,
  codigoPrellenado,
}: {
  isOpen: boolean;
  onClose: () => void;
  codigoPrellenado: string;
}) {
  const [loading, setLoading] = useState(false);
  const [metro, setMetro] = useState("");
  const [ubicacion, setUbicacion] = useState("");
  const [codigo, setCodigo] = useState(codigoPrellenado); // Estado local para el código

  // Ref para el foco
  const codigoInputRef = useRef<HTMLInputElement>(null);

  // Foco en el input al abrir
  useEffect(() => {
    if (isOpen && codigoInputRef.current) {
      setTimeout(() => {
        codigoInputRef.current?.focus();
      }, 50);
    }
  }, [isOpen]);

  // Resetear estado
  useEffect(() => {
    if (isOpen) {
      setCodigo(codigoPrellenado);
    }
  }, [codigoPrellenado, isOpen]);

  // 🆕 Cerrar con Escape
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);


  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!codigo || !metro || parseFloat(metro) <= 0) return;

    setLoading(true);

    const formData = new FormData();
    formData.append("codigo", codigo);
    formData.append("metros", metro);
    formData.append("ubicacion", ubicacion);
    formData.append("personalId", "1"); // ← Temporal hasta que tengas auth

    try {
      await addMangueraAction(formData);
      setMetro("");
      setUbicacion("");
      setCodigo("");
      onClose();
    } catch (error) {
      alert("Error al agregar el rollo: " + (error as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const esCodigoPrellenado = codigoPrellenado.length > 0;

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-md"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex justify-between items-center p-4 border-b bg-green-50 rounded-t-lg">
          <h3 className="text-lg font-semibold text-gray-900">
            ➕{" "}
            {esCodigoPrellenado
              ? `Nuevo Rollo: ${codigoPrellenado}`
              : "Nuevo Rollo"}
          </h3>
          <button
            onClick={onClose}
            disabled={loading}
            className="text-gray-400 hover:text-gray-600 text-2xl leading-none w-8 h-8 flex items-center justify-center rounded-full hover:bg-green-100 transition-colors"
          >
            ×
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {/* Código */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Código de Manguera <span className="text-red-500">*</span>
            </label>
            <input
              ref={codigoInputRef} // Ref para el foco
              type="text"
              value={codigo}
              onChange={(e) => setCodigo(e.target.value.toUpperCase())} // Convertir a mayúsculas
              placeholder={esCodigoPrellenado ? "" : "Ej: MANGUERA-25MM-ROJA"}
              readOnly={esCodigoPrellenado} // Solo lectura si viene pre-llenado
              required
              disabled={loading}
              className={`w-full px-3 py-2 border rounded-lg font-medium outline-none transition-all ${
                esCodigoPrellenado
                  ? "bg-gray-100 border-gray-300 text-gray-600 cursor-not-allowed"
                  : "bg-white border-gray-300 text-gray-900 focus:ring-2 focus:ring-green-500 focus:border-green-500"
              } disabled:bg-gray-100`}
            />
            <p className="text-xs text-gray-500 mt-1">
              {esCodigoPrellenado
                ? "Se agregará un nuevo ingreso de esta manguera"
                : "Ingresá el código identificador del rollo"}
            </p>
          </div>

          {/* Metros */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Metros que ingresan <span className="text-red-500">*</span>
            </label>
            <input
              type="number"
              min=".1"
              step=".1"
              value={metro}
              onChange={(e) => setMetro(e.target.value)}
              placeholder="Ej: 50"
              required
              disabled={loading}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900 font-medium focus:ring-2 focus:ring-green-500 focus:border-green-500 outline-none disabled:bg-gray-100"
            />
          </div>

          {/* Ubicación */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Ubicación
            </label>
            <input
              type="text"
              value={ubicacion}
              onChange={(e) => setUbicacion(e.target.value)}
              placeholder="Ej: Estante A3 - Sector 2"
              disabled={loading}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900 font-medium focus:ring-2 focus:ring-green-500 focus:border-green-500 outline-none disabled:bg-gray-100"
            />
          </div>

          {/* Botones */}
          <div className="flex gap-3 pt-2">
            <button
              type="submit"
              disabled={loading || !codigo || !metro}
              className="flex-1 px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? "Guardando..." : "Agregar Rollo"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
