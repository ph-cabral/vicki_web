"use client";
import { useState } from "react";
import { PedidosAsignadosTab } from "../components/pedidosAsignados";
import { AsignarPedidosTab } from "../components/asignarPedidos";
import { PorOperarioTab } from "../components/porOperario";
import { PreparadoresWms } from "../components/preparadoresWms";
import { InicioButton } from "@/components/ui/InicioButton";
import { UsuarioActual } from "@/components/auth/UsuarioActual";

// ──────────────────────────────────────────────────────────────────────────────
// Depósito — arriba, siempre visibles, las cartas "Preparadores con actividad"
// (OT del WMS por preparador y estado). Debajo, Mesas de Control con 2 sub-vistas:
//  · "Asignar y por operario" (default): pedidos a asignar (asignarPedidos.tsx)
//    seguidos de las tablas por operario (porOperario.tsx).
//  · "Pedidos asignados": detalle por pedido (deposito.control_asignacion).
// 2026-10-09: se sacó "Resumen" (MesaControlTab ya no se usa acá), se unificaron
// "Asignar pedidos" y "Por operario", y las cartas WMS volvieron a esta vista
// (el resto de los gráficos WMS quedó en /sistema/wms).
// ──────────────────────────────────────────────────────────────────────────────

type MesasSubTab = "asignar" | "asignados";

const MESAS_SUB: { id: MesasSubTab; label: string }[] = [
  { id: "asignar", label: "Asignar y por operario" },
  { id: "asignados", label: "Pedidos asignados" },
];

export default function DepositoDepositoPage() {
  const [mesasSub, setMesasSub] = useState<MesasSubTab>("asignar");

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
        <PreparadoresWms />
        <div className="flex gap-1 mt-8 mb-6 border-b border-zinc-800">
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
        {mesasSub === "asignar" && (
          <>
            <AsignarPedidosTab sticky={false} />
            <PorOperarioTab sticky={false} />
          </>
        )}
        {mesasSub === "asignados" && <PedidosAsignadosTab />}
      </main>
    </div>
  );
}
