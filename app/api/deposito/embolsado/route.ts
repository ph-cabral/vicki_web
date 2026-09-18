// Sistema de embolsado — /deposito/embolsado (2026-09-10).
//
// Una sola ruta con las tres cosas que necesita la pantalla, así el operario
// carga la vista con un solo viaje:
//
//   GET    [?meses_venta=6&meses_cobertura=4]
//          -> { rows, pendientes, enCurso, hechosHoy, ... }
//          `rows`       = recomendación en vivo (proxy → FastAPI, que la calcula
//                         contra Magnus + WMS; ver indicadores-api/embolsado.py),
//                         YA SIN los artículos recién cerrados (ver `pendientes`)
//          `pendientes` = artículos cerrados en los últimos 3 días que
//                         `rows` sacó de la lista de trabajo porque el WMS
//                         todavía no confirmó el movimiento; se calcula acá
//                         cruzando `rows` con los cierres recientes de
//                         Postgres, no en el FastAPI (que es sólo lectura de
//                         Magnus/WMS)
//          `enCurso`    = ítems tomados y todavía sin cerrar (Postgres)
//          `hechosHoy`  = lo terminado desde las 00:00 de hoy (Postgres)
//   POST   { codArticulo, usuario, ... }  -> valida el usuario y toma el ítem
//   PATCH  { id, cantidad }               -> lo cierra (fin + cantidad)
//
// RECIÉN EMBOLSADO. Sin esto, un artículo se queda en "Para embolsar" todo lo
// que tarde el WMS en reflejar el movimiento físico (puede ser días: ver
// claude/deposito_embolsado.md), y como la pantalla la usan varios
// preparadores sin coordinarse, terminan re-embolsando lo mismo. Por eso todo
// artículo con un cierre en los últimos `VENTANA_PENDIENTE_DIAS` días se saca
// de `rows` y pasa a `pendientes` — hasta que el propio WMS confirme el
// movimiento (con tolerancia `CONFIRMACION_TOLERANCIA`) o venzan los días de
// gracia, lo que pase primero. Ninguno de los dos cambia el cálculo de
// cobertura: sólo deciden en qué lista aparece.
//
// QUIÉN embolsa. La pantalla la comparten varias personas desde una sola PC:
// la sesión de la app no dice quién está parado ahí, así que cada vez que
// alguien toma un ítem manda su usuario de MAGNUS (número o nombre) y el POST
// lo resuelve contra `Gen_Usuarios` (FastAPI /deposito/embolsado/usuario)
// ANTES de escribir. La validación vive acá y no en el front a propósito: es
// la única forma de que no se pueda abrir una fila con un nombre inventado.
// Si el nombre es ambiguo se devuelve 400 con `candidatos` y la pantalla los
// ofrece para elegir.
//
// Los dos candados —un artículo tomado por una sola persona, y una persona
// con un solo ítem abierto— son índices únicos PARCIALES en Postgres (WHERE
// fin IS NULL, ver sql/deposito_embolsado.sql). Acá se chequea antes para dar
// un mensaje entendible, y el índice queda como red contra la carrera de dos
// pantallas tocando el mismo ítem en el mismo segundo (→ 409).
//
// Volumen: `enCurso` son un puñado de filas (índice parcial) y `hechosHoy` un
// range scan sobre (inicio DESC). Ninguna de las dos crece con el histórico.
import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth/session";

const API_URL = process.env.INDICADORES_API_URL ?? "http://indicadores-api:8001";

export const dynamic = "force-dynamic";

const MAX_CANTIDAD = 1_000_000; // techo defensivo contra el dedazo al cargar

