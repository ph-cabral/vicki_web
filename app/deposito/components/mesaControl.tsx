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
  ChartDonut,
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
interface PorControlador {
  controlador: string;
  codigo: number | string | null;
  por_mes: Record<string, number>;
  total: number;
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

type EjeTiempo = "hora" | "dia" | "semana";

const isoMes = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

// "YYYY-MM-DD" -> "dd/mm" sin el corrimiento de un día que da parsear con
// `new Date(s)` (lo toma como medianoche UTC y en es-AR corre para atrás).
function fmtDiaCorto(s: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return s;
  return `${m[3]}/${m[2]}`;
}

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
  const [ejeTiempo, setEjeTiempo] = useState<EjeTiempo>("dia"); // Por hora/día/semana

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
  const ult2 = mesesOrdenados.slice(-2);

  // Pie: comparación de los últimos 2 meses seleccionados.
  const pieData = ult2.map((m, i) => ({
    name: fmtMes(m),
    value: data?.por_mes.find((p) => p.mes === m)?.total ?? 0,
    color: PALETTE[i % PALETTE.length],
  }));

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

  // Barras por hora del día (0-23): distribución acumulada de los meses
  // elegidos — en qué franja horaria se concentra el control.
  const barHoraData = (data?.por_hora ?? []).map((h) => ({
    hora: `${String(h.hora).padStart(2, "0")}:00`,
    total: h.total,
  }));
  const horaPico = (data?.por_hora ?? []).reduce(
    (top, h) => (h.total > top.total ? h : top),
    { hora: -1, total: 0 },
  );

  // Barras por día calendario, un renglón por fecha (todos los meses elegidos
  // concatenados en orden cronológico).
  const barDiaData = (data?.por_dia ?? []).map((p) => ({
    fecha: fmtDiaCorto(p.fecha),
    total: p.total,
  }));
  const promedioDiario =
    data && data.por_dia.length > 0
      ? data.total_general / data.por_dia.length
      : 0;

  // Barras por semana (lunes de esa semana como etiqueta).
  const barSemanaData = (data?.por_semana ?? []).map((p) => ({
    semana: fmtDiaCorto(p.semana),
    total: p.total,
  }));
  const promedioSemanal =
    data && data.por_semana.length > 0
      ? data.total_general / data.por_semana.length
      : 0;

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

          <SectionTitle>📊 Comparación de los últimos 2 meses</SectionTitle>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Panel
              title="Últimos 2 meses seleccionados"
              accent={ult2.length === 2 ? `(${fmtMes(ult2[0])} vs ${fmtMes(ult2[1])})` : ""}
            >
              {ult2.length < 2 ? (
                <div className="py-10 text-center text-zinc-600 text-sm">
                  Elegí al menos 2 meses para comparar.
                </div>
              ) : (
                <ChartDonut data={pieData} height={260} fmt={(n) => fmtNum(n)} />
              )}
            </Panel>

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

          <SectionTitle>⏱️ Por hora / día / semana</SectionTitle>
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            {(
              [
                ["hora", "Por hora del día"],
                ["dia", "Por día"],
                ["semana", "Por semana"],
              ] as [EjeTiempo, string][]
            ).map(([id, label]) => (
              <button
                key={id}
                onClick={() => setEjeTiempo(id)}
                className={`px-3 py-1.5 rounded-lg text-[12px] font-medium border transition-colors ${
                  ejeTiempo === id
                    ? "bg-yellow-400/10 border-yellow-400/40 text-yellow-400"
                    : "bg-[#1f1f1f] border-zinc-800 text-zinc-400 hover:text-zinc-200"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {ejeTiempo === "hora" && (
            <Panel
              title="Distribución por hora del día"
              accent={
                horaPico.hora >= 0
                  ? `(pico: ${String(horaPico.hora).padStart(2, "0")}:00 con ${fmtNum(horaPico.total)})`
                  : ""
              }
            >
              <ChartBar
                data={barHoraData}
                xKey="hora"
                height={280}
                series={[{ key: "total", name: "Items controlados", color: PALETTE[2] }]}
                fmt={(n) => fmtNum(n)}
                showValues
              />
              <p className="text-[11px] text-zinc-600 mt-3">
                Suma de todos los meses elegidos, agrupada por la hora del día
                en que se controló cada renglón (no por día individual) — sirve
                para ver en qué franja del día se concentra el trabajo de mesa
                de control.
              </p>
            </Panel>
          )}

          {ejeTiempo === "dia" && (
            <Panel
              title="Total por día"
              accent={`(${fmtNum(data.por_dia.length)} días · promedio ${fmtNum(Math.round(promedioDiario))}/día)`}
            >
              <ChartBar
                data={barDiaData}
                xKey="fecha"
                height={300}
                series={[{ key: "total", name: "Items controlados", color: PALETTE[3] }]}
                fmt={(n) => fmtNum(n)}
                angle={-60}
              />
            </Panel>
          )}

          {ejeTiempo === "semana" && (
            <Panel
              title="Total por semana"
              accent={`(${fmtNum(data.por_semana.length)} semanas · promedio ${fmtNum(Math.round(promedioSemanal))}/semana)`}
            >
              <ChartBar
                data={barSemanaData}
                xKey="semana"
                height={300}
                series={[{ key: "total", name: "Items controlados", color: PALETTE[4] }]}
                fmt={(n) => fmtNum(n)}
                angle={-35}
                showValues
              />
              <p className="text-[11px] text-zinc-600 mt-3">
                Cada barra es la semana que arranca en la fecha indicada (lunes
                a domingo).
              </p>
            </Panel>
          )}

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
