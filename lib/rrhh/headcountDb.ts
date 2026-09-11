// lib/rrhh/headcountDb.ts
//
// Datos de la pestaña "Empleados" de /rrhh, leídos en vivo de Postgres
// (tabla everwear.legajo) en vez del Excel que se subía antes (2026-09-11).
//
// Una sola query liviana (solo las columnas que hacen falta) trae a todos
// los legajos ACTIVOS y de ahí salen: headcount, edad promedio, antigüedad
// promedio, ingresos del mes pasado, empleados por área, distribución por
// edad, distribución por sexo y la tabla de detalle. Una segunda query trae
// sólo fechaInicio de TODOS los legajos (activos o no) de los últimos 12
// meses, para el gráfico de ingresos histórico.
//
// `estado` tiene datos legados en distinta capitalización ("ACTIVO" /
// "activo") — el filtro usa mode "insensitive" en vez de comparar texto
// exacto.
//
// Edad y antigüedad dependen de que el legajo tenga fechaNacimiento /
// fechaInicio cargada — Pablo las está completando de a una; mientras no
// estén, esos promedios salen sólo de los legajos que sí las tienen (los
// KPI devuelven cuántos son, para que el front pueda mostrar la cobertura).

import { prisma } from "@/lib/prisma";

const YEAR_MS = 1000 * 60 * 60 * 24 * 365.25;

function ageYears(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / YEAR_MS;
}

const SEXO_LABELS: Record<string, string> = { M: "Masculino", F: "Femenino" };

export interface NameValue {
  name: string;
  value: number;
}

export interface HeadcountKpis {
  headcount: number;
  edadPromedio: number;
  edadCount: number;
  antiguedadPromedio: number;
  antiguedadCount: number;
  ingresosUltimoMes: number;
}

export interface EmpleadoRow {
  codigo: string | null;
  nombre: string;
  area: string;
  puesto: string | null;
  fechaIngreso: Date | null;
  edad: number | null;
}

export interface HeadcountData {
  kpis: HeadcountKpis;
  porArea: NameValue[];
  porEdad: NameValue[];
  porSexo: NameValue[];
  ingresosPorMes: Array<{ name: string; ingresos: number }>;
  empleados: EmpleadoRow[];
}

export async function getHeadcountData(): Promise<HeadcountData> {
  const today = new Date();
  const prevMonthDate = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const prevMonth = prevMonthDate.getMonth();
  const prevYear = prevMonthDate.getFullYear();
  const start12m = new Date(today.getFullYear(), today.getMonth() - 11, 1);

  const [activos, ingresos12mRows] = await Promise.all([
    prisma.legajo.findMany({
      where: { estado: { equals: "ACTIVO", mode: "insensitive" } },
      select: {
        codigo: true,
        nombre: true,
        puestoInterno: true,
        sexo: true,
        fechaNacimiento: true,
        fechaInicio: true,
        sector: true,
        sectorRel: { select: { nombre: true, area: { select: { nombre: true } } } },
      },
      orderBy: { nombre: "asc" },
    }),
    // Ingresos de los últimos 12 meses: TODOS los legajos, sin filtrar por
    // estado (alguien que ya no está activo sigue contando como ingreso del
    // mes en que entró).
    prisma.legajo.findMany({
      where: { fechaInicio: { gte: start12m } },
      select: { fechaInicio: true },
    }),
  ]);

  let edadSum = 0;
  let edadCount = 0;
  let antSum = 0;
  let antCount = 0;
  let ingresosUltimoMes = 0;
  const porAreaMap = new Map<string, number>();
  const porSexoMap = new Map<string, number>();
  const edadBuckets: Record<string, number> = {
    "<25": 0,
    "25-34": 0,
    "35-44": 0,
    "45-54": 0,
    "55+": 0,
  };

  for (const l of activos) {
    if (l.fechaNacimiento) {
      const edad = ageYears(l.fechaNacimiento, today);
      edadSum += edad;
      edadCount++;
      if (edad < 25) edadBuckets["<25"]++;
      else if (edad < 35) edadBuckets["25-34"]++;
      else if (edad < 45) edadBuckets["35-44"]++;
      else if (edad < 55) edadBuckets["45-54"]++;
      else edadBuckets["55+"]++;
    }
    if (l.fechaInicio) {
      antSum += ageYears(l.fechaInicio, today);
      antCount++;
      if (l.fechaInicio.getMonth() === prevMonth && l.fechaInicio.getFullYear() === prevYear) {
        ingresosUltimoMes++;
      }
    }

    const areaNombre = l.sectorRel?.area?.nombre ?? l.sector ?? "Sin área";
    porAreaMap.set(areaNombre, (porAreaMap.get(areaNombre) ?? 0) + 1);

    const sexoLabel = SEXO_LABELS[l.sexo] ?? l.sexo ?? "Sin dato";
    porSexoMap.set(sexoLabel, (porSexoMap.get(sexoLabel) ?? 0) + 1);
  }

  const ingresosPorMesMap = new Map<string, number>();
  for (let i = 0; i < 12; i++) {
    const dt = new Date(start12m.getFullYear(), start12m.getMonth() + i, 1);
    ingresosPorMesMap.set(`${String(dt.getMonth() + 1).padStart(2, "0")}-${dt.getFullYear()}`, 0);
  }
  for (const r of ingresos12mRows) {
    if (!r.fechaInicio) continue;
    const key = `${String(r.fechaInicio.getMonth() + 1).padStart(2, "0")}-${r.fechaInicio.getFullYear()}`;
    if (ingresosPorMesMap.has(key)) {
      ingresosPorMesMap.set(key, (ingresosPorMesMap.get(key) ?? 0) + 1);
    }
  }

  return {
    kpis: {
      headcount: activos.length,
      edadPromedio: edadCount ? +(edadSum / edadCount).toFixed(1) : 0,
      edadCount,
      antiguedadPromedio: antCount ? +(antSum / antCount).toFixed(1) : 0,
      antiguedadCount: antCount,
      ingresosUltimoMes,
    },
    porArea: [...porAreaMap.entries()]
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value),
    porEdad: Object.entries(edadBuckets).map(([name, value]) => ({ name, value })),
    porSexo: [...porSexoMap.entries()].map(([name, value]) => ({ name, value })),
    ingresosPorMes: [...ingresosPorMesMap.entries()].map(([name, ingresos]) => ({ name, ingresos })),
    empleados: activos.map((l) => ({
      codigo: l.codigo,
      nombre: l.nombre,
      area: l.sectorRel?.area?.nombre ?? l.sector ?? "Sin área",
      puesto: l.puestoInterno,
      fechaIngreso: l.fechaInicio,
      edad: l.fechaNacimiento ? Math.floor(ageYears(l.fechaNacimiento, today)) : null,
    })),
  };
}
