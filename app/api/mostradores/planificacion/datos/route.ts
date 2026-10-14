import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import {
  leerReporte,
  rangoMeses,
  esTablaFaltante,
  TABLA_FALTA_MSG,
} from "@/lib/mostradores/planificacion";

const API_URL = process.env.INDICADORES_API_URL ?? "http://indicadores-api:8001";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// ──────────────────────────────────────────────────────────────────────────────
// /mostradores/planificacion — GET ?id=<reporte>
//   Duplicado de /compras/planificacion SIN faltante ni proveedor. Por artículo
//   del filtro guardado (niveles Magnus, N meses cerrados):
//     · vendido / promedio  — pedidos válidos en el rango (indicadores-api)
//     · máximo / mínimo     — mes más alto / mes más bajo CON venta
//     · stock               — depósito 1 (central)
//     · oc                  — saldo pendiente de OC sin cerrar
//     · recomendado = ceil(max(0, promedio − max(stock,0) − oc))
//   Magnus se consulta en UNA sola query por reporte (mismo endpoint que compras).
// ──────────────────────────────────────────────────────────────────────────────

const r2 = (n: number) => Math.round(n * 100) / 100;

export async function GET(req: NextRequest) {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "Sin sesión" }, { status: 401 });
  const id = Number(req.nextUrl.searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "id inválido" }, { status: 400 });

  let rep;
  try {
    rep = await leerReporte(s.uid, id);
  } catch (e) {
    if (esTablaFaltante(e)) return NextResponse.json({ error: TABLA_FALTA_MSG }, { status: 503 });
    throw e;
  }
  if (!rep) return NextResponse.json({ error: "Reporte no encontrado" }, { status: 404 });

  const { desde, hasta } = rangoMeses(rep.meses);

  let api: {
    rows: {
      codigo: string;
      detalle: string | null;
      vendido: number;
      maximo: number;
      minimo: number | null;
      stock: number;
      oc: number;
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
        extra: [],
      }),
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => null);
      return NextResponse.json({ error: "Error en API de planificación", detail }, { status: res.status });
    }
    api = await res.json();
  } catch (e) {
    console.error("GET /api/mostradores/planificacion/datos", e);
    return NextResponse.json({ error: "No se pudo conectar al servicio de compras" }, { status: 503 });
  }

  const rows = api.rows
    .map((r) => {
      const promedio = r.vendido / rep.meses;
      const neto = promedio - Math.max(r.stock, 0) - r.oc;
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
        precio: r.precio ?? 0,
      };
    })
    .sort((a, b) => b.recomendado - a.recomendado || b.promedio - a.promedio || (a.codigo < b.codigo ? -1 : 1));

  return NextResponse.json({
    reporte: rep,
    desde,
    hasta,
    ocDesde: api.ocDesde ?? null,
    total: rows.length,
    rows,
  });
}
