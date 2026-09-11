// Escala de premios por % de error — modal "Márgenes" de /rrhh/premios.
//
// Cada tramo es UN número: el **% de error** (errores / cantidad × 100) hasta
// donde llega, más el % que se le RESTA a la cantidad. El tramo arranca donde
// terminó el anterior (el primero en 0) y el último va sin tope:
//   hasta 0,05 % -> resta 10 % · hasta 2 % -> resta 20 % · de ahí en más -> 50 %
// El tope entra en su propio tramo (`<=`). Dos escalas independientes:
// 'preparado' (tabla Preparadores) y 'mesa' (tabla Mesa de Control).
//
// VERSIONADO POR MES: cada fila rige DESDE `vigencia` (YYYY-MM) EN ADELANTE
// hasta que haya una versión posterior. La escala de un mes M es la de
// `vigencia` más alto <= M, así cambiar los números hoy no altera los meses ya
// liquidados. Guardar sobre un `vigencia` que ya existe lo corrige (upsert por
// la UNIQUE (ambito, vigencia)); guardar con un `vigencia` nuevo abre una
// versión nueva de ahí en adelante.
//
//   GET    -> { escalas: { preparado: Version[], mesa: Version[] }, puedeEditar }
//             Devuelve TODAS las versiones (la tabla tiene una fila por ámbito
//             y por cambio): la vista resuelve el mes en el front y cambiar de
//             mes no vuelve al servidor. `puedeEditar` viaja acá para que la
//             página sepa si mostrar el botón sin pegarle a otro endpoint.
//   POST   { ambito, vigencia, tramos } -> upsert de esa versión.
//   DELETE ?ambito=&vigencia=           -> borra esa versión (vuelve a regir
//                                          la anterior, si hay).
//
// Escrituras: SOLO ADMIN. La lectura la cubre el módulo "rrhh" del middleware.
// DDL: sql/rrhh_premio_escala.sql.
import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth/session";
import { requireAdmin } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";

const YM = /^\d{4}-(0[1-9]|1[0-2])$/;
const AMBITOS = ["preparado", "mesa"] as const;
type Ambito = (typeof AMBITOS)[number];

const MAX_TRAMOS = 20;

export type Tramo = {
  /** % de error hasta donde llega el tramo (incluido). null = último, sin tope. */
  hasta: number | null;
  /** % que se le resta a la cantidad en ese tramo. */
  descuento: number;
};

/** 2 decimales, que es lo que se carga en pantalla (0,05 %). */
const red2 = (n: number) => Math.round(n * 100) / 100;

function esAmbito(v: unknown): v is Ambito {
  return typeof v === "string" && (AMBITOS as readonly string[]).includes(v);
}

/**
 * Un tramo por % de error tope, en orden ESTRICTAMENTE creciente: el `desde` de
 * cada uno es el `hasta` del anterior, así la escala nunca queda con huecos ni
 * superpuesta y cualquier % de error cae en un solo tramo. Sólo el último puede
 * ir sin tope (`hasta: null`), y es el que junta todo lo que queda arriba.
 *
 * Tanto el tope como el descuento son porcentajes (0 a 100) y admiten decimales
 * — 0,05 % de error es un valor normal acá.
 */
