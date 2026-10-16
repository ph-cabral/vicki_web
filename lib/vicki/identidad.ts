import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";

/**
 * Identidad del usuario para el agente de vicki_chat (app/agente.py).
 *
 * Regla única del chat: un ADMIN consulta cualquier dato; los demás SOLO lo
 * propio (su cartera/ventas/facturas por `vendedorCodigo`, su legajo y su
 * asistencia por `legajoId`). Todo se resuelve ACÁ contra la cookie de sesión y
 * se pisa lo que mande el browser: vicki_chat confía en estos campos porque solo
 * este backend le habla (y, si está seteado CHAT_API_TOKEN, solo con el secreto).
 *
 * `vendedorCodigo` y `legajoId` se leen en VIVO de Postgres (no de la cookie), así
 * que asignarle un vendedor a alguien surte efecto en su próximo mensaje. A
 * diferencia de resolverAccesoVickiVentas() acá NO hace falta la bandera
 * `vickiVentasAcceso`: ver lo propio no requiere permiso especial.
 */
export type IdentidadVicki = {
  esAdmin: boolean;
  nombre: string | null;
  legajoId: number | null;
  vendedorCodigo: number | null;
};

const SIN_IDENTIDAD: IdentidadVicki = {
  esAdmin: false,
  nombre: null,
  legajoId: null,
  vendedorCodigo: null,
};

export async function resolverIdentidadVicki(): Promise<IdentidadVicki> {
  const session = await getSession();
  if (!session) return SIN_IDENTIDAD;

  const usuario = await prisma.usuario.findUnique({
    where: { id: session.uid },
    select: { nombre: true, legajoId: true, vendedorCodigo: true, activo: true },
  });
  // Usuario dado de baja con cookie vigente: sin datos de nadie.
  if (!usuario || usuario.activo === false) return SIN_IDENTIDAD;

  return {
    esAdmin: session.rol === "ADMIN",
    nombre: usuario.nombre ?? null,
    legajoId: usuario.legajoId ?? null,
    vendedorCodigo: usuario.vendedorCodigo ?? null,
  };
}
