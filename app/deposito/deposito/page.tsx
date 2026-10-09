"use client";
import { useState } from "react";
import { MesaControlTab } from "../components/mesaControl";
import { PedidosAsignadosTab } from "../components/pedidosAsignados";
import { AsignarPedidosTab } from "../components/asignarPedidos";
import { PorOperarioTab } from "../components/porOperario";
import { InicioButton } from "@/components/ui/InicioButton";
import { UsuarioActual } from "@/components/auth/UsuarioActual";

// ──────────────────────────────────────────────────────────────────────────────
// Depósito · Mesas de Control — 4 sub-vistas: "Resumen" (agregado mensual),
// "Pedidos asignados" (detalle por pedido, deposito.control_asignacion),
// "Asignar pedidos" (asignarPedidos.tsx, 2026-09-24) y "Por operario"
// (porOperario.tsx, 2026-10-02). Los gráficos WMS que vivían acá en una
// pestaña aparte se mudaron a /sistema/wms (2026-10-09).
// ──────────────────────────────────────────────────────────────────────────────

type MesasSubTab = "resumen" | "asignados" | "asignar" | "operario";

const MESAS_SUB: { id: MesasSubTab; label: string }[] = [
  { id: "resumen", label: "Resumen" },
  { id: "asignados", label: "Pedidos asignados" },
  { id: "asignar", label: "Asignar pedidos" },
  { id: "operario", label: "Por operario" },
];

export default function DepositoDepositoPage() {
  const [mesasSub, setMesasSub] = useState<MesasSubTab>("resumen");

  return (
    <div className="min-h-screen bg-[#111111] text-white">
      <header className="sticky top-0 z-50 bg-[#1A1A1A] border-b-[3px] border-yellow-400 flex items-center gap-4 px-8 h-16">
        <InicioButton />
        <span className="font-bold text-yellow-400 text-2xl tracking-wide uppercase">
          EVER WEAR <span className="text-sm tracking-[3px] font-normal">S.A.</span>
        </span>
        <div className="w-px h-7 bg-yellow-400/30" />
        <span className="text-zinc-500 text-sm hidden lg:inline">
          Depósito · Mesas de Control
        </span>
        <UsuarioActual className="ml-auto" />
      </header>
      <main className="max-w-[1400px] mx-auto px-8 py-8">
        <div className="flex gap-1 mb-6 border-b border-zinc-800">
          {MESAS_SUB.map(({ id, label }) => (
            <button
              key={id}
              onClick={() => setMesasSub(id)}
              className={`px-4 py-2.5 text-sm font-medium border-b-[3px] -mb-px transition-colors ${
                mesasSub === id
                  ? "text-yellow-400 border-yellow-400"
                  : "text-zinc-500 border-transparent hover:text-zinc-200"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {mesasSub === "resumen" && <MesaControlTab />}
        {mesasSub === "asignados" && <PedidosAsignadosTab />}
        {mesasSub === "asignar" && <AsignarPedidosTab />}
        {mesasSub === "operario" && <PorOperarioTab />}
      </main>
    </div>
  );
}
