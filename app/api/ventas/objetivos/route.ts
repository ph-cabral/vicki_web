// Objetivos de venta por VENDEDOR, LÍNEA y MES (2026-09-09).
//
// Los consume la pestaña "Pulso" de /ventas/bulones: al lado de lo vendido
// por cada vendedor en el período elegido va cuánto tenía que vender y el
// porcentaje de cumplimiento.
//
// Desde 2026-09-17 el objetivo puede cargarse en $ (columna `objetivo`,
// como antes) Y/O en UNIDADES (columna `objetivoUnidades`) — son dos
// campos INDEPENDIENTES de la misma fila (linea, vendedor, mes): un
// vendedor puede tener uno solo, los dos, o ninguno. Toda escritura
// (POST/DELETE) toma un `tipo` ("pesos" | "unidades") y toca SÓLO esa
// columna; la otra, si tiene algo cargado, no se toca.
//
//   GET    ?linea=BULONERIA[&desde=YYYY-MM][&hasta=YYYY-MM]
//          -> { linea, objetivos: { [vendedor]: { [mes]: { pesos?, unidades? } } }, puedeEditar }
//          UNA sola lectura trae todos los vendedores del rango: la pantalla
//          arma el ranking entero sin pegarle una vez por fila. `puedeEditar`
//          viaja en la misma respuesta para saber si mostrar el botón.
//
//   POST   { linea, vendedor, tipo: "pesos"|"unidades", meses: [{ mes, valor }] }
//          -> upsert de cada mes PARA ESE TIPO; un mes con el valor VACÍO
//             borra sólo ese tipo en ese mes (si el otro tipo le queda algo
//             cargado, la fila no se borra). "pesos" entra EN MILES y se
//             guarda en PESOS (x1.000); "unidades" entra sin escala. Va
//             todo en una transacción: o queda el rango entero o no queda
//             nada (si no, un objetivo "de 6 meses" puede quedar a medias).
//
//   DELETE ?linea&vendedor&tipo=pesos|unidades&mes=YYYY-MM      -> borra ese mes (sólo ese tipo)
//          ?linea&vendedor&tipo=pesos|unidades&desde=…&hasta=…  -> borra el rango (sólo ese tipo)
//
// OJO CON EL CHECK "al menos un tipo cargado": Postgres NO admite CHECK
// diferibles, así que un UPDATE que deje una fila con los dos campos en
// NULL falla en el acto, aunque haya un DELETE de limpieza después en la
// MISMA transacción. Por eso, antes de tocar nada, se lee el estado actual
// de las filas del rango y se decide fila por fila: si el OTRO tipo tiene
// algo cargado, se hace UPDATE (borra sólo esta columna, la fila sigue
// siendo válida); si no, se hace DELETE directo de la fila entera (nunca
// un UPDATE que la deje en (NULL, NULL)).
//
// Escrituras: ADMIN (ver lib/ventas/objetivoAcceso.ts). La lectura la protege
// el módulo "ventas" del middleware, igual que el resto de /api/ventas/*.
//
// La tabla tiene una fila por línea, vendedor y mes (unos cientos por año):
// toda lectura es un index scan por (linea, mes) y no crece con el volumen de
// facturación.
import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth/session";
import { resolverAccesoObjetivoVentas } from "@/lib/ventas/objetivoAcceso";

export const dynamic = "force-dynamic";

const YM = /^\d{4}-(0[1-9]|1[0-2])$/;
const MIL = 1_000;
type Tipo = "pesos" | "unidades";
const TIPOS: Tipo[] = ["pesos", "unidades"];

// Techos defensivos contra un dedazo: 1.000.000 de miles = $1.000 millones
// de objetivo en UN mes para UN vendedor; 10.000.000 de unidades ídem.
const MAX_MILES = 1_000_000;
const MAX_UNIDADES = 10_000_000;

// Un objetivo se carga por un puñado de meses; 36 es un año y medio largo y
// alcanza de sobra. El tope existe para que un POST no arme una transacción
// de tamaño arbitrario.
const MAX_MESES = 36;

