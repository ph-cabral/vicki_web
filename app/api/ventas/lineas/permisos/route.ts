import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth/guard";
import { getSession } from "@/lib/auth/session";
import { catalogoLineas, etiquetasLineas } from "@/lib/ventas/lineasAcceso";

export const dynamic = "force-dynamic";

// Configuración de qué líneas ve cada usuario en la vista de líneas
// (/ventas/bulones) — 2026-09-23. SÓLO ADMIN.
//
//   GET -> { lineas: [{id,nombre}], defecto,
//            usuarios: [{ id, nombre, rol, sector, vendedorCodigo, activo,
//                         bulonesAccesoTotal, lineas: number[] }] }
//          `lineas` vacío en un no-admin = sin configurar = sólo Bulones.
//   PUT { usuarioId, lineas: number[] } -> reemplaza las líneas del usuario
//          (en una transacción). Lista vacía = vuelve al defecto (Bulones).
//
// Una sola lectura para toda la pantalla: usuarios + todas sus filas de
// permiso (unas decenas), no una consulta por usuario.

export async function GET() {
  const g = await requireAdmin();
  if (!g.ok) return NextResponse.json({ error: g.error }, { status: g.status });

  let cat;
  try {
    cat = await catalogoLineas();
  } catch (e) {
    console.error("GET /api/ventas/lineas/permisos", e);
    return NextResponse.json({ error: "No se pudo leer el catálogo de líneas" }, { status: 503 });
  }

  const [usuarios, filas] = await Promise.all([
    prisma.usuario.findMany({
      orderBy: [{ activo: "desc" }, { nombre: "asc" }],
      select: {
        id: true,
        nombre: true,
        rol: true,
        sector: true,
        vendedorCodigo: true,
        activo: true,
        bulonesAccesoTotal: true,
      },
    }),
    prisma.usuario_linea_venta.findMany({ select: { usuarioId: true, lineaId: true } }),
  ]);

  const porUsuario = new Map<number, number[]>();
  for (const f of filas) {
    const a = porUsuario.get(f.usuarioId) ?? [];
    a.push(f.lineaId);
    porUsuario.set(f.usuarioId, a);
  }

  return NextResponse.json({
    lineas: etiquetasLineas(cat.lineas),
    defecto: cat.defecto,
    usuarios: usuarios.map((u) => ({ ...u, lineas: porUsuario.get(u.id) ?? [] })),
  });
}

export async function PUT(req: NextRequest) {
  const g = await requireAdmin();
  if (!g.ok) return NextResponse.json({ error: g.error }, { status: g.status });
  const session = await getSession();

  const body = await req.json().catch(() => null);
  const usuarioId = Number(body?.usuarioId);
  if (!Number.isInteger(usuarioId) || usuarioId <= 0)
    return NextResponse.json({ error: "Falta 'usuarioId'" }, { status: 400 });
  if (!Array.isArray(body?.lineas))
    return NextResponse.json({ error: "Falta 'lineas' (lista de ids)" }, { status: 400 });

  let cat;
  try {
    cat = await catalogoLineas();
  } catch {
    return NextResponse.json({ error: "No se pudo leer el catálogo de líneas" }, { status: 503 });
  }
  const validos = new Set(cat.lineas.map((l) => l.id));
  const ids = [...new Set((body.lineas as unknown[]).map((v) => Number(v)))];
  const malos = ids.filter((id) => !Number.isInteger(id) || !validos.has(id));
  if (malos.length)
    return NextResponse.json({ error: `Líneas inexistentes: ${malos.join(", ")}` }, { status: 400 });

  const existe = await prisma.usuario.findUnique({ where: { id: usuarioId }, select: { id: true } });
  if (!existe) return NextResponse.json({ error: "Usuario inexistente" }, { status: 404 });

  await prisma.$transaction([
    prisma.usuario_linea_venta.deleteMany({ where: { usuarioId } }),
    ...(ids.length
      ? [
          prisma.usuario_linea_venta.createMany({
            data: ids.map((lineaId) => ({ usuarioId, lineaId, creadoPor: session?.uid ?? null })),
          }),
        ]
      : []),
  ]);

  return NextResponse.json({ ok: true, usuarioId, lineas: ids });
}
