import { NextRequest, NextResponse } from "next/server";
import {
  agruparFaltantesMes,
  codigosPorOrigen,
  adaptarFilaFaltantePedido,
  type FilaFaltantePedidoApi,
  type OrigenFunnel,
} from "@/lib/compras/faltantesMes";

const API_URL =
  process.env.INDICADORES_API_URL ?? "http://indicadores-api:8001";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// ──────────────────────────────────────────────────────────────────────────────
// /compras — serie mensual de FALTANTES (items = artículos distintos) de los
// últimos N meses, para el gráfico de línea de la vista.
//
//   Mismo universo y mismo recorte que la columna "Faltantes" del funnel de
//   /api/compras/metricas (lib/compras/faltantesMes.ts: habilitados, sin
//   renglones de pedidos cancelados, origen real del artículo). Por eso el
//   último punto de la línea coincide SIEMPRE con la card "Faltantes del mes".
//
//   Un mes = una consulta a GET /deposito/faltantes?historico=1 acotada a ese
//   mes. NO se puede resolver con una sola consulta al rango completo: esa
//   respuesta viene deduplicada por renglón con la fecha del snapshot MÁS
//   NUEVO, así que un renglón arrastrado de meses anteriores se contaría solo
//   en el último y los meses viejos quedarían cortos.
//
//   Costo: los N fetches salen EN PARALELO (un solo roundtrip de espera) y son
//   los únicos — no se consulta OC ni ingresos, que la línea no usa. Cada mes
//   es best-effort: el que falle se informa en `warn` y sale en 0 sin romper el
//   resto.
//
//   Igual que el funnel, cada mes se devuelve YA calculado para los 4 orígenes
//   (nacionales | importados | otros | todos): cambiar de origen en la vista no
//   dispara ninguna consulta nueva.
// ──────────────────────────────────────────────────────────────────────────────

const MESES_DEFAULT = 4;
const MESES_MAX = 12;

async function getJson(url: string) {
  const res = await fetch(url, {
    cache: "no-store",
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

/** Rango calendario [desde, hasta] de un "YYYY-MM". */
function mesRange(y: number, m: number) {
  const yStr = String(y);
  const mStr = String(m).padStart(2, "0");
  const ultimoDia = new Date(y, m, 0).getDate();
  return {
    mes: `${yStr}-${mStr}`,
    desde: `${yStr}-${mStr}-01`,
    hasta: `${yStr}-${mStr}-${String(ultimoDia).padStart(2, "0")}`,
  };
}

/** Los N meses que terminan en `mes` (o el actual), del más viejo al más nuevo. */
function ultimosMeses(mes: string | null, n: number) {
  const now = new Date();
  const valido = mes && /^\d{4}-\d{2}$/.test(mes);
  const base = valido
    ? { y: Number((mes as string).slice(0, 4)), m: Number((mes as string).slice(5, 7)) }
    : { y: now.getFullYear(), m: now.getMonth() + 1 };

  const out: { mes: string; desde: string; hasta: string }[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(base.y, base.m - 1 - i, 1);
    out.push(mesRange(d.getFullYear(), d.getMonth() + 1));
  }
  return out;
}

const CLAVES: OrigenFunnel[] = ["nacionales", "importados", "otros", "todos"];

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const n = Math.min(
    Math.max(Number(sp.get("meses")) || MESES_DEFAULT, 1),
    MESES_MAX,
  );
  const rangos = ultimosMeses(sp.get("mes"), n);

  const q = encodeURIComponent;
  const res = await Promise.allSettled(
    rangos.map((r) =>
      getJson(
        `${API_URL}/deposito/faltante-pedidos?desde=${q(r.desde)}&hasta=${q(r.hasta)}`,
      ),
    ),
  );

  let warn = false;
  const meses = rangos.map((r, i) => {
    const p = res[i];
    if (p.status !== "fulfilled") {
      warn = true;
      console.error(`GET /api/compras/faltantes-serie — ${r.mes}`, p.reason);
      return {
        mes: r.mes,
        error: true,
        items: Object.fromEntries(CLAVES.map((k) => [k, 0])) as Record<string, number>,
      };
    }
    const faltMes = agruparFaltantesMes(
      ((p.value.rows ?? []) as FilaFaltantePedidoApi[]).map(adaptarFilaFaltantePedido),
    );
    return {
      mes: r.mes,
      error: false,
      items: Object.fromEntries(
        CLAVES.map((k) => [k, codigosPorOrigen(faltMes, k).length]),
      ) as Record<string, number>,
    };
  });

  return NextResponse.json({ meses, warn });
}