const normLinea = (v: unknown) => String(v ?? "").trim().toUpperCase().slice(0, 30);
const normTipo = (v: unknown): Tipo | null => (TIPOS.includes(v as Tipo) ? (v as Tipo) : null);

/** Valida el valor cargado según el tipo. `null` = el campo vino vacío (ese mes se borra). */
function aValor(
  v: unknown,
  mes: string,
  tipo: Tipo,
): { ok: true; valor: number | null } | { ok: false; error: string } {
  if (v === null || v === undefined || v === "") return { ok: true, valor: null };
  const n = Number(String(v).replace(",", "."));
  if (tipo === "pesos") {
    if (!Number.isFinite(n) || n <= 0)
      return { ok: false, error: `El objetivo de ${mes} tiene que ser un número mayor a 0 (en miles)` };
    if (n > MAX_MILES)
      return { ok: false, error: `El objetivo de ${mes} es demasiado alto (máximo ${MAX_MILES} miles)` };
    return { ok: true, valor: Math.round(n * MIL) };
  }
  if (!Number.isFinite(n) || n <= 0)
    return { ok: false, error: `El objetivo de ${mes} tiene que ser un número de unidades mayor a 0` };
  if (n > MAX_UNIDADES)
    return { ok: false, error: `El objetivo de ${mes} es demasiado alto (máximo ${MAX_UNIDADES} unidades)` };
  return { ok: true, valor: Math.round(n) };
}

/** Parche de escritura para una sola columna, sin gimnasia de claves computadas. */
function patchNull(tipo: Tipo): { objetivo: null } | { objetivoUnidades: null } {
  return tipo === "pesos" ? { objetivo: null } : { objetivoUnidades: null };
}
function patchValor(tipo: Tipo, valor: bigint): { objetivo: bigint } | { objetivoUnidades: bigint } {
  return tipo === "pesos" ? { objetivo: valor } : { objetivoUnidades: valor };
}

/**
 * Separa una lista de meses (de un vendedor/línea) en dos grupos según lo
 * que haya HOY en la base, para borrar el tipo pedido sin nunca dejar una
 * fila con los dos campos en NULL (ver comentario grande arriba):
 *   - `aLimpiar`: la fila existe y el OTRO tipo tiene algo -> UPDATE (sólo
 *     esta columna a NULL, la fila sigue siendo válida).
 *   - `aEliminar`: la fila existe y el OTRO tipo NO tiene nada -> DELETE de
 *     la fila entera.
 * Un mes sin fila (nunca se cargó nada) no entra en ninguno de los dos: no
 * hay nada que hacer.
 */
async function partirBorrado(linea: string, vendedor: number, meses: string[], tipo: Tipo) {
  const aLimpiar: string[] = [];
  const aEliminar: string[] = [];
  if (meses.length === 0) return { aLimpiar, aEliminar };
  const filas = await prisma.ventas_objetivo.findMany({
    where: { linea, vendedor, mes: { in: meses } },
    select: { mes: true, objetivo: true, objetivoUnidades: true },
  });
  for (const f of filas) {
    const otro = tipo === "pesos" ? f.objetivoUnidades : f.objetivo;
    (otro != null ? aLimpiar : aEliminar).push(f.mes.trim());
  }
  return { aLimpiar, aEliminar };
}

