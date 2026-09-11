"use client";

// Costo de Nómina mes a mes — barras apiladas por área + línea de total,
// leído de /api/rrhh/nomina (ver esa route para cómo se arma `porArea`).
// Reemplaza el mock: ahora sale de los meses realmente guardados desde el
// Excel de pago de sueldos (ver GuardarNominaModal + lib/rrhh/nomina.ts).
import { useEffect, useMemo, useState } from "react";
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, LabelList,
} from "recharts";
import { Loader2, UploadCloud } from "lucide-react";
import { everWearTheme as t } from "@/lib/rrhh/theme";
import { CardTitle } from "@/components/ui/card";
import { NOMBRES_MES } from "@/lib/rrhh/nomina";

type MesApi = {
  mes: string;
  total: number;
  cantEmpleados: number;
  archivoNombre: string | null;
  actualizado: string;
  porArea: Record<string, number>;
};

const SIN_AREA = "Sin área";
const COLOR_SIN_AREA = t.textMuted;
const COLOR_TOTAL = "#EF4444"; // rojo — misma idea que la línea "Total Mes" de referencia

const fmtARS = (n: number) =>
  new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 }).format(n);

function labelMes(mes: string, conAnio: boolean): string {
  const [anio, mm] = mes.split("-");
  const nombre = NOMBRES_MES[Number(mm) - 1] ?? mm;
  return conAnio ? `${nombre} ${anio}` : nombre;
}

type LabelProps = { x?: number; y?: number; width?: number; height?: number; value?: number; index?: number };

/** % del segmento sobre el total del mes, centrado adentro de la barra (como la referencia). */
function porcentajeSegmento(data: Record<string, string | number>[]) {
  return function PorcentajeLabel({ x = 0, y = 0, width = 0, height = 0, value = 0, index = 0 }: LabelProps) {
    if (width < 26 || height < 14) return null; // segmento angosto: el texto no entra
    const total = Number(data[index]?.total) || 0;
    if (!total || value <= 0) return null;
    const pct = (value / total) * 100;
    if (pct < 3) return null; // < 3% no entra legible
    return (
      <text
        x={x + width / 2}
        y={y + height / 2}
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={11}
        fontWeight={600}
        fill="#171717"
      >
        {pct.toFixed(1).replace(".", ",")}%
      </text>
    );
  };
}

export default function CostoNominaChart({ refreshKey }: { refreshKey?: number }) {
  const [meses, setMeses] = useState<MesApi[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelado = false;
    setError(null);
    fetch("/api/rrhh/nomina")
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? "Error al leer la nómina");
        return r.json();
      })
      .then((d) => { if (!cancelado) setMeses(d.meses ?? []); })
      .catch((e) => { if (!cancelado) setError(e instanceof Error ? e.message : "Error al leer la nómina"); });
    return () => { cancelado = true; };
  }, [refreshKey]);

  const { data, areas, conAnio } = useMemo(() => {
    if (!meses || meses.length === 0) return { data: [], areas: [] as string[], conAnio: false };

    const anios = new Set(meses.map((m) => m.mes.slice(0, 4)));
    const conAnio = anios.size > 1;

    // Áreas ordenadas por costo acumulado desc, "Sin área" siempre al final.
    const totalPorArea = new Map<string, number>();
    for (const m of meses) {
      for (const [area, costo] of Object.entries(m.porArea)) {
        totalPorArea.set(area, (totalPorArea.get(area) ?? 0) + costo);
      }
    }
    const areas = [...totalPorArea.keys()]
      .filter((a) => a !== SIN_AREA)
      .sort((a, b) => (totalPorArea.get(b) ?? 0) - (totalPorArea.get(a) ?? 0));
    if (totalPorArea.has(SIN_AREA)) areas.push(SIN_AREA);

    const data = meses.map((m) => {
      const row: Record<string, string | number> = {
        mes: labelMes(m.mes, conAnio),
        total: Math.round(m.total),
      };
      for (const area of areas) row[area] = Math.round(m.porArea[area] ?? 0);
      return row;
    });

    return { data, areas, conAnio };
  }, [meses]);

  if (error) {
    return <p className="text-sm text-red-400">{error}</p>;
  }
  if (meses === null) {
    return (
      <div className="flex items-center gap-2 text-zinc-500 text-sm py-12 justify-center">
        <Loader2 size={16} className="animate-spin" /> Cargando histórico…
      </div>
    );
  }
  if (meses.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-2 text-center">
        <UploadCloud size={32} className="text-zinc-700" />
        <p className="text-zinc-500 text-sm">Todavía no hay meses guardados en la base.</p>
      </div>
    );
  }

  return (
    <>
      <CardTitle className="mb-4 text-lg font-semibold" style={{ color: t.text }}>
        Costo de Nómina mes a mes
      </CardTitle>
      <ResponsiveContainer width="100%" height={420}>
        <ComposedChart data={data} margin={{ top: 24, right: 20, left: 0, bottom: 10 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={t.grid} />
          <XAxis dataKey="mes" stroke={t.textMuted} tick={{ fontSize: 12 }} />
          <YAxis
            stroke={t.textMuted}
            tick={{ fontSize: 12 }}
            tickFormatter={(v) => fmtARS(Number(v))}
            width={90}
          />
          <Tooltip
            contentStyle={{ background: t.bgCard, border: `1px solid ${t.border}`, color: t.text }}
            formatter={(value: number, name: string) => [fmtARS(value), name]}
          />
          <Legend wrapperStyle={{ fontSize: 12, color: t.textMuted }} />
          {areas.map((area, i) => (
            <Bar
              key={area}
              dataKey={area}
              stackId="costo"
              fill={area === SIN_AREA ? COLOR_SIN_AREA : t.palette[i % t.palette.length]}
              name={area}
            >
              <LabelList dataKey={area} content={porcentajeSegmento(data)} />
            </Bar>
          ))}
          <Line
            type="monotone"
            dataKey="total"
            name="Total Mes"
            stroke={COLOR_TOTAL}
            strokeWidth={2}
            dot={{ r: 3, fill: COLOR_TOTAL }}
          >
            <LabelList
              dataKey="total"
              position="top"
              fill={t.text}
              fontSize={11}
              formatter={(value: number) => fmtARS(value)}
            />
          </Line>
        </ComposedChart>
      </ResponsiveContainer>
    </>
  );
}
