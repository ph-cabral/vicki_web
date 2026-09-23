"use client";

import { useEffect, useState, useRef } from "react";
import { MapPin, X, Loader2, Truck } from "lucide-react";
import { UsuarioActual } from "@/components/auth/UsuarioActual";

const fmtNum = (n: number) =>
  new Intl.NumberFormat("es-AR", { maximumFractionDigits: 2 }).format(n || 0);

type Evento = {
  id: number;
  codigo: string;
  cantidad: number;
  picker_nombre: string;
  estado: string;
  creado_en: string;
};
type ChatMensaje = {
  id: number;
  picker_nombre: string;
  mensaje: string;
  creado_en: string;
};
// OT de reposición (OT1R) vivas con destino sin cumplir — /api/deposito/repo/en-curso
type RepoLinea = { Ubicacion: string; Pedido: number; Cumplido: number };
type RepoItem = {
  Articulo: string;
  Origenes: RepoLinea[];
  Destinos: RepoLinea[];
  Pedido: number;
  Cumplido: number;
  Pendiente: number;
  Cumplida: boolean;
};
type RepoOt = {
  OTId: number;
  Estado: number | null;
  EstadoLabel: string;
  Alta: string | null;
  InicioPick: string | null;
  Observaciones: string;
  Repositor: string;
  Items: RepoItem[];
};
type RepoData = { ots: RepoOt[]; articulos: Record<string, number[]> };

