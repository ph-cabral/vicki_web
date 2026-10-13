import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
type Params = { params: Promise<{ pid: string; eid: string }> };

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { pid, eid } = await params;
  const r = await prisma.rrhh_busqueda_evento.deleteMany({
    where: { id: Number(eid), postulanteId: Number(pid) },
  });
  return r.count
    ? NextResponse.json({ ok: true })
    : NextResponse.json({ error: "No existe la fecha" }, { status: 404 });
}
