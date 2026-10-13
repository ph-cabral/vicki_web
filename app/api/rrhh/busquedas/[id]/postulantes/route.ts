// Vincula un candidato (rag_system.candidato) a una búsqueda.
import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
type Params = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  const busquedaId = Number((await params).id);
  const body = await req.json().catch(() => null);
  const candidatoId = Number(body?.candidatoId);
  if (!Number.isInteger(busquedaId) || !Number.isInteger(candidatoId))
    return NextResponse.json({ error: "datos inválidos" }, { status: 400 });
  const ok = await prisma.$queryRaw<{ id: number }[]>(
    Prisma.sql`SELECT id FROM rag_system.candidato WHERE id = ${candidatoId}::int`,
  );
  if (!ok.length) return NextResponse.json({ error: "El candidato no existe" }, { status: 404 });
  try {
    const p = await prisma.rrhh_busqueda_postulante.create({ data: { busquedaId, candidatoId } });
    return NextResponse.json(p, { status: 201 });
  } catch (e) {
    const dup = e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
    return NextResponse.json(
      { error: dup ? "Ya está vinculado a esta búsqueda" : "No se pudo vincular" },
      { status: dup ? 409 : 500 },
    );
  }
}
