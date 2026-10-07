import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveBucketRenglones, type BucketRenglon } from "@/lib/faltantesArribo";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// ──────────────────────────────────────────────────────────────────────────────
// /compras/faltantes — carga fecha de arribo a nivel (artículo, día de 1ª
//   aparición del bucket), con fan-out a preparado.faltante_control por
//   renglón. Reemplaza a /deposito/faltantes/control como punto de carga de
//   fechaArribo (esa pantalla ahora redirige acá).
//
//   POST { fecha, codArticulo, fechaArribo: string|null }
//     · fecha       = PrimerDia del bucket (el "Día" que muestra la tabla de
//                     compras), NO la fecha de hoy.
//     · fechaArribo = null para borrar la fecha cargada.
//
//   No se toca esquema ni /ventas/faltantes: se sigue escribiendo
//   preparado.faltante_control por (fecha, nroPedOrigen, nroRengOrigen), donde
//   esa "fecha" es la que ya usa el resto del pipeline (ver
//   lib/faltantesArribo.ts — BucketRenglon.fecha).
// ──────────────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const primerDia = body?.fecha;
  const codArticulo = body?.codArticulo;
  const fechaArribo: string | null = body?.fechaArribo || null;

  if (!primerDia || typeof primerDia !== "string" || !codArticulo || typeof codArticulo !== "string") {
    return NextResponse.json({ error: "fecha y codArticulo son requeridos" }, { status: 400 });
  }

  let renglones: BucketRenglon[];
  try {
    renglones = await resolveBucketRenglones(codArticulo, primerDia);
  } catch (e) {
    return NextResponse.json(
      { error: "No se pudo resolver el bucket (indicadores-api)", detail: String(e) },
      { status: 503 },
    );
  }
  if (!renglones.length) {
    return NextResponse.json(
      { error: "No hay renglones sin existencia para ese artículo/día" },
      { status: 404 },
    );
  }

  try {
    await prisma.$transaction(
      renglones.map((r) =>
        prisma.$executeRaw`
          INSERT INTO preparado.faltante_control
            (fecha, "nroPedOrigen", "nroRengOrigen", "codArticulo", "fechaArribo", "updatedAt")
          VALUES (${r.fecha}::date, ${r.nroPedOrigen}, ${r.nroRengOrigen}, ${codArticulo}, ${fechaArribo}::date, now())
          ON CONFLICT (fecha, "nroPedOrigen", "nroRengOrigen") DO UPDATE SET
            "fechaArribo" = EXCLUDED."fechaArribo",
            "updatedAt"   = now()
        `,
      ),
    );
    return NextResponse.json({
      ok: true,
      fecha: primerDia,
      codArticulo,
      fechaArribo,
      renglones: renglones.length,
    });
  } catch (e) {
    return NextResponse.json(
      { error: "No se pudo guardar (¿falta aplicar faltante_control.sql?)", detail: String(e) },
      { status: 500 },
    );
  }
}
