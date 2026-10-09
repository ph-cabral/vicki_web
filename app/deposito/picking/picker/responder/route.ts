import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// Ruta sin segmento dinámico: el id tiene que venir en el body.
// (Antes leía params.id, que acá no existe → NaN → 500 siempre.)
export async function PATCH(req: Request) {
  try {
    const { id, respuesta } = await req.json();
    const idNum = Number(id);
    if (!Number.isFinite(idNum)) {
      return NextResponse.json({ error: "Falta id numérico" }, { status: 400 });
    }
    if (!respuesta) {
      return NextResponse.json({ error: "Falta respuesta" }, { status: 400 });
    }
    const actualizado = await prisma.chat_mensajes.update({
      where: { id: idNum },
      data: { respuesta, respondido: true },
    });
    return NextResponse.json(actualizado);
  } catch (error) {
    console.error("[chat PATCH]", error);
    return NextResponse.json({ error: "Error al responder" }, { status: 500 });
  }
}
