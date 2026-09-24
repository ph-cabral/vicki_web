"use client";
import { useState } from "react";
import { PackageSearch, ClipboardList } from "lucide-react";
import { WmsTab } from "../components/wmsTab";
import { MesaControlTab } from "../components/mesaControl";
import { PedidosAsignadosTab } from "../components/pedidosAsignados";
import { AsignarPedidosTab } from "../components/asignarPedidos";
import { InicioButton } from "@/components/ui/InicioButton";
import { UsuarioActual } from "@/components/auth/UsuarioActual";

// ──────────────────────────────────────────────────────────────────────────────
// Depósito · panel unificado — sidebar angosto a la izquierda con 2 vistas:
// "WMS" (ex /deposito/wms, migrada acá como componente) y "Mesas" (Mesas de
// Control). /deposito/wms redirige acá y ya no aparece en el menú.
//
// "Mesas" tiene 2 sub-vistas propias (agregado 2026-07-31): "Resumen" (la Mesa de Control de siempre, agregado mensual) y
// "Pedidos asignados" (detalle por pedido, deposito.control_asignacion — ver
// pedidosAsignados.tsx). 2026-09-24: "Asignar pedidos" (asignarPedidos.tsx) —
// elegir quién controla cada pedido listo o en preparación.
// ──────────────────────────────────────────────────────────────────────────────

type Tab = "wms" | "mesas";
type MesasSubTab = "resumen" | "asignados" | "asignar";

const NAV: { id: Tab; label: string; icon: typeof PackageSearch }[] = [
  { id: "wms", label: "WMS", icon: PackageSearch },
  { id: "mesas", label: "Mesas", icon: ClipboardList },
];

const MESAS_SUB: { id: MesasSubTab; label: string }[] = [
  { id: "resumen", label: "Resumen" },
  { id: "asignados", label: "Pedidos asignados" },
  { id: "asignar", label: "Asignar pedidos" },
];

export default function DepositoDepositoPage() {
  const [tab, setTab] = useState<Tab>("wms");
  const [mesasSub, setMesasSub] = useState<MesasSubTab>("resumen");

  return (
    <div className="min-h-screen bg-[#111111] text-white flex">
      {/* Sidebar */}
      <aside className="w-20 shrink-0 bg-[#1A1A1A] border-r border-zinc-800 flex flex-col items-center gap-2 py-4 sticky top-0 h-screen">
        {NAV.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`w-16 flex flex-col items-center gap-1.5 py-3 rounded-lg border text-[11px] font-medium transition-colors ${
              tab === id
                ? "bg-yellow-400/10 border-yellow-400/40 text-yellow-400"
                : "border-transparent text-zinc-500 hover:text-zinc-200 hover:border-zinc-700"
            }`}
          >
            <Icon size={18} />
            {label}
          </button>
        ))}
      </aside>

      {/* Contenido */}
      <div className="flex-1 min-w-0">
        {tab === "wms" && <WmsTab />}
        {tab === "mesas" && (
          <div className="min-h-screen">
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
            </main>
          </div>
        )}
      </div>
    </div>
  );
}
