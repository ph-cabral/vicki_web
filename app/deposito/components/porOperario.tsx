"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Loader2, AlertTriangle, RefreshCw, Users } from "lucide-react";
import { PageTitle, Table, Col, Tag, fmtNum } from "./ui";

// ──────────────────────────────────────────────────────────────────────────────
// Por operario — una tabla por controlador con lo ASIGNADO (Postgres
// deposito.control_asignacion / control_preasignacion) y lo CONTROLADO
// (Magnus Ven_PedImpresoCP, en vivo) en el día, vía
// /api/deposito/control-asignacion/por-operario (→ indicadores-api →
// control_asignacion.py::fetch_mesa_por_operario). Fila en rojo = lo controló
// sin que se le haya asignado. Refresca cada 30 s cuando el día es hoy.
// ──────────────────────────────────────────────────────────────────────────────

type Estado = "controlado" | "en_proceso" | "esperando";

interface Fila {
  nroPedido: number;
  nroRemito: number;
  items: number | null;
  estado: Estado;
  noAsignado: boolean;
  asignadoA: string | null;
  controladoPor: string | null;
  cliente: string | null;
  hora: string | null;
}
interface Operario {
  nroOperario: number;
  nombre: string;
  activo: boolean;
  filas: Fila[];
  totales: {
    controlados: number;
    itemsControlados: number;
    enProceso: number;
    esperando: number;
    noAsignados: number;
  };
}
interface Data {
  dia: string;
  esHoy: boolean;
  operarios: Operario[];
}

const REFRESCO_MS = 30_000;

const isoLocal = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// Las horas vienen en hora local sin zona ("2026-10-02T08:43:37").
const fmtHora = (iso: string | null) => (iso ? iso.slice(11, 16) : "—");

const ESTADO: Record<Estado, { label: string; tone: "green" | "amber" | "neutral" }> = {
  controlado: { label: "Controlado", tone: "green" },
  en_proceso: { label: "En proceso", tone: "amber" },
  esperando: { label: "Esperando", tone: "neutral" },
};

const cols: Col<Fila>[] = [
  {
    key: "nroPedido",
    label: "Nº Pedido",
    num: true,
    render: (r) => (
      <span title={r.cliente ?? undefined}>
        {r.nroPedido}
        {r.nroRemito ? <span className="text-zinc-500"> · v{r.nroRemito}</span> : null}
      </span>
    ),
  },
  { key: "items", label: "Items", num: true, render: (r) => (r.items == null ? "—" : fmtNum(r.items)) },
  {
    key: "estado",
    label: "Estado",
    render: (r) => (
      <span className="flex items-center gap-1.5">
        <Tag tone={r.noAsignado ? "red" : ESTADO[r.estado].tone}>{ESTADO[r.estado].label}</Tag>
        {r.noAsignado && (
          <span className="text-[10px] text-red-300">
            {r.asignadoA ? `asignado a ${r.asignadoA}` : "sin asignar"}
          </span>
        )}
        {r.controladoPor && (
          <span className="text-[10px] text-amber-300">lo controló {r.controladoPor}</span>
        )}
      </span>
    ),
  },
  { key: "hora", label: "Hora", render: (r) => fmtHora(r.hora) },
];

