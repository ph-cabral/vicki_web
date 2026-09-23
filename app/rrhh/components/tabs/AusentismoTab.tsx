"use client";

import { useEffect, useMemo, useState } from "react";
import { Percent, CalendarX, Users } from "lucide-react";
import KpiCard from "@/app/rrhh/components/KpiCard";
import PieChartCard from "@/app/rrhh/components/charts/PieChartCard";
import BarChartCard from "@/app/rrhh/components/charts/BarChartCard";
import AusentismoSectorMesChart from "@/app/rrhh/components/charts/AusentismoSectorMesChart";
import {
  TabHeader,
  Panel,
  ErrMsg,
  Empty,
} from "@/app/rrhh/components/IndicadorUI";
import {
  computeIndicadores,
  horasPorEmpleado,
  fetchResumen,
  fetchHorarios,
  buildTopeResolver,
  mesRange,
  currentYm,
  type ResumenRow,
  type HorarioTipo,
  type HorarioAsignacion,
} from "@/lib/rrhh/asistenciaIndicadores";

const fmt = (n: number) =>
  new Intl.NumberFormat("es-AR", { maximumFractionDigits: 1 }).format(n);
const round1 = (n: number) => Math.round(n * 10) / 10;

// Pestaña Ausentismo — alimentada por la BD de fichadas (API resumen).
// Por estado, excluye Normal / Ausente / Revisar (ver ESTADOS_NO_AUSENCIA).
export default function AusentismoTab() {
  const [ym, setYm] = useState(currentYm());
  const [rows, setRows] = useState<ResumenRow[]>([]);
  const [tipos, setTipos] = useState<HorarioTipo[]>([]);
  const [asignaciones, setAsignaciones] = useState<HorarioAsignacion[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Horas objetivo del mes (asistencia.horas_objetivo) — un número único que
  // representa cuántas horas laborales corresponden en el mes (ej. 300),
  // contra el que se compara el total trabajado (RRHH, con tope) de cada
  // empleado (2026-07-31).
  const [objetivo, setObjetivo] = useState<string>("");
  const [savingObjetivo, setSavingObjetivo] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchHorarios().then((h) => {
      if (!alive) return;
      setTipos(h.tipos);
      setAsignaciones(h.asignaciones);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    const { desde, hasta } = mesRange(ym);
    setLoading(true);
    setError(null);
    fetchResumen(desde, hasta)
      .then((d) => alive && setRows(d))
      .catch((e) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [ym]);

  useEffect(() => {
    let alive = true;
    fetch(`/api/rrhh/asistencia/horas-objetivo?ym=${ym}`)
      .then((r) => (r.ok ? r.json() : { horas: null }))
      .then((d) => alive && setObjetivo(d.horas != null ? String(d.horas) : ""))
      .catch(() => alive && setObjetivo(""));
    return () => {
      alive = false;
    };
  }, [ym]);

  const guardarObjetivo = async () => {
    setSavingObjetivo(true);
    try {
      await fetch("/api/rrhh/asistencia/horas-objetivo", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ym, horas: objetivo ? Number(objetivo) : null }),
      });
    } catch (err) {
      console.error("[horas objetivo]", err);
    } finally {
      setSavingObjetivo(false);
    }
  };

  const resolveTope = useMemo(
    () => buildTopeResolver(tipos, asignaciones),
    [tipos, asignaciones],
  );
  const ind = useMemo(
    () => computeIndicadores(rows, resolveTope),
    [rows, resolveTope],
  );
  const porEmpleado = useMemo(
    () => horasPorEmpleado(rows, resolveTope),
    [rows, resolveTope],
  );

  const objetivoNum = objetivo ? Number(objetivo) : null;
  const cumplieron =
    objetivoNum != null
      ? porEmpleado.filter((e) => e.minutos / 60 >= objetivoNum).length
      : null;

  return (
    <div className="space-y-6">
      <TabHeader
        title="Indicadores — Ausentismo"
        sub="Por estado, excluye Normal / Ausente / Revisar"
        ym={ym}
        setYm={setYm}
        loading={loading}
      />

      {error && <ErrMsg msg={error} />}

      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-zinc-800 bg-zinc-900/40 px-5 py-4">
        <label className="flex flex-col gap-1 text-sm text-zinc-400">
          Horas objetivo del mes
          <input
            type="number"
            min={0}
            value={objetivo}
            onChange={(e) => setObjetivo(e.target.value)}
            onBlur={guardarObjetivo}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
            placeholder="ej. 300"
            className="w-28 bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-1.5 text-zinc-100 outline-none focus:border-yellow-400"
          />
        </label>
        {savingObjetivo && (
          <span className="text-xs text-zinc-500">Guardando…</span>
        )}
        {cumplieron != null && (
          <span className="text-sm text-zinc-400">
            Cumplieron el objetivo:{" "}
            <span className="font-semibold text-zinc-200">
              {cumplieron} / {porEmpleado.length}
            </span>
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <KpiCard
          label="Ratio de ausencia por jornada"
          value={`${fmt(ind.ratioAusencia)} %`}
          icon={Percent}
          accent="orange"
          hint={`${ind.diasAusencia} de ${ind.jornadasEsperadas} jornadas`}
        />
        <KpiCard
          label="Días de ausencia"
          value={ind.diasAusencia}
          icon={CalendarX}
          accent="zinc"
        />
        <KpiCard
          label="Personas con ausencias"
          value={ind.personasAusentes}
          icon={Users}
          accent="zinc"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel>
          {ind.ausenciaPorMotivo.length > 0 ? (
            <PieChartCard
              title="Ausentismo por motivo"
              data={ind.ausenciaPorMotivo}
            />
          ) : (
            <Empty
              msg={loading ? "Cargando…" : "Sin ausencias en el período."}
            />
          )}
        </Panel>
        <Panel>
          {ind.ausenciaPorArea.length > 0 ? (
            <BarChartCard
              title="Distribución por área"
              data={ind.ausenciaPorArea}
              xKey="name"
              yKey="value"
              currency={false}
            />
          ) : (
            <Empty
              msg={loading ? "Cargando…" : "Sin ausencias en el período."}
            />
          )}
        </Panel>
      </div>

      {/* Anual: independiente del selector de mes (tiene su propio año). */}
      <Panel>
        <AusentismoSectorMesChart />
      </Panel>

      {objetivoNum != null && (
        <Panel>
          <h3 className="text-sm font-semibold text-zinc-300 mb-3">
            Horas trabajadas vs. objetivo ({fmt(objetivoNum)} hs)
          </h3>
          {porEmpleado.length === 0 ? (
            <Empty msg={loading ? "Cargando…" : "Sin datos en el período."} />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-zinc-500 border-b border-zinc-800">
                    <th className="py-2 pr-4">Empleado</th>
                    <th className="py-2 pr-4">Área</th>
                    <th className="py-2 pr-4 text-right">Horas</th>
                    <th className="py-2 pr-4 text-right">Cumplió</th>
                  </tr>
                </thead>
                <tbody>
                  {porEmpleado.map((e) => {
                    const horas = round1(e.minutos / 60);
                    const cumplio = horas >= objetivoNum;
                    return (
                      <tr
                        key={e.employee_no}
                        className="border-b border-zinc-800/60"
                      >
                        <td className="py-1.5 pr-4 text-zinc-200">
                          {e.employee_name ?? `#${e.employee_no}`}
                        </td>
                        <td className="py-1.5 pr-4 text-zinc-500">
                          {e.departamento ?? "—"}
                        </td>
                        <td className="py-1.5 pr-4 text-right text-zinc-200">
                          {fmt(horas)}
                        </td>
                        <td className="py-1.5 pr-4 text-right">
                          <span
                            className={
                              cumplio
                                ? "text-green-400 font-medium"
                                : "text-orange-400 font-medium"
                            }
                          >
                            {cumplio ? "Sí" : "No"}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      )}
    </div>
  );
}
