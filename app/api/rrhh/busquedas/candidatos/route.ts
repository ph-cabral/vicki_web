// Buscador de postulantes ingresados por el mail de selección (rag_system.candidato).
// Cada palabra del texto debe aparecer en nombre, email, DNI o teléfono. Con ~2 mil
// filas alcanza con LIKE; límite 20. `excluyente` avisa que la persona ya figura
// rechazada/desistió/mala referencia/descartada en alguna búsqueda.
import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ESTADOS_EXCLUYENTES } from "@/lib/rrhh/busqueda";

export const dynamic = "force-dynamic";

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export async function GET(req: NextRequest) {
  const q = norm(req.nextUrl.searchParams.get("q") ?? "").trim();
  const tokens = q.split(/\s+/).filter((t) => t.length >= 2).slice(0, 4);
  if (!tokens.length) return NextResponse.json([]);
  const conds = tokens.map((t) => {
    const like = `%${t.replace(/[%_\\]/g, "\\$&")}%`;
    return Prisma.sql`(c.nombre_normalizado LIKE ${like} OR lower(c.email) LIKE ${like}
                       OR c.dni LIKE ${like} OR c.telefono_normalizado LIKE ${like})`;
  });
  try {
    const rows = await prisma.$queryRaw<
      { id: number; nombre: string | null; apellido: string | null; email: string | null;
        telefono: string | null; dni: string | null; created_at: Date; estados: string[] | null }[]
    >(Prisma.sql`
      SELECT c.id, c.nombre, c.apellido, c.email, c.telefono, c.dni, c.created_at,
             (SELECT array_agg(DISTINCT p.estado) FROM everwear.rrhh_busqueda_postulante p
               WHERE p."candidatoId" = c.id AND p.estado IN (${Prisma.join(ESTADOS_EXCLUYENTES)})) AS estados
        FROM rag_system.candidato c
       WHERE ${Prisma.join(conds, " AND ")}
       ORDER BY c.created_at DESC
       LIMIT 20`);
    return NextResponse.json(
      rows.map((r) => ({
        id: Number(r.id),
        nombre: [r.nombre, r.apellido].filter(Boolean).join(" ").trim() || "Sin nombre",
        email: r.email, telefono: r.telefono, dni: r.dni, ingreso: r.created_at,
        estadosExcluyentes: r.estados ?? [],
      })),
    );
  } catch (e) {
    console.error("GET /api/rrhh/busquedas/candidatos", e);
    return NextResponse.json({ error: "No se pudo buscar" }, { status: 500 });
  }
}
