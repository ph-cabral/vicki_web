import { NextRequest, NextResponse } from "next/server";
import { sessionIdVicki } from "@/lib/vicki/sesionChat";

export const dynamic = "force-dynamic";

const VICKI_URL = process.env.VICKI_API_URL ?? "http://chat-agent:8000";

// Botón «Nueva conversación»: marca desde dónde arranca la charla nueva. NO
// borra nada — los mensajes anteriores siguen en la base y se vuelven a ver
// con /api/vicki/history/<sid>?todo=1. Lo único que cambia es hasta dónde mira
// el modelo (ver vicki_chat/app/summary.py::inicio_conversacion).
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ session_id: string }> },
) {
  const { session_id } = await params;
  const sid = await sessionIdVicki();
  if (!sid) return NextResponse.json({ error: "No autenticado" }, { status: 401 });
  if (sid !== session_id) {
    return NextResponse.json({ error: "No corresponde" }, { status: 403 });
  }
  try {
    const r = await fetch(
      `${VICKI_URL}/conversacion/${encodeURIComponent(session_id)}/nueva`,
      { method: "POST", signal: AbortSignal.timeout(10000) },
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
