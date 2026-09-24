"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InicioButton } from "@/components/ui/InicioButton";
import { UsuarioActual } from "@/components/auth/UsuarioActual";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

// ──────────────────────────────────────────────────────────────────────────────
// Mostradores → Control — códigos patrón mandados a control desde Administrar
// y todavía sin cerrar. Lee GET /api/mostradores/pendientes.
// ──────────────────────────────────────────────────────────────────────────────

interface Pendiente {
  id: number;
  codigo: string;
  detalle: string;
  lineaId: number | null;
  linea: string;
  mandadoAt: string | null;
}

const fmtFechaHora = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires", dateStyle: "short", timeStyle: "short" }) : "—";

const thBase = "px-2.5 py-2 text-[10px] font-semibold uppercase tracking-wider whitespace-nowrap border-b border-zinc-800 text-zinc-500";

export default function ControlPage() {
  const [pendientes, setPendientes] = useState<Pendiente[]>([]);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    setCargando(true);
    setError(null);
    try {
      const res = await fetch("/api/mostradores/pendientes", { cache: "no-store" });
      const json = (await res.json().catch(() => null)) as { pendientes?: Pendiente[]; error?: string } | null;
      if (!res.ok || !json) throw new Error(json?.error ?? `HTTP ${res.status}`);
      setPendientes(json.pendientes ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo cargar");
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => {
    cargar();
  }, [cargar]);

  return (
    <div className="dark min-h-screen bg-[#111111] text-white">
      <div className="container mx-auto px-6 py-8 max-w-6xl">
        <InicioButton label="Inicio" iconSize={16} className="text-sm text-zinc-500 hover:text-yellow-400 transition-colors mb-4" />
        <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-yellow-400 font-bold text-xl uppercase tracking-wide">Mostradores · Control</h1>
            <p className="text-sm text-zinc-500 mt-1">Códigos patrón pendientes de control.</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="icon" onClick={cargar} disabled={cargando} title="Recargar">
              <RefreshCw className={`h-4 w-4 ${cargando ? "animate-spin" : ""}`} />
            </Button>
            <UsuarioActual className="text-muted-foreground" />
          </div>
        </header>

        {error && (
          <div className="mb-4 flex items-center gap-2 text-sm text-[#f85149] bg-[#f85149]/10 border border-[#f85149]/30 rounded px-3 py-2">
            <AlertCircle className="h-4 w-4 shrink-0" />
            {error}
          </div>
        )}

        <section className="rounded-lg bg-[#171717] border border-zinc-800 overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="bg-[#1f1f1f] hover:bg-[#1f1f1f]">
                <TableHead className={thBase}>Línea</TableHead>
                <TableHead className={thBase}>Código patrón</TableHead>
                <TableHead className={thBase}>Detalle</TableHead>
                <TableHead className={thBase}>Mandado</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {cargando && !pendientes.length && (
                <TableRow>
                  <TableCell colSpan={4} className="py-10 text-center text-zinc-600">
                    <Loader2 className="h-4 w-4 animate-spin inline mr-2" />
                    Consultando…
                  </TableCell>
                </TableRow>
              )}
              {!cargando && !pendientes.length && (
                <TableRow>
                  <TableCell colSpan={4} className="py-10 text-center text-zinc-600">
                    No hay códigos patrón pendientes de control
                  </TableCell>
                </TableRow>
              )}
              {pendientes.map((p) => (
                <TableRow key={p.id} className="border-b border-zinc-800/60 hover:bg-[#1f1f1f]">
                  <TableCell className="px-2.5 text-zinc-100">{p.linea || "—"}</TableCell>
                  <TableCell className="px-2.5 tabular-nums text-zinc-100">{p.codigo}</TableCell>
                  <TableCell className="px-2.5 text-zinc-300">{p.detalle || <span className="text-zinc-600">—</span>}</TableCell>
                  <TableCell className="px-2.5 tabular-nums text-zinc-400">{fmtFechaHora(p.mandadoAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      </div>
    </div>
  );
}