export async function GET(req: NextRequest) {
  const acceso = await resolverAccesoObjetivoVentas();
  if (!acceso.ok) return NextResponse.json({ error: acceso.error }, { status: acceso.status });

  const sp = req.nextUrl.searchParams;
  const linea = normLinea(sp.get("linea"));
  const desde = sp.get("desde")?.trim() || "";
  const hasta = sp.get("hasta")?.trim() || "";

  if (!linea) return NextResponse.json({ error: "Falta 'linea'" }, { status: 400 });
  for (const [nombre, v] of [["desde", desde], ["hasta", hasta]] as const) {
    if (v && !YM.test(v))
      return NextResponse.json({ error: `'${nombre}' inválido: se espera YYYY-MM` }, { status: 400 });
  }

  try {
    const filas = await prisma.ventas_objetivo.findMany({
      where: {
        linea,
        ...(desde || hasta
          ? { mes: { ...(desde ? { gte: desde } : {}), ...(hasta ? { lte: hasta } : {}) } }
          : {}),
      },
      select: { vendedor: true, mes: true, objetivo: true, objetivoUnidades: true },
      orderBy: [{ vendedor: "asc" }, { mes: "asc" }],
    });

    // Mapa vendedor -> mes -> { pesos?, unidades? }: la fila del ranking lo
    // consulta por su código, sin recorrer la lista. Los dos campos son
    // BIGINT en la base y BigInt no serializa a JSON, así que se pasan a
    // número acá (los techos de arriba los mantienen muy por debajo del
    // entero seguro de JS).
    const objetivos: Record<string, Record<string, { pesos?: number; unidades?: number }>> = {};
    for (const f of filas) {
      const v = String(f.vendedor);
      const mes = f.mes.trim();
      const fila: { pesos?: number; unidades?: number } = {};
      if (f.objetivo != null) fila.pesos = Number(f.objetivo);
      if (f.objetivoUnidades != null) fila.unidades = Number(f.objetivoUnidades);
      if (Object.keys(fila).length > 0) (objetivos[v] ??= {})[mes] = fila;
    }
    return NextResponse.json({ linea, objetivos, puedeEditar: acceso.puedeEditar });
  } catch (error) {
    console.error("GET /api/ventas/objetivos", error);
    return NextResponse.json({ error: "No se pudieron leer los objetivos" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const acceso = await resolverAccesoObjetivoVentas();
  if (!acceso.ok) return NextResponse.json({ error: acceso.error }, { status: acceso.status });
  if (!acceso.puedeEditar)
    return NextResponse.json({ error: "No tenés permiso para cargar objetivos de venta" }, { status: 403 });

  const body = await req.json().catch(() => null);
  const linea = normLinea(body?.linea);
  const vendedor = Number(body?.vendedor);
  const tipo = normTipo(body?.tipo);
  const meses = Array.isArray(body?.meses) ? body.meses : null;

  if (!linea) return NextResponse.json({ error: "Falta 'linea'" }, { status: 400 });
  if (!Number.isInteger(vendedor) || vendedor <= 0)
    return NextResponse.json({ error: "Falta el vendedor" }, { status: 400 });
  if (!tipo) return NextResponse.json({ error: "'tipo' tiene que ser 'pesos' o 'unidades'" }, { status: 400 });
  if (!meses || meses.length === 0)
    return NextResponse.json({ error: "No hay meses para guardar" }, { status: 400 });
  if (meses.length > MAX_MESES)
    return NextResponse.json({ error: `Demasiados meses (máximo ${MAX_MESES})` }, { status: 400 });

  // Se valida TODO antes de escribir: si un mes está mal, no se guarda
  // ninguno y el usuario corrige con el rango completo a la vista.
  const aGuardar: { mes: string; valor: number }[] = [];
  const aBorrar: string[] = [];
  const vistos = new Set<string>();
  for (const m of meses as { mes?: unknown; valor?: unknown }[]) {
    const mes = String(m?.mes ?? "").trim();
    if (!YM.test(mes))
      return NextResponse.json({ error: `Mes inválido: ${mes || "(vacío)"}` }, { status: 400 });
    if (vistos.has(mes))
      return NextResponse.json({ error: `El mes ${mes} viene repetido` }, { status: 400 });
    vistos.add(mes);
    const v = aValor(m?.valor, mes, tipo);
    if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
    if (v.valor === null) aBorrar.push(mes);
    else aGuardar.push({ mes, valor: v.valor });
  }

  const s = await getSession();

  try {
    // Los meses a "borrar" (valor vacío) se reparten en UPDATE (limpia sólo
    // esta columna, si el otro tipo tiene algo) o DELETE (fila entera, si
    // no) según lo que haya HOY — nunca un UPDATE que deje la fila con los
    // dos tipos en NULL (ver comentario grande arriba). Los meses a guardar
    // van todos en la MISMA transacción: o queda el rango entero o no queda
    // nada.
    const { aLimpiar, aEliminar } = await partirBorrado(linea, vendedor, aBorrar, tipo);

    await prisma.$transaction([
      ...(aLimpiar.length
        ? [prisma.ventas_objetivo.updateMany({ where: { linea, vendedor, mes: { in: aLimpiar } }, data: patchNull(tipo) })]
        : []),
      ...(aEliminar.length
        ? [prisma.ventas_objetivo.deleteMany({ where: { linea, vendedor, mes: { in: aEliminar } } })]
        : []),
      ...aGuardar.map((g) =>
        prisma.ventas_objetivo.upsert({
          where: { linea_vendedor_mes: { linea, vendedor, mes: g.mes } },
          create: {
            linea,
            vendedor,
            mes: g.mes,
            ...patchValor(tipo, BigInt(g.valor)),
            creadoPor: s?.uid ?? null,
          },
          update: patchValor(tipo, BigInt(g.valor)),
        }),
      ),
    ]);

    // Se devuelve el estado final del vendedor (para este tipo) para que la
    // pantalla no recargue todo el mapa después de guardar.
    const valores: Record<string, number> = {};
    for (const g of aGuardar) valores[g.mes] = g.valor;
    return NextResponse.json({
      ok: true,
      linea,
      vendedor,
      tipo,
      valores,
      borrados: aBorrar,
    });
  } catch (error) {
    console.error("POST /api/ventas/objetivos", error);
    return NextResponse.json({ error: "No se pudieron guardar los objetivos" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const acceso = await resolverAccesoObjetivoVentas();
  if (!acceso.ok) return NextResponse.json({ error: acceso.error }, { status: acceso.status });
  if (!acceso.puedeEditar)
    return NextResponse.json({ error: "No tenés permiso para borrar objetivos de venta" }, { status: 403 });

  const sp = req.nextUrl.searchParams;
  const linea = normLinea(sp.get("linea"));
  const vendedor = Number(sp.get("vendedor"));
  const tipo = normTipo(sp.get("tipo"));
  const mes = sp.get("mes")?.trim() || "";
  const desde = sp.get("desde")?.trim() || "";
  const hasta = sp.get("hasta")?.trim() || "";

  if (!linea) return NextResponse.json({ error: "Falta 'linea'" }, { status: 400 });
  if (!Number.isInteger(vendedor) || vendedor <= 0)
    return NextResponse.json({ error: "Falta el vendedor" }, { status: 400 });
  if (!tipo) return NextResponse.json({ error: "'tipo' tiene que ser 'pesos' o 'unidades'" }, { status: 400 });
  if (!mes && !(desde && hasta))
    return NextResponse.json({ error: "Falta 'mes' o el rango 'desde'/'hasta'" }, { status: 400 });
  for (const [nombre, v] of [["mes", mes], ["desde", desde], ["hasta", hasta]] as const) {
    if (v && !YM.test(v))
      return NextResponse.json({ error: `'${nombre}' inválido: se espera YYYY-MM` }, { status: 400 });
  }

  try {
    // mes|rango -> lista de meses concreta (necesaria para partirBorrado,
    // que lee la base fila por fila).
    let meses: string[];
    if (mes) {
      meses = [mes];
    } else {
      meses = [];
      let [a, m] = desde.split("-").map(Number);
      for (let i = 0; i < 120; i++) {
        const ym = `${a}-${String(m).padStart(2, "0")}`;
        meses.push(ym);
        if (ym >= hasta) break;
        m += 1;
        if (m > 12) {
          m = 1;
          a += 1;
        }
      }
    }

    const { aLimpiar, aEliminar } = await partirBorrado(linea, vendedor, meses, tipo);

    await prisma.$transaction([
      ...(aLimpiar.length
        ? [prisma.ventas_objetivo.updateMany({ where: { linea, vendedor, mes: { in: aLimpiar } }, data: patchNull(tipo) })]
        : []),
      ...(aEliminar.length
        ? [prisma.ventas_objetivo.deleteMany({ where: { linea, vendedor, mes: { in: aEliminar } } })]
        : []),
    ]);

    return NextResponse.json({ ok: true, borrados: aLimpiar.length + aEliminar.length });
  } catch (error) {
    console.error("DELETE /api/ventas/objetivos", error);
    return NextResponse.json({ error: "No se pudieron borrar los objetivos" }, { status: 500 });
  }
}
