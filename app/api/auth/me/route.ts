import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession, sessionCookieOptions, SESSION_COOKIE } from "@/lib/auth/session";
import { validarDispositivo } from "@/lib/auth/dispositivo";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const s = await getSession();
  // hasUsers permite a /login mostrar el alta del primer admin (bootstrap).
  // dbReady=false => la tabla everwear.usuario no existe o falta `prisma generate`.
  let hasUsers = false;
  let dbReady = true;
  try {
    hasUsers = (await prisma.usuario.count()) > 0;
  } catch {
    dbReady = false;
  }
  if (!s) return NextResponse.json({ usuario: null, hasUsers, dbReady });
  // App Android: si el celular fue liberado/bloqueado desde el legajo, se corta la sesión acá.
  const disp = await validarDispositivo(s.uid, req.headers.get("user-agent"), false);
  if (!disp.ok) {
    const res = NextResponse.json({ usuario: null, hasUsers, dbReady, error: disp.error });
    res.cookies.set(SESSION_COOKIE, "", sessionCookieOptions(0));
    return res;
  }
  return NextResponse.json({
    hasUsers,
    dbReady,
    usuario: {
      uid: s.uid,
      dni: s.dni,
      nombre: s.nombre,
      rol: s.rol,
      mods: s.mods,
    },
  });
}
