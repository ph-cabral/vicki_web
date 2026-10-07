// Objetivos mensuales del ranking de operarios de /deposito (2026-09-09).
//
// Son las 3 líneas de referencia que se dibujan sobre las barras de las
// pestañas Picking / Libre + Reposición / Re-Ubicación:
//   objetivo (verde) · sobresaliente (amarilla) · bajo rendimiento (roja)
//
//   GET    ?proceso=Picking[&desde=YYYY-MM&hasta=YYYY-MM]
//          -> { objetivos: { [mes]: { objetivo, sobresaliente, bajo } }, puedeEditar }
//          `puedeEditar` viaja en la respuesta para que la vista sepa si
//          mostrar el botón sin pegarle a otro endpoint.
//   POST   { proceso, mes, objetivo, sobresaliente?, bajo? }  (todo en ITEMS)
//          -> upsert por (proceso + mes). Los valores entran y se guardan en
//             ITEMS, la misma unidad que las barras (2026-10-07: antes se
//             cargaban en miles y x1.000 y se cargaba mal: 4500 -> 4.500.000).
//   DELETE ?proceso=Picking&mes=YYYY-MM  -> borra las 3 líneas de ese mes.
//
// Escrituras: ADMIN o encargado con la bandera `depositoObjetivoAcceso`
// (ver lib/deposito/objetivoAcceso.ts). La lectura la protege el módulo
// "deposito" en el middleware, igual que el resto de /api/deposito/*.
//
// La tabla tiene una fila por proceso y mes (~36 por año): toda lectura es un
// index scan de un puñado de filas por (proceso, mes) y no crece con el
// volumen del WMS.
import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth/session";
import { resolverAccesoObjetivoDeposito } from "@/lib/deposito/objetivoAcceso";

export const dynamic = "force-dynamic";

const YM = /^\d{4}-(0[1-9]|1[0-2])$/;
// Techo defensivo: 1.000.000 de items en un mes por operario. Cualquier cosa
// por encima es un dedazo de ceros.
const MAX_ITEMS = 1_000_000;

type Linea = { objetivo: number; sobresaliente: number | null; bajo: number | null };

/** Items enteros. Devuelve null si el campo vino vacío (línea opcional). */
function aItems(v: unknown, campo: string): { ok: true; valor: number | null } | { ok: false; error: string } {
  if (v === null || v === undefined || v === "") return { ok: true, valor: null };
  const items = Number(typeof v === "string" ? v.replace(",", ".") : v);
  if (!Number.isFinite(items) || items <= 0)
    return { ok: false, error: `'${campo}' tiene que ser un número mayor a 0 (en items)` };
  if (items > MAX_ITEMS)
    return { ok: false, error: `'${campo}' es demasiado alto (máximo ${MAX_ITEMS} items)` };
  return { ok: true, valor: Math.round(items) };
}

