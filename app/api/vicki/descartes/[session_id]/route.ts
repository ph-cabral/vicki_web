import { NextRequest, NextResponse } from "next/server";
import { sessionIdVicki } from "@/lib/vicki/sesionChat";

export const dynamic = "force-dynamic";

const VICKI_URL = process.env.VICKI_API_URL ?? "http://chat-agent:8000";

// Candidatos que el reclutador saca de la conversación (tacho de la barra de
// CVs). Solo afecta a la conversación: no toca la base ni Qdrant.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ session_id: string }> },
) {
  const { session_id } = await params;
  // Cada uno opera sobre su propia conversación (ver lib/vicki/sesionChat.ts).
  const sid = await sessionIdVicki();
  if (!sid) return NextResponse.json({ error: "No autenticado" }, { status: 401 });
  if (sid !== session_id) {
    return NextResponse.json({ error: "No corresponde" }, { status: 403 });
  }

  return proxy(`${VICKI_URL}/descartes/${encodeURIComponent(session_id)}`, {});
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ session_id: string }> },
) {
  const { session_id } = await params;
  // Cada uno opera sobre su propia conversación (ver lib/vicki/sesionChat.ts).
  const sid = await sessionIdVicki();
  if (!sid) return NextResponse.json({ error: "No autenticado" }, { status: 401 });
  if (sid !== session_id) {
    return NextResponse.json({ error: "No corresponde" }, { status: 403 });
  }

  const body = await req.text();
  return proxy(`${VICKI_URL}/descartes/${encodeURIComponent(session_id)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

async function proxy(url: string, init: RequestInit) {
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(10000) });
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
