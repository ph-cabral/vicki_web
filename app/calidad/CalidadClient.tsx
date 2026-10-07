"use client";

/**
 * /calidad — Controles de mesa en línea de tiempo vertical.
 *
 * Buscás un cliente, elegís uno de sus pedidos controlados y ves: Toma del
 * pedido → cada ítem con la hora en que se anotó su cantidad → Cierre. La
 * duración de cada ítem corre desde el nodo anterior (el primero, desde la
 * toma). Datos: indicadores-api/calidad.py. La hora por ítem depende de la
 * captura en Postgres (deposito.control_item_log, sql/deposito_control_item_log.sql); sin ella se muestra el
 * resto de la línea de tiempo y un aviso.
 */

import { useEffect, useRef, useState } from "react";
import { Loader2, Search, Clock } from "lucide-react";
import { InicioButton } from "@/components/ui/InicioButton";
import { UsuarioActual } from "@/components/auth/UsuarioActual";

type ClienteSug = { codCliente: number; cliente: string; controles: number; ultimo: string | null };
type Control = {
  nroPedido: number;
  nroRemito: number;
  operario: string | null;
  items: number | null;
  unidades: number | null;
  toma: string | null;
  cierre: string | null;
  segundos: number | null;
};
type ItemTL = {
  nroRenglon: number;
  codArticulo: string;
  descripcion: string | null;
  cantPedida: number;
  cantControlada: number;
  hora: string | null;
  cambios: number;
  segundos: number | null;
};
type Detalle = {
  encontrado: boolean;
  nroPedido: number;
  cliente?: string;
  operario?: string | null;
  toma?: string | null;
  cierre?: string | null;
  segundosTotal?: number | null;
  items?: ItemTL[];
  horaPorItem?: boolean;
  aviso?: string | null;
};

// Horas locales sin zona: "2026-10-07T08:43:37"
const hhmmss = (iso: string | null | undefined) => (iso ? iso.slice(11, 19) : "—");
const fecha = (iso: string | null | undefined) =>
  iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)} ${iso.slice(11, 16)}` : "—";
const dur = (s: number | null | undefined) => {
  if (s == null) return "—";
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m} m ${String(r).padStart(2, "0")} s` : `${r} s`;
};
const num = (n: number) => (Number.isInteger(n) ? String(n) : n.toLocaleString("es-AR"));

