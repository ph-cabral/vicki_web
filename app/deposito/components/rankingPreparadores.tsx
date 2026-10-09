"use client";
// Pestaña "Ranking preparadores" de /deposito — salió de la vista Comparativa
// de /deposito/pedidos (2026-10-09). Mismas fuentes que esa vista:
//   OTs preparadas = /api/deposito/wms?todos=true (solo Picking productivo)
//   Ingresados     = /api/deposito/ingresados (total del período en el título)
import { useState, useEffect, useMemo } from "react";
import { CalendarDays, CalendarRange, Calendar, Loader2, AlertTriangle } from "lucide-react";
import { SectionTitle, Panel, ChartBar, Table, fmtNum } from "./ui";
import { esFilaProductiva } from "@/lib/deposito/parseDeposito";
import {
  type Row, type Rec, type IngRec, type Gran,
  bucketOf, clip, parseRow, parseIng,
} from "./pedidosUtil";

interface RankRow { op: string; ots: number; items: number }

const GRANS: { v: Gran; label: string; icon: typeof Calendar }[] = [
  { v: "dia", label: "Diario", icon: CalendarDays },
  { v: "sem", label: "Semanal", icon: CalendarRange },
  { v: "mes", label: "Mensual", icon: Calendar },
];

export function RankingPreparadoresTab({ desde, hasta }: { desde: string; hasta: string }) {
  const [gran, setGran] = useState<Gran>("sem");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [ingRows, setIngRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!desde || !hasta) return;
    let cancel = false;
    (async () => {
      setLoading(true); setError(null);
      const errs: string[] = [];
      try {
        const [wRes, iRes] = await Promise.all([
          fetch(`/api/deposito/wms?desde=${desde}&hasta=${hasta}&todos=true`, { cache: "no-store" }),
          fetch(`/api/deposito/ingresados?desde=${desde}&hasta=${hasta}`, { cache: "no-store" }),
        ]);
        const wj = (await wRes.json().catch(() => ({}))) as { rows?: Row[]; error?: string };
        if (!wRes.ok) throw new Error(wj.error || `WMS HTTP ${wRes.status}`);
        if (!cancel)
          setRows(
            (wj.rows ?? []).filter(
              (x) =>
                String(x["PROCESO"] ?? "") === "Picking" &&
                esFilaProductiva(x["OPERARIO"], x["PROCESO"]),
            ),
          );
        const ij = (await iRes.json().catch(() => ({}))) as { rows?: Row[]; error?: string };
        if (!iRes.ok) errs.push("Ingresados: " + (ij.error || `HTTP ${iRes.status}`));
        else if (!cancel) setIngRows(ij.rows ?? []);
      } catch (e) {
        errs.push(e instanceof Error ? e.message : "Error al cargar");
        if (!cancel) setRows([]);
      } finally {
        if (!cancel) { setError(errs.length ? errs.join(" · ") : null); setLoading(false); }
      }
    })();
    return () => { cancel = true; };
  }, [desde, hasta]);

  const recs = useMemo(() => (rows ?? []).map(parseRow).filter((x): x is Rec => x !== null), [rows]);
  const ingRecs = useMemo(() => ingRows.map(parseIng).filter((x): x is IngRec => x !== null), [ingRows]);
  const granLabel = gran === "mes" ? "mes" : gran === "sem" ? "semana" : "día";

  const { ranking, nBuckets } = useMemo(() => {
    const opTot = new Map<string, { ots: number; items: number }>();
    const keys = new Set<string>();
    for (const r of recs) {
      keys.add(bucketOf(r.d, gran).key);
      const o = opTot.get(r.op) ?? { ots: 0, items: 0 }; o.ots++; o.items += r.items; opTot.set(r.op, o);
    }
    const ranking: RankRow[] = [...opTot.entries()]
      .map(([op, v]) => ({ op, ots: v.ots, items: v.items }))
      .sort((a, b) => b.ots - a.ots);
    return { ranking, nBuckets: keys.size };
  }, [recs, gran]);

  const totIng = ingRecs.reduce((a, r) => a + r.pedidos, 0);

  return (
    <>
      {error && (
        <div className="flex items-center gap-2 text-red-400 text-sm mb-3">
          <AlertTriangle size={16} /> {error}
        </div>
      )}

      <div className="inline-flex rounded-lg border border-zinc-700 overflow-hidden mb-2">
        {GRANS.map(({ v, label, icon: Icon }) => (
          <button key={v} onClick={() => setGran(v)}
            className={`flex items-center gap-1.5 px-3.5 py-1.5 text-sm transition-colors ${
              gran === v ? "bg-yellow-400 text-black font-semibold" : "bg-[#1f1f1f] text-zinc-400 hover:text-zinc-100"
            }`}>
            <Icon size={15} />{label}
          </button>
        ))}
      </div>

      {!recs.length ? (
        <div className="flex flex-col items-center justify-center py-28 gap-3 text-center">
          {loading ? <Loader2 size={40} className="text-yellow-400 animate-spin" />
            : <CalendarRange size={44} className="text-zinc-700" />}
          <p className="text-zinc-400 font-medium">
            {loading ? "Consultando la base…" : "Sin datos en el rango seleccionado"}
          </p>
        </div>
      ) : (
        <>
          <SectionTitle>
            Ranking de preparadores · <span className="text-yellow-400 font-bold">{fmtNum(totIng)}</span> pedidos ingresados en el período
          </SectionTitle>
          <Panel>
            <ChartBar data={ranking.map((r) => ({ op: clip(r.op), ots: r.ots }))} xKey="op"
              height={Math.max(220, ranking.length * 38)} horizontal colorByIndex
              series={[{ key: "ots", name: "OTs" }]} fmt={(n) => fmtNum(n)} showValues />
          </Panel>

          <SectionTitle>Detalle por preparador</SectionTitle>
          <Table<RankRow>
            cols={[
              { key: "op", label: "Preparador" },
              { key: "ots", label: "OTs", num: true, render: (r) => fmtNum(r.ots) },
              { key: "items", label: "Ítems", num: true, render: (r) => fmtNum(r.items) },
              { key: "otsb", label: `OTs/${granLabel}`, num: true, render: (r) => fmtNum(nBuckets ? r.ots / nBuckets : 0, 1) },
              { key: "ipo", label: "Ítems/OT", num: true, render: (r) => fmtNum(r.ots ? r.items / r.ots : 0, 1) },
            ]}
            rows={ranking} max={50} maxH={460}
          />
        </>
      )}
    </>
  );
}
