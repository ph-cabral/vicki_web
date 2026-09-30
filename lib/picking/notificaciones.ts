// Canal de notificaciones al picker — reemplaza ntfy.sh.
//
// La app Android "EverWear Picker" (android/picker, APK en /apk) mantiene un
// GET SSE abierto contra /api/picking/notificaciones?picker=<nombre> desde un
// servicio en primer plano; cuando gerencia responde un pedido o un chat, el
// route handler llama a publicarAlPicker() y la app muestra una notificación
// Android con sonido aunque esté cerrada. Todo por la LAN, sin Google Play
// Services ni servicios externos.
//
// Estado en memoria del proceso Next (una sola instancia en Docker). Se guarda
// en globalThis para que todos los route handlers compartan el mismo emisor.
// Buffer corto por topic: si el equipo perdió WiFi un rato, al reconectar
// manda el último id recibido y se le reentrega lo que se perdió. Lo único que
// no sobrevive es un redeploy mientras el equipo está desconectado.
import { EventEmitter } from "events";

export type NotifPicker = {
  id: number; // monotónico (ms epoch); la app lo guarda como "último visto"
  tipo: "pedido" | "sin_existencia" | "chat";
  titulo: string;
  cuerpo: string;
  prioridad: "default" | "high";
  ts: number;
};

const RETENCION_MS = 12 * 60 * 60 * 1000;
const MAX_POR_TOPIC = 100;

type Estado = {
  emisor: EventEmitter;
  buffer: Map<string, NotifPicker[]>;
  ultimoId: number;
};

const g = globalThis as unknown as { __notifPicker?: Estado };
const estado: Estado =
  g.__notifPicker ??
  (g.__notifPicker = {
    emisor: new EventEmitter().setMaxListeners(0),
    buffer: new Map(),
    ultimoId: 0,
  });

/** Misma normalización que usaba ntfy: "Juan Perez" -> "juan-perez". */
export function topicPicker(nombre: string): string {
  return nombre.trim().toLowerCase().replace(/\s+/g, "-");
}

export function publicarAlPicker(
  pickerNombre: string,
  n: Omit<NotifPicker, "id" | "ts">,
): NotifPicker {
  const topic = topicPicker(pickerNombre);
  const ahora = Date.now();
  // id > cualquier id previo, incluso de antes de un reinicio (arranca en ms epoch)
  estado.ultimoId = Math.max(ahora, estado.ultimoId + 1);
  const notif: NotifPicker = { ...n, id: estado.ultimoId, ts: ahora };

  const lista = (estado.buffer.get(topic) ?? []).filter((x) => ahora - x.ts < RETENCION_MS);
  lista.push(notif);
  if (lista.length > MAX_POR_TOPIC) lista.splice(0, lista.length - MAX_POR_TOPIC);
  estado.buffer.set(topic, lista);

  estado.emisor.emit(topic, notif);
  return notif;
}

/** Lo publicado para el topic con id > desde (reentrega tras reconexión). */
export function pendientesPicker(topic: string, desde: number): NotifPicker[] {
  if (!desde) return []; // primera conexión de un equipo: no le tiro el historial
  const limite = Date.now() - RETENCION_MS;
  return (estado.buffer.get(topic) ?? []).filter((x) => x.id > desde && x.ts > limite);
}

export function suscribirPicker(topic: string, cb: (n: NotifPicker) => void): () => void {
  estado.emisor.on(topic, cb);
  return () => {
    estado.emisor.off(topic, cb);
  };
}
