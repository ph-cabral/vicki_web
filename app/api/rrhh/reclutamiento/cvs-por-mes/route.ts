import { NextRequest, NextResponse } from "next/server";

const API_URL =
  process.env.INDICADORES_API_URL ?? "http://indicadores-api:8001";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Proxy → FastAPI indicadores-api: personas únicas que postularon por mes
// (rag_system.candidato). Ver indicadores-api/rrhh.py.
export async function GET(req: NextRequest) {
  const meses = req.nextUrl.searchParams.get("meses") ?? "12";
  try {
    const res = await fetch(`${API_URL}/rrhh/cvs-por-mes?meses=${meses}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(45000),
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => null);
      return NextResponse.json(
        { error: "Error en API de reclutamiento (cvs-por-mes)", detail },
        { status: res.status },
      );
    }
    return NextResponse.json(await res.json());
  } catch (error) {
    console.error("GET /api/rrhh/reclutamiento/cvs-por-mes", error);
    return NextResponse.json(
      { error: "No se pudo conectar al servicio de reclutamiento" },
      { status: 503 },
    );
  }
}
