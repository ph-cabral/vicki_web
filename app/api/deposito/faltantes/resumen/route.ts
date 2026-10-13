import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { mesValido } from "@/lib/deposito/faltanteMes";

export const dynamic = "force-dynamic";

// Items (renglones) que llegaron a /deposito/faltantes en un mes — para la
// carta unificada de Picking. Lee el detalle ya persistido
// (preparado.faltante_pedido, índice por fecha): una sola agregación en
// Postgres, no toca Magnus.
//   GET ?mes=YYYY-MM → { mes, items, unidades, enExistencia, sinExistencia,
//                        malFacturado, pendiente }  (items = suma de los 4,
//                        según la marca de la mesa en faltante_existencia)
export async function GET(req: NextRequest) {
  const mes = req.nextUrl.searchParams.get("mes");
  if (!mesValido(mes)) {
    return NextResponse.json(
      { error: "mes requerido, formato YYYY-MM" },
      { status: 400 },
    );
  }
  const [anio, mm] = mes.split("-").map(Number);
  const desde = new Date(Date.UTC(anio, mm - 1, 1));
  const hasta = new Date(Date.UTC(anio, mm, 1)); // exclusivo
  try {
    // Una marca por renglón (la última): faltante_existencia es única por
    // (fecha, pedido, renglón), así que sin LATERAL..LIMIT 1 un renglón
    // marcado en dos fechas contaría doble.
    const [r] = await prisma.$queryRaw<
      {
        items: bigint;
        unidades: unknown;
        en: bigint;
        sin: bigint;
        mal: bigint;
      }[]
    >`
      SELECT COUNT(*)                                        AS items,
             COALESCE(SUM(fp.diferencia), 0)                 AS unidades,
             COUNT(*) FILTER (WHERE m.existencia IS TRUE)    AS en,
             COUNT(*) FILTER (WHERE m.existencia IS FALSE)   AS sin,
             COUNT(*) FILTER (WHERE m.existencia IS NULL AND m.mal_facturado IS TRUE) AS mal
      FROM preparado.faltante_pedido fp
      LEFT JOIN LATERAL (
        SELECT fe.existencia, fe.mal_facturado
        FROM preparado.faltante_existencia fe
        WHERE fe.nro_ped_origen = fp."nroMovVenta"
          AND fe.nro_reng_origen = fp."nroRenglon"
        ORDER BY fe.actualizado_en DESC
        LIMIT 1
      ) m ON true
      WHERE fp.fecha >= ${desde}::date AND fp.fecha < ${hasta}::date
    `;
    const items = Number(r?.items ?? 0);
    const en = Number(r?.en ?? 0);
    const sin = Number(r?.sin ?? 0);
    const mal = Number(r?.mal ?? 0);
    return NextResponse.json({
      mes,
      items,
      unidades: Number(r?.unidades ?? 0),
      enExistencia: en,
      sinExistencia: sin,
      malFacturado: mal,
      pendiente: Math.max(0, items - en - sin - mal),
    });
  } catch (error) {
    console.error("GET /api/deposito/faltantes/resumen", error);
    return NextResponse.json(
      { error: "No se pudo leer el resumen de faltantes" },
      { status: 500 },
    );
  }
}
