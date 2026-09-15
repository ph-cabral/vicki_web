"use client";

import { useEffect, useState } from "react";
import { Loader2, ChevronRight, ChevronDown } from "lucide-react";
import { toast } from "sonner";
import { Checkbox } from "@/components/ui/checkbox";

type ModuloDef = { key: string; label: string };
type UsuarioDef = { id: number; nombre: string; sector: string | null };

function keyOf(usuarioId: number, modulo: string) {
  return `${usuarioId}:${modulo}`;
}

export function EncargadosClient() {
  const [modulos, setModulos] = useState<ModuloDef[]>([]);
  const [usuarios, setUsuarios] = useState<UsuarioDef[]>([]);
  const [asignados, setAsignados] = useState<Set<string>>(new Set());
  const [pendientes, setPendientes] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [abierto, setAbierto] = useState<Record<string, boolean>>({});

  async function load() {
    setLoading(true);
    try {
      const r = await fetch("/api/admin/encargados");
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error ?? "Error");
      setModulos(d.modulos);
      setUsuarios(d.usuarios);
      setAsignados(
        new Set(d.asignaciones.map((a: { usuarioId: number; modulo: string }) => keyOf(a.usuarioId, a.modulo))),
      );
    } catch (e: any) {
      toast.error(e?.message ?? "No se pudieron cargar los encargados");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function toggle(usuarioId: number, modulo: string) {
    const key = keyOf(usuarioId, modulo);
    const estabaAsignado = asignados.has(key);
    setPendientes((p) => new Set(p).add(key));
    try {
      const r = await fetch("/api/admin/encargados", {
        method: estabaAsignado ? "DELETE" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ usuarioId, modulo }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.error ?? "Error");
      setAsignados((prev) => {
        const next = new Set(prev);
        if (estabaAsignado) next.delete(key);
        else next.add(key);
        return next;
      });
    } catch (e: any) {
      toast.error(e?.message ?? "No se pudo guardar");
    } finally {
      setPendientes((p) => {
        const next = new Set(p);
        next.delete(key);
        return next;
      });
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-lg font-medium">Encargados de módulo</h1>
      <p className="text-sm text-muted-foreground">
        Marcá qué personas son encargadas de cada módulo. Hoy esto habilita, por ejemplo, editar
        los objetivos de /deposito — podés marcar a más de una persona por módulo. Esto NO cambia
        a qué vistas puede entrar nadie; eso lo sigue dando el sector en Permisos. Los cambios
        aplican al toque, sin relogin.
      </p>

      {loading ? (
        <div className="flex justify-center py-10 text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {modulos.map((m) => {
            const open = abierto[m.key] ?? false;
            const count = usuarios.filter((u) => asignados.has(keyOf(u.id, m.key))).length;
            return (
              <div key={m.key} className="rounded-lg ring-1 ring-foreground/10">
                <button
                  type="button"
                  onClick={() => setAbierto((a) => ({ ...a, [m.key]: !open }))}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left"
                >
                  {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                  <span className="font-medium">{m.label}</span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {count} encargado{count === 1 ? "" : "s"}
                  </span>
                </button>

                {open && (
                  <div className="border-t border-border px-3 py-2">
                    {usuarios.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No hay usuarios activos.</p>
                    ) : (
                      usuarios.map((u) => {
                        const key = keyOf(u.id, m.key);
                        const checked = asignados.has(key);
                        return (
                          <div key={u.id} className="flex items-center gap-2 py-1">
                            <Checkbox
                              checked={checked}
                              disabled={pendientes.has(key)}
                              onCheckedChange={() => toggle(u.id, m.key)}
                            />
                            <span className={checked ? "text-sm font-medium" : "text-sm"}>
                              {u.nombre}
                            </span>
                            {u.sector && (
                              <span className="text-xs text-muted-foreground">{u.sector}</span>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