function TarjetaOperario({ o }: { o: Operario }) {
  const t = o.totales;
  return (
    <div className="bg-[#1A1A1A] border border-zinc-800 rounded-xl p-4 flex flex-col gap-3 min-w-0">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span
              className={`inline-block w-2 h-2 rounded-full shrink-0 ${o.activo ? "bg-green-400" : "bg-zinc-600"}`}
              title={o.activo ? "Widget abierto" : "Sin actividad en el widget"}
            />
            <span className="font-semibold text-zinc-100 truncate">{o.nombre}</span>
            <span className="text-[11px] text-zinc-500">#{o.nroOperario}</span>
          </div>
          <div className="text-[11px] text-zinc-500 mt-1">
            {fmtNum(t.controlados)} controlados · {fmtNum(t.itemsControlados)} items
          </div>
        </div>
        <div className="flex flex-wrap gap-1 justify-end">
          {t.enProceso > 0 && <Tag tone="amber">{t.enProceso} en proceso</Tag>}
          {t.esperando > 0 && <Tag tone="neutral">{t.esperando} esperando</Tag>}
          {t.noAsignados > 0 && <Tag tone="red">{t.noAsignados} sin asignar</Tag>}
        </div>
      </div>
      <Table
        cols={cols}
        rows={o.filas}
        maxH={420}
        empty="Sin pedidos en el día"
        rowClassName={(r) => (r.noAsignado ? "bg-red-500/15 hover:bg-red-500/25" : "")}
      />
    </div>
  );
}

export function PorOperarioTab() {
  const [dia, setDia] = useState("");
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const enVuelo = useRef(false);

  useEffect(() => setDia(isoLocal(new Date())), []);

  const load = useCallback(async (d: string) => {
    if (enVuelo.current) return;
    enVuelo.current = true;
    setLoading(true);
    try {
      const res = await fetch(`/api/deposito/control-asignacion/por-operario?dia=${d}`, {
        cache: "no-store",
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setData(j as Data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al cargar");
    } finally {
      enVuelo.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!dia) return;
    setData(null);
    load(dia);
    if (dia !== isoLocal(new Date())) return;
    const id = setInterval(() => {
      if (!document.hidden) load(dia);
    }, REFRESCO_MS);
    return () => clearInterval(id);
  }, [dia, load]);

  const operarios = data?.operarios ?? [];

  return (
    <div>
      <div className="sticky top-16 z-40 -mx-8 px-8 py-3 bg-[#111111]/95 backdrop-blur border-b border-zinc-800 flex items-start justify-between gap-4 flex-wrap">
        <PageTitle
          title="Control por operario"
          sub="Lo asignado vs. lo controlado en Magnus. En rojo: controlado sin estar asignado"
        />
        <div className="flex items-center gap-2">
          <input
            type="date"
            value={dia}
            max={isoLocal(new Date())}
            onChange={(e) => e.target.value && setDia(e.target.value)}
            className="bg-[#1A1A1A] border border-zinc-700 rounded-md px-2.5 py-1.5 text-sm text-zinc-200 [color-scheme:dark]"
          />
          <button
            onClick={() => dia && load(dia)}
            disabled={loading}
            className="flex items-center gap-1.5 text-zinc-400 hover:text-yellow-400 transition-colors px-2.5 py-1.5 rounded-md border border-zinc-700 disabled:opacity-40 text-sm"
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Refrescar
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-3 bg-[#1A1A1A] border border-red-400/40 rounded-xl px-5 py-3 text-sm text-red-300 mb-5 mt-3">
          <AlertTriangle size={16} className="text-red-400" /> {error}
        </div>
      )}

      {loading && !data ? (
        <div className="flex flex-col items-center justify-center py-24 gap-3 text-center">
          <Loader2 size={36} className="text-yellow-400 animate-spin" />
          <p className="text-zinc-400 font-medium">Consultando…</p>
        </div>
      ) : data && operarios.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 gap-3 text-center">
          <Users size={40} className="text-zinc-700" />
          <p className="text-zinc-400 font-medium">Sin operarios con actividad en el día.</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 gap-4 mt-5">
            {operarios.map((o) => (
              <TarjetaOperario key={o.nroOperario} o={o} />
            ))}
          </div>
          <p className="text-[11px] text-zinc-600 mt-4 leading-relaxed">
            Controlado = cerrado en Magnus. En proceso = asignado y sin cierre. Esperando =
            preasignado, sale cuando termine lo actual (sólo hoy). Items = renglones no anulados.
            Las vueltas de acopio (v) las cierra el puesto de mesa, no la persona: no se marcan en rojo.
            Punto verde = widget abierto.
          </p>
        </>
      )}
    </div>
  );
}
