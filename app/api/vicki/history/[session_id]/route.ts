import { NextRequest, NextResponse } from "next/server";
import { sessionIdVicki } from "@/lib/vicki/sesionChat";

export const dynamic = "force-dynamic";

const VICKI_URL = process.env.VICKI_API_URL ?? "http://chat-agent:8000";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ session_id: string }> },
) {
  try {
    const { session_id } = await params;
    // Cada uno ve su propia conversación y nada más (ver lib/vicki/sesionChat.ts).
    const sid = await sessionIdVicki();
    if (!sid) return NextResponse.json({ error: "No autenticado" }, { status: 401 });
    if (sid !== session_id) {
      return NextResponse.json({ error: "No corresponde" }, { status: 403 });
    }
    // ?todo=1 → también los mensajes anteriores al corte de «Nueva
    // conversación» (el botón «Ver anteriores» del chat). Nada se borra nunca.
    const todo = req.nextUrl.searchParams.get("todo") === "1" ? "?todo=1" : "";
    const r = await fetch(
      `${VICKI_URL}/history/${encodeURIComponent(session_id)}${todo}`,
      { signal: AbortSignal.timeout(10000) },
    );
    const txt = await r.text();
    return new NextResponse(txt, {
      status: r.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? "Error de conexión a Vicki" },
      { status: 502 },
    );
  }
}
