import { getSession } from "@/lib/auth/session";
import { moduleForPath, viewForPath } from "@/lib/auth/modules";

/**
 * Acceso a datos de DEPÓSITO desde el chat de Vicki (intent "deposito" en
 * vicki_chat/app/deposito_tools.py): productividad del mes por preparador
 * (WMS) y por mesa de control (EVERWEAR).
 *
 * CRITERIO: el permiso es el MISMO que el de la vista /deposito — copia
 * exacta de resolverAccesoVickiCompras() (ver lib/compras/vickiComprasAcceso.ts)
 * cambiando la ruta. Si podés entrar a la pantalla, el chat te contesta lo
 * que ya ves ahí; si no, no. Sin bandera nueva por usuario a propósito, y sin
 * filtro por persona (no hay un "operario logueado" que recorte la vista, a
 * diferencia de vendedorCodigo en ventas).
 *
 * Igual que compras: lee la COOKIE de sesión (permisos horneados al loguear,
 * ver lib/auth/permissions.ts), así que un permiso recién dado necesita
 * relogin — mismo comportamiento que para entrar a la vista.
 */
const RUTA_DEPOSITO = "/deposito";

export type AccesoVickiDeposito =
  | { ok: true; habilitado: boolean }
  | { ok: false; status: number; error: string };

export async function resolverAccesoVickiDeposito(): Promise<AccesoVickiDeposito> {
  const session = await getSession();
  if (!session) return { ok: false, status: 401, error: "No autenticado" };

  if (session.rol === "ADMIN") return { ok: true, habilitado: true };

  // Módulo: sin él el middleware ya lo rebota de /deposito.
  const mod = moduleForPath(RUTA_DEPOSITO);
  if (mod && !session.mods?.includes(mod)) return { ok: true, habilitado: false };

  // Vista: las cookies viejas no traen `vistas` — el middleware las deja pasar,
  // así que acá también (si no, el chat le diría que no a alguien que sí puede
  // abrir la pantalla, hasta que le caduque la sesión).
  const vista = viewForPath(RUTA_DEPOSITO);
  if (vista && session.vistas && !session.vistas.includes(vista.href)) {
    return { ok: true, habilitado: false };
  }

  return { ok: true, habilitado: true };
}
