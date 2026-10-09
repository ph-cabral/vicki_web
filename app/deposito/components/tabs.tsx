"use client";

import React from "react";
import type { DepositoData, DepRegistro } from "@/lib/deposito/parseDeposito";
import type { TiempoData, EtapaRow } from "@/lib/deposito/parseTiempo";
import {
  PageTitle,
  SectionTitle,
  Panel,
  KPI,
  Grid,
  Table,
  ChartBar,
  ChartDonut,
  ChartEvol,
  PALETTE,
  C,
  fmtNum,
  fmtMes,
  type Col,
  type Serie,
  type RefLinea,
} from "./ui";
import {
  useObjetivosDeposito,
  aItemsTxt,
  type ObjetivoMes,
} from "@/lib/deposito/objetivos";
import { Target } from "lucide-react";

const sumBy = <T,>(rows: T[], f: (r: T) => number) =>
  rows.reduce<number>((s, r) => s + (f(r) || 0), 0);
const clip = (s: string, n = 16) => (s.length > n ? s.slice(0, n) + "…" : s);
const pct = (rec: number, ped: number) =>
  ped > 0 ? `${((rec / ped) * 100).toFixed(1)} %` : "—";

interface OpRow {
  operario: string;
  recolectados: number;
  pedidos: number;
  ot: number;
  fill: number | null;
}

function rankingOperarios(regs: DepRegistro[], topN = 15) {
  const m = new Map<string, number>();
  regs.forEach((r) =>
    m.set(r.operario, (m.get(r.operario) ?? 0) + r.itemsRecolectados),
  );
  return [...m.entries()]
    .map(([operario, recolectados]) => ({ operario, recolectados }))
    .sort((a, b) => b.recolectados - a.recolectados)
    .slice(0, topN);
}
function tablaOperarios(regs: DepRegistro[]): OpRow[] {
  const m = new Map<string, OpRow>();
  regs.forEach((r) => {
    let o = m.get(r.operario);
    if (!o) {
      o = {
        operario: r.operario,
        recolectados: 0,
        pedidos: 0,
        ot: 0,
        fill: null,
      };
      m.set(r.operario, o);
    }
    o.recolectados += r.itemsRecolectados;
    o.pedidos += r.itemsPedidos;
    o.ot += r.ot;
  });
  const rows = [...m.values()];
  rows.forEach(
    (o) => (o.fill = o.pedidos > 0 ? (o.recolectados / o.pedidos) * 100 : null),
  );
  return rows.sort((a, b) => b.recolectados - a.recolectados);
}
function matrizOperarioMes(regs: DepRegistro[], meses: string[]) {
  const m = new Map<string, Map<string, number>>();
  regs.forEach((r) => {
    if (!m.has(r.operario)) m.set(r.operario, new Map());
    const mm = m.get(r.operario)!;
    mm.set(r.mes, (mm.get(r.mes) ?? 0) + r.itemsRecolectados);
  });
  return [...m.entries()]
    .map(([operario, mm]) => ({
      operario,
      valores: meses.map((x) => mm.get(x) ?? 0),
      total: sumBy(meses, (x) => mm.get(x) ?? 0),
    }))
    .sort((a, b) => b.total - a.total);
}

