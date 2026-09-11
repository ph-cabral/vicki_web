"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import {
  Loader2, AlertTriangle, ChevronRight, ChevronDown, Search,
} from "lucide-react";
import { PageTitle, KPI, Grid, SectionTitle } from "./ui";
import { esFilaProductiva } from "@/lib/deposito/parseDeposito";

// Tab "Tiempos de Picking" de /deposito.
//
// Dos lecturas de la MISMA fuente (WMS.dbo.OTItem, PickIni/PickFin por renglón):
//   1. Mapa de calor de pickeos por hora, con tres ejes conmutables (operario,
//      día de semana, día del mes). Se resuelve con UNA sola consulta al grano
//      fecha × operario × hora: cambiar de eje no vuelve a la base.
//   2. Tabla de OT con hora de inicio y fin; al abrir una fila se piden sus
//      renglones (artículo, ubicación, inicio, fin, segundos).
//
// El recorte de operarios usa esFilaProductiva() de parseDeposito.ts, la misma
// regla que el tab Picking, para que los ítems cierren entre pantallas.

interface HeatRow {
  FECHA: string;        // dd/mm/yyyy
  OPERARIO: string | null;
  HORA: number;
  ITEMS: number;
  RECOLECTADOS: number;
  SEG_TOTAL: number;
  CRONOMETRADOS: number;
  LARGOS: number;
}

interface OtRow {
  OT: number;
  FECHA: string;
  OPERARIO: string | null;
  INICIO: string | null;   // hh:mm:ss
  FIN: string | null;
  SEG_SPAN: number | null;
  ITEMS: number;
  RECOLECTADOS: number;
  SEG_ITEMS: number;
  CRONOMETRADOS: number;
  LARGOS: number;
  CLIENTE: string;
  PEDIDO: number | null;
}

interface ItemRow {
  RENGLON: number;
  ARTICULO: string;
  DESCRIPCION: string;
  UBICACION: string;
  PEDIDA: number;
  CUMPLIDA: number;
  INICIO: string | null;
  FIN: string | null;
  SEG: number | null;
}

type Eje = "operario" | "semana" | "dia";

const DIAS = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];

// ─── Helpers ─────────────────────────────────────────────────────────────────
function fechaADate(f: string): Date | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec((f ?? "").trim());
  if (!m) return null;
  return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
}