const normCod = (c: string) => (c ?? "").trim().toUpperCase();
const fmtHora = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString("es-AR", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";

const ESTADOS_DISPONIBLES = ["pendiente", "pedido", "s/e"] as const;
type Estado = (typeof ESTADOS_DISPONIBLES)[number];

export default function PickingPage() {
  const [eventos, setEventos] = useState<Evento[]>([]);
  const [mensajes, setMensajes] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState<Record<number, boolean>>({});

  const [chatMensajes, setChatMensajes] = useState<ChatMensaje[]>([]);

  const [mensajeSeleccionado, setMensajeSeleccionado] = useState<number | null>(
    null,
  );
  const [respuesta, setRespuesta] = useState("");
  const respuestaRef = useRef<HTMLInputElement>(null);
  const [estadoActivo, setEstadoActivo] = useState<Estado>("pendiente");
  const [busqueda, setBusqueda] = useState("");
  const [ubicArt, setUbicArt] = useState<string | null>(null); // artículo del modal de ubicaciones
  const [repo, setRepo] = useState<RepoData | null>(null);
  const [repoArt, setRepoArt] = useState<string | null>(null); // artículo del modal de OT de reposición

  const responderChat = async (id: number) => {
    if (!respuesta.trim()) return;
    await fetch(`/api/chat/${id}/responder`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ respuesta }),
    });
    setMensajeSeleccionado(null);
    setRespuesta("");
    fetchChat();
  };

  const fetchChat = async () => {
    const res = await fetch("/api/chat");
    if (res.ok) setChatMensajes(await res.json());
  };

  const fetchEventos = async () => {
    const res = await fetch(
      `/api/picking/eventos?estado=${encodeURIComponent(estadoActivo)}`,
    );
    if (res.ok) {
      const data = await res.json();
      setEventos(data);
    }
  };


  const eventosFiltrados = eventos.filter((e) => {
    const q = busqueda.trim().toLowerCase();
    if (!q) return true;
    return (
      e.codigo.toLowerCase().includes(q) ||
      e.picker_nombre.toLowerCase().includes(q)
    );
  });

  // Reposiciones en curso: cambia mucho más lento que los eventos, así que se
  // consulta aparte cada 30 s y se cruza por código en el navegador.
  useEffect(() => {
    let vivo = true;
    const cargar = () =>
      fetch("/api/deposito/repo/en-curso", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          if (vivo && j) setRepo(j);
        })
        .catch(() => {});
    cargar();
    const t = setInterval(cargar, 30000);
    return () => {
      vivo = false;
      clearInterval(t);
    };
  }, []);

  const otsDe = (codigo: string) => repo?.articulos?.[normCod(codigo)] ?? [];

  useEffect(() => {
    fetchEventos();
    fetchChat();
    const interval = setInterval(() => {
      fetchEventos();
      fetchChat();
    }, 3000);
    return () => clearInterval(interval);
  }, [estadoActivo]);

  const responder = async (id: number, estado: "pedido" | "s/e") => {
    setLoading((prev) => ({ ...prev, [id]: true }));
    await fetch(`/api/picking/eventos/${id}/responder`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ estado, respuesta_nota: mensajes[id] ?? "" }),
    });
    setLoading((prev) => ({ ...prev, [id]: false }));
    setMensajes((prev) => {
      const n = { ...prev };
      delete n[id];
      return n;
    });
    fetchEventos();
  };

  return (
    <div className="h-screen bg-gray-950 text-white p-6 flex flex-col overflow-hidden">
      <div className="flex items-center justify-between gap-4 mb-6 shrink-0">
        <h1 className="text-2xl font-bold">Deposito - Pedidos pendientes</h1>
        <UsuarioActual />
      </div>

      <div className="flex gap-2 mb-4 shrink-0 flex-wrap items-center">
        {ESTADOS_DISPONIBLES.map((estado) => (
          <button
            key={estado}
            // onClick={() => setEstadoActivo(estado)}
            onClick={() => {
              setBusqueda(""); // Asumiendo que setBusqueda limpia o resetea algo
              setEstadoActivo(estado);
            }}
            className={`px-4 py-2 rounded-lg font-medium capitalize transition ${
              estadoActivo === estado
                ? "bg-blue-600 text-white"
                : "bg-gray-800 text-gray-300 hover:bg-gray-700"
            }`}
          >
            {estado}
          </button>
        ))}

        <input
          type="text"
          placeholder="Buscar por código o picker..."
          value={busqueda}
          onChange={(e) => setBusqueda(e.target.value)}
          className="ml-auto bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 w-64"
        />

        {busqueda && (
          <button
            onClick={() => setBusqueda("")}
            className="text-gray-400 hover:text-white px-2"
            title="Limpiar búsqueda"
          >
            ✕
          </button>
        )}
      </div>

      {/* Layout principal */}
      <div className="flex gap-4 flex-1 overflow-hidden">
        {/* Tabla: scroll propio si es larga */}
        <div className="flex-1 overflow-auto">
          {eventosFiltrados.length === 0 ? (
            <p className="text-gray-400">Sin pedidos pendientes</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-gray-400 border-b border-gray-700">
                    <th className="text-left py-2 px-4">Codigo</th>
                    <th className="text-left py-2 px-4">OT repo</th>
                    <th className="text-left py-2 px-4">Cantidad</th>
                    <th className="text-left py-2 px-4">Picker</th>
                    <th className="text-left py-2 px-4">Hora</th>
                    <th className="text-left py-2 px-4">Nota</th>
                    <th className="text-left py-2 px-4">Accion</th>
                  </tr>
                </thead>
                <tbody>
                  {eventosFiltrados.map((e) => {
                    const ots = otsDe(e.codigo);
                    const enOt = ots.length > 0;
                    return (
                    <tr
                      key={e.id}
                      className={`border-b border-gray-800 ${
                        enOt
                          ? "bg-amber-500/10 hover:bg-amber-500/20 shadow-[inset_3px_0_0_0_rgb(245,158,11)]"
                          : "hover:bg-gray-900"
                      }`}
                    >
                      <td className="py-3 px-4 font-mono font-bold">
                        <button
                          onClick={() => setUbicArt(e.codigo)}
                          title="Ver ubicaciones"
                          className="inline-flex items-center gap-1 hover:text-yellow-400"
                        >
                          <MapPin size={13} className="text-gray-500" />
                          {e.codigo}
                        </button>
                      </td>
                      <td className="py-3 px-4">
                        {enOt ? (
                          <button
                            onClick={() => setRepoArt(normCod(e.codigo))}
                            title="Ver la OT de reposición"
                            className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/15 px-2 py-1 text-xs font-semibold text-amber-300 hover:bg-amber-500/25"
                          >
                            <Truck size={13} />
                            En OT {ots[0]}
                            {ots.length > 1 && (
                              <span className="text-amber-400/80">+{ots.length - 1}</span>
                            )}
                          </button>
                        ) : (
                          <span className="text-gray-600">—</span>
                        )}
                      </td>
                      <td className="py-3 px-4">{e.cantidad}</td>
                      <td className="py-3 px-4">{e.picker_nombre}</td>
                      <td className="py-3 px-4 text-gray-400 text-xs">
                        {new Date(e.creado_en).toLocaleTimeString("es-AR")}
                      </td>
                      <td className="py-3 px-4">
                        <input
                          type="text"
                          placeholder="Nota opcional..."
                          value={mensajes[e.id] ?? ""}
                          onChange={(ev) =>
                            setMensajes((prev) => ({
                              ...prev,
                              [e.id]: ev.target.value,
                            }))
                          }
                          className="bg-gray-800 border border-gray-600 rounded px-3 py-1 text-sm w-full focus:outline-none focus:border-blue-500"
                        />
                      </td>
                      <td className="py-3 px-4">
                        <div className="flex gap-2">
                          <button
                            onClick={() => responder(e.id, "pedido")}
                            disabled={loading[e.id]}
                            className="bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white text-xs font-semibold px-3 py-2 rounded transition-colors"
                          >
                            Pedido
                          </button>
                          <button
                            onClick={() => responder(e.id, "s/e")}
                            disabled={loading[e.id]}
                            className="bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white text-xs font-semibold px-3 py-2 rounded transition-colors"
                          >
                            S/E
                          </button>
                        </div>
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Sidebar: altura controlada con scroll interno */}
        <div className="w-80 bg-gray-900 rounded-xl p-4 flex flex-col gap-3 h-full">
          <h2 className="text-white font-bold text-sm uppercase tracking-wide shrink-0">
            💬 Consultas ({chatMensajes.length})
          </h2>

          {/* Área mensajes: flex-1 + overflow-y-auto +q   min-h-0 = scroll funcional */}
          <div className="flex-1 overflow-y-auto flex flex-col gap-2 min-h-0 scrollbar-hide">
            {chatMensajes.length === 0 && (
              <p className="text-gray-500 text-sm">Sin consultas</p>
            )}
            {chatMensajes.map((m) => (
              <div
                key={m.id}
                onClick={() => {
                  setMensajeSeleccionado(m.id);
                  setRespuesta("");
                  setTimeout(() => respuestaRef.current?.focus(), 50);
                }}
                className={`rounded-2xl p-3 cursor-pointer transition-colors ${
                  mensajeSeleccionado === m.id
                    ? "bg-blue-700"
                    : "bg-gray-800 hover:bg-gray-700"
                }`}
              >
                <p className="text-blue-300 text-xs font-bold mb-1">
                  {m.picker_nombre}
                </p>
                <p className="text-white text-sm">{m.mensaje}</p>
                <p className="text-gray-500 text-xs mt-1">
                  {new Date(m.creado_en).toLocaleTimeString("es-AR")}
                </p>
              </div>
            ))}
          </div>

          {/* Input: shrink-0 para que no desaparezca */}
          {mensajeSeleccionado !== null && (
            <div className="flex gap-2 mt-2 shrink-0">
              <input
                ref={respuestaRef}
                type="text"
                value={respuesta}
                onChange={(e) => setRespuesta(e.target.value)}
                onKeyDown={(e) =>
                  e.key === "Enter" && responderChat(mensajeSeleccionado)
                }
                placeholder="Responder..."
                className="flex-1 bg-gray-800 border border-blue-500 rounded-lg px-3 py-2 text-sm text-white focus:outline-none"
              />
              <button
                onClick={() => responderChat(mensajeSeleccionado)}
                className="bg-blue-600 hover:bg-blue-500 text-white px-3 rounded-lg text-sm font-bold"
              >
                ↵
              </button>
            </div>
          )}
        </div>
      </div>

      {ubicArt && (
        <UbicacionesModal articulo={ubicArt} onClose={() => setUbicArt(null)} />
      )}
      {repoArt && repo && (
        <RepoOtModal
          articulo={repoArt}
          ots={repo.ots.filter((o) => (repo.articulos[repoArt] ?? []).includes(o.OTId))}
          onClose={() => setRepoArt(null)}
        />
      )}
    </div>
  );
}

// Modal: ubicaciones del artículo con cantidad > 0. Mismo modal que en
// /deposito/faltantes (reutiliza el endpoint /api/deposito/faltantes/ubicaciones).
function UbicacionesModal({
  articulo,
  onClose,
}: {
  articulo: string;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<{ Ubicacion: string; Cantidad: number }[]>(
    [],
  );
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let vivo = true;
    fetch(
      `/api/deposito/faltantes/ubicaciones?articulo=${encodeURIComponent(articulo)}`,
      { cache: "no-store" },
    )
      .then((r) => r.json())
      .then((j) => {
        if (vivo) setRows((j.rows ?? []).filter((r: any) => r.Cantidad > 0));
      })
      .catch(() => {
        if (vivo) setRows([]);
      })
      .finally(() => {
        if (vivo) setLoading(false);
      });
    return () => {
      vivo = false;
    };
  }, [articulo]);
  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm bg-[#1A1A1A] border border-zinc-700 rounded-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
          <span className="font-mono text-sm text-yellow-400">{articulo}</span>
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-white"
          >
            <X size={18} />
          </button>
        </div>
        <div className="max-h-80 overflow-y-auto">
          {loading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="animate-spin text-zinc-500" />
            </div>
          ) : rows.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-zinc-500">
              Sin otras ubicaciones
            </p>
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className="border-b border-zinc-800/60">
                    <td className="px-4 py-2 text-zinc-200">{r.Ubicacion}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-zinc-300">
                      {fmtNum(r.Cantidad)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

// Modal: OT de reposición vivas en las que está el artículo — cabecera (hora de
// alta, estado, repositor, inicio del pick) y todos los renglones de la OT,
// con el artículo consultado resaltado.
function RepoOtModal({
  articulo,
  ots,
  onClose,
}: {
  articulo: string;
  ots: RepoOt[];
  onClose: () => void;
}) {
  useEffect(() => {
    const k = (ev: KeyboardEvent) => ev.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl max-h-[85vh] flex flex-col bg-[#1A1A1A] border border-zinc-700 rounded-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800 shrink-0">
          <div className="flex items-center gap-2">
            <Truck size={16} className="text-amber-400" />
            <span className="text-sm text-zinc-300">Reposición en curso ·</span>
            <span className="font-mono text-sm text-yellow-400">{articulo}</span>
          </div>
          <button onClick={onClose} className="text-zinc-400 hover:text-white">
            <X size={18} />
          </button>
        </div>
        <div className="overflow-y-auto p-4 flex flex-col gap-4">
          {ots.length === 0 && (
            <p className="py-6 text-center text-sm text-zinc-500">
              La OT ya se cumplió o se cerró
            </p>
          )}
          {ots.map((o) => (
            <div key={o.OTId} className="rounded-lg border border-zinc-800 bg-zinc-900/60">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 px-4 py-3 border-b border-zinc-800 text-xs">
                <div>
                  <p className="text-zinc-500 uppercase tracking-wide">OT</p>
                  <p className="font-mono text-base font-bold text-white">{o.OTId}</p>
                </div>
                <div>
                  <p className="text-zinc-500 uppercase tracking-wide">Enviada</p>
                  <p className="text-base font-semibold text-amber-300">{fmtHora(o.Alta)}</p>
                </div>
                <div>
                  <p className="text-zinc-500 uppercase tracking-wide">Estado</p>
                  <p className="text-sm text-zinc-200">
                    {o.EstadoLabel}
                    {o.InicioPick && (
                      <span className="block text-zinc-500">inició {fmtHora(o.InicioPick)}</span>
                    )}
                  </p>
                </div>
                <div>
                  <p className="text-zinc-500 uppercase tracking-wide">Repositor</p>
                  <p className="text-sm text-zinc-200">{o.Repositor || "—"}</p>
                </div>
                {o.Observaciones && (
                  <div className="col-span-full text-zinc-400">
                    <span className="text-zinc-500">Obs.: </span>
                    {o.Observaciones}
                  </div>
                )}
              </div>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-zinc-500 border-b border-zinc-800">
                    <th className="text-left px-4 py-2">Artículo</th>
                    <th className="text-left px-4 py-2">Sacar de</th>
                    <th className="text-left px-4 py-2">Llevar a</th>
                    <th className="text-right px-4 py-2">Pedido</th>
                    <th className="text-right px-4 py-2">Cumplido</th>
                    <th className="text-right px-4 py-2">Pendiente</th>
                  </tr>
                </thead>
                <tbody>
                  {[...o.Items]
                    .sort((a, b) =>
                      a.Articulo === articulo ? -1 : b.Articulo === articulo ? 1 : 0,
                    )
                    .map((it) => {
                      const sel = it.Articulo === articulo;
                      return (
                        <tr
                          key={it.Articulo}
                          className={`border-b border-zinc-800/60 align-top ${
                            sel ? "bg-amber-500/10" : ""
                          } ${it.Cumplida ? "text-zinc-500" : "text-zinc-200"}`}
                        >
                          <td className={`px-4 py-2 font-mono ${sel ? "text-yellow-400 font-bold" : ""}`}>
                            {it.Articulo}
                          </td>
                          <td className="px-4 py-2 font-mono">
                            {it.Origenes.length === 0
                              ? "—"
                              : it.Origenes.map((l, i) => (
                                  <div key={i}>
                                    {l.Ubicacion}
                                    {it.Origenes.length > 1 && (
                                      <span className="text-zinc-500"> · {fmtNum(l.Pedido)}</span>
                                    )}
                                  </div>
                                ))}
                          </td>
                          <td className="px-4 py-2 font-mono">
                            {it.Destinos.map((l, i) => (
                              <div key={i}>{l.Ubicacion}</div>
                            ))}
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums">{fmtNum(it.Pedido)}</td>
                          <td className="px-4 py-2 text-right tabular-nums">{fmtNum(it.Cumplido)}</td>
                          <td className="px-4 py-2 text-right tabular-nums">
                            {it.Cumplida ? "✓" : fmtNum(it.Pendiente)}
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
