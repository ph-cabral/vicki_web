import { NextRequest, NextResponse } from "next/server";
import { sessionIdVicki } from "@/lib/vicki/sesionChat";

export const dynamic = "force-dynamic";

const VICKI_URL = process.env.VICKI_API_URL ?? "http://chat-agent:8000";

// Deshacer un descarte: el candidato vuelve a la barra y a las búsquedas.
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ session_id: string; candidato_id: string }> },
) {
  const { session_id, candidato_id } = await params;
  // Cada uno opera sobre su propia conversación (ver lib/vicki/sesionChat.ts).
  const sid = await sessionIdVicki(session_id);
  if (!sid) return NextResponse.json({ error: "No autenticado" }, { status: 401 });
  if (sid !== session_id) {
    return NextResponse.json({ error: "No corresponde" }, { status: 403 });
  }
  if (!/^\d+$/.test(candidato_id)) {
    return NextResponse.json({ error: "candidato inválido" }, { status: 400 });
  }
  try {
    const r = await fetch(
      `${VICKI_URL}/descartes/${encodeURIComponent(session_id)}/${candidato_id}`,
      { method: "DELETE", signal: AbortSignal.timeout(10000) },
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
