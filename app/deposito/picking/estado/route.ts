import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  try {
    const count = await prisma.picking_eventos.count({
      where: { estado: "pendiente" },
    });

    return NextResponse.json({ pendientes: count, ok: true });

  } catch (error) {
    console.error("[picking/estado]", error);
    return NextResponse.json({ pendientes: 0, ok: false }, { status: 500 });
  }
}

// // GET — depósito lista eventos (filtra por uno o varios estados)
// export async function GET(req: NextRequest) {
//   try {
//     const { searchParams } = new URL(req.url);
//     const estados = searchParams.getAll("estado");
//     const limit = Number(searchParams.get("limit") ?? "50");

//     // Sin filtro → default a pendientes
//     const where =
//       estados.length === 0
//         ? { estado: "pendiente" }
//         : { estado: { in: estados } };

//     const eventos = await prisma.picking_eventos.findMany({
//       where,
//       orderBy: { creado_en: "desc" },
//       take: limit,
//     });

//     return NextResponse.json(eventos);
//   } catch (error) {
//     console.error("GET /api/picking/eventos", error);
//     return NextResponse.json({ error: "Error interno" }, { status: 500 });
//   }
// }