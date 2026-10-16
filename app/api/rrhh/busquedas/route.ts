// /rrhh/busqueda — listado y alta de búsquedas.
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth/session";
import { esTablaFaltante, TABLA_FALTA_MSG } from "@/lib/rrhh/busqueda";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [busquedas, conteo] = await Promise.all([
      prisma.rrhh_busqueda.findMany({
        orderBy: [{ estado: "asc" }, { abiertaEn: "desc" }, { id: "desc" }],
        include: { puesto: { select: { id: true, nombre: true } }, area: { select: { id: true, nombre: true } }, motivo: { select: { id: true, nombre: true } } },
      }),
      prisma.rrhh_busqueda_postulante.groupBy({
        by: ["busquedaId", "estado"],
        _count: { _all: true },
      }),
    ]);
    const porBusqueda = new Map<number, Record<string, number>>();
    for (const c of conteo) {
      const m = porBusqueda.get(c.busquedaId) ?? {};
      m[c.estado] = c._count._all;
      porBusqueda.set(c.busquedaId, m);
    }
    return NextResponse.json(
      busquedas.map((b) => ({ ...b, conteo: porBusqueda.get(b.id) ?? {} })),
    );
  } catch (e) {
    if (esTablaFaltante(e)) return NextResponse.json({ busquedas: [], tablaWarn: TABLA_FALTA_MSG }, { status: 200 });
    console.error("GET /api/rrhh/busquedas", e);
    return NextResponse.json({ error: "No se pudieron leer las búsquedas" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const titulo = String(body?.titulo ?? "").trim();
  if (!titulo) return NextResponse.json({ error: "Falta el puesto" }, { status: 400 });
  const s = await getSession();
  try {
    const b = await prisma.rrhh_busqueda.create({
      data: {
        titulo,
        descripcion: body?.descripcion ? String(body.descripcion) : null,
        puestoId: body?.puestoId ? Number(body.puestoId) : null,
        areaId: body?.areaId ? Number(body.areaId) : null,
        motivoId: body?.motivoId ? Number(body.motivoId) : null,
        creadoPor: s?.nombre ?? null,
      },
    });
    return NextResponse.json(b, { status: 201 });
  } catch (e) {
    if (esTablaFaltante(e)) return NextResponse.json({ error: TABLA_FALTA_MSG }, { status: 500 });
    console.error("POST /api/rrhh/busquedas", e);
    return NextResponse.json({ error: "No se pudo crear la búsqueda" }, { status: 500 });
  }
}
