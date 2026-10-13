// Estado y motivo de un postulante dentro de una búsqueda / desvincularlo.
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { esEstado } from "@/lib/rrhh/busqueda";

export const dynamic = "force-dynamic";
type Params = { params: Promise<{ pid: string }> };

export async function PATCH(req: NextRequest, { params }: Params) {
  const id = Number((await params).pid);
  if (!Number.isInteger(id)) return NextResponse.json({ error: "id inválido" }, { status: 400 });
  const body = await req.json().catch(() => ({}));
  const data: { estado?: string; motivo?: string | null } = {};
  if (body.estado !== undefined) {
    if (!esEstado(body.estado)) return NextResponse.json({ error: "estado inválido" }, { status: 400 });
    data.estado = body.estado;
  }
  if (body.motivo !== undefined) data.motivo = body.motivo ? String(body.motivo).trim() || null : null;
  try {
    return NextResponse.json(await prisma.rrhh_busqueda_postulante.update({ where: { id }, data }));
  } catch {
    return NextResponse.json({ error: "No existe el postulante" }, { status: 404 });
  }
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const id = Number((await params).pid);
  if (!Number.isInteger(id)) return NextResponse.json({ error: "id inválido" }, { status: 400 });
  try {
    await prisma.rrhh_busqueda_postulante.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "No existe el postulante" }, { status: 404 });
  }
}
