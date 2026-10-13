"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { Loader2, AlertTriangle, RefreshCw, ClipboardList, Info } from "lucide-react";
import {
  PageTitle,
  SectionTitle,
  Panel,
  KPI,
  Grid,
  ChartBar,
  Alert,
  PALETTE,
  fmtNum,
  fmtMes,
} from "./ui";

// ──────────────────────────────────────────────────────────────────────────────
// Mesas de Control — renglones (items) controlados, por mes y por Controlador.
// Fuente: Ven_PedImpresoCP + venfer_pedidoReng (EVERWEAR) vía
// /api/deposito/mesa-control (→ indicadores-api). Solo lectura.
//
// El total_general cuenta cada renglón (NroMovVenta+NroRenglon) UNA sola vez
// — NO usa el SP RPT_V325_ProductividadPorControlador porque ese SP hace
// UNION ALL de CodControlador1+CodControlador2 sin deduplicar, y duplicaba el
// total cuando un pedido tenía doble control.
//
// CONFIRMADO 2026-07-13: un pedido NO se controla 2 veces (1 sola persona
// controla y cierra). CodControlador1/2 vienen con el MISMO valor siempre
// — el backend (mesa_control.py) dedupea por renglón antes de acreditar, así
// que por_controlador ya no debería sumar ~2x el total. Si igual aparece una
// pequeña diferencia es por recontrol/reimpresión real del mismo renglón
// (créditos legítimos), no por el bug viejo.
//
// Selección de meses por checkbox (no un rango de fechas): se corre una
// consulta por mes elegido para poder comparar meses entre sí.
// ──────────────────────────────────────────────────────────────────────────────

interface PorMes {
  mes: string;
  total: number;
}
interface PorDiaControlador {
  fecha: string; // YYYY-MM-DD
  total: number; // items (renglones/créditos)
  ot: number; // pedidos (NroMovVenta) distintos detrás de esos items
}
interface PorDowControlador {
  dow: number; // 0=lunes .. 6=domingo (ISO)
  total: number;
  ot: number;
}
interface PorSlot30Controlador {
  slot: number; // 0..47
  hora: string; // "HH:MM", inicio de la franja de 30 min
  total: number;
  ot: number;
}
interface PorLineaControlador {
  linea: string;
  total: number;
}
interface PorControlador {
  controlador: string;
  codigo: number | string | null;
  por_mes: Record<string, number>;
  total: number;
  // Desglose 2026-09-14 para el toggle "Por controlador" (ver mesa_control.py):
  // cada crédito (incluye recontroles) ubicado en la fecha/hora de ESE
  // control puntual — no en la del "evento más reciente del renglón" que usa
  // el resto de la vista (por_dia/por_semana/por_hora de arriba).
  por_dia: PorDiaControlador[];
  por_dow: PorDowControlador[];
  por_slot30: PorSlot30Controlador[];
  por_linea: PorLineaControlador[];
}
interface PorDia {
  fecha: string; // YYYY-MM-DD
  total: number;
}
interface PorSemana {
  semana: string; // YYYY-MM-DD, lunes de esa semana
  total: number;
}
interface PorHora {
  hora: number; // 0-23
  total: number;
}
interface MesaControlData {
  meses: string[];
  por_mes: PorMes[];
  por_controlador: PorControlador[];
  por_dia: PorDia[];
  por_semana: PorSemana[];
  por_hora: PorHora[];
  total_general: number;
}

const isoMes = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

// Últimos N meses (más reciente primero), para el selector.
function ultimosMeses(n: number): string[] {
  const out: string[] = [];
  const hoy = new Date();
  for (let i = 0; i < n; i++) {
    const d = new Date(hoy.getFullYear(), hoy.getMonth() - i, 1);
    out.push(isoMes(d));
  }
  return out;
}

