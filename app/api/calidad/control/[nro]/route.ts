import { NextRequest, NextResponse } from "next/server";

const API_URL =
  process.env.INDICADORES_API_URL ?? "http://indicadores-api:8001";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Proxy → indicadores-api (calidad.py). Línea de tiempo vertical de un pedido.
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ nro: string }> },
) {
  const params = await ctx.params;
  let url = "";
  const nro = Number(params.nro);
  if (!Number.isInteger(nro) || nro <= 0) {
    return NextResponse.json({ error: "pedido inválido" }, { status: 400 });
  }
  url = `${API_URL}/calidad/control/${nro}`;
  try {
    const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(25000) });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      return NextResponse.json({ error: "Error en API de calidad", detail: data }, { status: res.status });
    }
    return NextResponse.json(data);
  } catch (error) {
    console.error("GET /api/calidad/control/[nro]", error);
    return NextResponse.json({ error: "No se pudo conectar al servicio de indicadores" }, { status: 503 });
  }
}
