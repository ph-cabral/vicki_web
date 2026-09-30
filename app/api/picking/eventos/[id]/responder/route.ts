import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { publicarAlPicker } from "@/lib/picking/notificaciones";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: idStr } = await params;
    const id = Number(idStr);
    if (isNaN(id)) {
      return NextResponse.json({ error: "ID inválido" }, { status: 400 });
    }

    const body = await req.json();
    const { estado, respuesta_nota } = body;

    if (!["pedido", "s/e"].includes(estado)) {
      return NextResponse.json(
        { error: "estado debe ser 'pedido' o 's/e'" },
        { status: 400 }
      );
    }

    const evento = await prisma.picking_eventos.update({
      where: { id },
      data: {
        estado,
        respuesta_nota: respuesta_nota ?? null,
        respondido_en: new Date(),
      },
    });

    // Notificación a la app Android del picker (canal SSE propio, ver
    // lib/picking/notificaciones.ts — reemplazó a ntfy.sh).
    const esOk = estado === "pedido";
    const cuerpo = respuesta_nota
      ? `${evento.codigo} x${evento.cantidad} — ${respuesta_nota}`
      : `${evento.codigo} x${evento.cantidad}`;
    try {
      publicarAlPicker(evento.picker_nombre, {
        tipo: esOk ? "pedido" : "sin_existencia",
        titulo: esOk ? "Pedido confirmado" : "Sin existencia",
        cuerpo,
        prioridad: esOk ? "default" : "high",
      });
    } catch (e) {
      // No rompe el flujo si falla la notificación
      console.warn("notificación picker (no crítico):", e);
    }

    return NextResponse.json(evento);
  } catch (error) {
    console.error("PATCH /api/picking/eventos/[id]/responder", error);
    return NextResponse.json({ error: "Error interno" }, { status: 500 });
  }
}

