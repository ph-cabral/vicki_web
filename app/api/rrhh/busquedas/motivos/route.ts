// /rrhh/busqueda — catálogo de motivos de búsqueda (reemplazo, puesto nuevo, ...).
// GET lista; POST agrega uno (si ya existe, sin importar mayúsculas, devuelve el existente).
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { esTablaFaltante, TABLA_FALTA_MSG } from "@/lib/rrhh/busqueda";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(
      await prisma.rrhh_busqueda_motivo.findMany({ orderBy: { nombre: "asc" }, select: { id: true, nombre: true } }),
    );
  } catch (e) {
    if (esTablaFaltante(e)) return NextResponse.json([], { status: 200 });
    console.error("GET /api/rrhh/busquedas/motivos", e);
    return NextResponse.json({ error: "No se pudieron leer los motivos" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const nombre = String(body?.nombre ?? "").trim().replace(/\s+/g, " ").slice(0, 80);
  if (!nombre) return NextResponse.json({ error: "Falta el motivo" }, { status: 400 });
  try {
    const ya = await prisma.rrhh_busqueda_motivo.findFirst({
      where: { nombre: { equals: nombre, mode: "insensitive" } },
      select: { id: true, nombre: true },
    });
    if (ya) return NextResponse.json(ya);
    const m = await prisma.rrhh_busqueda_motivo.create({ data: { nombre }, select: { id: true, nombre: true } });
    return NextResponse.json(m, { status: 201 });
  } catch (e) {
    if (esTablaFaltante(e)) return NextResponse.json({ error: TABLA_FALTA_MSG }, { status: 500 });
    console.error("POST /api/rrhh/busquedas/motivos", e);
    return NextResponse.json({ error: "No se pudo agregar el motivo" }, { status: 500 });
  }
}
