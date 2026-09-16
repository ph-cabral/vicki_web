// Datos de la central Issabel para el softphone web. Se leen en runtime del
// .env del server (no se inlinean en el build).
//   ISSABEL_WS_URL      ws://<ip-issabel>:8088/ws   (o wss://<host>:8089/ws)
//   ISSABEL_SIP_DOMAIN  <ip-issabel>                (dominio de la URI sip:ext@dominio)
export function configIssabel(): { wsUrl: string; dominio: string } | null {
  const wsUrl = process.env.ISSABEL_WS_URL?.trim();
  let dominio = process.env.ISSABEL_SIP_DOMAIN?.trim();
  if (!wsUrl) return null;
  if (!dominio) {
    try {
      dominio = new URL(wsUrl).hostname;
    } catch {
      return null;
    }
  }
  return { wsUrl, dominio };
}

/** Extensión válida: sólo dígitos, 2 a 8. */
export function extensionValida(v: unknown): v is string {
  return typeof v === "string" && /^\d{2,8}$/.test(v);
}
