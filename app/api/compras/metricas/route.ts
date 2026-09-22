import { NextRequest, NextResponse } from "next/server";
import {
  agruparFaltantesMes,
  codigosPorOrigen,
  ORIGEN_LABEL,
  adaptarFilaFaltantePedido,
  type FilaFaltantePedidoApi,
  type FaltantesMes,
  type OrigenFunnel,
} from "@/lib/compras/faltantesMes";
import type { OrigenArticulo } from "@/lib/compras/origenArticulo";

const API_URL =
  process.env.INDICADORES_API_URL ?? "http://indicadores-api:8001";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// ──────────────────────────────────────────────────────────────────────────────
// /compras — funnel MENSUAL de un mes calendario, en ARTÍCULOS distintos
// (items), no en unidades, calculado POR ORIGEN del artículo.
//
//   Columna 1 "Faltantes": CodArticulo distintos con renglón pendiente en el
//     mes (GET /deposito/faltantes?historico=1) que pasan el recorte de
//     lib/compras/faltantesMes.ts (habilitados, sin renglones de pedidos
//     cancelados). Es el universo del reporte de Magnus / del script
//     detalle_mes_extraccion.py: agosto 2026 = 762 items, 405 Nacionales.
//     2026-09-03: se sacó el cruce contra las marcas de la mesa
//     (preparado.faltante_existencia). Ese cruce dejaba la card en ~280
//     nacionales — un subconjunto de lo pendiente, imposible de cerrar contra
//     el reporte. De paso la vista dejó de consultar Postgres acá.
//
//   Columna 2 "Con OC": de los artículos de la columna 1, cuántos tuvieron
//     al menos un renglón de Orden de Compra HECHO ese mismo mes (indicadores-
//     api GET /compras/ordenes-mes, por FecMovim de la cabecera) — no importa
//     si ya se recibió o sigue pendiente.
//
//   Columna 3 "Ingresados": de los artículos de la columna 2, cuántos tuvieron
//     un remito de ingreso ya concretado ese mismo mes (indicadores-api
//     GET /compras/ingresos, por FecComprobante).
//     2026-09-03: el universo de remitos son TODOS los tipos de comprobante de
//     ingreso (59 RMTOxCPA.D · 60 RMTOxORD · 61 REM AV S.F · 160 · 590 REM IN
//     LIL), no solo los que cuelgan de una OC — es el mismo universo del
//     reporte de remitos del mes de Magnus. Antes se exigía NroOrdCompra <> 0 y
//     quedaba afuera ~4 de cada 10 renglones de remito del mes.
//
//   Es un funnel estricto: col2 ⊆ col1, col3 ⊆ col2.
//
//   Cada columna informa items, unidades y $ (a precio de VENTA: unidades de la
//   etapa × precio unitario del artículo, derivado del mismo fetch de
//   /deposito/faltantes — Importe/CantPend por renglón, ver deposito.py). No
//   cuesta ninguna consulta extra.
//
//   2026-09-08 — las TRES columnas se leen contra el faltante: unidades/$ son
//   siempre los del FALTANTE de los artículos de esa etapa, no lo pedido en la
//   OC ni lo ingresado por remito. Antes "Con OC" valorizaba lo PEDIDO y
//   "Ingresados" lo INGRESADO, que incluyen lo comprado/recibido de más sobre
//   el faltante: las tres cards no se podían leer entre sí ni contra el panel
//   "Cuánto faltó y cuánto se cubrió". Los valores sin capar siguen
//   disponibles en `ocUnidades`/`ocImporte` e `ingUnidades`/`ingImporte`.
//
//   Con esto: faltantes.importe = ingresados.importe + (conOC − ingresados) +
//   sin cubrir, y conOC.importe = "ya ingresó" + "con OC sin ingresar" del
//   panel. Los tres números cierran exactos.
//
//   Ademas cada columna informa `faltanteUnidades` / `faltanteImporte`: la
//   magnitud del FALTANTE de los articulos de esa etapa, no lo pedido ni lo
//   ingresado. Sirve para leer la cobertura en $ del faltante del mes ("de los
//   $X que faltaron, $Y ya tiene OC y $Z ya ingreso"), que es otra cosa que el
//   $ de lo efectivamente ingresado (un articulo puede haber ingresado menos,
//   igual o mas de lo que faltaba). Alimenta el panel "Cuanto falto y cuanto se
//   cubrio" de la vista. Es una pasada mas por el Map en memoria: 0 consultas.
//
// RECORTE (2026-09-03) — la vista contaba de más y no cerraba con el reporte de
// Magnus. Ahora los tres criterios de detalle_mes_extraccion.py se aplican acá,
// en lib/compras/faltantesMes.ts (ver el comentario de ese archivo):
//   · ORIGEN real del artículo (Stk_TiposArticulos) vía lib/compras/
//     origenArticulo.ts, el mismo criterio que /compras/faltantes y
//     /fabrica/faltantes. Reemplaza a la heurística `Importacion` de
//     /compras/ordenes-pendientes, que clasificaba mal y obligaba a un fetch
//     más (ese endpoint ya no se consulta desde acá).
//   · Solo artículos HABILITADOS.
//   · Sin renglones de pedidos cancelados o sin estado en Magnus.
//   · SIN cruce contra las marcas "sin existencia" de la mesa (ver arriba).
//
//   El funnel se calcula para CADA origen (nacionales / importados / otros) más
//   "todos", todo en memoria sobre los mismos 3 sets: el selector de la vista
//   cambia de origen SIN volver a pegarle a Magnus.
//
//   2026-09-08 — se sacó ocTotalItems/ocTotalUnidades (el set B completo, toda
//   la OC del mes sin recortar). La vista de compras se lee SOLO contra los
//   artículos que faltaron: mezclar en la card el total de OC — que incluye
//   artículos que nunca fueron faltante — confundía la lectura. El total de OC
//   del mes sigue estando en /compras/compras-valorizado.
//
//   `origenes` clasifica el mismo universo recortado en las 5 categorías de
//   origenArticulo (Nacionales / Importados / Fábrica / Original / Otros) y
//   alimenta la torta y los badges del selector.
//
//   Los 3 fetches a Magnus salen EN PARALELO (antes eran secuenciales, 4
//   roundtrips uno atrás del otro) y son best-effort: si alguno no responde, la
//   columna correspondiente se informa en `warn` pero no rompe la vista.
// ──────────────────────────────────────────────────────────────────────────────

