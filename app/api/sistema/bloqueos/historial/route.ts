import { NextRequest, NextResponse } from "next/server";

const API_URL =
  process.env.INDICADORES_API_URL ?? "http://indicadores-api:8001";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Historial de episodios de bloqueo registrados por el watchdog.
export async function GET(req: NextRequest) {
  const dias = req.nextUrl.searchParams.get("dias") ?? "30";
  const limite = req.nextUrl.searchParams.get("limite") ?? "100";
  try {
    const res = await fetch(
      `${API_URL}/sistema/bloqueos/historial?dias=${dias}&limite=${limite}`,
      { cache: "no-store", signal: AbortSignal.timeout(20000) },
    );
    if (!res.ok) {
      const detail = await res.json().catch(() => null);
      return NextResponse.json(
        { error: "Error al consultar el historial", detail },
        { status: res.status },
      );
    }
    return NextResponse.json(await res.json());
  } catch (error) {
    console.error("GET /api/sistema/bloqueos/historial", error);
    return NextResponse.json(
      { error: "No se pudo conectar al servicio de indicadores" },
      { status: 503 },
    );
  }
}
