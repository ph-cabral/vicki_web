"use client";

import { useMemo, useState } from "react";
import { DollarSign, Save, TrendingUp, Wallet } from "lucide-react";
import type { ParsedFile } from "@/lib/rrhh/parseXlsx";
import KpiCard from "@/app/rrhh/components/KpiCard";
import BarChartCard from "@/app/rrhh/components/charts/BarChartCard";
import CostoNominaChart from "@/app/rrhh/components/charts/CostoNominaChart";
import GuardarNominaModal from "@/app/rrhh/components/tabs/GuardarNominaModal";
import { nominaKpis, costoPorArea, netoPromedioPorArea } from "@/lib/rrhh/aggregations";

const fmtARS = (n: number) =>
  new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 }).format(n);

export default function NominaTab({ file, fileEmpleados }: { file: ParsedFile; fileEmpleados: ParsedFile }) {
  const kpis = useMemo(() => nominaKpis(file), [file]);
  // costos se calcula pero no se grafica acá (se mantiene por paridad con el original)
  useMemo(() => costoPorArea(file, fileEmpleados), [file, fileEmpleados]);
  const promedios = useMemo(() => netoPromedioPorArea(fileEmpleados, file), [fileEmpleados, file]);

  const [modalAbierto, setModalAbierto] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KpiCard label="Total neto + bono" value={fmtARS(kpis.totalNeto)} icon={Wallet} accent="green" />
        <KpiCard label="Costo total nómina" value={fmtARS(kpis.totalCostos)} icon={DollarSign} accent="green" />
        <KpiCard label="Neto promedio" value={fmtARS(kpis.netoPromedio)} icon={TrendingUp} accent="zinc" />
        <button
          onClick={() => setModalAbierto(true)}
          className="rounded-xl border border-yellow-400/40 bg-yellow-400/5 hover:bg-yellow-400/10 px-5 py-4 flex flex-col items-start justify-between gap-2 transition-colors text-left"
        >
          <div className="flex items-center justify-between w-full">
            <span className="text-xs font-semibold uppercase tracking-wider text-yellow-400">Base de datos</span>
            <Save size={16} className="text-yellow-400 shrink-0" />
          </div>
          <p className="text-sm text-zinc-300">Guardar este mes</p>
        </button>
      </div>

      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 px-5 py-5">
        <CostoNominaChart refreshKey={refreshKey} />
      </div>

      <div className="gap-4">
        {promedios.length > 0 && (
          <BarChartCard
            height={500}
            title="Neto promedio por área"
            ubicacionLabel="top"
            labelFontSize={14}
            data={promedios}
            xKey="name"
            yKey="promedio"
            labelFill="#fff"
            xTickFontSize={12}
            xAngle={-45}
          />
        )}
      </div>

      {modalAbierto && (
        <GuardarNominaModal
          file={file}
          onCerrar={() => setModalAbierto(false)}
          onGuardado={() => {
            setModalAbierto(false);
            setRefreshKey((k) => k + 1);
          }}
        />
      )}
    </div>
  );
}
