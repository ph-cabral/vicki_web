import { NextRequest, NextResponse } from "next/server";

const API_URL =
  process.env.INDICADORES_API_URL ?? "http://indicadores-api:8001";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Proxy → FastAPI indicadores-api, vista "Por operario" (/deposito/deposito →
// Mesas): asignado (Postgres) vs controlado (Magnus) por operario en el día.
export async function GET(req: NextRequest) {
  const dia = new URL(req.url).searchParams.get("dia");
  const qs = dia && /^\d{4}-\d{2}-\d{2}$/.test(dia) ? `?dia=${dia}` : "";
  try {
    const res = await fetch(`${API_URL}/deposito/control-asignacion/por-operario${qs}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(45000),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      return NextResponse.json(
        { error: "Error en API de control por operario", detail: data },
        { status: res.status },
      );
    }
    return NextResponse.json(data);
  } catch (error) {
    console.error("GET /api/deposito/control-asignacion/por-operario", error);
    return NextResponse.json(
      { error: "No se pudo conectar al servicio de depósito" },
      { status: 503 },
    );
  }
}
