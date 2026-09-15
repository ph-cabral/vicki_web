// Encargados de módulo, genérico (2026-09-15) — ver
// prisma/schema.prisma (model usuario_modulo_encargado) y
// app/admin/encargados/.
//
// Un usuario no-admin puede quedar marcado como "encargado" de uno o varios
// módulos (hoy: deposito, para editar los objetivos del ranking — ver
// lib/deposito/objetivoAcceso.ts). Pensado para que un módulo nuevo con un
// permiso "encargado de X" reuse esto en vez de sumar otra columna booleana
// a `usuario` (como bulonesAccesoTotal o depositoObjetivoAcceso).
//
// Ser encargado de un módulo NO abre el módulo ni ninguna vista — eso lo
// sigue dando el sector (ver lib/auth/permissions.ts). Sólo es una llave que
// cada pantalla puede consultar para decidir si mostrar un botón de edición
// puntual (como hace hoy /deposito con los objetivos).
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth/session";
import type { ModuleKey } from "./modules";

export async function esEncargadoDeModulo(
  usuarioId: number,
  modulo: ModuleKey,
): Promise<boolean> {
  const row = await prisma.usuario_modulo_encargado.findUnique({
    where: { usuarioId_modulo: { usuarioId, modulo } },
    select: { id: true },
  });
  return row !== null;
}

/** Todos los módulos de los que `usuarioId` es encargado. */
export async function modulosEncargadoDe(usuarioId: number): Promise<string[]> {
  const rows = await prisma.usuario_modulo_encargado.findMany({
    where: { usuarioId },
    select: { modulo: true },
  });
  return rows.map((r) => r.modulo);
}

/**
 * Sesión actual: true si es ADMIN o si está marcado como encargado del
 * módulo dado. Se resuelve EN VIVO contra Postgres (no desde la cookie):
 * dar o sacar el rol de encargado toma efecto en la próxima acción, sin
 * relogin — mismo criterio que bulonesAccesoTotal / depositoObjetivoAcceso.
 */
export async function esEncargadoDeModuloSesion(modulo: ModuleKey): Promise<boolean> {
  const session = await getSession();
  if (!session) return false;
  if (session.rol === "ADMIN") return true;
  return esEncargadoDeModulo(session.uid, modulo);
}
