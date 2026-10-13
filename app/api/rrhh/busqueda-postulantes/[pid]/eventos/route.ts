// Alta de una fecha del proceso (entrevista, preocupacional, psicotécnico, ingreso programado).
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { esTipoEvento } from "@/lib/rrhh/busqueda";

export const dynamic = "force-dynamic";
type Params = { params: Promise<{ pid: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  const postulanteId = Number((await params).pid);
  const body = await req.json().catch(() => null);
  if (!Number.isInteger(postulanteId)) return NextResponse.json({ error: "id inválido" }, { status: 400 });
  if (!esTipoEvento(body?.tipo)) return NextResponse.json({ error: "Elegí a qué corresponde la fecha" }, { status: 400 });
  const fecha = new Date(String(body?.fecha ?? ""));
  if (Number.isNaN(fecha.getTime())) return NextResponse.json({ error: "Fecha inválida" }, { status: 400 });
  try {
    const ev = await prisma.rrhh_busqueda_evento.create({
      data: { postulanteId, tipo: body.tipo, fecha, nota: body?.nota ? String(body.nota).trim() || null : null },
    });
    return NextResponse.json(ev, { status: 201 });
  } catch {
    return NextResponse.json({ error: "No existe el postulante" }, { status: 404 });
  }
}
