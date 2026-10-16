// /rrhh/busqueda — detalle (postulantes + fechas + datos del candidato), edición y baja.
import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
type Params = { params: Promise<{ id: string }> };

type CandRow = {
  id: number; nombre: string | null; apellido: string | null; email: string | null;
  telefono: string | null; dni: string | null; documento_id: number | null;
};

export async function GET(_req: NextRequest, { params }: Params) {
  const id = Number((await params).id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: "id inválido" }, { status: 400 });
  const b = await prisma.rrhh_busqueda.findUnique({
    where: { id },
    include: {
      puesto: { select: { id: true, nombre: true } },
      area: { select: { id: true, nombre: true } },
      motivo: { select: { id: true, nombre: true } },
      postulantes: {
        orderBy: { createdAt: "asc" },
        include: { eventos: { orderBy: { fecha: "asc" } } },
      },
    },
  });
  if (!b) return NextResponse.json({ error: "No existe la búsqueda" }, { status: 404 });

  // Datos del candidato (rag_system, otro schema → SQL crudo). Una sola consulta;
  // el último CV por candidato sale del índice documento_aprobado_candidato_cv_idx.
  const ids = b.postulantes.map((p) => p.candidatoId);
  const cands = new Map<number, CandRow>();
  if (ids.length) {
    const rows = await prisma.$queryRaw<CandRow[]>(Prisma.sql`
      SELECT c.id, c.nombre, c.apellido, c.email, c.telefono, c.dni,
             (SELECT d.id FROM rag_system.documento_aprobado d
               WHERE d.candidato_id = c.id AND d.tipo = 'CV'
               ORDER BY d.aprobado_at DESC NULLS LAST LIMIT 1) AS documento_id
        FROM rag_system.candidato c
       WHERE c.id = ANY(${ids}::int[])`);
    for (const r of rows) cands.set(Number(r.id), { ...r, id: Number(r.id), documento_id: r.documento_id == null ? null : Number(r.documento_id) });
  }
  return NextResponse.json({
    ...b,
    postulantes: b.postulantes.map((p) => {
      const c = cands.get(p.candidatoId);
      return {
        ...p,
        candidato: c
          ? {
              nombre: [c.nombre, c.apellido].filter(Boolean).join(" ").trim() || "Sin nombre",
              email: c.email, telefono: c.telefono, dni: c.dni, documentoId: c.documento_id,
            }
          : { nombre: `Candidato #${p.candidatoId}`, email: null, telefono: null, dni: null, documentoId: null },
      };
    }),
  });
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const id = Number((await params).id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: "id inválido" }, { status: 400 });
  const body = await req.json().catch(() => ({}));
  const data: Prisma.rrhh_busquedaUncheckedUpdateInput = {};
  if (body.titulo !== undefined) {
    const t = String(body.titulo).trim();
    if (!t) return NextResponse.json({ error: "Falta el título" }, { status: 400 });
    data.titulo = t;
  }
  if (body.descripcion !== undefined) data.descripcion = body.descripcion ? String(body.descripcion) : null;
  if (body.puestoId !== undefined) data.puestoId = body.puestoId ? Number(body.puestoId) : null;
  if (body.areaId !== undefined) data.areaId = body.areaId ? Number(body.areaId) : null;
  if (body.motivoId !== undefined) data.motivoId = body.motivoId ? Number(body.motivoId) : null;
  if (body.estado !== undefined) {
    if (body.estado !== "ABIERTA" && body.estado !== "CERRADA")
      return NextResponse.json({ error: "estado inválido" }, { status: 400 });
    data.estado = body.estado;
    data.cerradaEn = body.estado === "CERRADA" ? new Date() : null;
  }
  try {
    return NextResponse.json(await prisma.rrhh_busqueda.update({ where: { id }, data }));
  } catch {
    return NextResponse.json({ error: "No se pudo actualizar" }, { status: 404 });
  }
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const id = Number((await params).id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: "id inválido" }, { status: 400 });
  try {
    await prisma.rrhh_busqueda.delete({ where: { id } }); // cascada: postulantes y fechas
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "No existe la búsqueda" }, { status: 404 });
  }
}
