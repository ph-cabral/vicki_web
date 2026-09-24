"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Loader2, RefreshCw, Search, X, Zap, ListChecks } from "lucide-react";
import { PageTitle, fmtNum } from "./ui";

// ──────────────────────────────────────────────────────────────────────────────
// Asignar pedidos — /deposito/deposito → Mesas → "Asignar pedidos".
//
// Todas las unidades para controlar (pedidos 10/100/210/310/410 y vueltas de
// acopio 70/75): LISTAS (en la cola de mesa, sin asignar — azul) y EN
// PREPARACIÓN (mandadas a armar, sin terminar — amarillo). En cada fila se
// elige quién la controla: le sale a ese operario apenas cierre lo que está
// controlando (el widget la pide solo). "Urgente" = sin operario fijo, sale
// primera al primero que se libere. Ver PREASIGNACIÓN MANUAL en
// indicadores-api/control_asignacion.py.
//
// API: GET  /api/deposito/control-asignacion/tablero
//      GET  /api/deposito/control-asignacion/controladores
//      POST /api/deposito/control-asignacion/preasignar
// ──────────────────────────────────────────────────────────────────────────────

interface Preasignado {
  nroOperario: number | null;
  asignadoA: string | null;
  urgente: boolean;
  creadoPor: string | null;
  creadoEn: string | null;
}
interface Unidad {
  nroPedido: number;
  nroRemito: number;
  estado: "listo" | "prep";
  fecha: string | null;
  tipoPedido: string | null;
  cliente: string | null;
  codCliente: number | null;
  prioridad: number | null;
  compCodigo: number | null;
  ubicacion: string | null;
  armador: string | null;
  desde: string | null;
  preasignado: Preasignado | null;
  reservadoPor: string | null;
}
interface Controlador {
  nroOperario: number;
  nombre: string;
  activo: boolean;
  enCurso: { nroPedido: number; nroRemito: number; cliente: string | null; asignadoEn: string | null } | null;
  preasignados: number;
}

type FiltroEstado = "todos" | "listo" | "prep";

const POLL_MS = 30_000;
const URGENTE = "__urgente__";
const QUITAR = "__quitar__";

const claveDe = (u: { nroPedido: number; nroRemito: number }) => `${u.nroPedido}-${u.nroRemito}`;

const fmtDesde = (iso: string | null) => {
  if (!iso) return "—";
  if (iso.length <= 10) {
    const [, m, d] = iso.split("-");
    return `${d}/${m}`;
  }
  const dt = new Date(iso);
  const hoy = new Date();
  const hora = dt.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
  return dt.toDateString() === hoy.toDateString()
    ? hora
    : `${dt.toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit" })} ${hora}`;
};

const labelPre = (p: Preasignado | null) =>
  !p ? "" : p.urgente ? "Urgente · primero libre" : `${p.asignadoA ?? "Operario"} · ${p.nroOperario}`;

// ─── Selector con filtro (mismo comportamiento que el Combobox de /sistema) ───
interface Opcion {
  value: string;
  label: string;
  sub?: string;
  activo?: boolean;
  tono?: "urgente" | "quitar";
}