// "Recién embolsado": un artículo que se acaba de cerrar se saca de la lista
// de trabajo por unos días, para que dos preparadores que no se cruzan no
// sigan tomando lo mismo mientras el movimiento físico todavía no se reflejó
// en el WMS (ver claude/deposito_embolsado.md, "Por qué un artículo recién
// embolsado sigue apareciendo para embolsar"). Sale antes si el propio WMS ya
// confirma el movimiento (bajó lo que había en el pulmón, o subió el stock ya
// embolsado, lo esperado); si nunca confirma, a los 3 días vuelve solo a la
// lista — no tiene sentido esconder un faltante real para siempre.
const VENTANA_PENDIENTE_DIAS = 3;
const VENTANA_PENDIENTE_MS = VENTANA_PENDIENTE_DIAS * 24 * 60 * 60 * 1000;
const CONFIRMACION_TOLERANCIA = 0.8; // 80% de lo embolsado alcanza para confirmar

type Registro = {
  id: number;
  codArticulo: string;
  nombre: string;
  empaque: string;
  usuarioMagnus: number;
  embolsador: string;
  inicio: Date;
  fin: Date | null;
  cantidad: number | null;
  recomendado: number | null;
  enIngreso: number | null;
};

const SELECT_REGISTRO = {
  id: true,
  codArticulo: true,
  nombre: true,
  empaque: true,
  usuarioMagnus: true,
  embolsador: true,
  inicio: true,
  fin: true,
  cantidad: true,
  recomendado: true,
  enIngreso: true,
} as const;

/** Fila de `cerradosRecientes`: sólo lo necesario para el chequeo de confirmación. */
type Cierre = {
  codArticulo: string;
  cantidad: number | null;
  fin: Date | null;
  enIngreso: number | null;
  stockSinIngreso: number | null;
};

