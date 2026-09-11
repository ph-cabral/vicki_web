// Costo real de nómina por mes — pestaña Nómina de /rrhh (2026-09-11).
//
// Se carga desde el Excel de "pago de sueldos" que sube RRHH (parseado en el
// front con lib/rrhh/parseXlsx.ts + lib/rrhh/nomina.ts). Una fila en
// everwear.nomina_mes por mes, con el detalle línea a línea en `filas`
// (JSONB) — se lee/escribe el mes COMPLETO siempre, nunca una fila suelta,
// mismo criterio que /api/rrhh/premios/escala.
//
//   GET  ?mes=YYYY-MM  -> detalle completo de ESE mes (filas crudas), o 404.
//   GET  (sin mes)     -> { puedeEditar, meses: [{ mes, total, cantEmpleados,
//                          archivoNombre, actualizado, porArea }] } — TODOS
//                          los meses cargados, para el gráfico "Costo de
//                          Nómina mes a mes". `porArea` sale de cruzar el
//                          legajo de cada fila contra legajo.codigo ->
//                          sectorRel -> area EN EL MOMENTO DE LEER (no se
//                          guarda), así el desglose refleja el organigrama
//                          actual aunque haya cambiado después de cargado el
//                          mes. Legajos sin match (de baja, o que no calzan
//                          con ningún `codigo`) van a "Sin área".
//
//                          El N° de legajo puede cambiar (ej. al cambiar de
//                          puesto/convenio) y el código viejo puede
//                          reciclarse en otra persona (2026-09-11): además
//                          del `codigo` actual, se busca en
//                          legajo_codigo_historial (ver legajoService.ts).
//                          Si un código matchea a MÁS DE UN legajo (el
//                          actual + históricos), se desempata por similitud
//                          de nombre contra la columna "Apellido y Nombre"
//                          del Excel (ver elegirCandidato()/similitudNombre()
//                          más abajo) — así el pago de cada mes se le
//                          atribuye a quien realmente tuvo ese código ESE
//                          mes, no siempre al dueño actual del número.
//   POST { mes, archivoNombre, filas, confirmar? } -> guarda/reemplaza ese
//          mes. Si el mes YA tiene datos y no viene `confirmar: true`,
//          devuelve 409 con el resumen de lo que se pisaría, para que el
//          front pida confirmación antes de reintentar.
//
// Escrituras: SOLO ADMIN (requireAdmin de lib/auth/guard.ts) — la API lo
// exige igual aunque el front esconda el botón. La lectura la cubre el
// módulo "rrhh" del middleware, como el resto de /api/rrhh/*.
// DDL: sql/rrhh_nomina_mes.sql.
import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth/session";
import { requireAdmin } from "@/lib/auth/guard";
import type { NominaFila } from "@/lib/rrhh/nomina";

export const dynamic = "force-dynamic";

const YM = /^\d{4}-(0[1-9]|1[0-2])$/;
const SIN_AREA = "Sin área";

function normLegajo(v: string): string {
  const s = v.trim();
  // "007" y "7" tienen que matchear el mismo legajo: si es numérico puro,
  // se compara también sin ceros a la izquierda.
  const n = Number(s);
  return Number.isFinite(n) && String(n) !== "" ? String(n) : s;
}

