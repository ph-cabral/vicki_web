import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";

const API_URL = process.env.INDICADORES_API_URL ?? "http://indicadores-api:8001";

export const dynamic = "force-dynamic";

// El usuario del PDA toma un patrón pendiente (Mostradores → Control).
//   POST { controlId } -> { ok, controlId, patron }
// De a uno por usuario: 409 si ya tiene otro activo o si lo tomó otro usuario.
// El usuario sale de la sesión, nunca del body.
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autenticado" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as { controlId?: unknown } | null;
  const controlId = Number(body?.controlId);
  if (!Number.isInteger(controlId) || controlId <= 0) {
    return NextResponse.json({ error: "Control inválido" }, { status: 400 });
  }

  try {
    const res = await fetch(`${API_URL}/mostradores/tomar`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ controlId, usuarioId: session.uid }),
      cache: "no-store",
      signal: AbortSignal.timeout(30000),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      return NextResponse.json(
        { error: typeof json?.detail === "string" ? json.detail : "No se pudo tomar el patrón" },
        { status: res.status },
      );
    }
    return NextResponse.json(json);
  } catch (error) {
    console.error("POST /api/mostradores/tomar", error);
    return NextResponse.json({ error: "No se pudo conectar al servicio" }, { status: 503 });
  }
}
