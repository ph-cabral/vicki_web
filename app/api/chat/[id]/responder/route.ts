import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { publicarAlPicker } from "@/lib/picking/notificaciones";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { respuesta } = await req.json();
    if (!respuesta) {
      return NextResponse.json({ error: "Falta respuesta" }, { status: 400 });
    }

    const actualizado = await prisma.chat_mensajes.update({
      where: { id: Number(id) },
      data: { respuesta, respondido: true },
    });

    // Notificación a la app Android del picker (canal SSE propio, ver
    // lib/picking/notificaciones.ts — reemplazó a ntfy.sh).
    try {
      publicarAlPicker(actualizado.picker_nombre, {
        tipo: "chat",
        titulo: "Nuevo mensaje",
        cuerpo: `YO: ${actualizado.mensaje}\nGerencia: ${respuesta}`,
        prioridad: "default",
      });
    } catch (e) {
      console.warn("notificación picker (no crítico):", e);
    }

    return NextResponse.json(actualizado);
  } catch (error) {
    console.error("[chat PATCH]", error);
    return NextResponse.json({ error: "Error al responder" }, { status: 500 });
  }
}