export default function CalidadClient() {
  const [q, setQ] = useState("");
  const [sugs, setSugs] = useState<ClienteSug[]>([]);
  const [buscando, setBuscando] = useState(false);
  const [cliente, setCliente] = useState<ClienteSug | null>(null);
  const [controles, setControles] = useState<Control[] | null>(null);
  const [cargandoLista, setCargandoLista] = useState(false);
  const [sel, setSel] = useState<number | null>(null);
  const [detalle, setDetalle] = useState<Detalle | null>(null);
  const [cargandoDet, setCargandoDet] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  // Autocompletar cliente (debounce 300 ms)
  useEffect(() => {
    const t = q.trim();
    if (t.length < 2 || (cliente && t === cliente.cliente)) {
      setSugs([]);
      return;
    }
    const id = ++seq.current;
    const h = setTimeout(async () => {
      setBuscando(true);
      try {
        const r = await fetch(`/api/calidad/clientes?q=${encodeURIComponent(t)}`);
        const j = await r.json();
        if (id === seq.current) setSugs(r.ok ? (j.clientes ?? []) : []);
      } catch {
        if (id === seq.current) setSugs([]);
      } finally {
        if (id === seq.current) setBuscando(false);
      }
    }, 300);
    return () => clearTimeout(h);
  }, [q, cliente]);

  async function elegirCliente(c: ClienteSug) {
    setCliente(c);
    setQ(c.cliente);
    setSugs([]);
    setSel(null);
    setDetalle(null);
    setControles(null);
    setError(null);
    setCargandoLista(true);
    try {
      const r = await fetch(`/api/calidad/controles?codCliente=${c.codCliente}&dias=180`);
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error ?? "Error");
      setControles(j.controles ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al cargar los controles");
    } finally {
      setCargandoLista(false);
    }
  }

  async function abrir(nro: number) {
    setSel(nro);
    setDetalle(null);
    setCargandoDet(true);
    setError(null);
    try {
      const r = await fetch(`/api/calidad/control/${nro}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error ?? "Error");
      setDetalle(j);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al cargar el control");
    } finally {
      setCargandoDet(false);
    }
  }

  const items = detalle?.items ?? [];
  const conSeg = items.filter((i) => i.segundos != null).map((i) => i.segundos as number);
  const prom = conSeg.length ? conSeg.reduce((a, b) => a + b, 0) / conSeg.length : 0;
  const tono = (s: number | null) =>
    s == null || !prom ? "text-zinc-400" : s >= prom * 3 ? "text-red-400" : s >= prom * 2 ? "text-amber-400" : "text-emerald-400";

  return (
    <div className="min-h-screen bg-[#0d0d0d] text-white">
      <header className="sticky top-0 z-20 bg-[#151515] border-b border-zinc-800 px-6 h-14 flex items-center gap-4">
        <InicioButton label="Inicio" className="text-zinc-400 hover:text-white text-sm" />
        <h1 className="font-bold text-lime-500 text-lg">Calidad</h1>
        <span className="text-zinc-500 text-sm">Controles de mesa</span>
        <UsuarioActual className="ml-auto" />
      </header>

      <main className="max-w-6xl mx-auto px-6 py-6 space-y-6">
        {/* Buscador por cliente */}
        <div className="relative max-w-xl">
          <Search size={16} className="absolute left-3 top-3 text-zinc-500" />
          <input
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              if (cliente && e.target.value !== cliente.cliente) setCliente(null);
            }}
            placeholder="Buscar cliente por nombre o código…"
            className="w-full bg-[#151515] border border-zinc-700 focus:border-lime-500 outline-none rounded-lg pl-9 pr-9 py-2.5 text-sm"
            autoFocus
          />
          {buscando && <Loader2 size={16} className="absolute right-3 top-3 animate-spin text-zinc-500" />}
          {sugs.length > 0 && (
            <ul className="absolute z-30 mt-1 w-full bg-[#151515] border border-zinc-700 rounded-lg shadow-xl overflow-hidden">
              {sugs.map((c) => (
                <li key={c.codCliente}>
                  <button
                    onClick={() => elegirCliente(c)}
                    className="w-full text-left px-3 py-2 hover:bg-zinc-800 flex items-center justify-between gap-3 text-sm"
                  >
                    <span className="truncate">{c.cliente}</span>
                    <span className="text-xs text-zinc-500 shrink-0">
                      {c.controles} {c.controles === 1 ? "control" : "controles"} · últ. {fecha(c.ultimo)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {error && <div className="text-red-400 text-sm">{error}</div>}

        {!cliente && !cargandoLista && (
          <p className="text-zinc-500 text-sm">Buscá un cliente para ver sus controles de mesa.</p>
        )}

        {cargandoLista && (
          <div className="flex items-center gap-2 text-zinc-400 text-sm">
            <Loader2 size={16} className="animate-spin" /> Cargando controles…
          </div>
        )}

        {controles && (
          <div className="grid md:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] gap-6 items-start">
            {/* Lista de controles del cliente */}
            <section className="bg-[#151515] border border-zinc-800 rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-zinc-800 text-sm font-semibold">
                {cliente?.cliente} <span className="text-zinc-500 font-normal">· {controles.length} controles</span>
              </div>
              {controles.length === 0 ? (
                <p className="p-4 text-sm text-zinc-500">Sin controles en los últimos 180 días.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead className="text-xs text-zinc-500">
                    <tr>
                      <th className="text-left px-4 py-2 font-medium">Pedido</th>
                      <th className="text-left px-2 py-2 font-medium">Toma</th>
                      <th className="text-left px-2 py-2 font-medium">Controlador</th>
                      <th className="text-right px-2 py-2 font-medium">Ítems</th>
                      <th className="text-right px-4 py-2 font-medium">Duración</th>
                    </tr>
                  </thead>
                  <tbody>
                    {controles.map((c) => (
                      <tr
                        key={`${c.nroPedido}-${c.nroRemito}`}
                        onClick={() => abrir(c.nroPedido)}
                        className={`cursor-pointer border-t border-zinc-800 hover:bg-zinc-800/60 ${
                          sel === c.nroPedido ? "bg-zinc-800" : ""
                        }`}
                      >
                        <td className="px-4 py-2 font-mono">{c.nroPedido}</td>
                        <td className="px-2 py-2 text-zinc-300">{fecha(c.toma)}</td>
                        <td className="px-2 py-2 text-zinc-300 truncate max-w-[9rem]">{c.operario ?? "—"}</td>
                        <td className="px-2 py-2 text-right">{c.items ?? "—"}</td>
                        <td className="px-4 py-2 text-right text-zinc-300">{dur(c.segundos)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            {/* Línea de tiempo vertical */}
            <section className="bg-[#151515] border border-zinc-800 rounded-xl p-5 min-h-[12rem]">
              {!sel && <p className="text-sm text-zinc-500">Elegí un pedido para ver su línea de tiempo.</p>}
              {cargandoDet && (
                <div className="flex items-center gap-2 text-zinc-400 text-sm">
                  <Loader2 size={16} className="animate-spin" /> Cargando…
                </div>
              )}
              {detalle && !cargandoDet && !detalle.encontrado && (
                <p className="text-sm text-zinc-500">Pedido {detalle.nroPedido} sin registro de toma en mesa.</p>
              )}
              {detalle?.encontrado && !cargandoDet && (
                <div>
                  <div className="mb-4">
                    <div className="font-semibold">Pedido {detalle.nroPedido}</div>
                    <div className="text-xs text-zinc-500">
                      {detalle.operario ?? "—"} · total {dur(detalle.segundosTotal)} · {items.length} ítems
                    </div>
                  </div>
                  {detalle.aviso && (
                    <div className="mb-4 text-xs text-amber-400 bg-amber-950/30 border border-amber-900/50 rounded-md px-3 py-2">
                      {detalle.aviso}
                    </div>
                  )}

                  <ol className="relative border-l-2 border-zinc-700 ml-2 space-y-4">
                    <Nodo color="bg-lime-500" titulo="Toma del pedido" hora={hhmmss(detalle.toma)} />
                    {items.map((i) => (
                      <Nodo
                        key={i.nroRenglon}
                        color={i.hora ? "bg-sky-500" : "bg-zinc-600"}
                        titulo={`${i.codArticulo}${i.descripcion ? ` · ${i.descripcion}` : ""}`}
                        hora={hhmmss(i.hora)}
                        detalle={`Cant. ${num(i.cantControlada)} de ${num(i.cantPedida)}${
                          i.cambios > 1 ? ` · ${i.cambios} cambios` : ""
                        }`}
                        duracion={i.segundos != null ? dur(i.segundos) : null}
                        tono={tono(i.segundos)}
                      />
                    ))}
                    <Nodo color="bg-emerald-500" titulo="Cierre del control" hora={hhmmss(detalle.cierre)} />
                  </ol>
                </div>
              )}
            </section>
          </div>
        )}
      </main>
    </div>
  );
}

function Nodo({
  color,
  titulo,
  hora,
  detalle,
  duracion,
  tono = "text-zinc-400",
}: {
  color: string;
  titulo: string;
  hora: string;
  detalle?: string;
  duracion?: string | null;
  tono?: string;
}) {
  return (
    <li className="ml-5 relative">
      <span className={`absolute -left-[1.78rem] top-1.5 h-3 w-3 rounded-full ring-4 ring-[#151515] ${color}`} />
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm text-zinc-100 truncate">{titulo}</span>
        <span className="font-mono text-xs text-zinc-400 shrink-0 flex items-center gap-1">
          <Clock size={11} /> {hora}
        </span>
      </div>
      {(detalle || duracion) && (
        <div className="text-xs flex items-center gap-3 mt-0.5">
          {detalle && <span className="text-zinc-500">{detalle}</span>}
          {duracion && <span className={`font-medium ${tono}`}>+{duracion}</span>}
        </div>
      )}
    </li>
  );
}
