import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// GET /api/picking/eventos/historial?picker=Juan&dias=7
// Historial del picker para /picking/picker: sus pedidos de los últimos `dias`
// días calendario (hoy incluido, hora AR), más nuevos primero, máx. 300.
// Público en middleware como la página (sólo los pedidos de ese nombre).
// creado_en es timestamp SIN zona guardado en UTC (now() con TimeZone=UTC):
// el corte se calcula en AR y se pasa a UTC para que el filtro use el índice
// (picker_nombre, creado_en); día y hora salen ya formateados en AR.
export const dynamic = "force-dynamic";

interface Fila {
  id: number;
  codigo: string;
  cantidad: number;
  estado: string;
  respuesta_nota: string | null;
  dia: string;
  hora: string;
}

export async function GET(req: NextRequest) {
  const picker = (req.nextUrl.searchParams.get("picker") ?? "").trim().slice(0, 50);
  if (!picker) return NextResponse.json([]);
  const dias = Math.min(31, Math.max(1, Number(req.nextUrl.searchParams.get("dias")) || 7));

  try {
    const filas = await prisma.$queryRaw<Fila[]>`
      SELECT id, codigo, cantidad, estado, respuesta_nota,
             to_char(creado_en AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires', 'YYYY-MM-DD') AS dia,
             to_char(creado_en AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires', 'HH24:MI') AS hora
      FROM preparado.picking_eventos
      WHERE picker_nombre = ${picker}
        AND creado_en >= ((date_trunc('day', now() AT TIME ZONE 'America/Argentina/Buenos_Aires')
                           - make_interval(days => ${dias - 1}::int))
                          AT TIME ZONE 'America/Argentina/Buenos_Aires') AT TIME ZONE 'UTC'
      ORDER BY creado_en DESC
      LIMIT 300`;
    return NextResponse.json(filas, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("GET /api/picking/eventos/historial", error);
    return NextResponse.json({ error: "Error interno" }, { status: 500 });
  }
}
