"use client";

import { useState } from "react";
import { MangueraTable } from "./components/MangueraTable";
import { AddMangueraModal } from "./components/AddMangueraModal";
import { AddPersonalModal } from "./components/AddPersonalModal";
import ReportesModal from "./components/ReportesModal";
import { InicioButton } from "@/components/ui/InicioButton";
import { UsuarioActual } from "@/components/auth/UsuarioActual";

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

export function ManguerasClient({
  mangueras,
  personal,
}: {
  mangueras: Manguera[];
  personal: Personal[];
}) {
  const [modalAbierto, setModalAbierto] = useState(false);
  const [modalPersonal, setModalPersonal] = useState(false);
  const [modalReportes, setModalReportes] = useState(false);
  const [personalSeleccionado, setPersonalSeleccionado] = useState<number | "">(
    "",
  );

  return (
    <main className="container mx-auto p-4">
      <div className="flex items-center justify-between gap-3 mb-3">
        <InicioButton label="Inicio" iconSize={14} className="text-sm text-gray-500 hover:text-gray-900 transition-colors" />
        <UsuarioActual className="text-muted-foreground" />
      </div>
      <div className="flex flex-col lg:flex-row gap-4 items-start lg:items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Control de Mangueras</h1>

        <div className="flex flex-row lg:flex-row gap-4 items-start lg:items-center w-full lg:w-auto">
          <div className="flex items-center gap-1">
            {/* <SelectPersonal
              personal={personal}
              value={personalSeleccionado}
              onChange={setPersonalSeleccionado}
            /> */}
            {/* <button
              onClick={() => setModalPersonal(true)}
              className="px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-lg transition-colors text-lg"
              title="Agregar personal"
            >
              +
            </button> */}
          </div>

          {/* <button
            onClick={() => setModalAbierto(true)}
            className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white font-medium rounded-lg transition-colors whitespace-nowrap"
          >
            + Agregar Manguera
          </button> */}

          <button
            onClick={() => setModalReportes(true)}
            className="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white font-medium rounded-lg transition-colors whitespace-nowrap"
          >
            📊 Reportes
          </button>
        </div>
      </div>

      {/* {!personalSeleccionado && personal.length > 0 && (
        <div className="mb-4 bg-yellow-50 border border-yellow-200 text-yellow-800 px-4 py-2 rounded-lg text-sm">
          ⚠️ Seleccioná a alguien para poder cortar mangueras
        </div>
      )} */}

      <AddMangueraModal
        isOpen={modalAbierto}
        onClose={() => setModalAbierto(false)}
        codigoPrellenado=""
      />

      <AddPersonalModal
        isOpen={modalPersonal}
        onClose={() => setModalPersonal(false)}
      />

      <ReportesModal
        isOpen={modalReportes}
        onClose={() => setModalReportes(false)}
      />

      <MangueraTable
        mangueras={mangueras}
        personal={personal}
        personalSeleccionado={personalSeleccionado}
      />
    </main>
  );
}
