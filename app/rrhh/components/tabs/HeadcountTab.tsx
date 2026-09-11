// app/rrhh/components/tabs/HeadcountTab.tsx
"use client";

import { useEffect, useState } from "react";
import { Users, Cake, Briefcase, UserPlus } from "lucide-react";
import KpiCard from "@/app/rrhh/components/KpiCard";
import BarChartCard from "@/app/rrhh/components/charts/BarChartCard";
import PieChartCard from "@/app/rrhh/components/charts/PieChartCard";
import LineChartCard from "@/app/rrhh/components/charts/LineChartCard";
import HorizontalBarChartCard from "@/app/rrhh/components/charts/HorizontalBarChartCard";
import { Panel, ErrMsg, Empty } from "@/app/rrhh/components/IndicadorUI";
import { Card } from "@/components/ui/card";
import { everWearTheme as t } from "@/lib/rrhh/theme";

type NameValue = { name: string; value: number };

type EmpleadoRow = {
  codigo: string | null;
  nombre: string;
  area: string;
  puesto: string | null;
  fechaIngreso: string | null;
  edad: number | null;
};

type HeadcountData = {
  kpis: {
    headcount: number;
    edadPromedio: number;
    edadCount: number;
    antiguedadPromedio: number;
    antiguedadCount: number;
    ingresosUltimoMes: number;
  };
  porArea: NameValue[];
  porEdad: NameValue[];
  porSexo: NameValue[];
  ingresosPorMes: Array<{ name: string; ingresos: number }>;
  empleados: EmpleadoRow[];
};

const fmtFecha = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("es-AR") : "—";

// Empleados activos, leídos en vivo de Postgres (legajo) — reemplaza el Excel
// "empleados" que alimentaba esta pestaña antes (2026-09-11). Edad y
// antigüedad dependen de que cada legajo tenga fechaNacimiento / fechaInicio
// cargada; los hints de los KPI muestran sobre cuántos activos se calculó,
// porque hoy la mayoría todavía no la tiene.
export default function HeadcountTab() {
  const [data, setData] = useState<HeadcountData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fetch("/api/rrhh/headcount")
      .then((r) => {
        if (!r.ok) throw new Error("No se pudo obtener el headcount");
        return r.json();
      })
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  if (error) return <ErrMsg msg={error} />;
  if (loading || !data) return <Empty msg="Cargando…" />;

  const { kpis, porArea, porEdad, porSexo, ingresosPorMes, empleados } = data;
  const hayEdades = porEdad.some((b) => b.value > 0);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KpiCard label="Empleados activos" value={kpis.headcount} icon={Users} />
        <KpiCard
          label="Edad promedio"
          value={kpis.edadCount ? `${kpis.edadPromedio} años` : "—"}
          icon={Cake}
          accent="zinc"
          hint={`sobre ${kpis.edadCount} de ${kpis.headcount} con fecha de nac. cargada`}
        />
        <KpiCard
          label="Antigüedad promedio"
          value={kpis.antiguedadCount ? `${kpis.antiguedadPromedio} años` : "—"}
          icon={Briefcase}
          accent="zinc"
          hint={`sobre ${kpis.antiguedadCount} de ${kpis.headcount} con fecha de ingreso cargada`}
        />
        <KpiCard
          label="Ingresos mes pasado"
          value={kpis.ingresosUltimoMes}
          icon={UserPlus}
          accent="green"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {porArea.length > 0 && (
          <Card
            className="col-span-1 rounded-lg border p-4"
            style={{ background: t.bgCard, borderColor: t.border }}
          >
            <HorizontalBarChartCard
              title="Empleados por área"
              data={porArea}
              xKey="name"
              yKey="value"
            />
          </Card>
        )}

        <Card
          className="col-span-1 rounded-lg border p-4"
          style={{ background: t.bgCard, borderColor: t.border }}
        >
          {hayEdades ? (
            <BarChartCard
              height={350}
              title="Distribución por edad"
              ubicacionLabel="insideTop"
              labelFontSize={14}
              data={porEdad}
              xKey="name"
              yKey="value"
              xTickFontSize={14}
              currency={false}
            />
          ) : (
            <Empty msg="Todavía no hay fechas de nacimiento cargadas." />
          )}
          <LineChartCard
            title="Ingresos últimos 12 meses"
            data={ingresosPorMes}
            xKey="name"
            yKeys={["ingresos"]}
          />
        </Card>

        {porSexo.length > 0 && (
          <PieChartCard title="Distribución por género" data={porSexo} />
        )}
      </div>

      <Panel>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-zinc-300">
            Empleados activos ({empleados.length})
          </h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-zinc-800">
                <th className="px-3 py-2 text-left text-zinc-500 font-medium uppercase">Legajo</th>
                <th className="px-3 py-2 text-left text-zinc-500 font-medium uppercase">Nombre</th>
                <th className="px-3 py-2 text-left text-zinc-500 font-medium uppercase">Área</th>
                <th className="px-3 py-2 text-left text-zinc-500 font-medium uppercase">Puesto</th>
                <th className="px-3 py-2 text-left text-zinc-500 font-medium uppercase">Edad</th>
                <th className="px-3 py-2 text-left text-zinc-500 font-medium uppercase">Fecha ingreso</th>
              </tr>
            </thead>
            <tbody>
              {empleados.slice(0, 200).map((e, i) => (
                <tr key={e.codigo ?? i} className="border-b border-zinc-800/50 hover:bg-zinc-900/30">
                  <td className="px-3 py-2 text-zinc-300 whitespace-nowrap">{e.codigo ?? "—"}</td>
                  <td className="px-3 py-2 text-zinc-300 whitespace-nowrap">{e.nombre}</td>
                  <td className="px-3 py-2 text-zinc-300 whitespace-nowrap">{e.area}</td>
                  <td className="px-3 py-2 text-zinc-300 whitespace-nowrap">{e.puesto ?? "—"}</td>
                  <td className="px-3 py-2 text-zinc-300 whitespace-nowrap">{e.edad ?? "—"}</td>
                  <td className="px-3 py-2 text-zinc-300 whitespace-nowrap">{fmtFecha(e.fechaIngreso)}</td>
                </tr>
              ))}
              {empleados.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-4 text-center text-zinc-600">
                    Sin empleados activos
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          {empleados.length > 200 && (
            <p className="mt-2 text-xs text-zinc-600">
              Mostrando 200 de {empleados.length} empleados activos.
            </p>
          )}
        </div>
      </Panel>
    </div>
  );
}
