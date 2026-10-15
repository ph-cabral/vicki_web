import { NextRequest, NextResponse } from "next/server";

const API_URL =
  process.env.INDICADORES_API_URL ?? "http://indicadores-api:8001";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Proxy → FastAPI indicadores-api: detalle de una unidad (pedido o vuelta de
// acopio) para el modal de "Control por operario" (/deposito/streaming).
// Query: ?nroPedido=N&nroRemito=N (nroRemito opcional, 0 = pedido normal).
export async function GET(req: NextRequest) {
  const sp = new URL(req.url).searchParams;
  const nroPedido = sp.get("nroPedido") ?? "";
  const nroRemito = sp.get("nroRemito") ?? "0";
  if (!/^\d+$/.test(nroPedido) || !/^\d+$/.test(nroRemito)) {
    return NextResponse.json({ error: "Parámetros inválidos" }, { status: 400 });
  }
  try {
    const res = await fetch(
      `${API_URL}/deposito/control-asignacion/detalle?nroPedido=${nroPedido}&nroRemito=${nroRemito}`,
      { cache: "no-store", signal: AbortSignal.timeout(25000) },
    );
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      return NextResponse.json(
        { error: data?.detail ?? "No se pudo cargar el pedido", detail: data },
        { status: res.status },
      );
    }
    return NextResponse.json(data);
  } catch (error) {
    console.error("GET /api/deposito/control-asignacion/detalle", error);
    return NextResponse.json(
      { error: "No se pudo conectar al servicio de depósito" },
      { status: 503 },
    );
  }
}