/** 95 → "1:35"; 3720 → "1h 02m". Para duraciones de renglón y de OT. */
function fmtSeg(s: number | null | undefined): string {
  if (s == null || !Number.isFinite(s) || s < 0) return "—";
  if (s < 3600) {
    const m = Math.floor(s / 60);
    return `${m}:${String(Math.round(s % 60)).padStart(2, "0")}`;
  }
  const h = Math.floor(s / 3600);
  return `${h}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}
const fmtN = (n: number) => n.toLocaleString("es-AR");
const hhmm = (s: string | null) => (s ? s.slice(0, 5) : "—");

// Escala secuencial de un solo tono (el amarillo de marca) sobre fondo oscuro:
// a más pickeos, más brillante. 5 pasos + el 0, que queda como celda vacía.
// Los cortes son lineales sobre el máximo del mapa y se muestran en la leyenda,
// así el lector sabe qué significa cada tono sin tener que adivinarlo.
const PASOS = [0.2, 0.4, 0.6, 0.8];
const TONOS = [
  "rgba(250,204,21,0.16)",
  "rgba(250,204,21,0.32)",
  "rgba(250,204,21,0.52)",
  "rgba(250,204,21,0.76)",
  "rgb(250,204,21)",
];
function nivel(v: number, max: number): number {
  if (v <= 0 || max <= 0) return -1;
  const r = v / max;
  for (let i = 0; i < PASOS.length; i++) if (r <= PASOS[i]) return i;
  return 4;
}

// Cada celda guarda el total de ítems y las "horas-operario" que lo produjeron
// (pares fecha|operario con actividad en esa franja). Lo que se muestra es
// items / horas-operario = ítems por hora de un operario, la misma unidad en los
// tres ejes: en "por operario" es su promedio por hora trabajada en la franja; en
// los ejes por día, el promedio por operario de los que pickearon en esa hora.
interface Celda { items: number; recol: number; seg: number; cron: number; hs: Set<string> }
const celdaVacia = (): Celda => ({ items: 0, recol: 0, seg: 0, cron: 0, hs: new Set() });
const porHora = (items: number, hs: number) => (hs > 0 ? items / hs : 0);
const fmtRate = (v: number) => (v > 0 ? fmtN(Math.round(v)) : "");
// El nombre de Personal es char con padding: se compara siempre trimeado.
const nom = (s: string | null | undefined) => (s ?? "").trim();

export function TiemposPickingTab({
  desde, hasta, operario,
}: {
  desde: string;
  hasta: string;
  operario: string;
}) {
  const [heat, setHeat] = useState<HeatRow[] | null>(null);
  const [ots, setOts] = useState<OtRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [eje, setEje] = useState<Eje>("operario");
  const [abierta, setAbierta] = useState<number | null>(null);
  const [items, setItems] = useState<Record<number, ItemRow[]>>({});
  const [cargandoItems, setCargandoItems] = useState<number | null>(null);
  const [busq, setBusq] = useState("");
  const [orden, setOrden] = useState<{ col: string; desc: boolean }>({ col: "OT", desc: true });
  const [tope, setTope] = useState(150);

  useEffect(() => {
    if (!desde || !hasta) return;
    let cancelado = false;
    setLoading(true);
    setError(null);
    const qs = `desde=${desde}&hasta=${hasta}`;
    Promise.all([
      fetch(`/api/deposito/picking-horas?${qs}`, { cache: "no-store" }).then((r) => r.json()),
      fetch(`/api/deposito/picking-ots?${qs}`, { cache: "no-store" }).then((r) => r.json()),
    ])
      .then(([h, o]) => {
        if (cancelado) return;
        if (h?.error || o?.error) throw new Error(h?.error || o?.error);
        setHeat((h.rows ?? []) as HeatRow[]);
        setOts((o.rows ?? []) as OtRow[]);
        setAbierta(null);
        setItems({});
        setTope(150);
      })
      .catch((e) => !cancelado && setError(e instanceof Error ? e.message : "Error de consulta"))
      .finally(() => !cancelado && setLoading(false));
    return () => { cancelado = true; };
  }, [desde, hasta]);

  // Mismo recorte que el tab Picking (gerentes/no-operativos afuera) + el
  // operario elegido en el header.
  const heatFilt = useMemo(
    () =>
      (heat ?? []).filter(
        (r) =>
          esFilaProductiva(r.OPERARIO, "Picking") &&
          (operario === "__all__" || nom(r.OPERARIO) === nom(operario)),
      ),
    [heat, operario],
  );
  const otsFilt = useMemo(
    () =>
      (ots ?? []).filter(
        (r) =>
          esFilaProductiva(r.OPERARIO, "Picking") &&
          (operario === "__all__" || nom(r.OPERARIO) === nom(operario)),
      ),
    [ots, operario],
  );

  // ─── Armado del mapa: filas según el eje elegido, columnas = horas ─────────
  const mapa = useMemo(() => {
    const horas = new Set<number>();
    const filas = new Map<string, Map<number, Celda>>();
    const ordenFila = new Map<string, number>();

    for (const r of heatFilt) {
      const f = fechaADate(r.FECHA);
      let clave: string;
      let peso: number;
      if (eje === "operario") {
        clave = nom(r.OPERARIO) || "—";
        peso = 0;
      } else if (eje === "semana") {
        if (!f) continue;
        clave = DIAS[f.getDay()];
        peso = f.getDay() === 0 ? 7 : f.getDay(); // lunes primero, domingo último
      } else {
        if (!f) continue;
        clave = r.FECHA;
        peso = f.getTime();
      }
      horas.add(r.HORA);
      if (!filas.has(clave)) filas.set(clave, new Map());
      ordenFila.set(clave, peso);
      const fila = filas.get(clave)!;
      const c = fila.get(r.HORA) ?? celdaVacia();
      c.items += r.ITEMS;
      c.recol += r.RECOLECTADOS;
      c.seg += r.SEG_TOTAL;
      c.cron += r.CRONOMETRADOS;
      c.hs.add(`${r.FECHA}|${nom(r.OPERARIO)}`);
      fila.set(r.HORA, c);
    }

    const cols = [...horas].sort((a, b) => a - b);
    let claves = [...filas.keys()];
    if (eje === "operario") {
      // por volumen: el que más pickea, arriba
      const tot = (k: string) =>
        [...(filas.get(k)?.values() ?? [])].reduce((s, c) => s + c.recol, 0);
      claves.sort((a, b) => tot(b) - tot(a));
    } else {
      claves.sort((a, b) => (ordenFila.get(a) ?? 0) - (ordenFila.get(b) ?? 0));
    }

    // Las horas-operario de filas distintas nunca se pisan (otro operario u otra
    // fecha), así que los totales se arman sumando tamaños de los sets.
    let max = 0;
    const totalFila = new Map<string, { items: number; hs: number }>();
    const totalCol = new Map<number, { items: number; hs: number }>();
    const total = { items: 0, hs: 0 };
    for (const [k, fila] of filas) {
      const tf = { items: 0, hs: 0 };
      for (const [h, c] of fila) {
        const v = porHora(c.recol, c.hs.size);
        if (v > max) max = v;
        tf.items += c.recol; tf.hs += c.hs.size;
        const tc = totalCol.get(h) ?? { items: 0, hs: 0 };
        tc.items += c.recol; tc.hs += c.hs.size;
        totalCol.set(h, tc);
      }
      totalFila.set(k, tf);
      total.items += tf.items; total.hs += tf.hs;
    }

    return { cols, claves, filas, max, totalFila, totalCol, total };
  }, [heatFilt, eje]);

  // ─── KPIs del rango ────────────────────────────────────────────────────────
  const kpis = useMemo(() => {
    let items = 0, recol = 0, seg = 0, cron = 0, largos = 0;
    const porHora = new Map<number, number>();
    for (const r of heatFilt) {
      items += r.ITEMS; recol += r.RECOLECTADOS;
      seg += r.SEG_TOTAL; cron += r.CRONOMETRADOS; largos += r.LARGOS;
      porHora.set(r.HORA, (porHora.get(r.HORA) ?? 0) + r.ITEMS);
    }
    let pico = -1, picoItems = 0;
    for (const [h, v] of porHora) if (v > picoItems) { pico = h; picoItems = v; }
    const spans = otsFilt.reduce((s, o) => s + (o.SEG_SPAN && o.SEG_SPAN > 0 ? o.SEG_SPAN : 0), 0);
    const segItems = otsFilt.reduce((s, o) => s + o.SEG_ITEMS, 0);
    return {
      items, recol, largos,
      prom: cron > 0 ? seg / cron : null,
      sinCron: items - cron - largos,
      pico, picoItems,
      ots: otsFilt.length,
      muerto: spans > 0 ? 1 - segItems / spans : null,
    };
  }, [heatFilt, otsFilt]);

  // ─── Tabla de OT ───────────────────────────────────────────────────────────
  const otsVista = useMemo(() => {
    const q = busq.trim().toLowerCase();
    const base = q
      ? otsFilt.filter(
          (o) =>
            String(o.OT).includes(q) ||
            (o.OPERARIO ?? "").toLowerCase().includes(q) ||
            o.CLIENTE.toLowerCase().includes(q) ||
            String(o.PEDIDO ?? "").includes(q),
        )
      : otsFilt;
    const val = (o: OtRow): number => {
      switch (orden.col) {
        case "SPAN": return o.SEG_SPAN ?? 0;
        case "ITEMS": return o.ITEMS;
        case "PROM": return o.CRONOMETRADOS > 0 ? o.SEG_ITEMS / o.CRONOMETRADOS : 0;
        default: return o.OT;
      }
    };
    return [...base].sort((a, b) => (orden.desc ? val(b) - val(a) : val(a) - val(b)));
  }, [otsFilt, busq, orden]);

  const abrir = useCallback(
    async (ot: number) => {
      if (abierta === ot) { setAbierta(null); return; }
      setAbierta(ot);
      if (items[ot]) return;
      setCargandoItems(ot);
      try {
        const r = await fetch(`/api/deposito/picking-ot-items?ot=${ot}`, { cache: "no-store" });
        const j = await r.json();
        setItems((prev) => ({ ...prev, [ot]: (j.rows ?? []) as ItemRow[] }));
      } catch {
        setItems((prev) => ({ ...prev, [ot]: [] }));
      } finally {
        setCargandoItems(null);
      }
    },
    [abierta, items],
  );

  const th = (col: string, label: string) => (
    <th
      onClick={() => setOrden((o) => ({ col, desc: o.col === col ? !o.desc : true }))}
      className="px-2.5 py-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500 whitespace-nowrap border-b border-zinc-800 text-right cursor-pointer hover:text-zinc-300 select-none"
    >
      {label}{orden.col === col ? (orden.desc ? " ↓" : " ↑") : ""}
    </th>
  );

  if (loading && !heat) {
    return (
      <div className="flex flex-col items-center justify-center py-28 gap-4">
        <Loader2 size={40} className="text-yellow-400 animate-spin" />
        <p className="text-zinc-400 font-medium">Consultando tiempos de picking…</p>
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex items-center gap-3 rounded-lg bg-[#171717] border border-red-400/40 px-5 py-4 text-sm text-red-300">
        <AlertTriangle size={16} className="text-red-400" /> {error}
      </div>
    );
  }

  return (
    <div>
      <PageTitle
        title="Tiempos de Picking"
        sub="Hora real de cada renglón levantado (WMS · PickIni/PickFin por ítem) — mapa de calor por franja horaria y detalle de cada OT"
      />

      <Grid cols={5}>
        <KPI label="Ítems pickeados" value={fmtN(kpis.items)} sub={`${fmtN(kpis.recol)} con cantidad cumplida`} />
        <KPI
          label="Promedio por ítem"
          value={kpis.prom == null ? "—" : fmtSeg(kpis.prom)}
          sub="renglones de hasta 10 min"
          accent="green"
        />
        <KPI
          label="Hora pico"
          value={kpis.pico < 0 ? "—" : `${String(kpis.pico).padStart(2, "0")}:00`}
          sub={kpis.pico < 0 ? undefined : `${fmtN(kpis.picoItems)} ítems en la franja`}
          accent="amber"
        />
        <KPI label="OT de picking" value={fmtN(kpis.ots)} accent="neutral" />
        <KPI
          label="Tiempo entre ítems"
          value={kpis.muerto == null ? "—" : `${Math.round(kpis.muerto * 100)}%`}
          sub="del reloj de la OT no es picking de renglón"
          accent="neutral"
        />
      </Grid>

      {/* ─── Mapa de calor ─────────────────────────────────────────────── */}
      <SectionTitle>Pickeos por hora</SectionTitle>

      <div className="flex items-center gap-2 mb-3 flex-wrap">
        {([
          ["operario", "Por operario"],
          ["semana", "Por día de semana"],
          ["dia", "Por día del mes"],
        ] as [Eje, string][]).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setEje(id)}
            className={`px-3 py-1.5 rounded-lg text-[12px] font-medium border transition-colors ${
              eje === id
                ? "bg-yellow-400/10 border-yellow-400/40 text-yellow-400"
                : "bg-[#1f1f1f] border-zinc-800 text-zinc-400 hover:text-zinc-200"
            }`}
          >
            {label}
          </button>
        ))}
        <span className="flex-1" />
        <div className="flex items-center gap-2 text-[11px] text-zinc-500">
          <span>Menos</span>
          <span className="w-4 h-4 rounded-[3px] border border-zinc-800 bg-[#161616]" />
          {TONOS.map((t) => (
            <span key={t} className="w-4 h-4 rounded-[3px]" style={{ background: t }} />
          ))}
          <span>Más</span>
          {mapa.max > 0 && <span className="text-zinc-600">· máx {fmtN(Math.round(mapa.max))} recolectados/h</span>}
        </div>
      </div>

      <div className="rounded-lg bg-[#171717] border border-zinc-800 overflow-auto">
        {mapa.claves.length === 0 ? (
          <p className="px-4 py-8 text-center text-zinc-600 text-sm">
            Sin pickeos en el rango seleccionado
          </p>
        ) : (
          <table className="w-full text-[12px] border-separate border-spacing-0">
            <thead>
              <tr className="bg-[#1f1f1f]">
                <th className="sticky left-0 z-20 bg-[#1f1f1f] px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-zinc-500 border-b border-zinc-800 min-w-[150px]">
                  {eje === "operario" ? "Operario" : eje === "semana" ? "Día" : "Fecha"}
                </th>
                {mapa.cols.map((h) => (
                  <th
                    key={h}
                    className="px-1 py-2 text-[10px] font-semibold text-zinc-500 border-b border-zinc-800 tabular-nums w-[46px]"
                  >
                    {String(h).padStart(2, "0")}
                  </th>
                ))}
                <th className="px-2 py-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500 border-b border-zinc-800 text-right whitespace-nowrap">
                  Prom./h
                </th>
                <th className="px-2 py-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500 border-b border-zinc-800 text-right">
                  Recolect.
                </th>
              </tr>
            </thead>
            <tbody>
              {mapa.claves.map((k) => {
                const fila = mapa.filas.get(k)!;
                const tf = mapa.totalFila.get(k)!;
                return (
                  <tr key={k} className="group">
                    <td className="sticky left-0 z-10 bg-[#171717] group-hover:bg-[#1f1f1f] px-3 py-1 text-zinc-300 border-b border-zinc-800/60 whitespace-nowrap transition-colors">
                      {k}
                    </td>
                    {mapa.cols.map((h) => {
                      const c = fila.get(h);
                      const v = c ? porHora(c.recol, c.hs.size) : 0;
                      const n = nivel(v, mapa.max);
                      const prom = c && c.cron > 0 ? c.seg / c.cron : null;
                      const hsTxt = c
                        ? eje === "operario"
                          ? `${fmtN(c.hs.size)} ${c.hs.size === 1 ? "día" : "días"} con pickeos en la franja`
                          : `${fmtN(c.hs.size)} horas-operario en la franja`
                        : "";
                      return (
                        <td key={h} className="p-[2px] border-b border-zinc-800/60">
                          <div
                            title={
                              c
                                ? `${k} · ${String(h).padStart(2, "0")}:00\n${fmtRate(v)} recolectados por hora\n${fmtN(c.recol)} recolectados de ${fmtN(c.items)} pickeados · ${hsTxt}\n${prom ? `${fmtSeg(prom)} promedio por ítem` : "sin tiempos cronometrados"}`
                                : `${k} · ${String(h).padStart(2, "0")}:00 — sin pickeos`
                            }
                            className={`h-7 rounded-[3px] flex items-center justify-center tabular-nums text-[11px] ${
                              n < 0
                                ? "bg-[#161616] text-zinc-700"
                                : n === 4
                                  ? "text-black font-semibold"
                                  : "text-zinc-100"
                            }`}
                            style={n >= 0 ? { background: TONOS[n] } : undefined}
                          >
                            {fmtRate(v)}
                          </div>
                        </td>
                      );
                    })}
                    <td className="px-2 py-1 text-right tabular-nums text-zinc-200 font-medium border-b border-zinc-800/60">
                      {fmtRate(porHora(tf.items, tf.hs))}
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums text-zinc-500 border-b border-zinc-800/60">
                      {fmtN(tf.items)}
                    </td>
                  </tr>
                );
              })}
              <tr>
                <td className="sticky left-0 z-10 bg-[#1f1f1f] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                  Total
                </td>
                {mapa.cols.map((h) => {
                  const tc = mapa.totalCol.get(h);
                  return (
                    <td
                      key={h}
                      title={tc ? `${fmtN(tc.items)} recolectados en total · ${fmtN(tc.hs)} horas-operario` : undefined}
                      className="bg-[#1f1f1f] px-1 py-1.5 text-center tabular-nums text-[11px] text-zinc-400"
                    >
                      {tc ? fmtRate(porHora(tc.items, tc.hs)) : ""}
                    </td>
                  );
                })}
                <td className="bg-[#1f1f1f] px-2 py-1.5 text-right tabular-nums text-[11px] text-yellow-400 font-semibold">
                  {fmtRate(porHora(mapa.total.items, mapa.total.hs))}
                </td>
                <td className="bg-[#1f1f1f] px-2 py-1.5 text-right tabular-nums text-[11px] text-zinc-300 font-semibold">
                  {fmtN(mapa.total.items)}
                </td>
              </tr>
            </tbody>
          </table>
        )}
      </div>

      <p className="text-[11px] text-zinc-600 mt-2">
        Cada celda es ítems recolectados (cantidad cumplida &gt; 0) por hora de un operario:
        recolectados de la franja ÷ horas-operario con pickeos (en &quot;Por operario&quot;, los
        días que trabajó esa hora) — mismo criterio que la matriz de Pedidos Preparados.
      </p>
      {kpis.sinCron > 0 && (
        <p className="text-[11px] text-zinc-600 mt-1">
          {fmtN(kpis.sinCron)} renglones sin tiempos del handheld (se ubican en la hora de
          ejecución de la OT){kpis.largos > 0 && ` · ${fmtN(kpis.largos)} de más de 10 min quedan fuera del promedio`}.
        </p>
      )}

      {/* ─── Detalle por OT ────────────────────────────────────────────── */}
      <SectionTitle>Inicio y fin de cada OT</SectionTitle>

      <div className="flex items-center gap-2 mb-3">
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-600" />
          <input
            value={busq}
            onChange={(e) => setBusq(e.target.value)}
            placeholder="OT, pedido, cliente u operario…"
            className="bg-[#1f1f1f] border border-zinc-800 rounded-lg pl-8 pr-3 py-1.5 text-[12px] text-zinc-100 focus:border-yellow-400 outline-none w-72"
          />
        </div>
        <span className="text-[11px] text-zinc-600">
          {fmtN(otsVista.length)} OT · clic en una fila para ver los renglones
        </span>
      </div>

      <div className="rounded-lg bg-[#171717] border border-zinc-800 overflow-auto">
        <table className="w-full text-[12px]">
          <thead className="sticky top-0 z-10">
            <tr className="bg-[#1f1f1f]">
              <th className="w-6 border-b border-zinc-800" />
              {th("OT", "OT")}
              <th className="px-2.5 py-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500 border-b border-zinc-800 text-left">Fecha</th>
              <th className="px-2.5 py-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500 border-b border-zinc-800 text-left">Operario</th>
              <th className="px-2.5 py-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500 border-b border-zinc-800 text-left">Cliente</th>
              <th className="px-2.5 py-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500 border-b border-zinc-800 text-right">Inicio</th>
              <th className="px-2.5 py-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500 border-b border-zinc-800 text-right">Fin</th>
              {th("SPAN", "Duración")}
              {th("ITEMS", "Ítems")}
              {th("PROM", "Prom./ítem")}
            </tr>
          </thead>
          <tbody>
            {otsVista.slice(0, tope).map((o) => {
              const prom = o.CRONOMETRADOS > 0 ? o.SEG_ITEMS / o.CRONOMETRADOS : null;
              const open = abierta === o.OT;
              return (
                <Fragment key={o.OT}>
                  <tr
                    onClick={() => abrir(o.OT)}
                    className={`border-b border-zinc-800/60 cursor-pointer transition-colors ${open ? "bg-[#1f1f1f]" : "hover:bg-[#1f1f1f]"}`}
                  >
                    <td className="pl-2 text-zinc-600">
                      {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    </td>
                    <td className="px-2.5 py-1.5 text-right tabular-nums text-zinc-200">{o.OT}</td>
                    <td className="px-2.5 py-1.5 text-zinc-400 whitespace-nowrap">{o.FECHA}</td>
                    <td className="px-2.5 py-1.5 text-zinc-300 whitespace-nowrap">{o.OPERARIO ?? "—"}</td>
                    <td className="px-2.5 py-1.5 text-zinc-500 max-w-[220px] truncate" title={o.CLIENTE}>
                      {o.CLIENTE || "—"}
                    </td>
                    <td className="px-2.5 py-1.5 text-right tabular-nums text-zinc-200">{hhmm(o.INICIO)}</td>
                    <td className="px-2.5 py-1.5 text-right tabular-nums text-zinc-200">{hhmm(o.FIN)}</td>
                    <td className="px-2.5 py-1.5 text-right tabular-nums text-zinc-300">{fmtSeg(o.SEG_SPAN)}</td>
                    <td className="px-2.5 py-1.5 text-right tabular-nums text-zinc-300">
                      {fmtN(o.ITEMS)}
                      {o.RECOLECTADOS < o.ITEMS && (
                        <span className="text-zinc-600"> / {fmtN(o.RECOLECTADOS)}</span>
                      )}
                    </td>
                    <td className="px-2.5 py-1.5 text-right tabular-nums text-yellow-400">{fmtSeg(prom)}</td>
                  </tr>
                  {open && (
                    <tr className="border-b border-zinc-800">
                      <td colSpan={10} className="bg-[#141414] px-3 py-3">
                        {cargandoItems === o.OT ? (
                          <div className="flex items-center gap-2 text-zinc-500 text-[12px] py-2">
                            <Loader2 size={14} className="animate-spin text-yellow-400" /> Cargando renglones…
                          </div>
                        ) : (items[o.OT] ?? []).length === 0 ? (
                          <p className="text-zinc-600 text-[12px] py-2">Sin renglones de recolección.</p>
                        ) : (
                          <table className="w-full text-[11.5px]">
                            <thead>
                              <tr className="text-[10px] uppercase tracking-wider text-zinc-600">
                                <th className="text-left font-semibold pb-1.5 pr-3">#</th>
                                <th className="text-left font-semibold pb-1.5 pr-3">Artículo</th>
                                <th className="text-left font-semibold pb-1.5 pr-3">Descripción</th>
                                <th className="text-left font-semibold pb-1.5 pr-3">Ubicación</th>
                                <th className="text-right font-semibold pb-1.5 pr-3">Pedida</th>
                                <th className="text-right font-semibold pb-1.5 pr-3">Cumplida</th>
                                <th className="text-right font-semibold pb-1.5 pr-3">Inicio</th>
                                <th className="text-right font-semibold pb-1.5 pr-3">Fin</th>
                                <th className="text-right font-semibold pb-1.5">Tiempo</th>
                              </tr>
                            </thead>
                            <tbody>
                              {(items[o.OT] ?? []).map((it) => (
                                <tr key={it.RENGLON} className="border-t border-zinc-800/60">
                                  <td className="py-1 pr-3 text-zinc-600 tabular-nums">{it.RENGLON}</td>
                                  <td className="py-1 pr-3 text-zinc-200 font-medium whitespace-nowrap">{it.ARTICULO}</td>
                                  <td className="py-1 pr-3 text-zinc-500 max-w-[320px] truncate" title={it.DESCRIPCION}>
                                    {it.DESCRIPCION || "—"}
                                  </td>
                                  <td className="py-1 pr-3 text-zinc-400 whitespace-nowrap">{it.UBICACION || "—"}</td>
                                  <td className="py-1 pr-3 text-right tabular-nums text-zinc-300">{fmtN(it.PEDIDA)}</td>
                                  <td className={`py-1 pr-3 text-right tabular-nums ${it.CUMPLIDA < it.PEDIDA ? "text-red-400" : "text-zinc-300"}`}>
                                    {fmtN(it.CUMPLIDA)}
                                  </td>
                                  <td className="py-1 pr-3 text-right tabular-nums text-zinc-400">{hhmm(it.INICIO)}</td>
                                  <td className="py-1 pr-3 text-right tabular-nums text-zinc-400">{hhmm(it.FIN)}</td>
                                  <td className="py-1 text-right tabular-nums text-yellow-400">{fmtSeg(it.SEG)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {otsVista.length === 0 && (
              <tr>
                <td colSpan={10} className="px-4 py-8 text-center text-zinc-600 text-sm">
                  Sin OT de picking en el rango seleccionado
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {otsVista.length > tope && (
          <button
            onClick={() => setTope((t) => t + 150)}
            className="w-full px-3 py-2 text-[11px] text-zinc-500 hover:text-yellow-400 border-t border-zinc-800 transition-colors"
          >
            Mostrando {fmtN(tope)} de {fmtN(otsVista.length)} — ver más
          </button>
        )}
      </div>
    </div>
  );
}