function normNombre(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Similitud por tokens, orden-independiente: "Bottero, Lucas Ariel" vs
 * "Bottero Lucas" da 2/3 ≈ 0.67. Con un puñado de candidatos por código
 * reciclado alcanza y sobra — no hace falta nada más pesado (ni una lib de
 * fuzzy-matching) para desempatar. */
function similitudNombre(a: string, b: string): number {
  const ta = new Set(normNombre(a).split(" ").filter(Boolean));
  const tb = new Set(normNombre(b).split(" ").filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / Math.max(ta.size, tb.size);
}

interface Candidato {
  legajoId: number;
  nombre: string;
  area: string;
}

/**
 * Candidatos de área por código de legajo — incluye el código ACTUAL
 * (legajo.codigo) y todo lo que aparece en legajo_codigo_historial (números
 * que la persona tuvo antes de cambiar de puesto/convenio, ver
 * legajoService.updateLegajo()). Dos queries indexadas por `codigo`, una
 * sola vez para TODOS los meses — no una por fila ni por mes.
 */
async function mapaLegajoCandidatos(codigos: string[]): Promise<Map<string, Candidato[]>> {
  const claves = [...new Set(codigos.flatMap((c) => [c.trim(), normLegajo(c)]))];
  if (claves.length === 0) return new Map();

  const [actuales, historicos] = await Promise.all([
    prisma.legajo.findMany({
      where: { codigo: { in: claves } },
      select: { id: true, codigo: true, nombre: true, sectorRel: { select: { area: { select: { nombre: true } } } } },
    }),
    prisma.legajo_codigo_historial.findMany({
      where: { codigo: { in: claves } },
      select: {
        codigo: true,
        legajo: { select: { id: true, nombre: true, sectorRel: { select: { area: { select: { nombre: true } } } } } },
      },
    }),
  ]);

  const mapa = new Map<string, Candidato[]>();
  const agregar = (codigo: string | null | undefined, legajoId: number, nombre: string, area: string) => {
    if (!codigo) return;
    for (const clave of new Set([codigo.trim(), normLegajo(codigo)])) {
      const arr = mapa.get(clave) ?? [];
      if (!arr.some((c) => c.legajoId === legajoId)) arr.push({ legajoId, nombre, area });
      mapa.set(clave, arr);
    }
  };

  for (const l of actuales) agregar(l.codigo, l.id, l.nombre, l.sectorRel?.area?.nombre?.trim() || SIN_AREA);
  for (const h of historicos)
    agregar(h.codigo, h.legajo.id, h.legajo.nombre, h.legajo.sectorRel?.area?.nombre?.trim() || SIN_AREA);

  return mapa;
}

/** Un solo candidato (caso normal): ese. Varios (código reciclado entre
 * convenios/personas distintas): el de nombre más parecido a la columna
 * "Apellido y Nombre" del Excel de ESA fila. */
function elegirCandidato(candidatos: Candidato[], nombreExcel: string): Candidato | null {
  if (candidatos.length === 0) return null;
  if (candidatos.length === 1) return candidatos[0];
  let mejor = candidatos[0];
  let mejorScore = similitudNombre(nombreExcel, mejor.nombre);
  for (const c of candidatos.slice(1)) {
    const score = similitudNombre(nombreExcel, c.nombre);
    if (score > mejorScore) {
      mejor = c;
      mejorScore = score;
    }
  }
  return mejor;
}

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autenticado" }, { status: 401 });

  const mesParam = req.nextUrl.searchParams.get("mes")?.trim();

  try {
    if (mesParam) {
      if (!YM.test(mesParam))
        return NextResponse.json({ error: "'mes' inválido: se espera YYYY-MM" }, { status: 400 });
      const fila = await prisma.nomina_mes.findUnique({ where: { mes: mesParam } });
      if (!fila) return NextResponse.json({ error: "No hay datos cargados para ese mes" }, { status: 404 });
      return NextResponse.json({
        mes: fila.mes.trim(),
        archivoNombre: fila.archivoNombre,
        totalCosto: fila.totalCosto,
        cantEmpleados: fila.cantEmpleados,
        actualizado: fila.updatedAt.toISOString(),
        filas: fila.filas,
        puedeEditar: session.rol === "ADMIN",
      });
    }

    const todos = await prisma.nomina_mes.findMany({ orderBy: { mes: "asc" } });

    // Un solo query (bah, dos: actual + historial) para TODOS los meses, no uno por mes.
    const codigos = todos.flatMap((f) => (f.filas as unknown as NominaFila[]).map((r) => r.legajo));
    const candidatosPorCodigo = await mapaLegajoCandidatos(codigos);

    const meses = todos.map((f) => {
      const filas = f.filas as unknown as NominaFila[];
      const porArea: Record<string, number> = {};
      for (const r of filas) {
        const candidatos =
          candidatosPorCodigo.get(r.legajo.trim()) ?? candidatosPorCodigo.get(normLegajo(r.legajo)) ?? [];
        const elegido = elegirCandidato(candidatos, r.nombre);
        const area = elegido?.area ?? SIN_AREA;
        porArea[area] = (porArea[area] ?? 0) + r.total;
      }
      return {
        mes: f.mes.trim(),
        total: f.totalCosto,
        cantEmpleados: f.cantEmpleados,
        archivoNombre: f.archivoNombre,
        actualizado: f.updatedAt.toISOString(),
        porArea,
      };
    });

    return NextResponse.json({ puedeEditar: session.rol === "ADMIN", meses });
  } catch (error) {
    console.error("GET /api/rrhh/nomina", error);
    return NextResponse.json({ error: "No se pudo leer la nómina" }, { status: 503 });
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

  const mes = String(body.mes ?? "").trim();
  if (!YM.test(mes))
    return NextResponse.json({ error: "'mes' inválido: se espera YYYY-MM" }, { status: 400 });

  const filasRaw = body.filas;
  if (!Array.isArray(filasRaw) || filasRaw.length === 0)
    return NextResponse.json({ error: "No hay filas para guardar" }, { status: 400 });

  const filas: NominaFila[] = filasRaw.map((r) => {
    const x = r as Record<string, unknown>;
    const costos = Number(x.costos) || 0;
    const bono = Number(x.bono) || 0;
    return {
      legajo: String(x.legajo ?? "").trim(),
      nombre: String(x.nombre ?? "").trim(),
      neto: Number(x.neto) || 0,
      bono,
      costos,
      total: Number.isFinite(Number(x.total)) && x.total !== undefined ? Number(x.total) : costos + bono,
      banco: String(x.banco ?? "").trim(),
      liquidacion: String(x.liquidacion ?? "").trim(),
    };
  });
  if (filas.some((f) => !f.legajo))
    return NextResponse.json({ error: "Hay filas sin legajo" }, { status: 400 });

  const archivoNombre = body.archivoNombre ? String(body.archivoNombre).slice(0, 200) : null;
  const confirmar = body.confirmar === true;
  const totalCosto = filas.reduce((acc, f) => acc + f.total, 0);
  const cantEmpleados = filas.length;

  try {
    const existente = await prisma.nomina_mes.findUnique({ where: { mes } });
    if (existente && !confirmar) {
      return NextResponse.json(
        {
          error: "Ya hay datos cargados para ese mes",
          requiereConfirmacion: true,
          existente: {
            archivoNombre: existente.archivoNombre,
            cantEmpleados: existente.cantEmpleados,
            totalCosto: existente.totalCosto,
            actualizado: existente.updatedAt.toISOString(),
          },
        },
        { status: 409 },
      );
    }

    const guardado = await prisma.nomina_mes.upsert({
      where: { mes },
      create: { mes, archivoNombre, filas, totalCosto, cantEmpleados, subidoPor: session?.uid ?? null },
      update: { archivoNombre, filas, totalCosto, cantEmpleados, subidoPor: session?.uid ?? null },
      select: { mes: true, totalCosto: true, cantEmpleados: true, archivoNombre: true, updatedAt: true },
    });

    return NextResponse.json({
      mes: guardado.mes.trim(),
      totalCosto: guardado.totalCosto,
      cantEmpleados: guardado.cantEmpleados,
      archivoNombre: guardado.archivoNombre,
      actualizado: guardado.updatedAt.toISOString(),
      reemplazado: Boolean(existente),
    });
  } catch (error) {
    console.error("POST /api/rrhh/nomina", error);
    return NextResponse.json({ error: "No se pudo guardar la nómina" }, { status: 503 });
  }
}
