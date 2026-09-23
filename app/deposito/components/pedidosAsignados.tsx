"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { Loader2, AlertTriangle, RefreshCw, ListChecks } from "lucide-react";
import {
  PageTitle,
  SectionTitle,
  Table,
  Col,
  Tag,
  PALETTE,
  fmtNum,
} from "./ui";
import { DateRangeField } from "@/components/ui/date-range-field";

// ──────────────────────────────────────────────────────────────────────────────
// Pedidos asignados — detalle de deposito.control_asignacion (Postgres):
// 1 fila por pedido ya reclamado por un operario ("asignadoEn" IS NOT NULL),
// vía /api/deposito/control-asignacion/pedidos (→ indicadores-api →
// control_asignacion.py::fetch_pedidos_asignados). Solo lectura.
//
// "Cierre" = cierre en mesa registrado en Magnus (FechaCierre/HoraCierre), que
// indicadores-api guarda en cada fila cuando el pedido cierra. "Control" =
// minutos entre que se le asignó al operario y el cierre. "Espera" = minutos
// entre fin de armado y toma. Sin cierre todavía → "En curso".
// ──────────────────────────────────────────────────────────────────────────────

interface PedidoAsignado {
  nroPedido: number;
  nroRemito: number;
  armadoEn: string | null;
  cerradoEn: string | null;
  usuarioCierre: number | null;
  lineas: number;
  unidades: number | null;
  esperaMin: number | null;
  controlMin: number | null;
  codCliente: number | null;
  cliente: string | null;
  nroOperarioAsignado: number | null;
  asignadoA: string | null;
  asignadoEn: string;
  horaCierre: string | null;
  cantidadItems: number;
}
interface PedidosAsignadosData {
  pedidos: PedidoAsignado[];
}

const isoLocal = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;

const fmtFecha = (iso: string) =>
  new Date(iso).toLocaleDateString("es-AR");
const fmtHora = (iso: string) =>
  new Date(iso).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });

const fmtMin = (m: number | null | undefined): string => {
  if (m == null || !Number.isFinite(m)) return "—";
  const mins = Math.round(m);
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
};

const fmtUni = (n: number | null | undefined) =>
  n == null ? "—" : n.toLocaleString("es-AR", { maximumFractionDigits: 1 });

const rangoMes = (offset: number): [string, string] => {
  const hoy = new Date();
  const ini = new Date(hoy.getFullYear(), hoy.getMonth() + offset, 1);
  const fin = offset === 0 ? hoy : new Date(hoy.getFullYear(), hoy.getMonth() + offset + 1, 0);
  return [isoLocal(ini), isoLocal(fin)];
};

