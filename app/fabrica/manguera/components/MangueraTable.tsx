"use client";

import { useState } from "react";
import { CortarManguera } from "./CortarManguera";

type Manguera = {
  id: number;
  codigo: string;
  metros: number;
  ubicacion: string | null;
};

type Personal = {
  id: number;
  nombre: string;
};

export function MangueraTable({
  mangueras,
  personal = [],
  personalSeleccionado, // Recibe del padre
}: {
  mangueras: Manguera[];
  personal?: Personal[];
  personalSeleccionado: number | ""; // Nueva prop requerida
}) {
  const [filtro, setFiltro] = useState("");

  const manguerasFiltradas = mangueras.filter((m) =>
    m.codigo.toLowerCase().includes(filtro.toLowerCase()),
  );

  return (
    <div className="space-y-4">
      {/* Solo el buscador (el select se movió al padre) */}
      <div className="flex flex-col lg:flex-row gap-4 items-start lg:items-end justify-between">
        <div className="relative w-full lg:w-64">
          <label className="block text-sm font-medium text-gray-700 mb-1 text-left">
            Buscar manguera
          </label>
          <input
            type="text"
            placeholder="Código..."
            value={filtro}
            onChange={(e) => setFiltro(e.target.value)}
            className="w-full px-4 py-2  text-gray-900 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-green-500 outline-none text-left"
          />
          {filtro && (
            <button
              onClick={() => setFiltro("")}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* Tabla */}
      <div className="overflow-x-auto bg-white rounded-lg shadow">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Código
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Metros
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Ubicación
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Acción
              </th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {manguerasFiltradas.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-6 py-4 text-left text-gray-500">
                  No se encontraron coincidencias
                </td>
              </tr>
            ) : (
              manguerasFiltradas.map((m) => (
                <tr key={m.id}>
                  <td className="px-6 py-4 whitespace-nowrap text-left font-medium text-gray-900">
                    {m.codigo}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-left text-gray-900">
                    {m.metros} mts
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-left">
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
                      {m.ubicacion || "-"}
                    </span>
                  </td>
                  <td className="px-6 py-4  text-gray-900 whitespace-nowrap text-left">
                    <CortarManguera
                      id={m.id}
                      codigo={m.codigo}
                      personalId={personalSeleccionado || undefined}
                      disabled={!personalSeleccionado}
                    />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

