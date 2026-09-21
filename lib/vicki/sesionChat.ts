import { getSession } from "@/lib/auth/session";

/**
 * session_id del chat de Vicki para el usuario logueado.
 *
 * El front arma el id como `user_<uid>` y lo manda en el body/la URL, así que
 * hasta acá venía elegido por el cliente: cambiándolo a mano se podía leer (y
 * seguir) la conversación de otra persona, que es el historial de CVs y de
 * consultas de todo un usuario. Se resuelve server-side contra la cookie,
 * mismo criterio que los permisos de datos (ver lib/ventas/vickiVentasAcceso.ts).
 */
export async function sessionIdVicki(): Promise<string | null> {
  const session = await getSession();
  if (!session) return null;
  return `user_${session.uid}`;
}