function MatrixTable({
  head,
  rows,
}: {
  head: string[];
  rows: { label: string; cells: React.ReactNode[] }[];
}) {
  return (
    <div
      className="rounded-lg bg-[#171717] border border-zinc-800 overflow-auto"
      style={{ maxHeight: 460 }}
    >
      <table className="w-full text-[12px]">
        <thead className="sticky top-0 z-10">
          <tr className="bg-[#1f1f1f]">
            <th className="px-2.5 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-zinc-500 border-b border-zinc-800 sticky left-0 bg-[#1f1f1f]">
              Operario
            </th>
            {head.map((h, i) => (
              <th
                key={i}
                className="px-2.5 py-2 text-right text-[10px] font-semibold uppercase tracking-wider text-zinc-500 border-b border-zinc-800 whitespace-nowrap"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr
              key={i}
              className="border-b border-zinc-800/60 hover:bg-[#1f1f1f]"
            >
              <td className="px-2.5 py-1.5 sticky left-0 bg-[#171717] text-zinc-300">
                {r.label}
              </td>
              {r.cells.map((c, j) => (
                <td
                  key={j}
                  className="px-2.5 py-1.5 text-right tabular-nums text-zinc-300"
                >
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Selector de mes reutilizable
export function MesSelect({
  meses,
  value,
  onChange,
  nombre,
}: {
  meses: string[];
  value: string;
  onChange: (m: string) => void;
  nombre: (m: string) => string;
}) {
  return (
    <label className="flex items-center gap-2 text-sm text-zinc-400 mt-1 shrink-0">
      Mes:
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-[#1f1f1f] border border-zinc-700 rounded-lg px-3 py-1.5 text-zinc-100 focus:border-yellow-400 outline-none cursor-pointer"
      >
        {meses.map((m) => (
          <option key={m} value={m}>
            {nombre(m)}
          </option>
        ))}
      </select>
    </label>
  );
}

// Grilla de mini-gráficos: un gráfico de evolución por operario
function EvolucionPorOperario({
  meses,
  matriz,
}: {
  meses: string[];
  matriz: { operario: string; valores: number[]; total: number }[];
}) {
  const max = Math.max(1, ...matriz.flatMap((o) => o.valores)); // escala global compartida
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 mt-4">
      {matriz.map((o) => (
        <Panel key={o.operario} title={o.operario} accent={fmtNum(o.total)}>
          <ChartEvol
            data={meses.map((m, i) => ({ mes: fmtMes(m), val: o.valores[i] }))}
            xKey="mes"
            yKey="val"
            height={150}
            fmt={fmtNum}
            max={max}
          />
        </Panel>
      ))}
    </div>
  );
}

// ─── RESUMEN ─────────────────────────────────────────────────────────────────
export function ResumenTab({ d, mes }: { d: DepositoData; mes: string }) {
  const r = d.resumen;
  const esTodos = !d.meses.includes(mes);
  const pm = d.porMes.find((p) => p.mes === mes);
  const regsMes = d.registros.filter((x) => x.mes === mes);
  const kRecol = esTodos ? r.totalRecolectados : (pm?.recolectados ?? 0);
  const kPed = esTodos ? r.totalPedidos : (pm?.pedidos ?? 0);
  const kOT = esTodos ? r.totalOT : (pm?.ot ?? 0);
  const kFill = esTodos ? r.fillRate : kPed > 0 ? (kRecol / kPed) * 100 : null;
  const kOps = esTodos
    ? r.operariosActivos
    : new Set(regsMes.map((x) => x.operario)).size;
  const kPeriodo = esTodos
    ? (r.nombreUltimoMes ?? "—")
    : (pm?.nombreMes ?? mes);
  const recolMes = d.porMes.map((m) => ({
    mes: fmtMes(m.mes),
    recolectados: m.recolectados,
  }));
  const otMes = d.porMes.map((m) => ({ mes: fmtMes(m.mes), ot: m.ot }));
  const procDonut = d.porProceso.map((p, i) => ({
    name: p.proceso,
    value: p.recolectados,
    color: PALETTE[i % PALETTE.length],
  }));

  const ult2 = d.meses.slice(-2);
  type Cmp = { operario: string; a: number; b: number };
  const cmpMap = new Map<string, Cmp>();
  d.registros.forEach((reg) => {
    if (!ult2.includes(reg.mes)) return;
    let o = cmpMap.get(reg.operario);
    if (!o) {
      o = { operario: reg.operario, a: 0, b: 0 };
      cmpMap.set(reg.operario, o);
    }
    if (reg.mes === ult2[0]) o.a += reg.itemsRecolectados;
    else o.b += reg.itemsRecolectados;
  });
  const cmpData = [...cmpMap.values()]
    .sort((x, y) => y.a + y.b - (x.a + x.b))
    .slice(0, 8)
    .map((o) => ({ operario: clip(o.operario, 13), a: o.a, b: o.b }));
  const nameA =
    d.porMes.find((p) => p.mes === ult2[0])?.nombreMes ?? ult2[0] ?? "";
  const nameB = ult2[1]
    ? (d.porMes.find((p) => p.mes === ult2[1])?.nombreMes ?? ult2[1])
    : "";
  const cmpSeries: Serie[] =
    ult2.length === 2
      ? [
          { key: "a", name: nameA, color: "#facc15" },
          { key: "b", name: nameB, color: "#9ca3af" },
        ]
      : [{ key: "a", name: nameA, color: "#facc15" }];

  return (
    <div>
      <PageTitle
        title="Resumen de Producción"
        sub="Items recolectados, OT y rendimiento por proceso y operario — Depósito Central"
      />
      <Grid cols={6}>
        <KPI
          label="Items recolectados"
          value={fmtNum(kRecol)}
          sub={
            esTodos && r.nombreUltimoMes
              ? `${r.nombreUltimoMes}: ${fmtNum(r.recolectadosUltimoMes)}`
              : undefined
          }
          accent="green"
        />
        <KPI label="Items pedidos" value={fmtNum(kPed)} accent="neutral" />
        <KPI
          label="Fill rate"
          value={kFill != null ? `${kFill.toFixed(1)} %` : "—"}
          sub="recolectado / pedido"
          accent={kFill != null && kFill >= 95 ? "green" : "amber"}
        />
        <KPI label="OT totales" value={fmtNum(kOT)} accent="yellow" />
        <KPI label="Operarios activos" value={fmtNum(kOps)} accent="neutral" />
        <KPI
          label="Período"
          value={kPeriodo}
          sub={
            esTodos
              ? `${d.meses.length} ${d.meses.length === 1 ? "mes" : "meses"}`
              : "1 mes"
          }
          accent="amber"
        />
      </Grid>

      <SectionTitle>📦 Producción por Mes</SectionTitle>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel title="Items recolectados por mes">
          <ChartBar
            data={recolMes}
            xKey="mes"
            height={260}
            series={[
              { key: "recolectados", name: "Recolectados", color: PALETTE[0] },
            ]}
            fmt={(n) => fmtNum(n)}
            showValues
          />
        </Panel>
        <Panel title="OT (órdenes) por mes">
          <ChartBar
            data={otMes}
            xKey="mes"
            height={260}
            series={[{ key: "ot", name: "OT", color: PALETTE[3] }]}
            fmt={(n) => fmtNum(n)}
            showValues
          />
        </Panel>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4">
        <Panel title="Distribución por proceso" accent="(recolectados)">
          <ChartDonut data={procDonut} height={280} fmt={(n) => fmtNum(n)} />
        </Panel>
        <Panel
          title="Comparativa por operario"
          accent={ult2.length === 2 ? `(${nameA} vs ${nameB})` : ""}
        >
          <ChartBar
            data={cmpData}
            xKey="operario"
            height={280}
            series={cmpSeries}
            fmt={(n) => fmtNum(n)}
            angle={0}
            showValues
          />
        </Panel>
      </div>

      <SectionTitle>📊 Totales por Proceso</SectionTitle>
      <Table<DepositoData["porProceso"][number]>
        cols={[
          { key: "proceso", label: "Proceso" },
          {
            key: "recolectados",
            label: "Recolectados",
            num: true,
            render: (x) => fmtNum(x.recolectados),
          },
          {
            key: "pedidos",
            label: "Pedidos",
            num: true,
            render: (x) => fmtNum(x.pedidos),
          },
          { key: "ot", label: "OT", num: true, render: (x) => fmtNum(x.ot) },
          {
            key: "fill",
            label: "Fill %",
            num: true,
            render: (x) => pct(x.recolectados, x.pedidos),
          },
        ]}
        rows={d.porProceso}
      />
    </div>
  );
}

// ─── POR PROCESO (Picking / Libre+Repo / Re-Ubicación) ───────────────────────
export function ProcesoTab({
  d,
  proceso,
  mes,
  chartMeses,
  chartRegs,
}: {
  d: DepositoData;
  proceso: string;
  mes: string;
  /** Meses "yyyy-mm" a graficar en "Items recolectados por mes" (cronológico). */
  chartMeses: string[];
  /** Registros del rango del gráfico (ya filtrados por operario); null = cargando. */
  chartRegs: DepRegistro[] | null;
}) {
  const regs = d.registros.filter((r) => r.proceso === proceso);
  const meses = [...new Set(regs.map((r) => r.mes))].sort();
  const mesActivo = meses.includes(mes) ? mes : meses[meses.length - 1];

  // Objetivos del ranking (líneas verde/amarilla/roja) — una sola lectura por
  // proceso trae todos los meses, así que cambiar de mes no re-consulta.
  const obj = useObjetivosDeposito(proceso);
  const [modal, setModal] = React.useState(false);

  if (!regs.length) {
    return (
      <div>
        <PageTitle title={proceso} />
        <div className="py-16 text-center text-zinc-600 text-sm">
          Sin datos para este proceso.
        </div>
      </div>
    );
  }

  const nombreDe = (m: string) =>
    regs.find((r) => r.mes === m)?.nombreMes ?? fmtMes(m);
  const regsMes = regs.filter((r) => r.mes === mesActivo);

  // KPIs y tablas del MES seleccionado
  const totRecol = sumBy(regsMes, (r) => r.itemsRecolectados);
  const totPed = sumBy(regsMes, (r) => r.itemsPedidos);
  const totOT = sumBy(regsMes, (r) => r.ot);
  const ops = new Set(regsMes.map((r) => r.operario)).size;
  const ranking = rankingOperarios(regsMes, 15).map((x) => ({
    operario: clip(x.operario, 13),
    recolectados: x.recolectados,
  }));

  // Líneas de referencia del mes activo (ya vienen en ITEMS desde la API).
  const objMes: ObjetivoMes | undefined = obj.objetivos[mesActivo];
  const refLines: RefLinea[] = objMes
    ? [
        objMes.bajo != null
          ? { y: objMes.bajo, label: "Bajo rendimiento", color: C.red }
          : null,
        { y: objMes.objetivo, label: "Objetivo", color: C.green },
        objMes.sobresaliente != null
          ? { y: objMes.sobresaliente, label: "Sobresaliente", color: C.brand }
          : null,
      ].filter((l): l is RefLinea => l !== null)
    : [];
  const cumplen = objMes
    ? ranking.filter((r) => r.recolectados >= objMes.objetivo).length
    : 0;

  // Serie del gráfico: una columna por mes de `chartMeses` (con 0 si no hubo).
  const regsChart = (chartRegs ?? []).filter((r) => r.proceso === proceso);
  const recolMes = chartMeses.map((m) => ({
    mes: fmtMes(m),
    recolectados: sumBy(
      regsChart.filter((r) => r.mes === m),
      (r) => r.itemsRecolectados,
    ),
  }));

  return (
    <div>
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <PageTitle
          title={proceso}
          sub={`Recolección, ranking y evolución por operario — ${meses.length} ${meses.length === 1 ? "mes" : "meses"}`}
        />
      </div>

      <Grid cols={5}>
        <KPI
          label="Recolectados"
          value={fmtNum(totRecol)}
          sub={nombreDe(mesActivo)}
          accent="green"
        />
        <KPI
          label="Pedidos"
          value={fmtNum(totPed)}
          sub={nombreDe(mesActivo)}
          accent="neutral"
        />
        <KPI
          label="Fill rate"
          value={pct(totRecol, totPed)}
          accent={totPed > 0 && totRecol / totPed >= 0.95 ? "green" : "amber"}
        />
        <KPI label="OT" value={fmtNum(totOT)} accent="yellow" />
        <KPI label="Operarios" value={fmtNum(ops)} accent="neutral" />
      </Grid>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-5">
        <Panel title="Items recolectados por mes">
          {chartRegs === null ? (
            <div className="flex items-center justify-center h-[280px] text-sm text-zinc-500">
              Cargando…
            </div>
          ) : (
            <ChartBar
              data={recolMes}
              xKey="mes"
              height={280}
              series={[
                { key: "recolectados", name: "Recolectados", color: PALETTE[0] },
              ]}
              fmt={(n) => fmtNum(n)}
              showValues
            />
          )}
        </Panel>
        <Panel
          title={`Ranking operarios — ${nombreDe(mesActivo)}`}
          accent="(top 15)"
          action={
            obj.puedeEditar ? (
              <button
                type="button"
                onClick={() => setModal(true)}
                title="Cargar el objetivo, el sobresaliente y el piso de bajo rendimiento de este mes"
                className="flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-[#1f1f1f] px-2.5 py-1 text-[11px] font-medium text-zinc-300 hover:border-yellow-400 hover:text-yellow-400 transition-colors shrink-0"
              >
                <Target size={13} />
                {objMes ? "Editar objetivo" : "Objetivo"}
              </button>
            ) : null
          }
        >
          <ChartBar
            data={ranking}
            xKey="operario"
            height={280}
            series={[
              { key: "recolectados", name: "Recolectados", color: PALETTE[2] },
            ]}
            fmt={(n) => fmtNum(n)}
            angle={0}
            showValues
            refLines={refLines}
          />
          {refLines.length > 0 && (
            <div className="flex flex-wrap items-center gap-4 px-1 pt-2 text-[11px] text-zinc-400">
              {refLines.map((r) => (
                <span key={r.label} className="flex items-center gap-1.5">
                  <span
                    className="inline-block h-0.5 w-4 rounded"
                    style={{ background: r.color }}
                  />
                  {r.label} · {fmtNum(r.y)}
                </span>
              ))}
              <span className="text-zinc-600">
                Cumplen el objetivo: {cumplen} de {ranking.length}
              </span>
            </div>
          )}
        </Panel>
      </div>

      {modal && (
        <ObjetivoModal
          proceso={proceso}
          meses={meses}
          mesInicial={mesActivo}
          nombreDe={nombreDe}
          objetivos={obj.objetivos}
          onGuardar={obj.guardar}
          onBorrar={obj.borrar}
          onCerrar={() => setModal(false)}
        />
      )}
    </div>
  );
}

// Definido FUERA de ObjetivoModal a propósito: si viviera adentro, React lo
// trataría como un componente distinto en cada tecleo y el input perdería el
// foco letra por letra.
function CampoObjetivo({
  label,
  color,
  valor,
  setValor,
  ayuda,
}: {
  label: string;
  color: string;
  valor: string;
  setValor: (v: string) => void;
  ayuda: string;
}) {
  return (
    <label className="block">
      <span className="flex items-center gap-2 text-xs font-medium text-zinc-300">
        <span
          className="inline-block h-0.5 w-4 rounded"
          style={{ background: color }}
        />
        {label}
      </span>
      <div className="mt-1.5 flex items-center gap-2">
        <input
          type="number"
          step="1"
          min="0"
          inputMode="numeric"
          value={valor}
          onChange={(e) => setValor(e.target.value)}
          placeholder="0"
          className="w-32 rounded-lg border border-zinc-700 bg-[#1f1f1f] px-3 py-2 text-sm text-zinc-100 outline-none focus:border-yellow-400 tabular-nums"
        />
        <span className="text-xs text-zinc-500">items</span>
      </div>
      <span className="mt-1 block text-[11px] text-zinc-600">{ayuda}</span>
    </label>
  );
}

// ─── OBJETIVOS DEL RANKING ────────────────────────────────────────────────────
// Carga de las 3 líneas que se dibujan sobre el ranking de operarios, por
// PROCESO y por MES (2026-09-09). Los números se escriben EN ITEMS, la misma
// unidad que las barras (2026-10-07: antes eran miles y x1.000, y al escribir
// 4500 quedaba 4.500.000, fuera de escala).
//
// El mes arranca en el que está mirando la pantalla, pero se puede elegir
// cualquiera del rango: al cambiarlo, los campos se rellenan con lo que ya
// esté cargado para ese mes (o quedan vacíos si no hay nada).
function ObjetivoModal({
  proceso,
  meses,
  mesInicial,
  nombreDe,
  objetivos,
  onGuardar,
  onBorrar,
  onCerrar,
}: {
  proceso: string;
  meses: string[];
  mesInicial: string;
  nombreDe: (m: string) => string;
  objetivos: Record<string, ObjetivoMes>;
  onGuardar: (
    mes: string,
    v: { objetivo: string; sobresaliente: string; bajo: string },
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  onBorrar: (mes: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  onCerrar: () => void;
}) {
  const [mes, setMes] = React.useState(mesInicial);
  const [objetivo, setObjetivo] = React.useState("");
  const [sobresaliente, setSobresaliente] = React.useState("");
  const [bajo, setBajo] = React.useState("");
  const [guardando, setGuardando] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Al abrir y al cambiar de mes: precargar lo que ya esté guardado.
  React.useEffect(() => {
    const o = objetivos[mes];
    setObjetivo(aItemsTxt(o?.objetivo));
    setSobresaliente(aItemsTxt(o?.sobresaliente));
    setBajo(aItemsTxt(o?.bajo));
    setError(null);
  }, [mes, objetivos]);

  const yaCargado = !!objetivos[mes];

  const guardar = async () => {
    setGuardando(true);
    setError(null);
    const r = await onGuardar(mes, {
      objetivo: objetivo.replace(",", "."),
      sobresaliente: sobresaliente.replace(",", "."),
      bajo: bajo.replace(",", "."),
    });
    setGuardando(false);
    if (r.ok) onCerrar();
    else setError(r.error);
  };

  const borrar = async () => {
    setGuardando(true);
    setError(null);
    const r = await onBorrar(mes);
    setGuardando(false);
    if (r.ok) onCerrar();
    else setError(r.error);
  };

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 p-4"
      onClick={onCerrar}
    >
      <div
        className="w-full max-w-md rounded-xl border border-zinc-800 bg-[#171717] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-zinc-800 px-5 py-4">
          <h3 className="text-sm font-semibold text-zinc-100">
            Objetivos del ranking — {proceso}
          </h3>
          <p className="mt-1 text-[11px] text-zinc-500">
            Se cargan <strong className="text-zinc-400">en items</strong> del mes por operario: 5300 = 5.300 items.
          </p>
        </div>

        <div className="space-y-4 px-5 py-4">
          <label className="block">
            <span className="text-xs font-medium text-zinc-300">Mes</span>
            <select
              value={mes}
              onChange={(e) => setMes(e.target.value)}
              className="mt-1.5 w-full rounded-lg border border-zinc-700 bg-[#1f1f1f] px-3 py-2 text-sm text-zinc-100 outline-none focus:border-yellow-400 cursor-pointer"
            >
              {meses.map((m) => (
                <option key={m} value={m}>
                  {nombreDe(m)}
                  {objetivos[m] ? " · cargado" : ""}
                </option>
              ))}
            </select>
          </label>

          <CampoObjetivo
            label="Sobresaliente"
            color={C.brand}
            valor={sobresaliente}
            setValor={setSobresaliente}
            ayuda="Opcional. Tiene que ser mayor que el objetivo."
          />
          <CampoObjetivo
            label="Objetivo"
            color={C.green}
            valor={objetivo}
            setValor={setObjetivo}
            ayuda="Obligatorio. La línea contra la que se mide si cumplieron."
          />
          <CampoObjetivo
            label="Bajo rendimiento"
            color={C.red}
            valor={bajo}
            setValor={setBajo}
            ayuda="Opcional. Piso: tiene que ser menor que el objetivo."
          />

          {error && (
            <div className="rounded-lg border border-red-400/40 bg-red-400/5 px-3 py-2 text-xs text-red-300">
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-zinc-800 px-5 py-3">
          {yaCargado ? (
            <button
              type="button"
              onClick={borrar}
              disabled={guardando}
              className="text-xs text-zinc-500 hover:text-red-400 transition-colors disabled:opacity-40"
            >
              Quitar objetivo del mes
            </button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onCerrar}
              disabled={guardando}
              className="rounded-lg px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-100 transition-colors disabled:opacity-40"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={guardar}
              disabled={guardando || !objetivo}
              className="rounded-lg bg-yellow-400 px-4 py-1.5 text-xs font-semibold text-black hover:bg-yellow-300 transition-colors disabled:opacity-40"
            >
              {guardando ? "Guardando…" : "Guardar"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── TIEMPO DE PEDIDOS (lead-time) ───────────────────────────────────────────
const aHs = (v: number) => {
  if (!Number.isFinite(v) || v <= 0) return "0hs";
  const h = Math.floor(v);
  const m = Math.round((v - h) * 60);
  return m === 0 ? `${h}hs` : `${h}:${String(m).padStart(2, "0")}hs`;
};
const S3: Serie[] = [
  {
    key: "regAConf",
    name: "Registro → Confirmación",
    color: PALETTE[0],
    stackId: "a",
  },
  {
    key: "confAArm",
    name: "Confirmación → Armado",
    color: PALETTE[3],
    stackId: "a",
  },
  {
    key: "armACierre",
    name: "Armado → Cierre",
    color: PALETTE[2],
    stackId: "a",
  },
];
const S2: Serie[] = [
  {
    key: "regASusp",
    name: "Registro → Suspensión",
    color: PALETTE[0],
    stackId: "a",
  },
  {
    key: "suspAConf",
    name: "Suspensión → Confirmación",
    color: PALETTE[3],
    stackId: "a",
  },
];

export function TiempoTab({ d, mes }: { d: TiempoData; mes: string }) {
  const key = mes === "__all__" ? (d.meses[d.meses.length - 1] ?? "") : mes;
  const idx = d.meses.indexOf(key); // -1 = mes sin datos
  const ult = idx >= 0 ? d.metricas[idx] : null;
  const nombreMes = idx >= 0 ? d.metricas[idx].clave : fmtMes(mes);
  const priData = idx >= 0 ? (d.porPrioridadPorMes?.[key] ?? []) : [];
  const priTabla = idx >= 0 ? (d.prioridadesPorMes?.[key] ?? []) : [];

  return (
    <div>
      <PageTitle
        title="Tiempo de Pedidos"
        sub="Lead-time entre etapas (Registro → Confirmación → Armado → Cierre) — pedidos mayoristas facturados"
      />
      {ult && (
        <Grid cols={5}>
          <KPI
            label={`Registro → Cierre · ${nombreMes}`}
            value={ult ? aHs(ult.totalPag1) : "—"}
            accent="yellow"
          />
          <KPI
            label="Registro → Confirmación"
            value={ult ? aHs(ult.regAConf) : "—"}
            accent="green"
          />
          <KPI
            label="Confirmación → Armado"
            value={ult ? aHs(ult.confAArm) : "—"}
            sub="cuello de botella"
            accent="amber"
          />
          <KPI
            label="Armado → Cierre"
            value={ult ? aHs(ult.armACierre) : "—"}
            accent="neutral"
          />
          <KPI
            label="Pedidos (mes)"
            value={ult ? fmtNum(ult.ops) : "—"}
            accent="neutral"
          />
        </Grid>
      )}

      <SectionTitle>⏱️ Tiempos entre Etapas por Mes</SectionTitle>
      <Panel
        title="Registro → Confirmación → Armado → Cierre"
        accent="(promedio, horas apiladas)"
      >
        <ChartBar
          data={d.metricas}
          xKey="clave"
          height={300}
          series={S3}
          fmt={aHs}
        />
      </Panel>
      <div className="mt-4">
        <Table<EtapaRow>
          cols={[
            { key: "clave", label: "Mes" },
            {
              key: "regAConf",
              label: "Reg→Conf",
              num: true,
              render: (r) => aHs(r.regAConf),
            },
            {
              key: "confAArm",
              label: "Conf→Armado",
              num: true,
              render: (r) => aHs(r.confAArm),
            },
            {
              key: "armACierre",
              label: "Armado→Cierre",
              num: true,
              render: (r) => aHs(r.armACierre),
            },
            {
              key: "totalPag1",
              label: "Total",
              num: true,
              render: (r) => aHs(r.totalPag1),
            },
            {
              key: "ops",
              label: "Pedidos",
              num: true,
              render: (r) => fmtNum(r.ops),
            },
          ]}
          rows={d.metricas}
        />
      </div>

      <SectionTitle>⏸️ Flujo con Suspensión por Mes</SectionTitle>
      <Panel
        title="Registro → Suspensión → Confirmación"
        accent="(promedio, horas apiladas)"
      >
        <ChartBar
          data={d.metricas}
          xKey="clave"
          height={240}
          series={S2}
          fmt={aHs}
        />
      </Panel>

      <SectionTitle>🎯 Por Prioridad — {nombreMes}</SectionTitle>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel title="Tiempos por prioridad" accent="(Registro → Cierre)">
          <ChartBar
            data={priData}
            xKey="clave"
            height={280}
            series={S3}
            fmt={aHs}
          />
        </Panel>
        <Panel title="Resumen de prioridades" accent="(Confirmación → Cierre)">
          <Table<TiempoData["prioridades"][number]>
            cols={[
              {
                key: "prioridad",
                label: "Prioridad",
                render: (r) => `Prioridad ${r.prioridad}`,
              },
              {
                key: "cantidad",
                label: "Pedidos",
                num: true,
                render: (r) => fmtNum(r.cantidad),
              },
              {
                key: "tiempoPromedio",
                label: "Tiempo prom.",
                num: true,
                render: (r) => aHs(r.tiempoPromedio),
              },
            ]}
            rows={priTabla}
          />
        </Panel>
      </div>
    </div>
  );
}
