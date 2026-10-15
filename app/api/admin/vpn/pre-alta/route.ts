import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth/guard";
import { preAltaUsuario } from "@/lib/vpn/wireguard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Alta remota: el admin genera el código VPN de un usuario que no está en la oficina.
// El usuario lo pega en la app Vicki y entra por el túnel. Re-generar invalida el código anterior.
export async function POST(req: NextRequest) {
  const g = await requireAdmin();
  if (!g.ok) return NextResponse.json({ error: g.error }, { status: g.status });

  const body = await req.json().catch(() => null);
  const uid = Number(body?.uid);
  if (!Number.isInteger(uid) || uid <= 0) return NextResponse.json({ error: "uid inválido" }, { status: 400 });

  const u = await prisma.usuario.findUnique({ where: { id: uid }, select: { id: true, nombre: true, activo: true } });
  if (!u || !u.activo) return NextResponse.json({ error: "Usuario inexistente o inactivo" }, { status: 404 });

  try {
    const codigo = await preAltaUsuario({ uid: u.id, nombreUsuario: u.nombre });
    return NextResponse.json({ codigo, nombre: u.nombre }, { headers: { "Cache-Control": "no-store" } });
  } catch (e: any) {
    console.error("[vpn/pre-alta]", e);
    return NextResponse.json({ error: e?.message ?? "No se pudo generar el código" }, { status: 502 });
  }
}
