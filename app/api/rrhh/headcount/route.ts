import { NextResponse } from "next/server";
import { getHeadcountData } from "@/lib/rrhh/headcountDb";

export const dynamic = "force-dynamic";

// Empleados/headcount de /rrhh en vivo desde Postgres (everwear.legajo) —
// reemplaza al Excel "empleados" que hacía falta subir antes (2026-09-11).
// Ver lib/rrhh/headcountDb.ts para el detalle de los cálculos.
export async function GET() {
  try {
    const data = await getHeadcountData();
    return NextResponse.json(data);
  } catch (e) {
    console.error("GET rrhh/headcount error:", e);
    return NextResponse.json({ error: "Error al obtener datos de empleados" }, { status: 500 });
  }
}
