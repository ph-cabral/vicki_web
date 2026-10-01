import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth/session";
import {
  listarReportes,
  parseReporteIn,
  esTablaFaltante,
  TABLA_FALTA_MSG,
} from "@/lib/compras/planificacion";

export const dynamic = "force-dynamic";

// /compras/planificacion — botones (reportes guardados) del usuario logueado.
//   GET  → lista propia, en orden.
//   POST { nombre, lineas[], rubros[], subRubros[], subSubRubros[], meses } → alta.
// Ver lib/compras/planificacion.ts.

export async function GET() {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "Sin sesión" }, { status: 401 });
  try {
    return NextResponse.json({ reportes: await listarReportes(s.uid) });
  } catch (e) {
    if (esTablaFaltante(e)) return NextResponse.json({ reportes: [], tablaWarn: TABLA_FALTA_MSG });
    console.error("GET /api/compras/planificacion/reportes", e);
    return NextResponse.json({ error: "No se pudieron leer los reportes" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "Sin sesión" }, { status: 401 });
  const r = parseReporteIn(await req.json().catch(() => null));
  if (typeof r === "string") return NextResponse.json({ error: r }, { status: 400 });
  try {
    const out = await prisma.$queryRaw<{ id: number }[]>`
      INSERT INTO preparado.compras_planificacion_reporte
        ("usuarioId", nombre, lineas, rubros, "subRubros", "subSubRubros", meses, orden)
      VALUES (
        ${s.uid}, ${r.nombre}, ${r.lineas}::int[], ${r.rubros}::int[],
        ${r.subRubros}::int[], ${r.subSubRubros}::int[], ${r.meses},
        COALESCE((SELECT MAX(orden) + 1 FROM preparado.compras_planificacion_reporte
                  WHERE "usuarioId" = ${s.uid}), 0)
      )
      RETURNING id
    `;
    return NextResponse.json({ id: Number(out[0]?.id) });
  } catch (e) {
    if (esTablaFaltante(e)) return NextResponse.json({ error: TABLA_FALTA_MSG }, { status: 503 });
    console.error("POST /api/compras/planificacion/reportes", e);
    return NextResponse.json({ error: "No se pudo guardar" }, { status: 500 });
  }
}
