import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth/session";
import { descifrarClave } from "@/lib/telefonia/cifrado";
import { configIssabel } from "@/lib/telefonia/config";

export const dynamic = "force-dynamic";

// Credenciales SIP del usuario logueado para que el softphone del navegador se
// registre en Issabel. Sólo devuelve la extensión PROPIA (nunca por parámetro).
// 204 = el usuario no tiene extensión asignada (el softphone no se muestra).
export async function GET() {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "No autenticado" }, { status: 401 });

  const cfg = configIssabel();
  if (!cfg) return new NextResponse(null, { status: 204 });

  const row = await prisma.usuario_extension.findUnique({
    where: { usuarioId: s.uid },
    select: { extension: true, sipClaveCifrada: true, activo: true },
  });
  if (!row || !row.activo) return new NextResponse(null, { status: 204 });

  const clave = descifrarClave(row.sipClaveCifrada);
  if (clave === null) {
    return NextResponse.json(
      { error: "La clave de la extensión no se pudo leer: volver a cargarla en Administración › Telefonía" },
      { status: 500 },
    );
  }

  return NextResponse.json(
    {
      extension: row.extension,
      clave,
      nombre: s.nombre,
      wsUrl: cfg.wsUrl,
      dominio: cfg.dominio,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
