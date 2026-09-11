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

async function mapaLegajoArea(codigos: string[]): Promise<Map<string, string>> {
  const claves = [...new Set(codigos.map(normLegajo))];
  if (claves.length === 0) return new Map();

  const legajos = await prisma.legajo.findMany({
    where: { codigo: { in: [...new Set(codigos)] } }, // trae por el valor crudo…
    select: { codigo: true, sectorRel: { select: { area: { select: { nombre: true } } } } },
  });

  const mapa = new Map<string, string>();
  for (const l of legajos) {
    if (!l.codigo) continue;
    const area = l.sectorRel?.area?.nombre?.trim() || SIN_AREA;
    mapa.set(l.codigo.trim(), area);
    mapa.set(normLegajo(l.codigo), area); // …y también matcheable normalizado
  }
  return mapa;
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

    // Un solo query a `legajo` para TODOS los meses, no uno por mes.
    const codigos = todos.flatMap((f) => (f.filas as unknown as NominaFila[]).map((r) => r.legajo));
    const areaDeLegajo = await mapaLegajoArea(codigos);

    const meses = todos.map((f) => {
      const filas = f.filas as unknown as NominaFila[];
      const porArea: Record<string, number> = {};
      for (const r of filas) {
        const area = areaDeLegajo.get(r.legajo.trim()) ?? areaDeLegajo.get(normLegajo(r.legajo)) ?? SIN_AREA;
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
