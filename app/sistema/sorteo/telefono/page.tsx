import type { Metadata } from "next";
import { InicioButton } from "@/components/ui/InicioButton";
import { Softphone } from "@/components/telefonia/Softphone";

export const metadata: Metadata = { title: "Teléfono — EverWear" };

// Softphone web (Issabel) como vista del módulo sorteo. Ver TELEFONIA.md.
// La llamada vive mientras esta pestaña esté abierta en esta vista.
export default function TelefonoPage() {
  return (
    <div className="min-h-screen bg-[#0f0f0f] text-zinc-100">
      <header className="flex items-center gap-2 border-b border-zinc-800 px-4 py-2">
        <InicioButton />
        <span className="text-sm font-medium">Teléfono</span>
        <span className="ml-auto text-xs text-zinc-500">Dejá esta pestaña abierta para recibir llamadas</span>
      </header>
      <main className="px-4 py-8">
        <Softphone modo="pagina" />
      </main>
    </div>
  );
}
