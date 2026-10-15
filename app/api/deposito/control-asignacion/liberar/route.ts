import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";

const API_URL =
  process.env.INDICADORES_API_URL ?? "http://indicadores-api:8001";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Proxy → FastAPI indicadores-api: libera una unidad asignada/preasignada (y
// todas las abiertas del mismo cliente con el mismo operario) y la devuelve a
// la cola. Body: {nroPedido, nroRemito}. "usuario" sale de la sesión.
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }
  const nroPedido = Number(body.nroPedido);
  const nroRemito = Number(body.nroRemito ?? 0);
  if (!Number.isInteger(nroPedido) || nroPedido <= 0 || !Number.isInteger(nroRemito) || nroRemito < 0) {
    return NextResponse.json({ error: "Parámetros inválidos" }, { status: 400 });
  }
  const s = await getSession();

  try {
    const res = await fetch(`${API_URL}/deposito/control-asignacion/liberar`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nroPedido, nroRemito, usuario: s?.nombre ?? null }),
      signal: AbortSignal.timeout(25000),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      return NextResponse.json(
        { error: data?.detail ?? "No se pudo liberar", detail: data },
        { status: res.status },
      );
    }
    return NextResponse.json(data);
  } catch (error) {
    console.error("POST /api/deposito/control-asignacion/liberar", error);
    return NextResponse.json(
      { error: "No se pudo conectar al servicio de depósito" },
      { status: 503 },
    );
  }
}
