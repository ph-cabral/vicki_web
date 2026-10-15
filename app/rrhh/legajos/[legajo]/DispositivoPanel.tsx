"use client";
// Celular registrado en la app Vicki para este legajo (un solo celular por usuario).
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

type Disp = {
  id: number;
  deviceId: string;
  modelo: string | null;
  estado: "ACTIVO" | "BLOQUEADO";
  createdAt: string;
  ultimoAcceso: string;
  bloqueadoAt: string | null;
};

const fmt = (iso: string) =>
  new Date(iso).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" });

export function DispositivoPanel({ legajoId }: { legajoId: number }) {
  const [cargando, setCargando] = useState(true);
  const [tieneUsuario, setTieneUsuario] = useState(true);
  const [lista, setLista] = useState<Disp[]>([]);
  const [ocupado, setOcupado] = useState<number | null>(null);

  const cargar = useCallback(async () => {
    try {
      const r = await fetch(`/api/rrhh/legajos/${legajoId}/dispositivos`, { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error ?? "Error");
      setTieneUsuario(!!j.usuario);
      setLista(j.dispositivos ?? []);
    } catch (e: any) {
      toast.error(e?.message ?? "No se pudo leer el celular registrado");
    } finally {
      setCargando(false);
    }
  }, [legajoId]);

  useEffect(() => {
    cargar();
  }, [cargar]);

  async function accion(d: Disp, a: "liberar" | "bloquear" | "desbloquear") {
    const msg =
      a === "liberar"
        ? "¿Liberar este celular? El usuario podrá registrar otro y este dejará de entrar."
        : a === "bloquear"
          ? "¿Bloquear este celular? No va a poder entrar a Vicki con ningún usuario."
          : "¿Quitar el bloqueo de este celular?";
    if (!window.confirm(msg)) return;
    setOcupado(d.id);
    try {
      const r = await fetch(`/api/rrhh/legajos/${legajoId}/dispositivos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accion: a, id: d.id }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error ?? "Error");
      toast.success(a === "bloquear" ? "Celular bloqueado" : a === "liberar" ? "Celular liberado" : "Bloqueo quitado");
      await cargar();
    } catch (e: any) {
      toast.error(e?.message ?? "No se pudo completar");
    } finally {
      setOcupado(null);
    }
  }

  const btn = "rounded-md border px-3 py-1.5 text-xs disabled:opacity-50 transition-colors";

  return (
    <div className="sm:col-span-3 space-y-3">
      <p className="text-xs text-zinc-500">
        La app Vicki sólo deja usar el usuario desde un celular. Se registra el primero con el que
        se ingresa. <b>Liberar</b> cuando cambia de celular (o lo vendió/reseteó de fábrica);{" "}
        <b>Bloquear</b> si se lo robaron. Se identifica por el ID del equipo (Android no permite leer
        la MAC real); se regenera con un reseteo de fábrica.
      </p>
      {cargando ? (
        <p className="text-sm text-zinc-500">Cargando…</p>
      ) : !tieneUsuario ? (
        <p className="text-sm text-zinc-500">Este legajo todavía no tiene usuario de Vicki.</p>
      ) : lista.length === 0 ? (
        <p className="text-sm text-zinc-500">Todavía no se registró ningún celular.</p>
      ) : (
        lista.map((d) => (
          <div key={d.id} className="flex flex-wrap items-center gap-3 rounded-md border border-zinc-800 bg-zinc-900/60 p-3">
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                d.estado === "ACTIVO"
                  ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30"
                  : "bg-red-500/15 text-red-300 border border-red-500/30"
              }`}
            >
              {d.estado === "ACTIVO" ? "Registrado" : "Bloqueado"}
            </span>
            <div className="min-w-0 flex-1 text-sm">
              <div className="truncate text-zinc-100">{d.modelo || "Celular"}</div>
              <div className="truncate font-mono text-xs text-zinc-500">{d.deviceId}</div>
              <div className="text-xs text-zinc-500">
                Registrado {fmt(d.createdAt)} · Último ingreso {fmt(d.ultimoAcceso)}
                {d.bloqueadoAt && ` · Bloqueado ${fmt(d.bloqueadoAt)}`}
              </div>
            </div>
            {d.estado === "ACTIVO" ? (
              <>
                <button type="button" disabled={ocupado === d.id} onClick={() => accion(d, "liberar")}
                  className={`${btn} border-zinc-600 text-zinc-200 hover:border-yellow-400 hover:text-yellow-400`}>
                  Liberar
                </button>
                <button type="button" disabled={ocupado === d.id} onClick={() => accion(d, "bloquear")}
                  className={`${btn} border-red-500/50 text-red-300 hover:bg-red-500/10`}>
                  Bloquear
                </button>
              </>
            ) : (
              <button type="button" disabled={ocupado === d.id} onClick={() => accion(d, "desbloquear")}
                className={`${btn} border-zinc-600 text-zinc-200 hover:border-yellow-400 hover:text-yellow-400`}>
                Desbloquear
              </button>
            )}
          </div>
        ))
      )}
    </div>
  );
}
