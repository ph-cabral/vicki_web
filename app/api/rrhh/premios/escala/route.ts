// Escala de premios por errores — modal "Márgenes" de /rrhh/premios.
//
// Tramos de errores -> % del premio que se RESTA (de 0 a 5 errores resta 0 %,
// de 6 a 10 resta 25 %, etc.). Dos escalas independientes: 'preparado'
// (tabla Preparadores) y 'mesa' (tabla Mesa de Control).
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
// Techo defensivo para el "hasta" de un tramo cerrado: nadie hace 10.000
// errores en un mes, un número así es un dedazo cargando.
const MAX_ERRORES = 10_000;

export type Tramo = { desde: number; hasta: number | null; descuento: number };

function esAmbito(v: unknown): v is Ambito {
  return typeof v === "string" && (AMBITOS as readonly string[]).includes(v);
}

/**
 * Los tramos tienen que cubrir la recta de errores SIN huecos ni
 * superposiciones: arrancan en 0, cada `desde` es el `hasta` anterior + 1, y
 * sólo el último puede quedar abierto (`hasta: null`). Si no, un error podría
 * caer en dos tramos (o en ninguno) y el premio saldría distinto según el orden
 * en que se recorra la lista.
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
    const desde = Number(t?.desde);
    const hasta = t?.hasta === null || t?.hasta === undefined || t?.hasta === "" ? null : Number(t.hasta);
    const descuento = Number(t?.descuento);

    if (!Number.isInteger(desde) || desde < 0)
      return { ok: false, error: `Tramo ${n}: "desde" tiene que ser un entero de 0 o más` };
    if (hasta !== null && (!Number.isInteger(hasta) || hasta > MAX_ERRORES))
      return { ok: false, error: `Tramo ${n}: "hasta" tiene que ser un entero (máximo ${MAX_ERRORES})` };
    if (hasta !== null && hasta < desde)
      return { ok: false, error: `Tramo ${n}: "hasta" no puede ser menor que "desde"` };
    if (!Number.isFinite(descuento) || descuento < 0 || descuento > 100)
      return { ok: false, error: `Tramo ${n}: el descuento va de 0 a 100 %` };
    if (hasta === null && i !== raw.length - 1)
      return { ok: false, error: `Tramo ${n}: sólo el último puede quedar sin tope` };

    const previo = tramos[i - 1];
    if (i === 0) {
      if (desde !== 0) return { ok: false, error: "El primer tramo tiene que arrancar en 0 errores" };
    } else if (previo.hasta === null || desde !== previo.hasta + 1) {
      return { ok: false, error: `Tramo ${n}: tiene que arrancar en ${(previo.hasta ?? 0) + 1} (sin huecos ni superposición)` };
    }

    tramos.push({ desde, hasta, descuento: Math.round(descuento * 100) / 100 });
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
