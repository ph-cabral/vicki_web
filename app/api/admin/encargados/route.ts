import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth/guard";
import { MODULES, isModuleKey } from "@/lib/auth/modules";

export const dynamic = "force-dynamic";

// Catálogo de módulos + usuarios activos no-admin + quién es encargado de
// qué, para armar la matriz en /admin/encargados.
export async function GET() {
  const g = await requireAdmin();
  if (!g.ok) return NextResponse.json({ error: g.error }, { status: g.status });

  const [usuarios, asignaciones] = await Promise.all([
    prisma.usuario.findMany({
      where: { activo: true, rol: "USUARIO" },
      orderBy: { nombre: "asc" },
      select: { id: true, nombre: true, sector: true },
    }),
    prisma.usuario_modulo_encargado.findMany({
      select: { usuarioId: true, modulo: true },
    }),
  ]);

  return NextResponse.json({
    modulos: MODULES.map((m) => ({ key: m.key, label: m.label })),
    usuarios,
    asignaciones,
  });
}

function parseBody(body: any): { usuarioId: number; modulo: string } | null {
  const usuarioId = Number(body?.usuarioId);
  const modulo = body?.modulo;
  if (!Number.isInteger(usuarioId) || usuarioId <= 0 || !isModuleKey(modulo)) return null;
  return { usuarioId, modulo };
}

// Marca a un usuario como encargado de un módulo (idempotente).
export async function POST(req: NextRequest) {
  const g = await requireAdmin();
  if (!g.ok) return NextResponse.json({ error: g.error }, { status: g.status });

  const parsed = parseBody(await req.json().catch(() => null));
  if (!parsed) return NextResponse.json({ error: "usuarioId/modulo inválido" }, { status: 400 });

  await prisma.usuario_modulo_encargado.upsert({
    where: { usuarioId_modulo: parsed },
    create: parsed,
    update: {},
  });

  return NextResponse.json({ ok: true });
}

// Saca a un usuario de encargado de un módulo.
export async function DELETE(req: NextRequest) {
  const g = await requireAdmin();
  if (!g.ok) return NextResponse.json({ error: g.error }, { status: g.status });

  const parsed = parseBody(await req.json().catch(() => null));
  if (!parsed) return NextResponse.json({ error: "usuarioId/modulo inválido" }, { status: 400 });

  await prisma.usuario_modulo_encargado.deleteMany({ where: parsed });

  return NextResponse.json({ ok: true });
}
