import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/guard";
import { getSession } from "@/lib/auth/session";

const API_URL =
  process.env.INDICADORES_API_URL ?? "http://indicadores-api:8001";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

type Body = {
  accion?: "matar" | "dejar";
  episodioId?: number;
  motivo?: string | null;
};

// Las dos acciones de /sistema/bloqueos. Requieren ADMIN: "matar" ejecuta un
// KILL sobre una sesión de producción (el usuario de esa PC pierde lo que
// tenga sin guardar). El KILL en sí lo hace vicki.sp_bloqueos_matar, que
// revalida que el SPID siga siendo cabeza de un episodio abierto — desde acá
// no se puede matar una sesión cualquiera.
export async function POST(req: NextRequest) {
  const g = await requireAdmin();
  if (!g.ok) return NextResponse.json({ error: g.error }, { status: g.status });

  const body: Body = await req.json().catch(() => ({}));
  if (body.accion !== "matar" && body.accion !== "dejar") {
    return NextResponse.json(
      { error: "accion debe ser 'matar' o 'dejar'" },
      { status: 400 },
    );
  }
  if (typeof body.episodioId !== "number") {
    return NextResponse.json(
      { error: "episodioId es obligatorio" },
      { status: 400 },
    );
  }

  const session = await getSession();
  try {
    const res = await fetch(`${API_URL}/sistema/bloqueos/${body.accion}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        episodioId: body.episodioId,
        usuario: session?.nombre ?? null,
        motivo: body.motivo ?? null,
      }),
      signal: AbortSignal.timeout(30000),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      return NextResponse.json(
        { error: "No se pudo ejecutar la acción", detail: data },
        { status: res.status },
      );
    }
    return NextResponse.json(data);
  } catch (error) {
    console.error("POST /api/sistema/bloqueos/accion", error);
    return NextResponse.json(
      { error: "No se pudo conectar al servicio de indicadores" },
      { status: 503 },
    );
  }
}
