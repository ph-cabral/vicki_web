// Celular registrado en la app Vicki para el usuario de este legajo (ver lib/auth/dispositivo.ts).
// El middleware ya exige el módulo rrhh para /api/rrhh/*.
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

function parseId(v: string) {
  const id = Number(v);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function usuarioDelLegajo(legajoId: number) {
  return prisma.usuario.findUnique({
    where: { legajoId },
    select: { id: true, dni: true, nombre: true },
  });
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ legajo: string }> },
) {
  const legajoId = parseId((await params).legajo);
  if (legajoId === null) return NextResponse.json({ error: "id inválido" }, { status: 400 });

  const usuario = await usuarioDelLegajo(legajoId);
  if (!usuario) return NextResponse.json({ usuario: null, dispositivos: [] });

  const dispositivos = await prisma.usuario_dispositivo.findMany({
    where: { usuarioId: usuario.id },
    orderBy: [{ estado: "asc" }, { ultimoAcceso: "desc" }],
  });
  return NextResponse.json({ usuario, dispositivos });
}

// accion: "liberar" (borra el celular ACTIVO: el usuario puede registrar otro, p. ej. cambió de
// celular o lo reseteó de fábrica) | "bloquear" (robado: ese celular no entra más) |
// "desbloquear" (borra el bloqueo).
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ legajo: string }> },
) {
  const legajoId = parseId((await params).legajo);
  if (legajoId === null) return NextResponse.json({ error: "id inválido" }, { status: 400 });
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "No autenticado" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const accion = String(body?.accion ?? "");
  const id = parseId(String(body?.id ?? ""));
  if (id === null || !["liberar", "bloquear", "desbloquear"].includes(accion))
    return NextResponse.json({ error: "Datos inválidos" }, { status: 400 });

  const usuario = await usuarioDelLegajo(legajoId);
  if (!usuario) return NextResponse.json({ error: "El legajo no tiene usuario" }, { status: 404 });

  const disp = await prisma.usuario_dispositivo.findFirst({
    where: { id, usuarioId: usuario.id },
  });
  if (!disp) return NextResponse.json({ error: "Celular no encontrado" }, { status: 404 });

  if (accion === "bloquear") {
    await prisma.usuario_dispositivo.update({
      where: { id },
      data: { estado: "BLOQUEADO", bloqueadoAt: new Date(), bloqueadoPor: s.uid },
    });
  } else if (accion === "liberar") {
    if (disp.estado !== "ACTIVO")
      return NextResponse.json({ error: "Ese celular está bloqueado: usá Desbloquear" }, { status: 409 });
    await prisma.usuario_dispositivo.delete({ where: { id } });
  } else {
    if (disp.estado !== "BLOQUEADO")
      return NextResponse.json({ error: "Ese celular no está bloqueado" }, { status: 409 });
    await prisma.usuario_dispositivo.delete({ where: { id } });
  }
  return NextResponse.json({ ok: true });
}