export function PedidosAsignadosTab() {
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");
  const [data, setData] = useState<PedidosAsignadosData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const hoy = isoLocal(new Date());
    setDesde(hoy);
    setHasta(hoy);
  }, []);

  const load = useCallback(async (d: string, h: string) => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams();
      if (d) qs.set("desde", d);
      if (h) qs.set("hasta", h || d);
      const res = await fetch(`/api/deposito/control-asignacion/pedidos?${qs.toString()}`, {
        cache: "no-store",
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setData(j as PedidosAsignadosData);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al cargar");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (desde && hasta) load(desde, hasta);
  }, [desde, hasta, load]);

  const pedidos = useMemo(() => data?.pedidos ?? [], [data]);

  // Color estable por operario (orden alfabético → PALETTE cíclico), para
  // detectar de un vistazo cuál hizo cada pedido.
  const colorPorOperario = useMemo(() => {
    const nombres = Array.from(
      new Set(pedidos.map((p) => p.asignadoA).filter((n): n is string => !!n)),
    ).sort();
    const m = new Map<string, string>();
    nombres.forEach((n, i) => m.set(n, PALETTE[i % PALETTE.length]));
    return m;
  }, [pedidos]);

  // Desglose: cantidad de pedidos + items controlados, por operario.
  const desglose = useMemo(() => {
    const m = new Map<
      string,
      { operario: string; pedidos: number; items: number; unidades: number; cerrados: number; minTotal: number; minPromedio: number | null }
    >();
    for (const p of pedidos) {
      const nombre = p.asignadoA || "—";
      const e =
        m.get(nombre) ??
        { operario: nombre, pedidos: 0, items: 0, unidades: 0, cerrados: 0, minTotal: 0, minPromedio: null };
      e.pedidos += 1;
      e.items += p.lineas || 0;
      e.unidades += p.unidades || 0;
      if (p.controlMin != null) {
        e.cerrados += 1;
        e.minTotal += p.controlMin;
      }
      m.set(nombre, e);
    }
    const out = Array.from(m.values());
    for (const e of out) e.minPromedio = e.cerrados ? e.minTotal / e.cerrados : null;
    return out.sort((a, b) => b.items - a.items);
  }, [pedidos]);

  const totalItems = desglose.reduce((s, d) => s + d.items, 0);

  const cols: Col<PedidoAsignado>[] = [
    { key: "nroPedido", label: "Nº Pedido", num: true },
    { key: "codCliente", label: "Nº Cliente", num: true },
    {
      key: "cliente",
      label: "Cliente",
      render: (r) => r.cliente || "—",
    },
    {
      key: "nroRemito",
      label: "Vuelta",
      num: true,
      render: (r) => (r.nroRemito ? String(r.nroRemito) : "—"),
    },
    { key: "fecha", label: "Fecha", render: (r) => fmtFecha(r.asignadoEn) },
    { key: "hora", label: "Asignado", render: (r) => fmtHora(r.asignadoEn) },
    {
      key: "operario",
      label: "Operario",
      render: (r) => {
        const color = r.asignadoA ? colorPorOperario.get(r.asignadoA) : undefined;
        return (
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block w-2 h-2 rounded-full shrink-0"
              style={{ background: color || "#3f3f46" }}
            />
            {r.asignadoA || "—"}
          </span>
        );
      },
    },
    { key: "lineas", label: "Líneas", num: true, render: (r) => fmtNum(r.lineas) },
    { key: "unidades", label: "Unidades", num: true, render: (r) => fmtUni(r.unidades) },
    {
      key: "cerradoEn",
      label: "Cierre",
      render: (r) =>
        r.cerradoEn ? fmtHora(r.cerradoEn) : <Tag tone="amber">En curso</Tag>,
    },
    { key: "espera", label: "Espera", render: (r) => fmtMin(r.esperaMin) },
    { key: "control", label: "Control", render: (r) => fmtMin(r.controlMin) },
  ];

  const desgloseCols: Col<(typeof desglose)[number]>[] = [
    {
      key: "operario",
      label: "Operario",
      render: (r) => (
        <span className="flex items-center gap-1.5 font-medium text-zinc-200">
          <span
            className="inline-block w-2 h-2 rounded-full shrink-0"
            style={{ background: colorPorOperario.get(r.operario) || "#3f3f46" }}
          />
          {r.operario}
        </span>
      ),
    },
    { key: "pedidos", label: "Pedidos", num: true, render: (r) => fmtNum(r.pedidos) },
    { key: "items", label: "Líneas", num: true, render: (r) => fmtNum(r.items) },
    { key: "unidades", label: "Unidades", num: true, render: (r) => fmtUni(r.unidades) },
    { key: "minTotal", label: "Tiempo de control", num: true, render: (r) => fmtMin(r.minTotal) },
    { key: "minPromedio", label: "Promedio por pedido", num: true, render: (r) => fmtMin(r.minPromedio) },
  ];

  return (
    <div>
      <div className="sticky top-16 z-40 -mx-8 px-8 py-3 bg-[#111111]/95 backdrop-blur border-b border-zinc-800 flex items-start justify-between gap-4 flex-wrap">
        <PageTitle
          title="Pedidos asignados"
          sub="Pedidos, líneas, unidades y tiempos que controló cada operario"
        />
        <div className="flex items-center gap-2">
          <button
            onClick={() => { const [d, h] = rangoMes(0); setDesde(d); setHasta(h); }}
            className="text-zinc-400 hover:text-yellow-400 transition-colors px-2.5 py-1.5 rounded-md border border-zinc-700 text-sm"
          >
            Este mes
          </button>
          <button
            onClick={() => { const [d, h] = rangoMes(-1); setDesde(d); setHasta(h); }}
            className="text-zinc-400 hover:text-yellow-400 transition-colors px-2.5 py-1.5 rounded-md border border-zinc-700 text-sm"
          >
            Mes anterior
          </button>
          <DateRangeField desde={desde} hasta={hasta} onChange={(d, h) => { setDesde(d); setHasta(h); }} align="end" />
          <button
            onClick={() => load(desde, hasta)}
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
      ) : pedidos.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 gap-3 text-center">
          <ListChecks size={40} className="text-zinc-700" />
          <p className="text-zinc-400 font-medium">
            Sin pedidos asignados en el rango elegido.
          </p>
        </div>
      ) : (
        <>
          <SectionTitle>👷 Desglose por operario ({fmtNum(totalItems)} líneas en total)</SectionTitle>
          <Table cols={desgloseCols} rows={desglose} empty="Sin datos" />

          <SectionTitle>📋 Detalle por pedido ({fmtNum(pedidos.length)})</SectionTitle>
          <Table cols={cols} rows={pedidos} maxH={560} />

          <p className="text-[11px] text-zinc-600 mt-4 leading-relaxed">
            "Cierre" es el cierre en mesa registrado en Magnus. "Control" son
            los minutos entre la asignación y ese cierre; "Espera", entre el
            fin de armado y la asignación. Líneas = renglones no anulados;
            unidades = cantidad cumplida. "En curso" = todavía sin cierre.
            Vuelta = remito de acopio. Solo lectura.
          </p>
        </>
      )}
    </div>
  );
}
