"use client";

import { useEffect, useState, useCallback } from "react";
import { X, Loader2, AlertTriangle, Unlock } from "lucide-react";
import { Table, Col, Tag, fmtNum } from "./ui";

// ──────────────────────────────────────────────────────────────────────────────
// Modal del pedido en "Control por operario" (/deposito/streaming): cabecera y
// renglones desde Magnus (vía /api/deposito/control-asignacion/detalle) y botón
// "Liberar", que devuelve la unidad a la cola. Si el cliente tiene más pedidos
// abiertos con el mismo operario, se liberan TODOS juntos (el backend los
// calcula; acá se avisa cuáles son antes de confirmar).
// ──────────────────────────────────────────────────────────────────────────────

type Estado = "controlado" | "en_proceso" | "esperando" | "urgente" | "libre";

interface Renglon {
  renglon: number;
  codArticulo: string;
  descripcion: string;
  pedida: number;
  cumplida: number;
  anulado: boolean;
}
interface GrupoItem {
  nroPedido: number;
  nroRemito: number;
  cliente: string | null;
  origen: "asignado" | "preasignado";
}
interface Detalle {
  nroPedido: number;
  nroRemito: number;
  fecha: string | null;
  tipo: string | null;
  cliente: string | null;
  codCliente: number | null;
  prioridad: number | null;
  observaciones: string | null;
  ubicacion: string | null;
  nombreArmador: string | null;
  lineas: number;
  unidades: number;
  estado: Estado;
  nroOperario: number | null;
  operario: string | null;
  asignadoEn: string | null;
  cerradoEn: string | null;
  puedeLiberar: boolean;
  grupo: GrupoItem[];
  renglones: Renglon[];
}

const ESTADO: Record<Estado, { label: string; tone: "green" | "amber" | "neutral" | "red" }> = {
  controlado: { label: "Controlado", tone: "green" },
  en_proceso: { label: "En proceso", tone: "amber" },
  esperando: { label: "Esperando", tone: "neutral" },
  urgente: { label: "Urgente", tone: "red" },
  libre: { label: "Libre", tone: "neutral" },
};

const unidadTxt = (g: { nroPedido: number; nroRemito: number }) =>
  g.nroRemito ? `${g.nroPedido} · v${g.nroRemito}` : String(g.nroPedido);

const fmtFecha = (iso: string | null) => (iso ? iso.slice(0, 10).split("-").reverse().join("/") : "—");
const fmtFechaHora = (iso: string | null) =>
  iso ? `${fmtFecha(iso)} ${iso.slice(11, 16)}` : "—";

const cols: Col<Renglon>[] = [
  { key: "renglon", label: "#", num: true },
  { key: "codArticulo", label: "Código", render: (r) => <span className={r.anulado ? "line-through text-zinc-600" : ""}>{r.codArticulo}</span> },
  {
    key: "descripcion",
    label: "Artículo",
    className: "whitespace-normal min-w-[220px]",
    render: (r) => <span className={r.anulado ? "line-through text-zinc-600" : ""}>{r.descripcion}</span>,
  },
  { key: "pedida", label: "Pedida", num: true, render: (r) => fmtNum(r.pedida, 2).replace(/,00$/, "") },
  { key: "cumplida", label: "Armada", num: true, render: (r) => fmtNum(r.cumplida, 2).replace(/,00$/, "") },
];

