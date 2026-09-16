"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, Phone, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// Asignación de extensiones de Issabel a usuarios para el softphone web
// (components/telefonia/Softphone.tsx). La clave SIP se escribe acá y se guarda
// cifrada; nunca se vuelve a mostrar. Ver TELEFONIA.md.

type Fila = {
  id: number;
  nombre: string;
  sector: string | null;
  extension: string | null;
  activo: boolean;
};

type Borrador = { extension: string; clave: string };

export function TelefoniaClient() {
  const [filas, setFilas] = useState<Fila[]>([]);
  const [configurada, setConfigurada] = useState(true);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [soloAsignados, setSoloAsignados] = useState(false);
  const [borr, setBorr] = useState<Record<number, Borrador>>({});
  const [guardando, setGuardando] = useState<number | null>(null);

  async function load() {
    setLoading(true);
    try {
      const r = await fetch("/api/admin/telefonia");
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error ?? "Error");
      setFilas(d.usuarios);
      setConfigurada(d.configurada);
      setBorr({});
    } catch (e: any) {
      toast.error(e?.message ?? "No se pudo cargar");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const visibles = useMemo(() => {
    const t = q.trim().toLowerCase();
    return filas.filter(
      (f) =>
        (!soloAsignados || f.extension) &&
        (!t ||
          f.nombre.toLowerCase().includes(t) ||
          (f.sector ?? "").toLowerCase().includes(t) ||
          (f.extension ?? "").includes(t)),
    );
  }, [filas, q, soloAsignados]);

  const asignadas = filas.filter((f) => f.extension).length;

  function valor(f: Fila): Borrador {
    return borr[f.id] ?? { extension: f.extension ?? "", clave: "" };
  }

  async function guardar(f: Fila) {
    const b = valor(f);
    setGuardando(f.id);
    try {
      const r = await fetch("/api/admin/telefonia", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ usuarioId: f.id, extension: b.extension.trim(), clave: b.clave }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.error ?? "Error");
      toast.success(`Extensión ${b.extension} asignada a ${f.nombre}`);
      await load();
    } catch (e: any) {
      toast.error(e?.message ?? "No se pudo guardar");
    } finally {
      setGuardando(null);
    }
  }

  async function quitar(f: Fila) {
    setGuardando(f.id);
    try {
      const r = await fetch("/api/admin/telefonia", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ usuarioId: f.id }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.error ?? "Error");
      toast.success(`Se quitó la extensión a ${f.nombre}`);
      await load();
    } catch (e: any) {
      toast.error(e?.message ?? "No se pudo quitar");
    } finally {
      setGuardando(null);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-lg font-medium">Telefonía</h1>
      <p className="text-sm text-muted-foreground">
        Asigná una extensión de Issabel a cada persona que atiende desde la computadora. Con extensión
        asignada le aparece el teléfono abajo a la derecha en toda la app. La clave es la
        &quot;secret&quot; de la extensión en Issabel; se guarda cifrada y no se vuelve a mostrar (dejala
        vacía para conservar la actual). Los cambios toman efecto al recargar la página del usuario.
      </p>

      {!configurada && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
          Falta configurar <code>ISSABEL_WS_URL</code> en el .env del server: sin eso el teléfono no
          aparece para nadie.
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar persona, sector o extensión"
            className="w-72 pl-8"
          />
        </div>
        <label className="flex items-center gap-1.5 text-sm">
          <input
            type="checkbox"
            checked={soloAsignados}
            onChange={(e) => setSoloAsignados(e.target.checked)}
          />
          Sólo con extensión
        </label>
        <span className="ml-auto text-xs text-muted-foreground">
          {asignadas} extensión{asignadas === 1 ? "" : "es"} asignada{asignadas === 1 ? "" : "s"}
        </span>
      </div>

      {loading ? (
        <div className="flex justify-center py-10 text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
        </div>
      ) : (
        <div className="rounded-lg ring-1 ring-foreground/10 divide-y divide-border">
          {visibles.length === 0 && (
            <p className="px-3 py-4 text-sm text-muted-foreground">Sin resultados.</p>
          )}
          {visibles.map((f) => {
            const b = valor(f);
            const cambio = b.extension !== (f.extension ?? "") || b.clave !== "";
            const ocupado = guardando === f.id;
            return (
              <div key={f.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                <div className="min-w-44 flex-1">
                  <div className="flex items-center gap-1.5 text-sm font-medium">
                    {f.extension && <Phone className="size-3.5 text-emerald-500" />}
                    {f.nombre}
                  </div>
                  {f.sector && <div className="text-xs text-muted-foreground">{f.sector}</div>}
                </div>
                <Input
                  value={b.extension}
                  inputMode="numeric"
                  placeholder="Ext."
                  className="w-20"
                  onChange={(e) =>
                    setBorr((p) => ({ ...p, [f.id]: { ...b, extension: e.target.value.replace(/\D/g, "") } }))
                  }
                />
                <Input
                  type="password"
                  autoComplete="new-password"
                  value={b.clave}
                  placeholder={f.extension ? "•••• (sin cambios)" : "Clave SIP"}
                  className="w-40"
                  onChange={(e) => setBorr((p) => ({ ...p, [f.id]: { ...b, clave: e.target.value } }))}
                />
                <Button
                  size="sm"
                  disabled={!cambio || !b.extension || (!f.extension && !b.clave) || ocupado}
                  onClick={() => guardar(f)}
                >
                  {ocupado ? <Loader2 className="size-3.5 animate-spin" /> : "Guardar"}
                </Button>
                {f.extension && (
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    title="Quitar extensión"
                    disabled={ocupado}
                    onClick={() => quitar(f)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
