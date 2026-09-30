import { NextRequest } from "next/server";
import {
  pendientesPicker,
  suscribirPicker,
  topicPicker,
  type NotifPicker,
} from "@/lib/picking/notificaciones";

// GET /api/picking/notificaciones?picker=<nombre>&desde=<ultimoId>
// Stream SSE que consume la app Android del picker (ver lib/picking/notificaciones.ts).
// Público en middleware (la app no tiene sesión), igual que /picking/picker.
// Sin consultas a BBDD: todo sale del emisor en memoria.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PING_MS = 20_000; // la app corta y reconecta si pasan 60 s sin nada

export async function GET(req: NextRequest) {
  const picker = req.nextUrl.searchParams.get("picker")?.trim();
  if (!picker) return new Response("falta picker", { status: 400 });

  const topic = topicPicker(picker);
  const desde =
    Number(req.headers.get("last-event-id") ?? req.nextUrl.searchParams.get("desde") ?? 0) || 0;

  const enc = new TextEncoder();
  let limpiar = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let cerrado = false;
      let ultimo = desde;
      let off = () => {};
      let ping: ReturnType<typeof setInterval> | undefined;

      limpiar = () => {
        if (cerrado) return;
        cerrado = true;
        if (ping) clearInterval(ping);
        off();
        try {
          controller.close();
        } catch {
          /* ya cerrado */
        }
      };

      const escribir = (txt: string) => {
        if (cerrado) return;
        try {
          controller.enqueue(enc.encode(txt));
        } catch {
          limpiar();
        }
      };

      const enviar = (n: NotifPicker) => {
        if (n.id <= ultimo) return; // dedupe entre pendientes y en vivo
        ultimo = n.id;
        escribir(`id: ${n.id}\nevent: notif\ndata: ${JSON.stringify(n)}\n\n`);
      };

      escribir(`retry: 5000\n: conectado ${topic}\n\n`);
      for (const n of pendientesPicker(topic, desde)) enviar(n);
      off = suscribirPicker(topic, enviar);
      ping = setInterval(() => escribir(`: ping\n\n`), PING_MS);

      req.signal.addEventListener("abort", () => limpiar());
    },
    cancel() {
      limpiar();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      // no-transform: evita que la compresión de Next bufferee el stream
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
