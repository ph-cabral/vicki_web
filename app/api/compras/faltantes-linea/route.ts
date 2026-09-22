import { NextRequest, NextResponse } from "next/server";
import {
  agruparFaltantesMes,
  pasaRecorte,
  ORIGEN_LABEL,
  adaptarFilaFaltantePedido,
  type FilaFaltantePedidoApi,
} from "@/lib/compras/faltantesMes";
import type { OrigenArticulo } from "@/lib/compras/origenArticulo";

const API_URL =
  process.env.INDICADORES_API_URL ?? "http://indicadores-api:8001";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// ──────────────────────────────────────────────────────────────────────────────
// /compras — sección "Faltantes por línea".
//
// Los faltantes de un mes agrupados por LÍNEA (no por artículo) y separados por
// ORIGEN del artículo. Por cada línea:
//   · items          → artículos distintos faltantes
//   · cantFaltante   → unidades pendientes del mes (CantPend de Magnus, sin los
//                      renglones de pedidos cancelados). 2026-09-03: antes era
//                      la cantidad que marcó el operario en la mesa
//                      (faltante_existencia.cantidad) y el universo eran solo
//                      los artículos marcados; ahora es el mismo universo del
//                      reporte de Magnus que cuentan las cards de arriba.
//   · cantComprada   → unidades de OC hechas ESE MISMO MES para esos mismos
//                      artículos (/compras/compras-valorizado, por FecMovim).
//   · monto          → esas unidades valorizadas a precio de VENTA (último
//                      PrecioVenta visto en Ven_PedRenPendientes), no al costo
//                      de la OC — mismo criterio que la card "Compras del mes".
//
// RECORTE (2026-09-03) — mismo universo que las cards de /compras: se comparte
// lib/compras/faltantesMes.ts (origen real del artículo por Stk_TiposArticulos,
// solo Habilitados, sin renglones de pedidos cancelados, sin cruzar contra las
// marcas de la mesa). Antes el origen salía de la heurística `Importacion` de
// /compras/ordenes-pendientes, que clasificaba mal y no coincidía con
// /compras/faltantes.
//
// Consecuencias buenas para la latencia: ya no se consulta Postgres
// (faltante_existencia), ni /compras/ordenes-pendientes (el origen no lo
// necesita), ni /compras/lineas-articulos (la línea ya viene en
// /deposito/faltantes). Quedan 2 fetches y salen EN PARALELO.
//
// Los grupos son los 3 del selector de la vista (nacionales / importados /
// otros). Fábrica y Original no se trabajan en compras: se cuentan aparte en
// `excluidos` para que nada desaparezca sin explicación.
// ──────────────────────────────────────────────────────────────────────────────

const SIN_LINEA = "SIN LÍNEA";

const GRUPOS: OrigenArticulo[] = ["nacionales", "importados", "otros"];

