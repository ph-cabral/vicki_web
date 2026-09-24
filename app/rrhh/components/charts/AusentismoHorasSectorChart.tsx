"use client";

// Ausentismo por sector — Horas solicitadas: barras apiladas en horas (una por
// mes, un segmento por área) con el total arriba de cada barra + tarjetas con
// el total del período por sector y el total general.
// Datos: /api/rrhh/asistencia/ausentismo-horas-sector-mes (novedades).
//
// HTML/CSS puro, sin recharts (mismo motivo que AusentismoSectorMesChart).
import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";

type Row = { mes: string; area: string; horas: number };

const MESES = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

// Mismas áreas, etiquetas y paleta que AusentismoSectorMesChart.
const AREAS: Record<string, { label: string; color: string; texto: string }> = {
  industria: { label: "Industria", color: "#8B6500", texto: "#FFFFFF" },
  deposito: { label: "Depósito", color: "#C99700", texto: "#FFFFFF" },
  administracion: { label: "Administración", color: "#F2BE22", texto: "#2B1F00" },
  locales: { label: "Mostradores", color: "#FFDD7A", texto: "#2B1F00" },
  viajante: { label: "Comercial", color: "#FFF0B3", texto: "#2B1F00" },
};
const ORDEN = Object.keys(AREAS);
const EXTRA = [
  { color: "#A1A1AA", texto: "#18181B" },
  { color: "#71717A", texto: "#FFFFFF" },
  { color: "#52525B", texto: "#FFFFFF" },
];

const norm = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();
const capitalizar = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const num = (n: number) =>
  n.toLocaleString("es-AR", { maximumFractionDigits: 1 });
const hs = (n: number) => `${num(n)} ${n === 1 ? "hora" : "horas"}`;

// Techo "redondo" del eje Y para el máximo mensual.
function techo(max: number) {
  if (max <= 0) return 10;
  const pasos = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];
  const paso = pasos.find((p) => max / p <= 4) ?? Math.ceil(max / 4);
  return Math.ceil(max / paso) * paso;
}

type Serie = { key: string; label: string; color: string; texto: string; total: number };

