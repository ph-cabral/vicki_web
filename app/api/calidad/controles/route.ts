import { NextRequest, NextResponse } from "next/server";

const API_URL =
  process.env.INDICADORES_API_URL ?? "http://indicadores-api:8001";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Proxy → indicadores-api (calidad.py). Pedidos tomados en mesa por un cliente.
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  let url = "";
  const cod = Number(sp.get("codCliente"));
  if (!Number.isInteger(cod) || cod <= 0) {
    return NextResponse.json({ error: "codCliente inválido" }, { status: 400 });
  }
  const dias = Math.min(Math.max(Number(sp.get("dias")) || 90, 1), 365);
  url = `${API_URL}/calidad/controles?cod_cliente=${cod}&dias=${dias}`;
  try {
    const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(25000) });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      return NextResponse.json({ error: "Error en API de calidad", detail: data }, { status: res.status });
    }
    return NextResponse.json(data);
  } catch (error) {
    console.error("GET /api/calidad/controles", error);
    return NextResponse.json({ error: "No se pudo conectar al servicio de indicadores" }, { status: 503 });
  }
}
