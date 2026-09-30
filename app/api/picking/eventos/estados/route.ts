import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// GET /api/picking/eventos/estados?ids=1,2,3
// Estado de los pedidos que el picker mandó recién ("Enviados recién" de
// /picking/picker se pinta verde = pedido, rojo = s/e). Público en middleware
// como la página; sólo devuelve id/estado/nota por PK (máx. 20 ids).
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const ids = (req.nextUrl.searchParams.get("ids") ?? "")
    .split(",")
    .map((x) => Number(x))
    .filter((n) => Number.isInteger(n) && n > 0)
    .slice(0, 20);
  if (ids.length === 0) return NextResponse.json([]);

  try {
    const filas = await prisma.picking_eventos.findMany({
      where: { id: { in: ids } },
      select: { id: true, estado: true, respuesta_nota: true },
    });
    return NextResponse.json(filas, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("GET /api/picking/eventos/estados", error);
    return NextResponse.json({ error: "Error interno" }, { status: 500 });
  }
}