export async function GET(req: NextRequest) {
  const acceso = await resolverAccesoObjetivoDeposito();
  if (!acceso.ok) return NextResponse.json({ error: acceso.error }, { status: acceso.status });

  const sp = req.nextUrl.searchParams;
  const proceso = sp.get("proceso")?.trim() || "";
  const desde = sp.get("desde")?.trim() || "";
  const hasta = sp.get("hasta")?.trim() || "";

  if (!proceso) return NextResponse.json({ error: "Falta 'proceso'" }, { status: 400 });
  for (const [nombre, v] of [["desde", desde], ["hasta", hasta]] as const) {
    if (v && !YM.test(v))
      return NextResponse.json({ error: `'${nombre}' inválido: se espera YYYY-MM` }, { status: 400 });
  }

  try {
    const filas = await prisma.deposito_objetivo.findMany({
      where: {
        proceso,
        ...(desde || hasta
          ? { mes: { ...(desde ? { gte: desde } : {}), ...(hasta ? { lte: hasta } : {}) } }
          : {}),
      },
      select: { mes: true, objetivo: true, sobresaliente: true, bajo: true },
      orderBy: { mes: "asc" },
    });

    // Mapa mes -> líneas: la vista lo consulta por el mes activo, sin recorrer.
    const objetivos: Record<string, Linea> = {};
    for (const f of filas) {
      objetivos[f.mes.trim()] = {
        objetivo: f.objetivo,
        sobresaliente: f.sobresaliente,
        bajo: f.bajo,
      };
    }
    return NextResponse.json({ proceso, objetivos, puedeEditar: acceso.puedeEditar });
  } catch (error) {
    console.error("GET /api/deposito/objetivos", error);
    return NextResponse.json({ error: "No se pudieron leer los objetivos" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const acceso = await resolverAccesoObjetivoDeposito();
  if (!acceso.ok) return NextResponse.json({ error: acceso.error }, { status: acceso.status });
  if (!acceso.puedeEditar)
    return NextResponse.json(
      { error: "No tenés permiso para cargar objetivos de depósito" },
      { status: 403 },
    );

  const body = await req.json().catch(() => null);
  const proceso = String(body?.proceso ?? "").trim().slice(0, 40);
  const mes = String(body?.mes ?? "").trim();

  if (!proceso) return NextResponse.json({ error: "Falta 'proceso'" }, { status: 400 });
  if (!YM.test(mes))
    return NextResponse.json({ error: "Mes inválido: se espera YYYY-MM" }, { status: 400 });

  const obj = aItems(body?.objetivo, "objetivo");
  if (!obj.ok) return NextResponse.json({ error: obj.error }, { status: 400 });
  if (obj.valor === null)
    return NextResponse.json({ error: "El objetivo es obligatorio" }, { status: 400 });
  const sob = aItems(body?.sobresaliente, "sobresaliente");
  if (!sob.ok) return NextResponse.json({ error: sob.error }, { status: 400 });
  const baj = aItems(body?.bajo, "bajo rendimiento");
  if (!baj.ok) return NextResponse.json({ error: baj.error }, { status: 400 });

  // Orden lógico de las líneas: bajo < objetivo < sobresaliente. Si están al
  // revés el gráfico se lee al revés, así que se corta acá y no en la pantalla.
  if (sob.valor !== null && sob.valor <= obj.valor)
    return NextResponse.json(
      { error: "Sobresaliente tiene que ser mayor que el objetivo" },
      { status: 400 },
    );
  if (baj.valor !== null && baj.valor >= obj.valor)
    return NextResponse.json(
      { error: "Bajo rendimiento tiene que ser menor que el objetivo" },
      { status: 400 },
    );

  const s = await getSession();

  try {
    // Mismo proceso + mismo mes = corrección, no un objetivo nuevo (lo
    // garantiza la UNIQUE de la tabla).
    const fila = await prisma.deposito_objetivo.upsert({
      where: { proceso_mes: { proceso, mes } },
      create: {
        proceso,
        mes,
        objetivo: obj.valor,
        sobresaliente: sob.valor,
        bajo: baj.valor,
        creadoPor: s?.uid ?? null,
      },
      update: { objetivo: obj.valor, sobresaliente: sob.valor, bajo: baj.valor },
    });
    return NextResponse.json({
      ok: true,
      id: fila.id,
      mes,
      objetivo: fila.objetivo,
      sobresaliente: fila.sobresaliente,
      bajo: fila.bajo,
    });
  } catch (error) {
    console.error("POST /api/deposito/objetivos", error);
    return NextResponse.json({ error: "No se pudo guardar el objetivo" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const acceso = await resolverAccesoObjetivoDeposito();
  if (!acceso.ok) return NextResponse.json({ error: acceso.error }, { status: acceso.status });
  if (!acceso.puedeEditar)
    return NextResponse.json(
      { error: "No tenés permiso para borrar objetivos de depósito" },
      { status: 403 },
    );

  const sp = req.nextUrl.searchParams;
  const proceso = sp.get("proceso")?.trim() || "";
  const mes = sp.get("mes")?.trim() || "";
  if (!proceso) return NextResponse.json({ error: "Falta 'proceso'" }, { status: 400 });
  if (!YM.test(mes))
    return NextResponse.json({ error: "Mes inválido: se espera YYYY-MM" }, { status: 400 });

  try {
    await prisma.deposito_objetivo.deleteMany({ where: { proceso, mes } });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("DELETE /api/deposito/objetivos", error);
    return NextResponse.json({ error: "No se pudo borrar el objetivo" }, { status: 500 });
  }
}
