import { NextRequest, NextResponse } from "next/server";

const API_URL =
  process.env.INDICADORES_API_URL ?? "http://indicadores-api:8001";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Proxy → FastAPI indicadores-api: OT de reposición (OT1R) vivas con algún
// destino sin cumplir, agrupadas por artículo, con hora de alta y repositor.
// Lo consume /picking para marcar los códigos pedidos que ya tienen una
// reposición en marcha (columna "OT repo" + modal de detalle).
export async function GET(req: NextRequest) {
  const dias = req.nextUrl.searchParams.get("dias");
  const qs = dias ? `?dias=${encodeURIComponent(dias)}` : "";
  try {
    const res = await fetch(`${API_URL}/deposito/repo/en-curso${qs}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => null);
      return NextResponse.json(
        { error: "Error en API de depósito (reposición en curso)", detail },
        { status: res.status },
      );
    }
    return NextResponse.json(await res.json());
  } catch (error) {
    console.error("GET /api/deposito/repo/en-curso", error);
    return NextResponse.json(
      { error: "No se pudo conectar al servicio de depósito" },
      { status: 503 },
    );
  }
}