export function MesaControlTab() {
  const disponibles = useMemo(() => ultimosMeses(12), []);
  const [seleccionados, setSeleccionados] = useState<string[]>(() =>
    ultimosMeses(3).reverse(), // cronológico ascendente
  );
  const [data, setData] = useState<MesaControlData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verTodos, setVerTodos] = useState(false); // toggle carta por controlador

  const load = useCallback(async (meses: string[]) => {
    if (!meses.length) {
      setData(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/deposito/mesa-control?meses=${meses.join(",")}`,
        { cache: "no-store" },
      );
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setData(j as MesaControlData);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al cargar");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(seleccionados);
    // Sólo en el montaje: los cambios posteriores los dispara toggleMes().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleMes = (m: string) => {
    const next = seleccionados.includes(m)
      ? seleccionados.filter((x) => x !== m)
      : [...seleccionados, m];
    const ordenados = disponibles.filter((x) => next.includes(x)).reverse(); // cronológico
    setSeleccionados(ordenados);
    load(ordenados);
  };

  const mesesOrdenados = data?.meses ?? []; // ya viene ascendente desde el back
  const ultimoMes = mesesOrdenados[mesesOrdenados.length - 1] ?? null;

  // Barras: 1 barra por mes, todos los meses seleccionados.
  const barMesData = (data?.por_mes ?? []).map((p) => ({
    mes: fmtMes(p.mes),
    total: p.total,
  }));

  // Barras por controlador: último mes o suma de todos los seleccionados (toggle).
  const barControladorData = (data?.por_controlador ?? [])
    .map((c) => ({
      controlador:
        c.controlador.length > 16 ? c.controlador.slice(0, 16) + "…" : c.controlador,
      cantidad: verTodos ? c.total : ultimoMes ? (c.por_mes[ultimoMes] ?? 0) : 0,
    }))
    .filter((c) => c.cantidad > 0)
    .sort((a, b) => b.cantidad - a.cantidad);

  // Referencia: con el fix de dedupe (backend, 2026-07-13) la suma de
  // controladores debería ser ~= al total. Si sobra algo es por recontrol/
  // reimpresión real del mismo renglón (créditos legítimos), no por el bug
  // viejo de CodControlador1==CodControlador2 duplicando el crédito.
  const sumaControladores = barControladorData.reduce((s, c) => s + c.cantidad, 0);
  const totalRef = verTodos
    ? data?.total_general ?? 0
    : (ultimoMes && data?.por_mes.find((p) => p.mes === ultimoMes)?.total) ?? 0;
  const dobleControl = sumaControladores - totalRef;

  return (
    <div>
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <PageTitle
          title="Mesas de Control"
          sub="Renglones controlados (exacto) por Controlador — Ven_PedImpresoCP / venfer_pedidoReng (EVERWEAR)"
        />
        <button
          onClick={() => load(seleccionados)}
          disabled={loading}
          className="flex items-center gap-1.5 text-zinc-400 hover:text-yellow-400 transition-colors px-2.5 py-1.5 rounded-md border border-zinc-700 disabled:opacity-40 text-sm"
        >
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Refrescar
        </button>
      </div>

      <div className="mb-5">
        <Alert tone="green">
          <Info size={15} className="mt-0.5 shrink-0" />
          <span>
            "Total controlado" cuenta cada renglón (línea de pedido) una sola
            vez — es el número que reconcilia contra lo preparado/facturado.
            El desglose por controlador debería sumar prácticamente lo mismo
            (1 control = 1 persona); si hay una pequeña diferencia es por
            recontrol/reimpresión real del mismo renglón, no por doble conteo.
          </span>
        </Alert>
      </div>

      {/* Selector de meses */}
      <Panel title="Meses a comparar" accent="(elegí uno o más)" className="mb-5">
        <div className="flex flex-wrap gap-2">
          {disponibles.map((m) => {
            const activo = seleccionados.includes(m);
            return (
              <button
                key={m}
                onClick={() => toggleMes(m)}
                className={`px-3 py-1.5 rounded-md border text-[12px] font-medium transition-colors ${
                  activo
                    ? "bg-yellow-400/10 border-yellow-400/50 text-yellow-400"
                    : "border-zinc-700 text-zinc-400 hover:border-zinc-500"
                }`}
              >
                {fmtMes(m)}
              </button>
            );
          })}
        </div>
      </Panel>

      {error && (
        <div className="flex items-center gap-3 bg-[#1A1A1A] border border-red-400/40 rounded-xl px-5 py-3 text-sm text-red-300 mb-5">
          <AlertTriangle size={16} className="text-red-400" /> {error}
        </div>
      )}

      {loading && !data ? (
        <div className="flex flex-col items-center justify-center py-24 gap-3 text-center">
          <Loader2 size={36} className="text-yellow-400 animate-spin" />
          <p className="text-zinc-400 font-medium">Consultando EVERWEAR…</p>
        </div>
      ) : !data || data.meses.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 gap-3 text-center">
          <ClipboardList size={40} className="text-zinc-700" />
          <p className="text-zinc-400 font-medium">
            Elegí al menos un mes para ver datos.
          </p>
        </div>
      ) : (
        <>
          <Grid cols={4}>
            <KPI label="Total controlado" value={fmtNum(data.total_general)} accent="yellow" />
            <KPI label="Meses" value={fmtNum(data.meses.length)} accent="neutral" />
            <KPI
              label="Controladores"
              value={fmtNum(data.por_controlador.length)}
              accent="neutral"
            />
            <KPI
              label="Último mes"
              value={ultimoMes ? fmtMes(ultimoMes) : "—"}
              sub={
                ultimoMes
                  ? fmtNum(data.por_mes.find((p) => p.mes === ultimoMes)?.total ?? 0)
                  : undefined
              }
              accent="green"
            />
          </Grid>

          <SectionTitle>📊 Total por mes</SectionTitle>
          <div>
            <Panel
              title="Total por mes"
              accent={`(${data.meses.length} ${data.meses.length === 1 ? "mes" : "meses"})`}
            >
              <ChartBar
                data={barMesData}
                xKey="mes"
                height={260}
                series={[{ key: "total", name: "Items controlados", color: PALETTE[0] }]}
                fmt={(n) => fmtNum(n)}
                showValues
              />
            </Panel>
          </div>

          <SectionTitle>👷 Por Controlador</SectionTitle>
          <Panel
            title={
              verTodos ? "Todos los meses seleccionados" : `Último mes (${ultimoMes ? fmtMes(ultimoMes) : "—"})`
            }
            accent={
              <button
                onClick={() => setVerTodos((v) => !v)}
                className="text-[11px] font-semibold px-2 py-1 rounded-md border border-zinc-700 text-zinc-300 hover:border-yellow-400 hover:text-yellow-400 transition-colors normal-case"
              >
                {verTodos ? "Ver solo último mes" : "Ver todos los meses"}
              </button>
            }
          >
            <ChartBar
              data={barControladorData}
              xKey="controlador"
              height={320}
              series={[{ key: "cantidad", name: "Items controlados", color: PALETTE[1] }]}
              fmt={(n) => fmtNum(n)}
              angle={-35}
              showValues
            />
            <p className="text-[11px] text-zinc-600 mt-3">
              Suma de controladores: {fmtNum(sumaControladores)}
              {dobleControl > 0 && (
                <>
                  {" "}
                  (+{fmtNum(dobleControl)} por recontrol/reimpresión real del
                  mismo renglón, ver aviso de arriba)
                </>
              )}
            </p>
          </Panel>

          <p className="text-[11px] text-zinc-600 mt-6 leading-relaxed">
            Fuente: EVERWEAR.dbo.Ven_PedImpresoCP (CodControlador1/2, FechaControl)
            + venfer_pedidoReng (renglón/línea), consulta directa — no el SP de
            Softech (RPT_V325_ProductividadPorControlador), que duplicaba el
            total al no deduplicar el doble control. Backend dedupea por
            renglón (CodControlador1==CodControlador2 es 1 solo crédito, no 2).
            Lectura en vivo, solo lectura — no se escribe en Magnus.
          </p>
        </>
      )}
    </div>
  );
}
