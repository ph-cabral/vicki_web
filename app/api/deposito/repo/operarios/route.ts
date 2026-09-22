import { NextRequest, NextResponse } from "next/server";

const API_URL =
  process.env.INDICADORES_API_URL ?? "http://indicadores-api:8001";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Proxy → FastAPI indicadores-api: operarios a los que se les puede asignar la
// OT de reposición. Por defecto sólo los que repusieron en los últimos 90 días
// (7 de los 51 de WMS.Personal), ordenados por uso; ?todos=1 trae los activos.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const qs = new URLSearchParams();
  const dias = sp.get("dias");
  const todos = sp.get("todos");
  if (dias) qs.set("dias", dias);
  if (todos) qs.set("todos", todos);

  try {
    const res = await fetch(`${API_URL}/deposito/repo/operarios?${qs.toString()}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => null);
      return NextResponse.json(
        { error: "Error en API de depósito (operarios)", detail },
        { status: res.status, headers: CORS },
      );
    }
    return NextResponse.json(await res.json(), { headers: CORS });
  } catch (error) {
    console.error("GET /api/deposito/repo/operarios", error);
    return NextResponse.json(
      { error: "No se pudo conectar al servicio de depósito" },
      { status: 503, headers: CORS },
    );
  }
}
