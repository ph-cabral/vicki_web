import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyPassword } from "@/lib/auth/password";
import { signSession, sessionCookieOptions, SESSION_COOKIE } from "@/lib/auth/session";
import { permisosForUsuario } from "@/lib/auth/permissions";
import { validarDispositivo } from "@/lib/auth/dispositivo";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  // En producción AUTH_SECRET es obligatorio para firmar la sesión.
  if (
    process.env.NODE_ENV === "production" &&
    (!process.env.AUTH_SECRET || process.env.AUTH_SECRET.length < 16)
  ) {
    return NextResponse.json(
      { error: "Falta AUTH_SECRET en el .env del servidor (ver AUTENTICACION.md)." },
      { status: 503 },
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body inválido" }, { status: 400 });
  }

  const dni = String(body?.dni ?? "").trim();
  const password = String(body?.password ?? "");
  if (!dni || !password) {
    return NextResponse.json(
      { error: "DNI y contraseña son obligatorios" },
      { status: 400 },
    );
  }

  const usuario = await prisma.usuario.findUnique({ where: { dni } });
  // Mismo mensaje para usuario inexistente / inactivo / pass incorrecta (no filtrar info).
  if (!usuario || !usuario.activo || !verifyPassword(password, usuario.passwordHash)) {
    return NextResponse.json({ error: "DNI o contraseña incorrectos" }, { status: 401 });
  }

  // App Android: un solo celular por usuario (lib/auth/dispositivo.ts). Se valida
  // DESPUÉS de la contraseña para no revelar nada a quien no la sabe.
  const disp = await validarDispositivo(usuario.id, req.headers.get("user-agent"), true);
  if (!disp.ok) return NextResponse.json({ error: disp.error }, { status: disp.status });

  const rol = usuario.rol === "ADMIN" ? "ADMIN" : "USUARIO";
  const { mods, vistas, ocultos } = await permisosForUsuario({
    rol: usuario.rol,
    sector: usuario.sector,
    // Los permisos viajan HORNEADOS en la cookie: prender/apagar la bandera en
    // /admin/usuarios recién le cambia el acceso al usuario cuando vuelve a
    // loguear (mismo comportamiento que /admin/permisos).
    bulonesAccesoTotal: usuario.bulonesAccesoTotal,
  });
  const { token, maxAge } = signSession({
    uid: usuario.id,
    dni: usuario.dni,
    nombre: usuario.nombre,
    rol,
    mods,
    vistas,
    ocultos,
  });

  await prisma.usuario
    .update({ where: { id: usuario.id }, data: { ultimoAcceso: new Date() } })
    .catch(() => {});

  const res = NextResponse.json({
    ok: true,
    usuario: { nombre: usuario.nombre, rol, mods },
  });
  res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(maxAge));
  return res;
}