/** Medianoche de hoy en hora local del server (el corte que ve el operario). */
function inicioDelDia(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function entero(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autenticado" }, { status: 401 });

  const sp = req.nextUrl.searchParams;
  const params = new URLSearchParams({
    meses_venta: sp.get("meses_venta") ?? "6",
    meses_cobertura: sp.get("meses_cobertura") ?? "4",
    incluir_cubiertos: sp.get("incluir_cubiertos") ?? "true",
  });

  // Recomendación y registros en paralelo: son bases distintas y ninguna
  // depende de la otra.
  const [reco, enCurso, hechosHoy, cerradosRecientes] = await Promise.all([
    fetch(`${API_URL}/deposito/embolsado?${params}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(60000),
    })
      .then(async (res) => {
        if (!res.ok) {
          const detail = await res.json().catch(() => null);
          return { error: "Error en API de embolsado", detail, status: res.status };
        }
        return res.json();
      })
      .catch((e) => {
        console.error("GET /api/deposito/embolsado (proxy)", e);
        return { error: "No se pudo conectar al servicio de depósito", status: 503 };
      }),
    prisma.deposito_embolsado.findMany({
      where: { fin: null },
      select: SELECT_REGISTRO,
      orderBy: { inicio: "asc" },
    }),
    prisma.deposito_embolsado.findMany({
      where: { fin: { not: null }, inicio: { gte: inicioDelDia() } },
      select: SELECT_REGISTRO,
      orderBy: { inicio: "desc" },
    }),
    prisma.deposito_embolsado.findMany({
      where: { fin: { not: null, gte: new Date(Date.now() - VENTANA_PENDIENTE_MS) } },
      select: { codArticulo: true, cantidad: true, fin: true, enIngreso: true, stockSinIngreso: true },
      orderBy: { fin: "asc" },
    }),
  ]);

  if (reco?.error) {
    return NextResponse.json(
      { error: reco.error, detail: reco.detail ?? null },
      { status: reco.status ?? 503 },
    );
  }

  // Un artículo recién cerrado se saca de `rows` y pasa a `pendientes` hasta
  // que el WMS confirme el movimiento o venzan los 3 días de gracia (ver
  // constantes arriba). `cierres` agrupa por artículo, ordenado por `fin` asc:
  // el primero de cada grupo es la foto más vieja dentro de la ventana (contra
  // la que se mide el delta) y el último marca cuándo vence la supresión.
  const cierres = new Map<string, Cierre[]>();
  for (const c of cerradosRecientes as Cierre[]) {
    const cod = c.codArticulo.trim();
    const arr = cierres.get(cod);
    if (arr) arr.push(c);
    else cierres.set(cod, [c]);
  }

  const rows: unknown[] = [];
  const pendientes: unknown[] = [];
  for (const r of (reco.rows ?? []) as Record<string, any>[]) {
    const grupo = cierres.get(String(r.codArticulo).trim());
    if (!grupo?.length) {
      rows.push(r);
      continue;
    }
    const foto = grupo[0];
    const ultimoCierre = grupo[grupo.length - 1].fin as Date;
    const venceEl = new Date(ultimoCierre.getTime() + VENTANA_PENDIENTE_MS);
    const cantidadEmbolsada = grupo.reduce((a, c) => a + (c.cantidad ?? 0), 0);

    // Dos señales, cualquiera alcanza: bajó lo que había en el pulmón de
    // ingreso, o subió el stock ya embolsado, al menos lo que se cargó acá.
    const deltaIngreso = foto.enIngreso != null ? foto.enIngreso - Number(r.enIngreso) : null;
    const deltaStock = foto.stockSinIngreso != null ? Number(r.stockSinIngreso) - foto.stockSinIngreso : null;
    const confirmado =
      (deltaIngreso != null && deltaIngreso >= cantidadEmbolsada * CONFIRMACION_TOLERANCIA) ||
      (deltaStock != null && deltaStock >= cantidadEmbolsada * CONFIRMACION_TOLERANCIA);

    if (confirmado || Date.now() > venceEl.getTime()) {
      rows.push(r); // el WMS ya lo reflejó, o pasaron los 3 días: vuelve al flujo normal
    } else {
      pendientes.push({ ...r, cantidadEmbolsada, ultimoCierre, venceEl });
    }
  }

  return NextResponse.json({ ...reco, rows, pendientes, enCurso, hechosHoy });
}

/** Resuelve el usuario tipeado contra Gen_Usuarios (Magnus). */
async function resolverUsuario(q: string): Promise<
  | { ok: true; numero: number; nombre: string }
  | { ok: false; status: number; error: string; candidatos: { numero: number; nombre: string }[] }
> {
  try {
    const res = await fetch(
      `${API_URL}/deposito/embolsado/usuario?q=${encodeURIComponent(q)}`,
      { cache: "no-store", signal: AbortSignal.timeout(15000) },
    );
    const j = await res.json().catch(() => ({}));
    if (!res.ok)
      return { ok: false, status: 503, error: "No se pudo validar el usuario contra Magnus", candidatos: [] };
    if (j?.ok === true && j?.usuario?.numero != null)
      return { ok: true, numero: Number(j.usuario.numero), nombre: String(j.usuario.nombre) };
    return {
      ok: false,
      status: 400,
      error: j?.error || "Usuario no encontrado en Magnus",
      candidatos: Array.isArray(j?.candidatos) ? j.candidatos : [],
    };
  } catch (e) {
    console.error("resolverUsuario", e);
    return { ok: false, status: 503, error: "No se pudo validar el usuario contra Magnus", candidatos: [] };
  }
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autenticado" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const codArticulo = String(body?.codArticulo ?? "").trim();
  const tipeado = String(body?.usuario ?? "").trim().replace(/\s+/g, " ");

  if (!codArticulo) return NextResponse.json({ error: "Falta el artículo" }, { status: 400 });
  // Un caracter solo vale si es un dígito: hay usuarios de Magnus de un dígito.
  if (!tipeado || (tipeado.length < 2 && !/^\d$/.test(tipeado)))
    return NextResponse.json({ error: "Escribí tu nombre o número de usuario" }, { status: 400 });

  const usuario = await resolverUsuario(tipeado);
  if (!usuario.ok)
    return NextResponse.json(
      { error: usuario.error, candidatos: usuario.candidatos },
      { status: usuario.status },
    );

  // Chequeo previo sólo para el mensaje: el candado real es el índice parcial.
  const abiertos = await prisma.deposito_embolsado.findMany({
    where: { fin: null },
    select: { codArticulo: true, embolsador: true, usuarioMagnus: true },
  });
  const tomado = abiertos.find((r) => r.codArticulo.trim() === codArticulo);
  if (tomado)
    return NextResponse.json(
      { error: `${codArticulo} ya lo está embolsando ${tomado.embolsador}` },
      { status: 409 },
    );
  const ocupado = abiertos.find((r) => r.usuarioMagnus === usuario.numero);
  if (ocupado)
    return NextResponse.json(
      { error: `${usuario.nombre} tiene abierto ${ocupado.codArticulo}: hay que cerrarlo primero` },
      { status: 409 },
    );

  try {
    const fila = await prisma.deposito_embolsado.create({
      data: {
        codArticulo,
        usuarioMagnus: usuario.numero,
        embolsador: usuario.nombre.slice(0, 60),
        nombre: String(body?.nombre ?? "").trim().slice(0, 160),
        empaque: String(body?.empaque ?? "").trim().slice(0, 40),
        recomendado: entero(body?.recomendado),
        ventaMaxMes: entero(body?.ventaMaxMes),
        stockSinIngreso: entero(body?.stockSinIngreso),
        enIngreso: entero(body?.enIngreso),
        creadoPor: session.uid,
      },
      select: SELECT_REGISTRO,
    });
    return NextResponse.json(fila);
  } catch (e) {
    // P2002 = pisó uno de los índices parciales (dos pantallas a la vez).
    if ((e as { code?: string })?.code === "P2002")
      return NextResponse.json(
        { error: "Alguien lo tomó justo antes. Refrescá la lista." },
        { status: 409 },
      );
    console.error("POST /api/deposito/embolsado", e);
    return NextResponse.json({ error: "No se pudo tomar el ítem" }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autenticado" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const id = entero(body?.id);
  const cantidad = entero(body?.cantidad);

  if (!id) return NextResponse.json({ error: "Falta el registro" }, { status: 400 });
  if (cantidad === null || cantidad < 0)
    return NextResponse.json({ error: "La cantidad tiene que ser un número mayor o igual a 0" }, { status: 400 });
  if (cantidad > MAX_CANTIDAD)
    return NextResponse.json({ error: "La cantidad es demasiado alta" }, { status: 400 });

  // Tope: no se puede embolsar más de lo que había a granel en el pulmón de
  // ingreso cuando se tomó el ítem (foto guardada en la fila). Es material
  // físico: cualquier número mayor es un dedazo. Si la fila es vieja y no tiene
  // la foto (`enIngreso` null), no hay contra qué comparar y se deja pasar.
  const previo = await prisma.deposito_embolsado.findUnique({
    where: { id },
    select: { enIngreso: true },
  });
  if (previo?.enIngreso != null && cantidad > previo.enIngreso)
    return NextResponse.json(
      {
        error: `No se puede embolsar más de ${previo.enIngreso} u: es todo lo que hay en el pulmón de ingreso`,
      },
      { status: 400 },
    );

  // updateMany con `fin: null` en el WHERE: si otro ya lo cerró, devuelve 0 y
  // no se pisa el cierre anterior.
  const r = await prisma.deposito_embolsado.updateMany({
    where: { id, fin: null },
    data: { fin: new Date(), cantidad },
  });
  if (r.count === 0)
    return NextResponse.json({ error: "Ese ítem ya estaba cerrado" }, { status: 409 });

  const fila = await prisma.deposito_embolsado.findUnique({
    where: { id },
    select: SELECT_REGISTRO,
  });
  return NextResponse.json(fila);
}

export type { Registro };
