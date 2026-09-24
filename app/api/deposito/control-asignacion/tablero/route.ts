import { NextResponse } from "next/server";

const API_URL =
  process.env.INDICADORES_API_URL ?? "http://indicadores-api:8001";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Proxy → FastAPI indicadores-api, vista "Asignar pedidos" (/deposito/deposito →
// Mesas): unidades listas para control y en preparación con su preasignación.
export async function GET() {
  try {
    const res = await fetch(`${API_URL}/deposito/control-asignacion/tablero`, {
      cache: "no-store",
      signal: AbortSignal.timeout(45000),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      return NextResponse.json(
        { error: "Error en API de asignación de pedidos", detail: data },
        { status: res.status },
      );
    }
    return NextResponse.json(data);
  } catch (error) {
    console.error("GET /api/deposito/control-asignacion/tablero", error);
    return NextResponse.json(
      { error: "No se pudo conectar al servicio de depósito" },
      { status: 503 },
    );
  }
}
