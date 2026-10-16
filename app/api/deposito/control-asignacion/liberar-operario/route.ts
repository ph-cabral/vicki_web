import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";

const API_URL =
  process.env.INDICADORES_API_URL ?? "http://indicadores-api:8001";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Proxy → FastAPI indicadores-api: "Liberar todos" de un operario — devuelve a
// la cola todo lo asignado sin cerrar y lo preasignado de ese operario
// (nroOperario 0 = pseudo-operario "Bloqueados": desbloquea todos).
// Body: {nroOperario}. "usuario" sale de la sesión.
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }
  const nroOperario = Number(body.nroOperario);
  if (!Number.isInteger(nroOperario) || nroOperario < 0) {
    return NextResponse.json({ error: "Parámetros inválidos" }, { status: 400 });
  }
  const s = await getSession();

  try {
    const res = await fetch(`${API_URL}/deposito/control-asignacion/liberar-operario`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nroOperario, usuario: s?.nombre ?? null }),
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
    console.error("POST /api/deposito/control-asignacion/liberar-operario", error);
    return NextResponse.json(
      { error: "No se pudo conectar al servicio de depósito" },
      { status: 503 },
    );
  }
}
