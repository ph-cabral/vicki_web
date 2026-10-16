import { NextResponse } from "next/server";
import { uidVicki } from "@/lib/vicki/sesionChat";

export const dynamic = "force-dynamic";

const VICKI_URL = process.env.VICKI_API_URL ?? "http://chat-agent:8000";

// Lista de conversaciones del usuario logueado (solo lectura): título, fecha y
// cantidad de mensajes. El uid sale de la cookie, nunca del cliente.
export async function GET() {
  const uid = await uidVicki();
  if (uid == null) return NextResponse.json({ error: "No autenticado" }, { status: 401 });
  try {
    const headers: Record<string, string> = {};
    if (process.env.VICKI_API_TOKEN) headers["X-Vicki-Token"] = process.env.VICKI_API_TOKEN;
    const r = await fetch(`${VICKI_URL}/conversaciones/${uid}`, {
      headers,
      signal: AbortSignal.timeout(10000),
    });
    const txt = await r.text();
    return new NextResponse(txt, {
      status: r.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Error de conexión a Vicki" }, { status: 502 });
  }
}