export function PedidoControlModal({
  nroPedido,
  nroRemito,
  onClose,
  onLiberado,
}: {
  nroPedido: number;
  nroRemito: number;
  onClose: () => void;
  onLiberado: () => void;
}) {
  const [d, setD] = useState<Detalle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmando, setConfirmando] = useState(false);
  const [liberando, setLiberando] = useState(false);
  const [resultado, setResultado] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    setD(null);
    setError(null);
    fetch(`/api/deposito/control-asignacion/detalle?nroPedido=${nroPedido}&nroRemito=${nroRemito}`, {
      cache: "no-store",
      signal: ac.signal,
    })
      .then(async (res) => {
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
        setD(j as Detalle);
      })
      .catch((e) => {
        if (e?.name !== "AbortError") setError(e instanceof Error ? e.message : "Error al cargar");
      });
    return () => ac.abort();
  }, [nroPedido, nroRemito]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !liberando && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, liberando]);

  const liberar = useCallback(async () => {
    setLiberando(true);
    setError(null);
    try {
      const res = await fetch("/api/deposito/control-asignacion/liberar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nroPedido, nroRemito }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      const n = Array.isArray(j.liberados) ? j.liberados.length : 0;
      setResultado(`Liberado${n === 1 ? "" : "s"}: ${n} pedido${n === 1 ? "" : "s"} vuelven a la cola.`);
      onLiberado();
      setTimeout(onClose, 1200);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo liberar");
      setConfirmando(false);
    } finally {
      setLiberando(false);
    }
  }, [nroPedido, nroRemito, onLiberado, onClose]);

  const grupo = d?.grupo ?? [];
  const varios = grupo.length > 1;

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/70 flex items-start justify-center p-4 overflow-y-auto"
      onClick={() => !liberando && onClose()}
    >
      <div
        className="bg-[#1A1A1A] border border-zinc-700 rounded-xl w-full max-w-3xl my-8 flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-zinc-800">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-lg font-semibold text-zinc-100">
                Pedido {nroPedido}
                {nroRemito ? <span className="text-zinc-500"> · vuelta {nroRemito}</span> : null}
              </span>
              {d && <Tag tone={ESTADO[d.estado].tone}>{ESTADO[d.estado].label}</Tag>}
              {d?.tipo && <span className="text-[11px] text-zinc-500">{d.tipo}</span>}
            </div>
            {d && (
              <div className="text-sm text-zinc-300 mt-1 truncate">
                {d.cliente ?? "—"}
                {d.codCliente != null && <span className="text-zinc-500"> · #{d.codCliente}</span>}
              </div>
            )}
          </div>
          <button
            onClick={onClose}
            disabled={liberando}
            className="text-zinc-500 hover:text-zinc-200 p-1 rounded-md disabled:opacity-40"
            aria-label="Cerrar"
          >
            <X size={18} />
          </button>
        </div>

        <div className="px-5 py-4 flex flex-col gap-4">
          {error && (
            <div className="flex items-center gap-2 bg-[#111] border border-red-400/40 rounded-lg px-3 py-2 text-sm text-red-300">
              <AlertTriangle size={15} className="text-red-400 shrink-0" /> {error}
            </div>
          )}
          {resultado && (
            <div className="bg-[#111] border border-green-500/40 rounded-lg px-3 py-2 text-sm text-green-300">
              {resultado}
            </div>
          )}

          {!d && !error && (
            <div className="flex items-center justify-center py-16 gap-3 text-zinc-400">
              <Loader2 size={22} className="text-yellow-400 animate-spin" /> Consultando…
            </div>
          )}

          {d && (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-3 text-[12px]">
                <Dato k="Fecha pedido" v={fmtFecha(d.fecha)} />
                <Dato k="Prioridad" v={d.prioridad != null ? String(d.prioridad) : "—"} />
                <Dato k="Items · unidades" v={`${fmtNum(d.lineas)} · ${fmtNum(d.unidades, 0)}`} />
                <Dato k="Ubicación" v={d.ubicacion ?? "—"} />
                <Dato k="Controla" v={d.operario ? `${d.operario} (#${d.nroOperario})` : "—"} />
                <Dato k="Asignado" v={fmtFechaHora(d.asignadoEn)} />
                <Dato k="Armó" v={d.nombreArmador ?? "—"} />
                <Dato k="Cerrado" v={fmtFechaHora(d.cerradoEn)} />
              </div>
              {d.observaciones && (
                <div className="text-[12px] text-zinc-400 bg-[#111] border border-zinc-800 rounded-lg px-3 py-2 whitespace-pre-wrap">
                  {d.observaciones}
                </div>
              )}
              <Table cols={cols} rows={d.renglones} maxH={320} max={500} empty="Sin renglones" />
            </>
          )}
        </div>

        {d && (
          <div className="px-5 py-4 border-t border-zinc-800 flex items-center justify-between gap-4 flex-wrap">
            <div className="text-[12px] text-zinc-400 min-w-0">
              {d.puedeLiberar ? (
                varios ? (
                  <>
                    <span className="text-amber-300 font-medium">
                      Se liberarán {grupo.length} pedidos de este cliente
                    </span>{" "}
                    de {d.operario}: {grupo.map(unidadTxt).join(", ")}
                  </>
                ) : (
                  <>Vuelve a la cola y lo puede tomar cualquier controlador.</>
                )
              ) : d.estado === "controlado" ? (
                <>Ya está controlado en Magnus: no se puede liberar.</>
              ) : (
                <>No está asignado a ningún operario.</>
              )}
            </div>
            {d.puedeLiberar && !resultado && (
              <div className="flex items-center gap-2">
                {confirmando && (
                  <button
                    onClick={() => setConfirmando(false)}
                    disabled={liberando}
                    className="text-sm text-zinc-400 hover:text-zinc-200 px-3 py-1.5 rounded-md border border-zinc-700 disabled:opacity-40"
                  >
                    Cancelar
                  </button>
                )}
                <button
                  onClick={() => (confirmando ? liberar() : setConfirmando(true))}
                  disabled={liberando}
                  className={`flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-md border disabled:opacity-60 transition-colors ${
                    confirmando
                      ? "bg-red-500/20 border-red-400/60 text-red-200 hover:bg-red-500/30"
                      : "border-yellow-400/60 text-yellow-300 hover:bg-yellow-400/10"
                  }`}
                >
                  {liberando ? <Loader2 size={14} className="animate-spin" /> : <Unlock size={14} />}
                  {confirmando
                    ? varios
                      ? `Confirmar: liberar ${grupo.length} pedidos`
                      : "Confirmar liberación"
                    : varios
                      ? `Liberar ${grupo.length} pedidos`
                      : "Liberar pedido"}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Dato({ k, v }: { k: string; v: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wider text-zinc-500">{k}</div>
      <div className="text-zinc-200 truncate" title={v}>{v}</div>
    </div>
  );
}
