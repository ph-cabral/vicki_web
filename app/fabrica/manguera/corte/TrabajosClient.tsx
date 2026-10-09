"use client";

import { Fragment, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { InicioButton } from "@/components/ui/InicioButton";

type Corte = {
  id: number;
  codigo: string;
  metros: number;
  fecha: string | Date;
  observacion: string | null;
  personal: { nombre: string } | null;
};

type Trabajo = {
  id: number;
  ordenTrabajo: string | null;
  fechaPedido: string | Date;
  estado: string;
  legajo: { nombre: string } | null;
  sector: { nombre: string } | null;
  clienteNombre: string | null;
  _count: { cortes: number };
  cortes: Corte[];
};

export function TrabajosClient({ trabajos }: { trabajos: Trabajo[] }) {
  const router = useRouter();
  const [filtro, setFiltro] = useState("");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const f = filtro.toLowerCase();
  const filtrados = trabajos.filter(
    (t) =>
      (t.ordenTrabajo || "").toLowerCase().includes(f) ||
      (t.legajo?.nombre || "").toLowerCase().includes(f) ||
      (t.clienteNombre || "").toLowerCase().includes(f),
  );
  const incompletos = filtrados.filter((t) => t.estado !== "CUMPLIDO");

  const fmt = (d: string | Date) => new Date(d).toLocaleDateString("es-AR");
  const fmtDT = (d: string | Date) =>
    new Date(d).toLocaleString("es-AR", {
      dateStyle: "short",
      timeStyle: "short",
    });

  const toggle = (id: number) =>
    setExpanded((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  const badge = (e: string) =>
    e === "CUMPLIDO"
      ? "bg-green-100 text-green-800"
      : e === "ESPERA_RECEPCION"
        ? "bg-amber-100 text-amber-800"
        : "bg-blue-100 text-blue-800";

  const cols = [
    "",
    "OT n°",
    "Fecha",
    "Operario",
    "Sector",
    "Cliente",
    "N° cortes",
    "Estado",
  ];

  return (
    <main className="container mx-auto p-4 space-y-8">
      <InicioButton label="Inicio" iconSize={14} className="text-sm text-gray-500 hover:text-gray-900 transition-colors" />
      <div className="flex flex-col lg:flex-row gap-4 items-start lg:items-center justify-between">
        <h1 className="text-2xl font-bold">Trabajos</h1>
        <div className="flex items-center gap-2 w-full lg:w-auto">
          <div className="relative w-full lg:w-72">
            <input
              type="text"
              placeholder="Buscar OT, operario, cliente..."
              value={filtro}
              onChange={(e) => setFiltro(e.target.value)}
              className="w-full px-4 py-2 text-gray-900 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-green-500 outline-none"
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
          <Link
            href="/fabrica/manguera/corte/nuevo"
            className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white font-medium rounded-lg transition-colors whitespace-nowrap"
          >
            + Crear trabajo
          </Link>
        </div>
      </div>

      {/* TABLA SUPERIOR: no completos (click → editar) */}
      <div>
        <h2 className="text-lg font-semibold mb-2">Pendientes / en proceso</h2>
        <div className="overflow-x-auto bg-white rounded-lg shadow">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                {[
                  "OT n°",
                  "Fecha",
                  "Operario",
                  "Cliente",
                  "N° cortes",
                  "Estado",
                ].map((h, i) => (
                  <th
                    key={i}
                    className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {incompletos.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-6 py-4 text-left text-gray-500">
                    Sin pendientes
                  </td>
                </tr>
              ) : (
                incompletos.map((t) => (
                  <tr
                    key={t.id}
                    onClick={() =>
                      router.push(`/fabrica/manguera/corte/${t.id}/editar`)
                    }
                    className="cursor-pointer hover:bg-gray-50"
                  >
                    <td className="px-6 py-4 whitespace-nowrap text-left font-medium text-gray-900">
                      {t.ordenTrabajo || `#${t.id}`}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-left text-gray-900">
                      {fmt(t.fechaPedido)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-left text-gray-900">
                      {t.legajo?.nombre || "-"}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-left text-gray-900">
                      {t.clienteNombre || "-"}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-left text-gray-900">
                      {t._count.cortes}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-left">
                      <span
                        className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${badge(t.estado)}`}
                      >
                        {t.estado.replace(/_/g, " ")}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* TABLA INFERIOR: todos (expandible, solo lectura) */}
      <div>
        <h2 className="text-lg font-semibold mb-2">Todos</h2>
        <div className="overflow-x-auto bg-white rounded-lg shadow">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                {cols.map((h, i) => (
                  <th
                    key={i}
                    className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {filtrados.length === 0 ? (
                <tr>
                  <td
                    colSpan={cols.length}
                    className="px-6 py-4 text-left text-gray-500"
                  >
                    Sin trabajos
                  </td>
                </tr>
              ) : (
                // filtrados.map((t) => {
                filtrados
                  .filter((t) => t.estado === "CUMPLIDO")
                  .map((t) => {
                    const isOpen = expanded.has(t.id);
                    const totalMetros = t.cortes.reduce(
                      (s, c) => s + c.metros,
                      0,
                    );
                    return (
                      <Fragment key={t.id}>
                        <tr
                          onClick={() => toggle(t.id)}
                          className="cursor-pointer hover:bg-gray-50"
                        >
                          <td className="px-6 py-4 whitespace-nowrap text-gray-500 select-none">
                            <span
                              className={`inline-block transition-transform duration-300 ${isOpen ? "rotate-90" : ""}`}
                            >
                              ▶
                            </span>
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-left font-medium text-gray-900">
                            {t.ordenTrabajo || `#${t.id}`}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-left text-gray-900">
                            {fmt(t.fechaPedido)}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-left text-gray-900">
                            {t.legajo?.nombre || "-"}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-left text-gray-900">
                            {t.sector?.nombre || "-"}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-left text-gray-900">
                            {t.clienteNombre || "-"}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-left text-gray-900">
                            {t._count.cortes}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-left">
                            <span
                              className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${badge(t.estado)}`}
                            >
                              {t.estado.replace(/_/g, " ")}
                            </span>
                          </td>
                        </tr>
                        <tr className="bg-gray-50">
                          <td colSpan={cols.length} className="p-0">
                            <div
                              className={`grid transition-all duration-300 ease-in-out ${
                                isOpen
                                  ? "grid-rows-[1fr] opacity-100"
                                  : "grid-rows-[0fr] opacity-0"
                              }`}
                            >
                              <div className="overflow-hidden">
                                <div className="px-6 py-4">
                                  {t.cortes.length === 0 ? (
                                    <p className="text-sm text-gray-500">
                                      Sin cortes
                                    </p>
                                  ) : (
                                    <div className="overflow-x-auto">
                                      <table className="min-w-full text-sm">
                                        <thead>
                                          <tr className="text-xs text-gray-500 uppercase">
                                            <th className="px-3 py-2 text-left">
                                              Fecha
                                            </th>
                                            <th className="px-3 py-2 text-left">
                                              Código
                                            </th>
                                            <th className="px-3 py-2 text-right">
                                              Metros
                                            </th>
                                            <th className="px-3 py-2 text-left">
                                              Operario
                                            </th>
                                            <th className="px-3 py-2 text-left">
                                              Observación
                                            </th>
                                          </tr>
                                        </thead>
                                        <tbody className="divide-y divide-gray-200">
                                          {t.cortes.map((c) => (
                                            <tr key={c.id}>
                                              <td className="px-3 py-2 text-gray-900">
                                                {fmtDT(c.fecha)}
                                              </td>
                                              <td className="px-3 py-2 text-gray-900">
                                                {c.codigo}
                                              </td>
                                              <td className="px-3 py-2 text-right text-gray-900">
                                                {c.metros}
                                              </td>
                                              <td className="px-3 py-2 text-gray-900">
                                                {c.personal?.nombre || "-"}
                                              </td>
                                              <td className="px-3 py-2 text-gray-900">
                                                {c.observacion || "-"}
                                              </td>
                                            </tr>
                                          ))}
                                          <tr className="font-medium bg-gray-100">
                                            <td
                                              className="px-3 py-2"
                                              colSpan={2}
                                            >
                                              Total
                                            </td>
                                            <td className="px-3 py-2 text-right">
                                              {totalMetros}
                                            </td>
                                            <td
                                              className="px-3 py-2"
                                              colSpan={2}
                                            ></td>
                                          </tr>
                                        </tbody>
                                      </table>
                                    </div>
                                  )}
                                </div>
                              </div>
                            </div>
                          </td>
                        </tr>
                      </Fragment>
                    );
                  })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}
