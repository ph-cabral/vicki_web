import { NextResponse } from "next/server";

const API_URL = process.env.INDICADORES_API_URL ?? "http://indicadores-api:8001";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Proxy → indicadores-api /compras/planificacion/niveles: nombres de
// Stk_Nivel1..4 + combinaciones existentes (N1,N2,N3,N4,cantidad) para armar
// las listas en cascada del modal de /compras/planificacion.
export async function GET() {
  try {
    const res = await fetch(`${API_URL}/compras/planificacion/niveles`, {
      cache: "no-store",
      signal: AbortSignal.timeout(25000),
    });
    if (!res.ok) {
      return NextResponse.json({ error: "Error en API de niveles" }, { status: res.status });
    }
    return NextResponse.json(await res.json());
  } catch (e) {
    console.error("GET /api/compras/planificacion/niveles", e);
    return NextResponse.json({ error: "No se pudo conectar al servicio de compras" }, { status: 503 });
  }
}