function validarTramos(raw: unknown): { ok: true; tramos: Tramo[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length === 0)
    return { ok: false, error: "Cargá al menos un tramo" };
  if (raw.length > MAX_TRAMOS)
    return { ok: false, error: `Máximo ${MAX_TRAMOS} tramos` };

  const tramos: Tramo[] = [];
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i] as Record<string, unknown>;
    const n = i + 1;
    const ultimo = i === raw.length - 1;
    const hasta = t?.hasta === null || t?.hasta === undefined || t?.hasta === "" ? null : Number(t.hasta);
    const descuento = Number(t?.descuento);

    if (hasta === null && !ultimo)
      return { ok: false, error: `Tramo ${n}: sólo el último puede quedar sin tope` };
    if (hasta !== null && (!Number.isFinite(hasta) || hasta <= 0 || hasta > 100))
      return { ok: false, error: `Tramo ${n}: el % de error va de 0 a 100` };
    if (!Number.isFinite(descuento) || descuento < 0 || descuento > 100)
      return { ok: false, error: `Tramo ${n}: el descuento va de 0 a 100 %` };

    const previo = tramos[i - 1];
    if (previo && (previo.hasta === null || (hasta !== null && hasta <= previo.hasta)))
      return {
        ok: false,
        error: `Tramo ${n}: el % de error tiene que ser mayor que el del tramo anterior (${previo.hasta ?? "sin tope"})`,
      };

    tramos.push({ hasta: hasta === null ? null : red2(hasta), descuento: red2(descuento) });
  }
  return { ok: true, tramos };
}

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autenticado" }, { status: 401 });

  try {
    const filas = await prisma.premio_escala.findMany({
      select: { ambito: true, vigencia: true, tramos: true, updatedAt: true },
      orderBy: [{ ambito: "asc" }, { vigencia: "asc" }],
    });

    const escalas: Record<Ambito, unknown[]> = { preparado: [], mesa: [] };
    for (const f of filas) {
      const ambito = f.ambito.trim();
      if (!esAmbito(ambito)) continue;
      escalas[ambito].push({
        vigencia: f.vigencia.trim(),
        tramos: f.tramos,
        actualizado: f.updatedAt.toISOString(),
      });
    }

    return NextResponse.json({ escalas, puedeEditar: session.rol === "ADMIN" });
  } catch (error) {
    console.error("GET /api/rrhh/premios/escala", error);
    return NextResponse.json({ error: "No se pudo leer la escala" }, { status: 503 });
  }
}

export async function POST(req: NextRequest) {
  const admin = await requireAdmin();
  if (!admin.ok) return NextResponse.json({ error: admin.error }, { status: admin.status });
  const session = await getSession();

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  const ambito = String(body.ambito ?? "").trim();
  const vigencia = String(body.vigencia ?? "").trim();
  if (!esAmbito(ambito))
    return NextResponse.json({ error: "'ambito' inválido: preparado | mesa" }, { status: 400 });
  if (!YM.test(vigencia))
    return NextResponse.json({ error: "'vigencia' inválida: se espera YYYY-MM" }, { status: 400 });

  const v = validarTramos(body.tramos);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });

  try {
    const fila = await prisma.premio_escala.upsert({
      where: { ambito_vigencia: { ambito, vigencia } },
      create: { ambito, vigencia, tramos: v.tramos, creadoPor: session?.uid ?? null },
      update: { tramos: v.tramos, creadoPor: session?.uid ?? null },
      select: { ambito: true, vigencia: true, tramos: true, updatedAt: true },
    });
    return NextResponse.json({
      ambito: fila.ambito.trim(),
      vigencia: fila.vigencia.trim(),
      tramos: fila.tramos,
      actualizado: fila.updatedAt.toISOString(),
    });
  } catch (error) {
    console.error("POST /api/rrhh/premios/escala", error);
    return NextResponse.json({ error: "No se pudo guardar la escala" }, { status: 503 });
  }
}

export async function DELETE(req: NextRequest) {
  const admin = await requireAdmin();
  if (!admin.ok) return NextResponse.json({ error: admin.error }, { status: admin.status });

  const sp = req.nextUrl.searchParams;
  const ambito = sp.get("ambito")?.trim() ?? "";
  const vigencia = sp.get("vigencia")?.trim() ?? "";
  if (!esAmbito(ambito))
    return NextResponse.json({ error: "'ambito' inválido: preparado | mesa" }, { status: 400 });
  if (!YM.test(vigencia))
    return NextResponse.json({ error: "'vigencia' inválida: se espera YYYY-MM" }, { status: 400 });

  try {
    await prisma.premio_escala.delete({ where: { ambito_vigencia: { ambito, vigencia } } });
    return NextResponse.json({ ok: true });
  } catch {
    // Borrar algo que no está no es un error para la pantalla: el estado final
    // es el mismo (esa versión no existe).
    return NextResponse.json({ ok: true });
  }
}
