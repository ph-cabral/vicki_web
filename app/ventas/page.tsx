"use client";
import { useEffect, useState } from "react";
import { Users } from "lucide-react";
import { InicioButton } from "@/components/ui/InicioButton";
import { UsuarioActual } from "@/components/auth/UsuarioActual";
import SerieMensual from "./SerieMensual";

// ──────────────────────────────────────────────────────────────────────────
// /ventas — dashboard del módulo (2026-10-01). Aloja el gráfico "Venta por
// mes" (antes estaba dentro de /ventas/vendedor). Al existir este page.tsx,
// gen-nav marca ventas con hasIndex=true y el botón del home entra acá, con
// las vistas hijas como satélites.
//
// Filtro de vendedor SOLO ADMIN: misma fuente que /ventas/vendedor
// (/api/ventas/vendedor/vendedores, admin-only). Si contesta 403 no se
// muestra el filtro: el no-admin queda acotado a su vendedorCodigo en el
// servidor (ver app/api/ventas/vendedor/serie-mensual/route.ts).
// ──────────────────────────────────────────────────────────────────────────

interface VendedorOpcion {
  codigo: number;
  nombre: string | null;
}

export default function VentasPage() {
  const [vendedores, setVendedores] = useState<VendedorOpcion[]>([]);
  const [vendedorSel, setVendedorSel] = useState("");
  const [esAdmin, setEsAdmin] = useState(false);

  useEffect(() => {
    let vivo = true;
    fetch("/api/ventas/vendedor/vendedores", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!vivo || !j) return;
        setEsAdmin(true);
        setVendedores(Array.isArray(j.vendedores) ? j.vendedores : []);
      })
      .catch(() => {});
    return () => {
      vivo = false;
    };
  }, []);

  return (
    <div className="min-h-screen bg-[#111111] text-white">
      <header className="sticky top-0 z-50 bg-[#1A1A1A] border-b-[3px] border-yellow-400 flex items-center justify-between px-4 md:px-8 h-16 gap-4">
        <div className="flex items-center gap-4 min-w-0">
          <InicioButton />
          <span className="font-bold text-yellow-400 text-xl md:text-2xl tracking-wide uppercase whitespace-nowrap">
            EVER WEAR <span className="text-sm tracking-[3px] font-normal">S.A.</span>
          </span>
          <div className="hidden md:block w-px h-7 bg-yellow-400/30" />
          <span className="hidden md:inline text-zinc-500 text-sm">Ventas</span>
        </div>
        <div className="flex items-center gap-3 min-w-0">
          {esAdmin && (
            <div className="flex min-w-0 items-center gap-2">
              <Users size={14} className="text-yellow-400 shrink-0" />
              <select
                value={vendedorSel}
                onChange={(e) => setVendedorSel(e.target.value)}
                disabled={vendedores.length === 0}
                title="Ver la venta de un vendedor"
                className="bg-[#1f1f1f] border border-zinc-700 rounded-md px-2 py-1.5 text-xs text-zinc-100 outline-none focus:border-yellow-400 min-w-0 max-w-[160px] md:text-sm md:max-w-[220px] disabled:opacity-50"
              >
                <option value="">
                  {vendedores.length === 0 ? "Sin vendedores activos" : "Todos los vendedores"}
                </option>
                {vendedores.map((v) => (
                  <option key={v.codigo} value={String(v.codigo)}>
                    {v.nombre ?? `Vendedor ${v.codigo}`}
                  </option>
                ))}
              </select>
            </div>
          )}
          <UsuarioActual />
        </div>
      </header>

      <main className="max-w-[1400px] mx-auto px-4 md:px-8 py-8 space-y-6">
        <SerieMensual vendedor={vendedorSel} />
      </main>
    </div>
  );
}