export default function AusentismoHorasSectorChart() {
  const anioActual = new Date().getFullYear();
  const [anio, setAnio] = useState(anioActual);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [foco, setFoco] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setRows(null);
    setError(null);
    fetch(`/api/rrhh/asistencia/ausentismo-horas-sector-mes?anio=${anio}`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? "Error al cargar horas solicitadas");
        return r.json();
      })
      .then((d) => alive && setRows(d.rows ?? []))
      .catch((e) => alive && setError(e instanceof Error ? e.message : "Error al cargar horas solicitadas"));
    return () => {
      alive = false;
    };
  }, [anio]);

  const { series, meses, totalGeneral, primerMes, eje } = useMemo(() => {
    const r = rows ?? [];
    const porArea = new Map<string, { nombre: string; total: number }>();
    const porMes = new Map<string, Map<string, number>>();
    for (const x of r) {
      const k = norm(x.area);
      const a = porArea.get(k) ?? { nombre: x.area, total: 0 };
      a.total += x.horas;
      porArea.set(k, a);
      const m = porMes.get(x.mes) ?? new Map<string, number>();
      m.set(k, (m.get(k) ?? 0) + x.horas);
      porMes.set(x.mes, m);
    }

    const conocidas = ORDEN.filter((k) => porArea.has(k));
    const otras = [...porArea.keys()]
      .filter((k) => !AREAS[k])
      .sort((a, b) => porArea.get(b)!.total - porArea.get(a)!.total);
    const series: Serie[] = [
      ...conocidas.map((k) => ({ key: k, ...AREAS[k], total: porArea.get(k)!.total })),
      ...otras.map((k, i) => ({
        key: k,
        label: capitalizar(porArea.get(k)!.nombre),
        ...EXTRA[i % EXTRA.length],
        total: porArea.get(k)!.total,
      })),
    ];

    // Meses: desde el primero con registros hasta el actual (o diciembre).
    const ultimoMes = anio === anioActual ? new Date().getMonth() + 1 : 12;
    const conDatos = [...porMes.keys()].sort();
    const primerMes = conDatos.length ? Number(conDatos[0].slice(5, 7)) : 1;
    const meses = [];
    for (let m = primerMes; m <= ultimoMes; m++) {
      const ym = `${anio}-${String(m).padStart(2, "0")}`;
      const valores = porMes.get(ym) ?? new Map<string, number>();
      const total = [...valores.values()].reduce((a, b) => a + b, 0);
      meses.push({ ym, label: MESES[m - 1], enCurso: anio === anioActual && m === ultimoMes, total, valores });
    }

    const totalGeneral = series.reduce((a, s) => a + s.total, 0);
    const max = Math.max(0, ...meses.map((m) => m.total));
    const tope = techo(max);
    const eje = { tope, ticks: [0, 1, 2, 3, 4].map((i) => (tope / 4) * i) };
    return { series, meses, totalGeneral, primerMes, eje };
  }, [rows, anio, anioActual]);

  const anios = [anioActual, anioActual - 1, anioActual - 2];
  const cargando = rows === null && !error;

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h3 className="text-lg font-bold text-zinc-100">
            Ausentismo por sector – Horas solicitadas{" "}
            <span className="text-yellow-400">| Período {anio}</span>
          </h3>
          <p className="text-sm text-zinc-500 mt-0.5">
            Horas cargadas en novedades · Total mensual sobre cada barra
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm text-zinc-400">
          Año:
          <select
            value={anio}
            onChange={(e) => setAnio(Number(e.target.value))}
            className="bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-1.5 text-zinc-100 outline-none focus:border-yellow-400 cursor-pointer"
          >
            {anios.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
          {cargando && <Loader2 size={15} className="animate-spin text-yellow-400" />}
        </label>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      {!cargando && !error && totalGeneral === 0 && (
        <div className="py-12 text-center text-zinc-600 text-sm">
          Sin horas solicitadas registradas en {anio}.
        </div>
      )}

      {totalGeneral > 0 && (
        <>
          {/* Tarjetas: total del período por sector + total general */}
          <div className="grid grid-cols-2 gap-3 sm:[grid-template-columns:repeat(auto-fit,minmax(160px,1fr))]">
            {series.map((s) => (
              <button
                key={s.key}
                type="button"
                onMouseEnter={() => setFoco(s.key)}
                onMouseLeave={() => setFoco(null)}
                onClick={() => setFoco((f) => (f === s.key ? null : s.key))}
                className={`flex items-center gap-2 sm:gap-3 rounded-xl border px-3 sm:px-4 py-3 text-left transition-colors ${
                  foco === s.key
                    ? "border-yellow-400/70 bg-yellow-400/10"
                    : "border-zinc-800 bg-zinc-900/60 hover:border-zinc-700"
                }`}
              >
                <span className="h-5 w-5 sm:h-8 sm:w-8 shrink-0 rounded-md" style={{ background: s.color }} />
                <span className="min-w-0">
                  <span className="block text-xs sm:text-sm text-zinc-400 truncate">Total {s.label}</span>
                  <span className="block text-lg sm:text-2xl font-bold text-zinc-100 tabular-nums leading-tight">
                    {num(s.total)}
                  </span>
                </span>
              </button>
            ))}
            <div className="flex items-center gap-2 sm:gap-3 rounded-xl border border-yellow-400/40 bg-yellow-400/5 px-3 sm:px-4 py-3">
              <span className="h-5 w-5 sm:h-8 sm:w-8 shrink-0 rounded-md bg-yellow-500" />
              <span className="min-w-0">
                <span className="block text-xs sm:text-sm text-zinc-400 truncate">Total general</span>
                <span className="block text-lg sm:text-2xl font-bold text-zinc-100 tabular-nums leading-tight">
                  {num(totalGeneral)}
                </span>
              </span>
            </div>
          </div>

          {/* Barras apiladas en horas */}
          <div className="overflow-x-auto">
            <div className="flex min-w-[560px]">
              {/* Eje Y */}
              <div className="relative w-11 shrink-0 mt-7 h-[340px] text-[11px] text-zinc-500 tabular-nums">
                {eje.ticks.map((v) => (
                  <span
                    key={v}
                    className="absolute right-2 -translate-y-1/2"
                    style={{ top: `${100 - (v / eje.tope) * 100}%` }}
                  >
                    {num(v)}
                  </span>
                ))}
              </div>

              <div className="flex-1">
                <div className="relative">
                  {/* Grilla */}
                  <div className="absolute inset-x-0 top-7 h-[340px] pointer-events-none">
                    {eje.ticks.slice(1).map((v) => (
                      <div
                        key={v}
                        className="absolute inset-x-0 border-t border-dashed border-zinc-800"
                        style={{ top: `${100 - (v / eje.tope) * 100}%` }}
                      />
                    ))}
                    <div className="absolute inset-x-0 bottom-0 border-t border-zinc-600" />
                  </div>

                  <div className="relative flex">
                    {meses.map((m) => (
                      <div key={m.ym} className="flex-1 min-w-[64px] px-1.5 sm:px-3">
                        <div className="h-7 flex items-end justify-center pb-1.5 text-sm font-bold text-zinc-100 tabular-nums">
                          {m.total > 0 ? num(m.total) : ""}
                        </div>
                        <div className="h-[340px] mx-auto w-full max-w-[120px] flex flex-col-reverse">
                          {/* Segmentos de abajo hacia arriba; la altura es proporcional a las horas. */}
                          {series.map((s) => {
                            const v = m.valores.get(s.key) ?? 0;
                            if (v <= 0) return null;
                            const h = (v / eje.tope) * 100;
                            const atenuado = foco !== null && foco !== s.key;
                            return (
                              <div
                                key={s.key}
                                title={`${m.label} · ${s.label}: ${hs(v)}`}
                                className="relative flex items-center justify-center border-t border-black/20 first:border-t-0 transition-opacity"
                                style={{
                                  height: `${h}%`,
                                  background: s.color,
                                  opacity: atenuado ? 0.25 : 1,
                                }}
                              >
                                {h >= 4 && (
                                  <span
                                    className="text-[11px] font-semibold tabular-nums"
                                    style={{ color: s.texto }}
                                  >
                                    {num(v)}
                                  </span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                        <div className="pt-2 text-center text-sm text-zinc-300">{m.label}</div>
                        <div className="text-center text-[10px] uppercase tracking-wide text-yellow-400/80 h-3.5">
                          {m.enCurso ? "en curso" : ""}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Leyenda */}
          <div className="flex flex-wrap justify-center gap-x-5 gap-y-1 text-xs text-zinc-400">
            {series.map((s) => (
              <span key={s.key} className="inline-flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />
                {s.label}
              </span>
            ))}
          </div>

          <p className="text-xs text-zinc-500">
            Total general del período: {hs(totalGeneral)}.
            {primerMes > 1 && ` Sin novedades registradas antes de ${MESES[primerMes - 1].toLowerCase()}.`}
          </p>
        </>
      )}
    </div>
  );
}
