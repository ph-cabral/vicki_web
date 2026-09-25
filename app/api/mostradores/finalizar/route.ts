import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";

const API_URL = process.env.INDICADORES_API_URL ?? "http://indicadores-api:8001";

export const dynamic = "force-dynamic";

// Finaliza el control de un patrón desde el PDA (Mostradores → Control).
//   POST { controlId } -> { ok, controlId, patron, contados, sinContarConStock, conDiferencia, cerradoAt }
// Guarda código / controlado / sistema / diferencia / usuario en
// everwear.mostrador_control_detalle. El usuario sale de la sesión, nunca del body.
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autenticado" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as { controlId?: unknown } | null;
  const controlId = Number(body?.controlId);
  if (!Number.isInteger(controlId) || controlId <= 0) {
    return NextResponse.json({ error: "Control inválido" }, { status: 400 });
  }

  try {
    const res = await fetch(`${API_URL}/mostradores/finalizar`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ controlId, usuarioId: session.uid, usuarioNombre: session.nombre }),
      cache: "no-store",
      signal: AbortSignal.timeout(60000),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      return NextResponse.json(
        { error: typeof json?.detail === "string" ? json.detail : "No se pudo finalizar" },
        { status: res.status },
      );
    }
    return NextResponse.json(json);
  } catch (error) {
    console.error("POST /api/mostradores/finalizar", error);
    return NextResponse.json({ error: "No se pudo conectar al servicio" }, { status: 503 });
  }
}
