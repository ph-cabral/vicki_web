"use client";
import { PedidosAsignadosTab } from "../components/pedidosAsignados";
import { AsignarPedidosTab } from "../components/asignarPedidos";
import { PorOperarioTab } from "../components/porOperario";
import { PreparadoresWms } from "../components/preparadoresWms";
import { WmsResumenBar, useWmsEstados } from "../components/wmsResumen";
import { InicioButton } from "@/components/ui/InicioButton";
import { UsuarioActual } from "@/components/auth/UsuarioActual";

// ──────────────────────────────────────────────────────────────────────────────
// Depósito · Streaming (antes /deposito/deposito) — una sola vista apilada:
// KPIs WMS por estado (arriba de todo, con selector de rango), cartas "Preparadores con actividad" (OT del WMS), "Asignar pedidos",
// tablas "Por operario" y, abajo de todo, "Pedidos asignados"
// (deposito.control_asignacion). Sin tabs.
// ──────────────────────────────────────────────────────────────────────────────

export default function DepositoStreamingPage() {
  // Una sola consulta a wms-estados alimenta los KPIs y las cartas de preparadores.
  const wms = useWmsEstados();
  return (
    <div className="min-h-screen bg-[#111111] text-white">
      <header className="sticky top-0 z-50 bg-[#1A1A1A] border-b-[3px] border-yellow-400 flex items-center gap-4 px-8 h-16">
        <InicioButton />
        <span className="font-bold text-yellow-400 text-2xl tracking-wide uppercase">
          EVER WEAR <span className="text-sm tracking-[3px] font-normal">S.A.</span>
        </span>
        <div className="w-px h-7 bg-yellow-400/30" />
        <span className="text-zinc-500 text-sm hidden lg:inline">
          Depósito · Streaming
        </span>
        <UsuarioActual className="ml-auto" />
      </header>
      <main className="max-w-[1400px] mx-auto px-8 py-8">
        <WmsResumenBar ctl={wms} />
        <PreparadoresWms externo={{ data: wms.data, loading: wms.loading, error: wms.error }} />
        <AsignarPedidosTab sticky={false} />
        <PorOperarioTab sticky={false} />
        <PedidosAsignadosTab sticky={false} />
      </main>
    </div>
  );
}
