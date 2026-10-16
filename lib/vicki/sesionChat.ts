import { getSession } from "@/lib/auth/session";

/**
 * session_id del chat de Vicki para el usuario logueado.
 *
 * Cada conversación es una sesión propia: `user_<uid>` (la histórica, de antes
 * de separar conversaciones) o `user_<uid>_<token>` (una por cada «Nueva
 * conversación»). El cliente propone el token, pero el prefijo `user_<uid>` se
 * resuelve server-side contra la cookie: nadie puede leer ni escribir la
 * conversación de otro usuario (mismo criterio que los permisos de datos, ver
 * lib/ventas/vickiVentasAcceso.ts).
 *
 * Con `pedido` devuelve ese mismo id si es una sesión válida DE ESTE usuario;
 * si no, el id base `user_<uid>` (las rutas que comparan lo rechazan con 403).
 */
export async function sessionIdVicki(pedido?: string | null): Promise<string | null> {
  const session = await getSession();
  if (!session) return null;
  const base = `user_${session.uid}`;
  if (pedido && (pedido === base || new RegExp(`^${base}_[a-z0-9]{6,24}$`).test(pedido))) {
    return pedido;
  }
  return base;
}

/** uid del usuario logueado (para listar sus conversaciones). */
export async function uidVicki(): Promise<number | null> {
  const session = await getSession();
  return session ? Number(session.uid) : null;
}
