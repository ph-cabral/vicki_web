import { NextRequest, NextResponse } from "next/server";

const API_URL =
  process.env.INDICADORES_API_URL ?? "http://indicadores-api:8001";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Proxy → indicadores-api (calidad.py). Buscador de clientes con controles de mesa.
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  let url = "";
  url = `${API_URL}/calidad/clientes?q=${encodeURIComponent(sp.get("q") ?? "")}`;
  try {
    const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(25000) });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      return NextResponse.json({ error: "Error en API de calidad", detail: data }, { status: res.status });
    }
    return NextResponse.json(data);
  } catch (error) {
    console.error("GET /api/calidad/clientes", error);
    return NextResponse.json({ error: "No se pudo conectar al servicio de indicadores" }, { status: 503 });
  }
}
