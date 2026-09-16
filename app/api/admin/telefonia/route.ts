import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth/guard";
import { cifrarClave } from "@/lib/telefonia/cifrado";
import { configIssabel, extensionValida } from "@/lib/telefonia/config";

export const dynamic = "force-dynamic";

// Usuarios activos + su extensión (sin la clave) para /admin/telefonia.
export async function GET() {
  const g = await requireAdmin();
  if (!g.ok) return NextResponse.json({ error: g.error }, { status: g.status });

  const usuarios = await prisma.usuario.findMany({
    where: { activo: true },
    orderBy: { nombre: "asc" },
    select: {
      id: true,
      nombre: true,
      sector: true,
      extension: { select: { extension: true, activo: true } },
    },
  });

  return NextResponse.json({
    configurada: configIssabel() !== null,
    usuarios: usuarios.map((u) => ({
      id: u.id,
      nombre: u.nombre,
      sector: u.sector,
      extension: u.extension?.extension ?? null,
      activo: u.extension?.activo ?? false,
    })),
  });
}

// Asigna / cambia la extensión de un usuario.
// body: { usuarioId, extension, clave? , activo? } — la clave es obligatoria
// sólo al asignar por primera vez; vacía = se conserva la guardada.
export async function PUT(req: NextRequest) {
  const g = await requireAdmin();
  if (!g.ok) return NextResponse.json({ error: g.error }, { status: g.status });

  const b = await req.json().catch(() => null);
  const usuarioId = Number(b?.usuarioId);
  const extension = typeof b?.extension === "string" ? b.extension.trim() : "";
  const clave = typeof b?.clave === "string" ? b.clave : "";
  const activo = b?.activo === undefined ? true : Boolean(b.activo);

  if (!Number.isInteger(usuarioId) || usuarioId <= 0)
    return NextResponse.json({ error: "usuarioId inválido" }, { status: 400 });
  if (!extensionValida(extension))
    return NextResponse.json({ error: "Extensión inválida (sólo números)" }, { status: 400 });

  const [actual, ocupada] = await Promise.all([
    prisma.usuario_extension.findUnique({ where: { usuarioId }, select: { id: true } }),
    prisma.usuario_extension.findUnique({
      where: { extension },
      select: { usuarioId: true, usuario: { select: { nombre: true } } },
    }),
  ]);

  if (ocupada && ocupada.usuarioId !== usuarioId)
    return NextResponse.json(
      { error: `La extensión ${extension} ya la tiene ${ocupada.usuario.nombre}` },
      { status: 409 },
    );
  if (!actual && !clave)
    return NextResponse.json({ error: "Falta la clave SIP de la extensión" }, { status: 400 });

  const data = {
    extension,
    activo,
    ...(clave ? { sipClaveCifrada: cifrarClave(clave) } : {}),
  };

  if (actual) {
    await prisma.usuario_extension.update({ where: { usuarioId }, data });
  } else {
    await prisma.usuario_extension.create({
      data: { usuarioId, extension, activo, sipClaveCifrada: cifrarClave(clave) },
    });
  }

  return NextResponse.json({ ok: true });
}

// Quita la extensión a un usuario.
export async function DELETE(req: NextRequest) {
  const g = await requireAdmin();
  if (!g.ok) return NextResponse.json({ error: g.error }, { status: g.status });

  const b = await req.json().catch(() => null);
  const usuarioId = Number(b?.usuarioId);
  if (!Number.isInteger(usuarioId) || usuarioId <= 0)
    return NextResponse.json({ error: "usuarioId inválido" }, { status: 400 });

  await prisma.usuario_extension.deleteMany({ where: { usuarioId } });
  return NextResponse.json({ ok: true });
}