function ControladorSelect({
  unidad,
  opciones,
  guardando,
  onElegir,
}: {
  unidad: Unidad;
  opciones: Opcion[];
  guardando: boolean;
  onElegir: (value: string) => void;
}) {
  const actual = labelPre(unidad.preasignado);
  const [texto, setTexto] = useState(actual);
  const [open, setOpen] = useState(false);
  const [filtrando, setFiltrando] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // El polling refresca la fila: si no se está escribiendo, el texto sigue a la preasignación.
  useEffect(() => {
    if (!open) setTexto(actual);
  }, [actual, open]);

  const abrir = () => {
    const r = wrapRef.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 4, left: r.left, width: Math.max(r.width, 260) });
    setOpen(true);
  };
  const cerrar = useCallback(() => {
    setOpen(false);
    setFiltrando(false);
    setTexto(actual);
  }, [actual]);

  useEffect(() => {
    if (!open) return;
    const onScroll = (e: Event) => {
      if (dropRef.current && e.target instanceof Node && dropRef.current.contains(e.target)) return;
      cerrar();
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (wrapRef.current?.contains(t) || dropRef.current?.contains(t)) return;
      cerrar();
    };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", cerrar);
    document.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", cerrar);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open, cerrar]);

  const lista = useMemo(() => {
    const base = unidad.preasignado
      ? [{ value: QUITAR, label: "Quitar asignación", tono: "quitar" as const }, ...opciones]
      : opciones;
    const q = filtrando ? texto.trim().toLowerCase() : "";
    const f = q
      ? base.filter((o) => o.label.toLowerCase().includes(q) || (o.sub ?? "").toLowerCase().includes(q))
      : [...base];
    // Nº de operario tipeado que no está en la lista: se ofrece igual (el server valida el nombre).
    const n = texto.trim();
    if (filtrando && /^\d+$/.test(n) && !f.some((o) => o.value === n)) {
      f.push({ value: n, label: `Operario ${n}`, sub: "Nº tipeado" });
    }
    return f;
  }, [opciones, texto, filtrando, unidad.preasignado]);

  const elegir = (o: Opcion) => {
    setOpen(false);
    setFiltrando(false);
    inputRef.current?.blur();
    onElegir(o.value);
  };

  const pre = unidad.preasignado;
  const tonoInput = pre
    ? pre.urgente
      ? "border-red-500/50 text-red-300 bg-red-500/10"
      : "border-emerald-500/50 text-emerald-300 bg-emerald-500/10"
    : "border-zinc-700 text-zinc-200 bg-[#111111]";

  return (
    <div className="relative w-64" ref={wrapRef}>
      <div className="relative">
        {pre?.urgente && <Zap size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-red-400" />}
        <input
          ref={inputRef}
          type="text"
          value={texto}
          placeholder="Elegí quién controla…"
          autoComplete="off"
          data-1p-ignore
          disabled={guardando}
          onFocus={(e) => {
            abrir();
            e.currentTarget.select();
          }}
          onClick={abrir}
          onChange={(e) => {
            setTexto(e.target.value);
            setFiltrando(true);
            abrir();
            setHighlight(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              cerrar();
              inputRef.current?.blur();
              return;
            }
            if (!open || lista.length === 0) return;
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setHighlight((h) => Math.min(lista.length - 1, h + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setHighlight((h) => Math.max(0, h - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              elegir(lista[Math.min(highlight, lista.length - 1)]);
            }
          }}
          className={`w-full h-8 rounded-md border px-2.5 text-[12px] outline-none focus:border-yellow-400/70 placeholder:text-zinc-600 disabled:opacity-60 ${pre?.urgente ? "pl-6" : ""} ${tonoInput}`}
        />
        {guardando && (
          <Loader2 size={13} className="absolute right-2 top-1/2 -translate-y-1/2 text-yellow-400 animate-spin" />
        )}
      </div>
      {open && lista.length > 0 && pos &&
        createPortal(
          <div
            ref={dropRef}
            style={{ position: "fixed", top: pos.top, left: pos.left, width: pos.width }}
            className="z-[60] max-h-64 overflow-y-auto bg-[#1f1f1f] border border-zinc-700 rounded-md shadow-lg py-1"
          >
            {lista.map((o, i) => (
              <button
                key={o.value}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setHighlight(i)}
                onClick={() => elegir(o)}
                className={`flex w-full items-center gap-2 text-left px-3 py-1.5 text-[12px] ${
                  i === highlight ? "bg-zinc-700 text-white" : "text-zinc-200 hover:bg-zinc-800"
                }`}
              >
                {o.tono === "urgente" ? (
                  <Zap size={12} className="text-red-400 shrink-0" />
                ) : o.tono === "quitar" ? (
                  <X size={12} className="text-zinc-500 shrink-0" />
                ) : (
                  <span
                    className={`inline-block w-2 h-2 rounded-full shrink-0 ${o.activo ? "bg-emerald-400" : "bg-zinc-600"}`}
                    title={o.activo ? "Widget abierto" : "Sin widget abierto"}
                  />
                )}
                <span className={`truncate ${o.tono === "urgente" ? "text-red-300 font-semibold" : o.tono === "quitar" ? "text-zinc-400" : ""}`}>
                  {o.label}
                </span>
                {o.sub && <span className="ml-auto text-[10px] text-zinc-500 truncate">{o.sub}</span>}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}

// ─── Vista ────────────────────────────────────────────────────────────────────
export function AsignarPedidosTab() {
  const [unidades, setUnidades] = useState<Unidad[]>([]);
  const [controladores, setControladores] = useState<Controlador[]>([]);
  const [magnusOk, setMagnusOk] = useState(true);
  const [loading, setLoading] = useState(false);
  const [cargado, setCargado] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [guardando, setGuardando] = useState<Set<string>>(new Set());
  const [fPedido, setFPedido] = useState("");
  const [fCliente, setFCliente] = useState("");
  const [fEstado, setFEstado] = useState<FiltroEstado>("todos");

  const cargar = useCallback(async (silencioso = false) => {
    if (!silencioso) setLoading(true);
    try {
      const [rt, rc] = await Promise.all([
        fetch("/api/deposito/control-asignacion/tablero", { cache: "no-store" }),
        fetch("/api/deposito/control-asignacion/controladores", { cache: "no-store" }),
      ]);
      const jt = await rt.json().catch(() => ({}));
      if (!rt.ok) throw new Error(jt.error || `HTTP ${rt.status}`);
      setUnidades(jt.pedidos ?? []);
      setMagnusOk(jt.magnusOk !== false);
      const jc = await rc.json().catch(() => ({}));
      if (rc.ok) setControladores(jc.controladores ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al cargar");
    } finally {
      setLoading(false);
      setCargado(true);
    }
  }, []);

  useEffect(() => {
    cargar();
    const id = setInterval(() => {
      if (document.visibilityState === "visible") cargar(true);
    }, POLL_MS);
    return () => clearInterval(id);
  }, [cargar]);

  useEffect(() => {
    if (!aviso) return;
    const t = setTimeout(() => setAviso(null), 5000);
    return () => clearTimeout(t);
  }, [aviso]);

  const opciones: Opcion[] = useMemo(
    () => [
      { value: URGENTE, label: "Urgente · primero libre", sub: "sin operario fijo", tono: "urgente" },
      ...controladores.map((c) => ({
        value: String(c.nroOperario),
        label: `${c.nombre} · ${c.nroOperario}`,
        activo: c.activo,
        sub: c.enCurso
          ? `controlando ${c.enCurso.nroPedido}`
          : c.activo
            ? "libre"
            : "sin widget",
      })),
    ],
    [controladores],
  );

  const elegir = async (u: Unidad, value: string) => {
    const k = claveDe(u);
    const body = {
      nroPedido: u.nroPedido,
      nroRemito: u.nroRemito,
      nroOperario: value === URGENTE || value === QUITAR ? null : Number(value),
      urgente: value === URGENTE,
      codCliente: u.codCliente,
      cliente: u.cliente,
    };
    setGuardando((s) => new Set(s).add(k));
    try {
      const res = await fetch("/api/deposito/control-asignacion/preasignar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof j.error === "string" ? j.error : `HTTP ${res.status}`);
      setUnidades((prev) =>
        prev.map((x) => (claveDe(x) === k ? { ...x, preasignado: j.preasignado ?? null } : x)),
      );
      // Contadores de preasignados por controlador.
      fetch("/api/deposito/control-asignacion/controladores", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((jc) => jc && setControladores(jc.controladores ?? []))
        .catch(() => {});
    } catch (e) {
      setAviso(`Pedido ${u.nroPedido}: ${e instanceof Error ? e.message : "no se pudo guardar"}`);
      if (e instanceof Error && e.message.startsWith("Ya lo")) cargar(true);
    } finally {
      setGuardando((s) => {
        const n = new Set(s);
        n.delete(k);
        return n;
      });
    }
  };

  const cuenta = useMemo(
    () => ({
      todos: unidades.length,
      listo: unidades.filter((u) => u.estado === "listo").length,
      prep: unidades.filter((u) => u.estado === "prep").length,
    }),
    [unidades],
  );

  const filtradas = useMemo(() => {
    const qp = fPedido.trim();
    const qc = fCliente.trim().toLowerCase();
    return unidades.filter((u) => {
      if (fEstado !== "todos" && u.estado !== fEstado) return false;
      if (qp && !String(u.nroPedido).includes(qp) && !(u.nroRemito && String(u.nroRemito).includes(qp)))
        return false;
      if (qc) {
        const nom = (u.cliente ?? "").toLowerCase();
        const cod = u.codCliente != null ? String(u.codCliente) : "";
        if (!nom.includes(qc) && !cod.includes(qc)) return false;
      }
      return true;
    });
  }, [unidades, fPedido, fCliente, fEstado]);

  const nPre = unidades.filter((u) => u.preasignado).length;

  return (
    <div>
      <div className="sticky top-16 z-40 -mx-8 px-8 py-3 bg-[#111111]/95 backdrop-blur border-b border-zinc-800">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <PageTitle
            title="Asignar pedidos"
            sub="Elegí quién controla cada pedido: le sale apenas termine el que está controlando"
          />
          <button
            onClick={() => cargar()}
            disabled={loading}
            className="flex items-center gap-1.5 text-zinc-400 hover:text-yellow-400 transition-colors px-2.5 py-1.5 rounded-md border border-zinc-700 disabled:opacity-40 text-sm"
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Refrescar
          </button>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500" />
            <input
              value={fPedido}
              onChange={(e) => setFPedido(e.target.value.replace(/\D/g, ""))}
              placeholder="Nº pedido"
              inputMode="numeric"
              className="h-8 w-36 rounded-md border border-zinc-700 bg-[#171717] pl-7 pr-2 text-[12px] text-zinc-200 outline-none focus:border-yellow-400/70 placeholder:text-zinc-600"
            />
          </div>
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500" />
            <input
              value={fCliente}
              onChange={(e) => setFCliente(e.target.value)}
              placeholder="Cliente (nombre o nº)"
              className="h-8 w-64 rounded-md border border-zinc-700 bg-[#171717] pl-7 pr-7 text-[12px] text-zinc-200 outline-none focus:border-yellow-400/70 placeholder:text-zinc-600"
            />
            {(fCliente || fPedido) && (
              <button
                onClick={() => {
                  setFCliente("");
                  setFPedido("");
                }}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-200"
                title="Limpiar filtros"
              >
                <X size={13} />
              </button>
            )}
          </div>
          <div className="flex rounded-md border border-zinc-700 overflow-hidden text-[12px]">
            {(
              [
                ["todos", "Todos", "text-zinc-200"],
                ["listo", "Listos", "text-sky-300"],
                ["prep", "En preparación", "text-yellow-300"],
              ] as [FiltroEstado, string, string][]
            ).map(([id, label, color]) => (
              <button
                key={id}
                onClick={() => setFEstado(id)}
                className={`px-3 h-8 transition-colors ${
                  fEstado === id ? `bg-zinc-800 ${color} font-semibold` : "text-zinc-500 hover:text-zinc-200"
                }`}
              >
                {label} <span className="text-zinc-500 font-normal">{fmtNum(cuenta[id])}</span>
              </button>
            ))}
          </div>
          <span className="ml-auto flex items-center gap-3 text-[11px] text-zinc-500">
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-sm bg-sky-400" /> Listo para control
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-sm bg-yellow-400" /> En preparación
            </span>
          </span>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-3 bg-[#1A1A1A] border border-red-400/40 rounded-xl px-5 py-3 text-sm text-red-300 mt-4">
          <AlertTriangle size={16} className="text-red-400" /> {error}
        </div>
      )}
      {!magnusOk && !error && (
        <div className="flex items-center gap-3 bg-[#1A1A1A] border border-amber-400/40 rounded-xl px-5 py-3 text-sm text-amber-300 mt-4">
          <AlertTriangle size={16} className="text-amber-400" /> Magnus no respondió: se muestran solo los
          pedidos listos.
        </div>
      )}
      {aviso && (
        <div className="fixed bottom-6 right-6 z-[70] flex items-center gap-3 bg-[#1f1f1f] border border-red-400/50 rounded-lg px-4 py-2.5 text-sm text-red-300 shadow-lg">
          <AlertTriangle size={15} className="text-red-400" /> {aviso}
        </div>
      )}

      {/* Controladores: quién está con qué */}
      {controladores.length > 0 && (
        <div className="flex gap-2 flex-wrap mt-4">
          {controladores.map((c) => (
            <div
              key={c.nroOperario}
              className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-[#171717] px-3 py-1.5 text-[12px]"
            >
              <span
                className={`w-2 h-2 rounded-full ${c.activo ? "bg-emerald-400" : "bg-zinc-600"}`}
                title={c.activo ? "Widget abierto" : "Sin widget abierto"}
              />
              <span className="text-zinc-200 font-medium">{c.nombre}</span>
              <span className="text-zinc-500">
                {c.enCurso
                  ? `controlando ${c.enCurso.nroPedido}${c.enCurso.nroRemito ? ` · vta ${c.enCurso.nroRemito}` : ""}`
                  : c.activo
                    ? "libre"
                    : "sin widget"}
              </span>
              {c.preasignados > 0 && (
                <span className="rounded-full bg-emerald-500/15 text-emerald-300 px-1.5 text-[10px] font-semibold">
                  +{c.preasignados} en espera
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {loading && !cargado ? (
        <div className="flex flex-col items-center justify-center py-24 gap-3 text-center">
          <Loader2 size={36} className="text-yellow-400 animate-spin" />
          <p className="text-zinc-400 font-medium">Consultando…</p>
        </div>
      ) : unidades.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 gap-3 text-center">
          <ListChecks size={40} className="text-zinc-700" />
          <p className="text-zinc-400 font-medium">No hay pedidos listos ni en preparación.</p>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-3 mt-5 mb-2 text-[12px] text-zinc-500">
            <span>
              {fmtNum(filtradas.length)} de {fmtNum(unidades.length)} pedidos
            </span>
            {nPre > 0 && <span className="text-emerald-400">· {fmtNum(nPre)} con controlador elegido</span>}
          </div>
          <div className="rounded-lg bg-[#171717] border border-zinc-800 overflow-auto" style={{ maxHeight: 640 }}>
            <table className="w-full text-[12px]">
              <thead className="sticky top-0 z-10">
                <tr className="bg-[#1f1f1f]">
                  {["Estado", "Nº Pedido", "Tipo", "Nº Cliente", "Cliente", "Prior.", "Desde", "Ubicación", "Reservado", "Controla"].map(
                    (h) => (
                      <th
                        key={h}
                        className={`px-2.5 py-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500 whitespace-nowrap border-b border-zinc-800 ${
                          h === "Nº Pedido" || h === "Nº Cliente" || h === "Prior." ? "text-right" : "text-left"
                        }`}
                      >
                        {h}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {filtradas.map((u) => {
                  const listo = u.estado === "listo";
                  return (
                    <tr
                      key={claveDe(u)}
                      className={`border-b border-zinc-800/60 transition-colors ${
                        listo
                          ? "bg-sky-500/[0.07] hover:bg-sky-500/[0.12] shadow-[inset_3px_0_0_0_#38bdf8]"
                          : "bg-yellow-400/[0.05] hover:bg-yellow-400/[0.10] shadow-[inset_3px_0_0_0_#facc15]"
                      }`}
                    >
                      <td className="px-2.5 py-1.5 whitespace-nowrap">
                        <span
                          className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                            listo ? "bg-sky-500/15 text-sky-300" : "bg-yellow-400/15 text-yellow-300"
                          }`}
                        >
                          {listo ? "Listo" : "En preparación"}
                        </span>
                      </td>
                      <td className="px-2.5 py-1.5 whitespace-nowrap text-right tabular-nums text-zinc-100 font-medium">
                        {u.nroPedido}
                        {u.nroRemito ? <span className="block text-[10px] text-zinc-500">vta {u.nroRemito}</span> : null}
                      </td>
                      <td className="px-2.5 py-1.5 whitespace-nowrap text-zinc-400">
                        {u.tipoPedido ?? (u.compCodigo ? `Cód. ${u.compCodigo}` : "—")}
                      </td>
                      <td className="px-2.5 py-1.5 whitespace-nowrap text-right tabular-nums text-zinc-300">
                        {u.codCliente ?? "—"}
                      </td>
                      <td className="px-2.5 py-1.5 text-zinc-200 max-w-[320px] truncate" title={u.cliente ?? ""}>
                        {u.cliente ?? "—"}
                      </td>
                      <td className="px-2.5 py-1.5 whitespace-nowrap text-right tabular-nums text-zinc-300">
                        {u.prioridad ?? "—"}
                      </td>
                      <td
                        className="px-2.5 py-1.5 whitespace-nowrap text-zinc-400"
                        title={listo ? "Entró a la cola de mesa" : "Mandado a armar"}
                      >
                        {fmtDesde(u.desde)}
                      </td>
                      <td className="px-2.5 py-1.5 whitespace-nowrap text-zinc-400 max-w-[160px] truncate" title={u.ubicacion ?? ""}>
                        {u.ubicacion ?? "—"}
                      </td>
                      <td className="px-2.5 py-1.5 whitespace-nowrap text-zinc-400">
                        {u.reservadoPor ?? "—"}
                      </td>
                      <td className="px-2.5 py-1">
                        <ControladorSelect
                          unidad={u}
                          opciones={opciones}
                          guardando={guardando.has(claveDe(u))}
                          onElegir={(v) => elegir(u, v)}
                        />
                      </td>
                    </tr>
                  );
                })}
                {filtradas.length === 0 && (
                  <tr>
                    <td colSpan={10} className="px-4 py-8 text-center text-zinc-600 text-sm">
                      Ningún pedido coincide con el filtro
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-zinc-600 mt-4 leading-relaxed">
            El pedido elegido le sale a ese controlador apenas cierre en Magnus el que está controlando, antes que
            cualquier otro de la cola; si está en preparación, le sale cuando termine de armarse. &quot;Urgente&quot;
            lo toma el primero que se libere. &quot;Reservado&quot; = el cliente ya lo está controlando esa persona
            (el resto de sus pedidos va a ella, salvo que elijas otro controlador acá). Vta = vuelta de acopio.
            Se actualiza cada 30 segundos.
          </p>
        </>
      )}
    </div>
  );
}
