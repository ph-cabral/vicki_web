import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { esEncargadoDeModulo } from "@/lib/auth/encargados";

/**
 * Quién puede CARGAR/EDITAR los objetivos mensuales del ranking de operarios
 * de /deposito (las 3 líneas del gráfico: objetivo, sobresaliente y bajo
 * rendimiento) — 2026-09-09.
 *
 * Reglas:
 *   · ADMIN: siempre.
 *   · No-admin: si `usuario.depositoObjetivoAcceso = true` (bandera vieja,
 *     se mantiene por compatibilidad) O si figura como encargado del módulo
 *     "deposito" en usuario_modulo_encargado (2026-09-15, ver
 *     lib/auth/encargados.ts — /admin/encargados, admite varias personas a
 *     la vez, a diferencia de la bandera vieja que había que tocar una por
 *     una en /admin/usuarios).
 *
 * LEER los objetivos no pasa por acá: los ve cualquiera que entre a /deposito
 * (lo cubre el módulo "deposito" del middleware). Esto es sólo el candado de
 * escritura — el número es el mismo para todos, lo que cambia es quién lo
 * fija.
 *
 * Se resuelve en VIVO contra Postgres (no desde la cookie), igual que
 * resolverAccesoVickiRrhh(): dar o sacar el acceso toma efecto sin relogin.
 */
export type AccesoObjetivoDeposito =
  | { ok: true; puedeEditar: boolean }
  | { ok: false; status: number; error: string };

export async function resolverAccesoObjetivoDeposito(): Promise<AccesoObjetivoDeposito> {
  const session = await getSession();
  if (!session) return { ok: false, status: 401, error: "No autenticado" };

  if (session.rol === "ADMIN") return { ok: true, puedeEditar: true };

  const [usuario, encargado] = await Promise.all([
    prisma.usuario.findUnique({
      where: { id: session.uid },
      select: { depositoObjetivoAcceso: true },
    }),
    esEncargadoDeModulo(session.uid, "deposito"),
  ]);

  return {
    ok: true,
    puedeEditar: usuario?.depositoObjetivoAcceso === true || encargado,
  };
}
