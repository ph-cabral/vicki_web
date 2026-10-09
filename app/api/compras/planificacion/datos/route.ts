import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import {
  leerReporte,
  rangoMeses,
  hoyAR,
  esTablaFaltante,
  TABLA_FALTA_MSG,
} from "@/lib/compras/planificacion";
// Faltante vivo = el MISMO cálculo de /compras/faltantes (extraordinarios,
// descartados, marca de agua de stock, etc.). Se invoca el handler en proceso,
// sin HTTP ni cookie: es una función pura sobre (req) → JSON.
import { GET as faltantesConsumoGET } from "../../faltantes-consumo/route";

const API_URL = process.env.INDICADORES_API_URL ?? "http://indicadores-api:8001";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// ──────────────────────────────────────────────────────────────────────────────
// /compras/planificacion — GET ?id=<reporte>[&fresh=1]
//   Por artículo del filtro guardado (niveles Magnus, N meses cerrados):
//     · vendido / promedio  — pedidos válidos en el rango (indicadores-api)
//     · máximo / mínimo     — mes más alto / mes más bajo CON venta (= /compras/consumo)
//     · stock               — depósito 1 (central)
//     · oc                  — saldo pendiente de OC sin cerrar
//     · faltante            — faltante VIVO de /compras/faltantes: `faltan` del
//                             bucket más nuevo del artículo (acumulado bruto,
//                             ya sin extraordinarios ni lo cubierto por stock)
//     · recomendado = ceil(max(0, promedio + faltante − max(stock,0) − oc))
//   Rendimiento: el faltante (lo más caro) se calcula UNA vez para toda la
//   empresa y se cachea 3 min en memoria — todos los botones de todos los
//   usuarios lo comparten. Magnus se consulta en UNA sola query por reporte.
// ──────────────────────────────────────────────────────────────────────────────

const FALT_DESDE = "2026-06-26"; // mismo DESDE_DEFAULT que /compras/faltantes
const FALT_TTL_MS = 3 * 60 * 1000;
let faltCache: { t: number; p: Promise<Map<string, number>> } | null = null;

async function calcularFaltantes(): Promise<Map<string, number>> {
  const qs = new URLSearchParams({ desde: FALT_DESDE, hasta: hoyAR(), conArribo: "1" });
  const res = await faltantesConsumoGET(
    new NextRequest(`http://localhost/api/compras/faltantes-consumo?${qs}`),
  );
  if (!res.ok) throw new Error(`faltantes-consumo HTTP ${res.status}`);
  const j = (await res.json()) as { rows?: { CodArticulo: string; fecha: string; faltan: number }[] };
  const ult = new Map<string, { fecha: string; faltan: number }>();
  for (const r of j.rows ?? []) {
    const cod = String(r.CodArticulo ?? "").trim();
    if (!cod) continue;
    const prev = ult.get(cod);
    if (!prev || r.fecha > prev.fecha) ult.set(cod, { fecha: r.fecha, faltan: Number(r.faltan) || 0 });
  }
  const out = new Map<string, number>();
  for (const [cod, v] of ult) if (v.faltan > 0) out.set(cod, v.faltan);
  return out;
}

function faltantesVivos(fresh: boolean): Promise<Map<string, number>> {
  if (!fresh && faltCache && Date.now() - faltCache.t < FALT_TTL_MS) return faltCache.p;
  const p = calcularFaltantes();
  faltCache = { t: Date.now(), p };
  p.catch(() => {
    if (faltCache?.p === p) faltCache = null; // no cachear el error
  });
  return p;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export async function GET(req: NextRequest) {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "Sin sesión" }, { status: 401 });
  const id = Number(req.nextUrl.searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "id inválido" }, { status: 400 });
  const fresh = req.nextUrl.searchParams.get("fresh") === "1";

  let rep;
  try {
    rep = await leerReporte(s.uid, id);
  } catch (e) {
    if (esTablaFaltante(e)) return NextResponse.json({ error: TABLA_FALTA_MSG }, { status: 503 });
    throw e;
  }
  if (!rep) return NextResponse.json({ error: "Reporte no encontrado" }, { status: 404 });

  const { desde, hasta } = rangoMeses(rep.meses);

  let faltMap = new Map<string, number>();
  let faltanteWarn = false;
  try {
    faltMap = await faltantesVivos(fresh);
  } catch (e) {
    faltanteWarn = true;
    console.error("GET /api/compras/planificacion/datos — faltantes", e);
  }

  let api: {
    rows: {
      codigo: string;
      detalle: string | null;
      vendido: number;
      maximo: number;
      minimo: number | null;
      stock: number;
      oc: number;
      proveedor?: string | null;
      precio?: number;
    }[];
    ocDesde?: string;
  };
  try {
    const res = await fetch(`${API_URL}/compras/planificacion`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(85000),
      body: JSON.stringify({
        n1: rep.lineas,
        n2: rep.rubros,
        n3: rep.subRubros,
        n4: rep.subSubRubros,
        desde,
        hasta,
        extra: [...faltMap.keys()],
      }),
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => null);
      return NextResponse.json({ error: "Error en API de planificación", detail }, { status: res.status });
    }
    api = await res.json();
  } catch (e) {
    console.error("GET /api/compras/planificacion/datos", e);
    return NextResponse.json({ error: "No se pudo conectar al servicio de compras" }, { status: 503 });
  }

  const rows = api.rows
    .map((r) => {
      const promedio = r.vendido / rep.meses;
      const faltante = faltMap.get(r.codigo) ?? 0;
      const neto = promedio + faltante - Math.max(r.stock, 0) - r.oc;
      return {
        codigo: r.codigo,
        detalle: r.detalle,
        recomendado: neto > 0 ? Math.ceil(neto - 1e-9) : 0,
        promedio: r2(promedio),
        vendido: r2(r.vendido),
        maximo: r2(r.maximo ?? 0),
        minimo: r.minimo == null ? null : r2(r.minimo),
        stock: r2(r.stock),
        oc: r2(r.oc),
        faltante: r2(faltante),
        proveedor: r.proveedor ?? null,
        precio: r.precio ?? 0,
      };
    })
    .sort((a, b) => b.recomendado - a.recomendado || b.promedio - a.promedio || (a.codigo < b.codigo ? -1 : 1));

  return NextResponse.json({
    reporte: rep,
    desde,
    hasta,
    ocDesde: api.ocDesde ?? null,
    faltanteWarn,
    total: rows.length,
    rows,
  });
}
