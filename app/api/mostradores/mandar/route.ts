import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";

const API_URL = process.env.INDICADORES_API_URL ?? "http://indicadores-api:8001";

export const dynamic = "force-dynamic";

// Manda un código patrón a control (queda pendiente en Mostradores → Control).
// El usuario sale de la sesión, nunca del body.
//   POST { codigoPatron } -> { ok, yaPendiente }
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autenticado" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as { codigoPatron?: unknown } | null;
  const codigoPatron = typeof body?.codigoPatron === "string" ? body.codigoPatron.trim() : "";
  if (!codigoPatron) {
    return NextResponse.json({ error: "Falta el código patrón" }, { status: 400 });
  }

  try {
    const res = await fetch(`${API_URL}/mostradores/mandar`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ codigoPatron, usuarioId: session.uid }),
      cache: "no-store",
      signal: AbortSignal.timeout(30000),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      return NextResponse.json(
        { error: typeof json?.detail === "string" ? json.detail : "No se pudo mandar a control" },
        { status: res.status },
      );
    }
    return NextResponse.json(json);
  } catch (error) {
    console.error("POST /api/mostradores/mandar", error);
    return NextResponse.json({ error: "No se pudo conectar al servicio" }, { status: 503 });
  }
}