async function getJson(url: string) {
  const res = await fetch(url, {
    cache: "no-store",
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

// mes = "YYYY-MM" (o null/ inválido → mes actual, hora del server). Devuelve
// el rango calendario completo [desde, hasta] de ese mes.
function mesRange(mes: string | null) {
  const now = new Date();
  const valido = mes && /^\d{4}-\d{2}$/.test(mes);
  const [yStr, mStr] = (
    valido ? (mes as string) : `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`
  ).split("-");
  const y = Number(yStr);
  const m = Number(mStr);
  const desde = `${yStr}-${mStr}-01`;
  const ultimoDia = new Date(y, m, 0).getDate(); // día 0 del mes siguiente = último día de este mes
  const hasta = `${yStr}-${mStr}-${String(ultimoDia).padStart(2, "0")}`;
  return { mes: `${yStr}-${mStr}`, desde, hasta };
}

const r2 = (n: number) => Math.round(n * 100) / 100;

// Suma las unidades de un map solo para los artículos de la columna (el
// funnel ya viene recortado: col2 ⊆ col1, col3 ⊆ col2).
const sumUnid = (arts: string[], map: Map<string, number>) =>
  r2(arts.reduce((a, c) => a + (map.get(c) ?? 0), 0));

// $ de una etapa = unidades de esa etapa × precio unitario del artículo. El
// precio sale del mismo fetch de /deposito/faltantes que ya se hace (Importe =
// PrecioVenta × CantPend por renglón, ver deposito.py), así que no cuesta
// ninguna consulta extra. Se valoriza a precio de VENTA.
const sumImporte = (
  arts: string[],
  unidMap: Map<string, number>,
  precioMap: Map<string, number>,
) => r2(arts.reduce((a, c) => a + (unidMap.get(c) ?? 0) * (precioMap.get(c) ?? 0), 0));

interface Columna {
  key: string;
  label: string;
  total: number;
  unidades: number;
  importe: number;
  // Magnitud del FALTANTE de los articulos de esta etapa (no lo pedido ni lo
  // ingresado): cuanto de lo que falto en el mes esta representado aca. En
  // "faltantes" coincide con unidades/importe; en "conOC" e "ingresados"
  // responde "de los $X que faltaron, cuanto ya tiene OC / cuanto ya llego".
  faltanteUnidades: number;
  faltanteImporte: number;
  // Solo la columna "conOC": lo efectivamente PEDIDO en la OC de esos mismos
  // artículos (puede ser mayor o menor que lo que faltaba). La vista muestra
  // unidades/importe, que ya vienen capados al faltante.
  ocUnidades?: number;
  ocImporte?: number;
  // Idem en la columna "ingresados": lo efectivamente INGRESADO por remito de
  // esos artículos, sin capar al faltante.
  ingUnidades?: number;
  ingImporte?: number;
}
interface Funnel {
  faltantesUnidades: number;
  faltantesImporte: number;
  columnas: Columna[];
}

/** Funnel completo de un origen. Todo en memoria: no consulta nada. */
function armarFunnel(
  origen: OrigenFunnel,
  faltMes: FaltantesMes,
  setB: Set<string>,
  setC: Set<string>,
  ocUnidMap: Map<string, number>,
  ingUnidMap: Map<string, number>,
  precioUnitMap: Map<string, number>,
): Funnel {
  const faltantes = codigosPorOrigen(faltMes, origen);
  const conOC = faltantes.filter((c) => setB.has(c));
  const ingresados = conOC.filter((c) => setC.has(c));

  // Magnitud del FALTANTE de un conjunto de articulos: sus unidades pendientes
  // del mes y su $ (a precio de venta), tal cual salieron de agruparFaltantesMes.
  // No cuesta ninguna consulta: es una pasada por el Map que ya esta en memoria.
  const magnitudFaltante = (arts: string[]) => {
    let u = 0;
    let i = 0;
    for (const cod of arts) {
      const a = faltMes.articulos.get(cod);
      if (!a) continue;
      u += a.unidades;
      i += a.importe;
    }
    return { unidades: r2(u), importe: r2(i) };
  };

  const fFalt = magnitudFaltante(faltantes);
  const fOC = magnitudFaltante(conOC);
  const fIng = magnitudFaltante(ingresados);

  return {
    faltantesUnidades: fFalt.unidades,
    faltantesImporte: fFalt.importe,
    columnas: [
      {
        key: "faltantes",
        label: "Faltantes",
        total: faltantes.length,
        unidades: fFalt.unidades,
        importe: fFalt.importe,
        faltanteUnidades: fFalt.unidades,
        faltanteImporte: fFalt.importe,
      },
      {
        key: "conOC",
        // Unidades/$ = la magnitud del FALTANTE de esos artículos, NO lo pedido
        // en la OC (ver cabecera): la card responde "de lo que faltó, cuánto ya
        // tiene OC". Lo pedido queda en `ocUnidades`/`ocImporte` por si alguna
        // vista lo necesita; la de /compras no lo muestra.
        label: "Con OC",
        total: conOC.length,
        unidades: fOC.unidades,
        importe: fOC.importe,
        ocUnidades: sumUnid(conOC, ocUnidMap),
        ocImporte: sumImporte(conOC, ocUnidMap, precioUnitMap),
        faltanteUnidades: fOC.unidades,
        faltanteImporte: fOC.importe,
      },
      {
        key: "ingresados",
        // Igual que "conOC": unidades/$ = la magnitud del FALTANTE de esos
        // artículos, NO lo efectivamente ingresado (un remito puede traer
        // mucho más que lo que faltaba). Lo ingresado queda en
        // `ingUnidades`/`ingImporte`.
        label: "Ingresados",
        total: ingresados.length,
        unidades: fIng.unidades,
        importe: fIng.importe,
        ingUnidades: sumUnid(ingresados, ingUnidMap),
        ingImporte: sumImporte(ingresados, ingUnidMap, precioUnitMap),
        faltanteUnidades: fIng.unidades,
        faltanteImporte: fIng.importe,
      },
    ],
  };
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const { mes, desde, hasta } = mesRange(sp.get("mes"));

  // 1) Los 3 fetches a Magnus, EN PARALELO (best-effort cada uno). Ya no se
  //    consulta Postgres: el universo de faltantes del mes sale del propio
  //    /deposito/faltantes (ver cabecera).
  //    · ordenes-mes      → set B (OC hecha ese mes) + unidades pedidas
  //    · ingresos         → set C (remito x OC concretado ese mes)
  //    · deposito/faltantes → origen, estado, unidades e importe por artículo
  const q = encodeURIComponent;
  const [ocRes, ingRes, faltRes] = await Promise.allSettled([
    getJson(`${API_URL}/compras/ordenes-mes?desde=${q(desde)}&hasta=${q(hasta)}`),
    getJson(`${API_URL}/compras/ingresos?desde=${q(desde)}&hasta=${q(hasta)}`),
    getJson(`${API_URL}/deposito/faltante-pedidos?desde=${q(desde)}&hasta=${q(hasta)}`),
  ]);

  // Set B: artículos con OC hecha en el mes.
  const setB = new Set<string>();
  const ocUnidMap = new Map<string, number>();
  const ocWarn = ocRes.status !== "fulfilled";
  if (ocRes.status === "fulfilled") {
    const ocJson = ocRes.value;
    for (const cod of (ocJson.articulos ?? []) as string[]) setB.add(cod);
    for (const [cod, u] of Object.entries((ocJson.unidades ?? {}) as Record<string, number>)) {
      ocUnidMap.set(cod, Number(u) || 0);
    }
  } else {
    console.error("GET /api/compras/metricas — ordenes-mes", ocRes.reason);
  }

  // Set C: artículos con remito de ingreso concretado en el mes (todos los
  // tipos de comprobante de ingreso, ver cabecera).
  const setC = new Set<string>();
  const ingUnidMap = new Map<string, number>();
  const ingresoWarn = ingRes.status !== "fulfilled";
  // true = indicadores-api no pudo detectar la columna del código de
  // comprobante en Com_RemitoCabecera → no filtró por tipo de remito.
  const comprobanteWarn =
    ingRes.status === "fulfilled" && ingRes.value?.comprobanteWarn === true;
  if (ingRes.status === "fulfilled") {
    for (const r of (ingRes.value.rows ?? []) as {
      CodArticulo: string;
      CantidadIngresada?: number;
    }[]) {
      const cod = (r.CodArticulo ?? "").trim();
      if (!cod) continue;
      setC.add(cod);
      ingUnidMap.set(cod, (ingUnidMap.get(cod) ?? 0) + (Number(r.CantidadIngresada) || 0));
    }
  } else {
    console.error("GET /api/compras/metricas — ingresos", ingRes.reason);
  }

  // 2) Origen / estado / unidades por artículo — el recorte del mes.
  const clasifWarn = faltRes.status !== "fulfilled";
  if (clasifWarn) {
    console.error("GET /api/compras/metricas — deposito/faltantes", faltRes.reason);
  }
  const faltMes = agruparFaltantesMes(
    clasifWarn
      ? []
      : ((faltRes.value.rows ?? []) as FilaFaltantePedidoApi[]).map(adaptarFilaFaltantePedido),
  );

  // Precio unitario por artículo (venta), para valorizar las etapas 2 y 3 sin
  // pedirle nada más a Magnus.
  const precioUnitMap = new Map<string, number>();
  for (const a of faltMes.articulos.values()) {
    if (a.unidades > 0) precioUnitMap.set(a.cod, a.importe / a.unidades);
  }

  // 3) Un funnel por origen + los dos agregados. Todo en memoria, sin consultas
  //    extra.
  //    · "compras" = Nacionales + Importados + Otros (las solapas del selector).
  //      Es el total que muestra la vista: Fábrica y Original quedan afuera
  //      porque no se compran — Fábrica ni siquiera puede entrar al set de OC
  //      (compras.py excluye los artículos Fabril), así que sumarla al total
  //      sólo inflaba el "sin cubrir".
  //    · "todos" = el universo completo, se sigue devolviendo para el que lo
  //      necesite (y para poder informar cuánto se dejó afuera).
  const claves: OrigenFunnel[] = ["nacionales", "importados", "otros", "compras", "todos"];
  const funnels: Record<string, Funnel> = {};
  for (const k of claves) {
    funnels[k] = armarFunnel(k, faltMes, setB, setC, ocUnidMap, ingUnidMap, precioUnitMap);
  }

  // 4) Torta + badges: el mismo universo recortado, clasificado en las 5 categorías de
  // origenArticulo (incluye Fábrica y Original, que la vista no trabaja pero
  // tienen que verse para que nada desaparezca sin explicación).
  const cats: OrigenArticulo[] = ["nacionales", "importados", "fabrica", "original", "otros"];
  const origenes = cats.map((k) => ({
    key: k,
    label: ORIGEN_LABEL[k],
    total: codigosPorOrigen(faltMes, k).length,
  }));

  return NextResponse.json({
    mes,
    desde,
    hasta,
    ocWarn,
    ingresoWarn,
    comprobanteWarn,
    clasifWarn,
    // false = indicadores-api no informó el estado del artículo (columna no
    // detectada en StkFer_Articulos): NO se filtró por Habilitado.
    estadoArticuloDisponible: faltMes.estadoDisponible,
    unidadesDescartadas: r2(faltMes.unidadesDescartadas),
    // Items del mes que el total "compras" deja afuera a propósito (Fábrica +
    // Original). Se informan para que nada desaparezca en silencio.
    excluidosItems:
      codigosPorOrigen(faltMes, "fabrica").length +
      codigosPorOrigen(faltMes, "original").length,
    origenDefault: "nacionales",
    origenes,
    funnels,
  });
}