async function getJson(url: string) {
  const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(45000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

function mesRange(mes: string | null) {
  const now = new Date();
  const valido = mes && /^\d{4}-\d{2}$/.test(mes);
  const [yStr, mStr] = (
    valido ? (mes as string) : `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`
  ).split("-");
  const y = Number(yStr);
  const m = Number(mStr);
  const desde = `${yStr}-${mStr}-01`;
  const ultimoDia = new Date(y, m, 0).getDate();
  const hasta = `${yStr}-${mStr}-${String(ultimoDia).padStart(2, "0")}`;
  return { mes: `${yStr}-${mStr}`, desde, hasta };
}

const r2 = (n: number) => Math.round(n * 100) / 100;

interface Acum {
  linea: string;
  items: number;
  cantFaltante: number;
  cantComprada: number;
  monto: number;
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const { mes, desde, hasta } = mesRange(sp.get("mes"));

  // 1) Los 2 fetches a Magnus, en paralelo (best-effort cada uno):
  //    · deposito/faltantes    → origen, estado, línea por artículo
  //    · compras-valorizado    → unidades y $ de OC del mes por artículo
  const q = encodeURIComponent;
  const [faltRes, valRes] = await Promise.allSettled([
    getJson(`${API_URL}/deposito/faltante-pedidos?desde=${q(desde)}&hasta=${q(hasta)}`),
    getJson(`${API_URL}/compras/compras-valorizado?desde=${q(desde)}&hasta=${q(hasta)}`),
  ]);

  const clasifWarn = faltRes.status !== "fulfilled";
  if (clasifWarn) {
    console.error("GET /api/compras/faltantes-linea — deposito/faltantes", faltRes.reason);
  }
  const faltMes = agruparFaltantesMes(
    clasifWarn
      ? []
      : ((faltRes.value.rows ?? []) as FilaFaltantePedidoApi[]).map(adaptarFilaFaltantePedido),
  );

  const compradoUnid = new Map<string, number>();
  const compradoMonto = new Map<string, number>();
  const ocWarn = valRes.status !== "fulfilled";
  if (valRes.status === "fulfilled") {
    for (const r of (valRes.value.rows ?? []) as {
      CodArticulo: string;
      Cantidad: number;
      Importe: number;
    }[]) {
      const cod = (r.CodArticulo ?? "").trim();
      if (!cod) continue;
      compradoUnid.set(cod, (compradoUnid.get(cod) ?? 0) + (Number(r.Cantidad) || 0));
      compradoMonto.set(cod, (compradoMonto.get(cod) ?? 0) + (Number(r.Importe) || 0));
    }
  } else {
    console.error("GET /api/compras/faltantes-linea — compras-valorizado", valRes.reason);
  }

  // 2) Agrupar: origen → línea. El universo son todos los artículos con
  //    renglón pendiente en el mes (no solo los marcados por la mesa).
  const grupos = new Map<OrigenArticulo, Map<string, Acum>>(
    GRUPOS.map((g) => [g, new Map<string, Acum>()]),
  );
  const excluidos: Record<string, number> = { fabrica: 0, original: 0, noHabilitado: 0 };
  let articulosFaltantes = 0;

  for (const cod of [...faltMes.articulos.keys()].sort()) {
    const a = faltMes.articulos.get(cod)!;
    if (!pasaRecorte(a, faltMes.estadoDisponible)) {
      excluidos.noHabilitado++;
      continue;
    }
    const mapa = grupos.get(a.origen);
    if (!mapa) {
      // fabrica / original: no se trabajan en compras.
      excluidos[a.origen] = (excluidos[a.origen] ?? 0) + 1;
      continue;
    }
    articulosFaltantes++;
    const linea = a.linea || SIN_LINEA;
    const acum = mapa.get(linea) ?? { linea, items: 0, cantFaltante: 0, cantComprada: 0, monto: 0 };
    acum.items += 1;
    acum.cantFaltante += a.unidades;
    acum.cantComprada += compradoUnid.get(cod) ?? 0;
    acum.monto += compradoMonto.get(cod) ?? 0;
    mapa.set(linea, acum);
  }

  const armar = (mapa: Map<string, Acum>) => {
    const filas = [...mapa.values()]
      .map((a) => ({
        linea: a.linea,
        items: a.items,
        cantFaltante: r2(a.cantFaltante),
        cantComprada: r2(a.cantComprada),
        monto: r2(a.monto),
      }))
      .sort((a, b) => b.cantFaltante - a.cantFaltante || a.linea.localeCompare(b.linea));
    const total = filas.reduce(
      (acc, f) => ({
        items: acc.items + f.items,
        cantFaltante: acc.cantFaltante + f.cantFaltante,
        cantComprada: acc.cantComprada + f.cantComprada,
        monto: acc.monto + f.monto,
      }),
      { items: 0, cantFaltante: 0, cantComprada: 0, monto: 0 },
    );
    return {
      lineas: filas,
      total: {
        items: total.items,
        cantFaltante: r2(total.cantFaltante),
        cantComprada: r2(total.cantComprada),
        monto: r2(total.monto),
      },
    };
  };

  const porOrigen = Object.fromEntries(
    GRUPOS.map((g) => [g, { label: ORIGEN_LABEL[g], ...armar(grupos.get(g)!) }]),
  );

  return NextResponse.json({
    mes,
    desde,
    hasta,
    ocWarn,
    clasifWarn,
    lineaWarn: clasifWarn, // la línea viene del mismo fetch que el origen
    estadoArticuloDisponible: faltMes.estadoDisponible,
    excluidos,
    excluidosFabrica: excluidos.fabrica, // compat con la vista anterior
    articulosFaltantes,
    ...porOrigen,
  });
}
