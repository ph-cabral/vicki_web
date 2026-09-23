"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, AlertTriangle, X, Search, Check, ShieldCheck } from "lucide-react";

// ──────────────────────────────────────────────────────────────────────────────
// Configuración de líneas por usuario (2026-09-23) — SÓLO ADMIN.
//
// Decide qué líneas del catálogo puede elegir cada usuario en la vista de
// líneas (/ventas/bulones). Reglas (ver lib/ventas/lineasAcceso.ts):
//   · ADMIN: ve todas, no se configura.
//   · Sin ninguna línea marcada = sólo la línea por defecto (Bulones).
//   · Con líneas marcadas = exactamente esas.
// Guarda por usuario (PUT /api/ventas/lineas/permisos, reemplaza la lista
// entera en una transacción). El cambio aplica en la próxima consulta del
// usuario, sin relogin.
// ──────────────────────────────────────────────────────────────────────────────

interface Linea {
  id: number;
  nombre: string;
}

interface UsuarioCfg {
  id: number;
  nombre: string;
  rol: string;
  sector: string | null;
  vendedorCodigo: number | null;
  activo: boolean;
  bulonesAccesoTotal: boolean;
  lineas: number[];
}

export default function ConfigLineas({ onCerrar }: { onCerrar: () => void }) {
  const [lineas, setLineas] = useState<Linea[]>([]);
  const [defecto, setDefecto] = useState<number | null>(null);
  const [usuarios, setUsuarios] = useState<UsuarioCfg[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [selId, setSelId] = useState<number | null>(null);
  const [marcadas, setMarcadas] = useState<Set<number>>(new Set());
  const [guardando, setGuardando] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);

  useEffect(() => {
    let cancelado = false;
    (async () => {
      try {
        const res = await fetch("/api/ventas/lineas/permisos", { cache: "no-store" });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
        if (cancelado) return;
        setLineas(j.lineas ?? []);
        setDefecto(typeof j.defecto === "number" ? j.defecto : null);
        setUsuarios(j.usuarios ?? []);
      } catch (e) {
        if (!cancelado) setError(e instanceof Error ? e.message : "Error al cargar");
      } finally {
        if (!cancelado) setCargando(false);
      }
    })();
    return () => {
      cancelado = true;
    };
  }, []);

  const nombreLinea = useCallback(
    (id: number) => lineas.find((l) => l.id === id)?.nombre ?? `#${id}`,
    [lineas],
  );

  const filtrados = useMemo(() => {
    const t = q.trim().toLowerCase();
    return usuarios.filter(
      (u) =>
        !t ||
        u.nombre.toLowerCase().includes(t) ||
        (u.sector ?? "").toLowerCase().includes(t) ||
        String(u.vendedorCodigo ?? "").includes(t),
    );
  }, [usuarios, q]);

  const sel = usuarios.find((u) => u.id === selId) ?? null;

  const elegir = (u: UsuarioCfg) => {
    setSelId(u.id);
    setMarcadas(new Set(u.lineas));
    setAviso(null);
  };

  const resumen = (u: UsuarioCfg) => {
    if (u.rol === "ADMIN") return "Todas (admin)";
    if (!u.lineas.length) return `${defecto != null ? nombreLinea(defecto) : "Por defecto"} (por defecto)`;
    if (u.lineas.length === 1) return nombreLinea(u.lineas[0]);
    return `${u.lineas.length} líneas`;
  };

  const cambiado =
    !!sel &&
    (sel.lineas.length !== marcadas.size || sel.lineas.some((id) => !marcadas.has(id)));

  const guardar = async () => {
    if (!sel) return;
    setGuardando(true);
    setAviso(null);
    try {
      const ids = [...marcadas];
      const res = await fetch("/api/ventas/lineas/permisos", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ usuarioId: sel.id, lineas: ids }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setUsuarios((us) => us.map((u) => (u.id === sel.id ? { ...u, lineas: ids } : u)));
      setAviso("Guardado");
    } catch (e) {
      setAviso(e instanceof Error ? e.message : "No se pudo guardar");
    } finally {
      setGuardando(false);
    }
  };

  const toggle = (id: number) =>
    setMarcadas((m) => {
      const n = new Set(m);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <div
      className="fixed inset-0 z-[120] bg-black/70 flex items-start justify-center p-3 md:p-4 overflow-y-auto"
      onClick={onCerrar}
    >
      <div
        className="w-full max-w-5xl max-h-[calc(100dvh-1.5rem)] md:max-h-[90dvh] rounded-xl border border-zinc-800 bg-[#111111] flex flex-col overflow-hidden shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 bg-[#1A1A1A] border-b border-zinc-800 px-5 py-4 flex items-start justify-between gap-4">
          <div>
            <h3 className="font-bold text-base uppercase tracking-wide text-yellow-400">
              Líneas por usuario
            </h3>
            <p className="text-zinc-500 text-xs mt-0.5">
              Los administradores ven todas. Sin ninguna línea marcada, el usuario ve sólo{" "}
              {defecto != null ? nombreLinea(defecto) : "la línea por defecto"}.
            </p>
          </div>
          <button
            type="button"
            onClick={onCerrar}
            className="text-zinc-500 hover:text-zinc-200 transition-colors"
            aria-label="Cerrar"
          >
            <X size={20} />
          </button>
        </div>

        {cargando ? (
          <div className="px-5 py-16 flex items-center justify-center gap-3 text-sm text-zinc-400">
            <Loader2 size={16} className="animate-spin text-yellow-400" /> Cargando…
          </div>
        ) : error ? (
          <div className="m-5 rounded-xl border border-red-400/40 px-5 py-4 flex items-center gap-3 text-sm text-red-300">
            <AlertTriangle size={16} className="text-red-400" /> {error}
          </div>
        ) : (
          <div className="flex-1 min-h-0 grid md:grid-cols-[320px_1fr]">
            {/* Usuarios */}
            <div className="min-h-0 flex flex-col border-b md:border-b-0 md:border-r border-zinc-800 max-h-[35dvh] md:max-h-none">
              <div className="p-3 border-b border-zinc-800">
                <div className="flex items-center gap-2 rounded-md border border-zinc-700 px-3 py-2">
                  <Search size={14} className="text-zinc-500" />
                  <input
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="Buscar usuario, sector o vendedor"
                    className="w-full bg-transparent text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none"
                  />
                </div>
              </div>
              <ul className="flex-1 overflow-y-auto divide-y divide-zinc-800/70">
                {filtrados.map((u) => (
                  <li key={u.id}>
                    <button
                      type="button"
                      onClick={() => elegir(u)}
                      className={`w-full text-left px-4 py-2.5 transition-colors ${
                        u.id === selId ? "bg-yellow-400/10" : "hover:bg-zinc-800/50"
                      } ${u.activo ? "" : "opacity-50"}`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm text-zinc-100 truncate">{u.nombre}</span>
                        {u.rol === "ADMIN" && <ShieldCheck size={14} className="text-yellow-400 shrink-0" />}
                      </div>
                      <div className="text-[11px] text-zinc-500 truncate">
                        {u.vendedorCodigo ? `Vend. ${u.vendedorCodigo} · ` : ""}
                        {resumen(u)}
                      </div>
                    </button>
                  </li>
                ))}
                {!filtrados.length && (
                  <li className="px-4 py-6 text-center text-xs text-zinc-600">Sin coincidencias</li>
                )}
              </ul>
            </div>

            {/* Líneas del usuario elegido */}
            <div className="min-h-0 flex flex-col">
              {!sel ? (
                <p className="px-5 py-16 text-center text-sm text-zinc-600">
                  Elegí un usuario para ver y cambiar sus líneas.
                </p>
              ) : sel.rol === "ADMIN" ? (
                <p className="px-5 py-16 text-center text-sm text-zinc-400">
                  {sel.nombre} es administrador: ve y elige todas las líneas.
                </p>
              ) : (
                <>
                  <div className="shrink-0 px-5 py-3 border-b border-zinc-800 flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-zinc-100 truncate">{sel.nombre}</p>
                      <p className="text-[11px] text-zinc-500">
                        {marcadas.size === 0
                          ? `Sin líneas marcadas: ve sólo ${defecto != null ? nombreLinea(defecto) : "la de defecto"}`
                          : `${marcadas.size} ${marcadas.size === 1 ? "línea habilitada" : "líneas habilitadas"}`}
                        {sel.bulonesAccesoTotal ? " · ve toda la empresa en sus líneas" : " · ve sólo sus ventas"}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setMarcadas(new Set())}
                        className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:border-zinc-500"
                      >
                        Limpiar
                      </button>
                      <button
                        type="button"
                        onClick={() => void guardar()}
                        disabled={!cambiado || guardando}
                        className="inline-flex items-center gap-1.5 rounded-md bg-yellow-400 px-3 py-1.5 text-xs font-semibold text-black disabled:opacity-40"
                      >
                        {guardando ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                        Guardar
                      </button>
                    </div>
                  </div>
                  {aviso && (
                    <p
                      className={`px-5 pt-2 text-xs ${aviso === "Guardado" ? "text-green-400" : "text-red-300"}`}
                    >
                      {aviso}
                    </p>
                  )}
                  <div className="flex-1 overflow-y-auto p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 content-start">
                    {lineas.map((l) => {
                      const on = marcadas.has(l.id);
                      return (
                        <button
                          key={l.id}
                          type="button"
                          onClick={() => toggle(l.id)}
                          className={`flex items-center gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors ${
                            on
                              ? "border-yellow-400/60 bg-yellow-400/10 text-zinc-100"
                              : "border-zinc-800 text-zinc-400 hover:border-zinc-600"
                          }`}
                        >
                          <span
                            className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                              on ? "border-yellow-400 bg-yellow-400 text-black" : "border-zinc-600"
                            }`}
                          >
                            {on && <Check size={11} />}
                          </span>
                          <span className="truncate">{l.nombre}</span>
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
