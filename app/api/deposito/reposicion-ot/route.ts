import { NextResponse } from "next/server";

const API_URL =
  process.env.INDICADORES_API_URL ?? "http://indicadores-api:8001";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Proxy → FastAPI indicadores-api: alerta de reposición (artículos con
// demanda pendiente en OT de Picking abiertas/en proceso que superan el stock
// del depósito central). Sin params: siempre la foto en vivo del momento.
export async function GET() {
  try {
    const res = await fetch(`${API_URL}/deposito/reposicion-ot`, {
      cache: "no-store",
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => null);
      return NextResponse.json(
        { error: "Error en API de depósito (reposición)", detail },
        { status: res.status },
      );
    }
    return NextResponse.json(await res.json());
  } catch (error) {
    console.error("GET /api/deposito/reposicion-ot", error);
    return NextResponse.json(
      { error: "No se pudo conectar al servicio de depósito" },
      { status: 503 },
    );
  }
}
