import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth/session";
import { parseReporteIn, esTablaFaltante, TABLA_FALTA_MSG } from "@/lib/compras/planificacion";

export const dynamic = "force-dynamic";

// /compras/planificacion — editar (lápiz) / borrar un botón PROPIO. El WHERE
// lleva siempre "usuarioId" de la sesión: el id de otro usuario da 404.

async function idYSesion(params: Promise<{ id: string }>) {
  const s = await getSession();
  const id = Number((await params).id);
  return { s, id: Number.isInteger(id) && id > 0 ? id : null };
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { s, id } = await idYSesion(params);
  if (!s) return NextResponse.json({ error: "Sin sesión" }, { status: 401 });
  if (!id) return NextResponse.json({ error: "id inválido" }, { status: 400 });
  const r = parseReporteIn(await req.json().catch(() => null));
  if (typeof r === "string") return NextResponse.json({ error: r }, { status: 400 });
  try {
    const n = await prisma.$executeRaw`
      UPDATE preparado.compras_planificacion_reporte SET
        nombre = ${r.nombre}, lineas = ${r.lineas}::int[], rubros = ${r.rubros}::int[],
        "subRubros" = ${r.subRubros}::int[], "subSubRubros" = ${r.subSubRubros}::int[],
        meses = ${r.meses}, "updatedAt" = now()
      WHERE id = ${id} AND "usuarioId" = ${s.uid}
    `;
    if (!n) return NextResponse.json({ error: "No encontrado" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (esTablaFaltante(e)) return NextResponse.json({ error: TABLA_FALTA_MSG }, { status: 503 });
    console.error("PUT /api/compras/planificacion/reportes/[id]", e);
    return NextResponse.json({ error: "No se pudo guardar" }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { s, id } = await idYSesion(params);
  if (!s) return NextResponse.json({ error: "Sin sesión" }, { status: 401 });
  if (!id) return NextResponse.json({ error: "id inválido" }, { status: 400 });
  try {
    const n = await prisma.$executeRaw`
      DELETE FROM preparado.compras_planificacion_reporte
      WHERE id = ${id} AND "usuarioId" = ${s.uid}
    `;
    if (!n) return NextResponse.json({ error: "No encontrado" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (esTablaFaltante(e)) return NextResponse.json({ error: TABLA_FALTA_MSG }, { status: 503 });
    console.error("DELETE /api/compras/planificacion/reportes/[id]", e);
    return NextResponse.json({ error: "No se pudo borrar" }, { status: 500 });
  }
}
