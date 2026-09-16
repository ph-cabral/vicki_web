import { origenArticulo, type OrigenArticulo } from "./origenArticulo";

// ──────────────────────────────────────────────────────────────────────────────
// Recorte del mes de compras, compartido por /api/compras/metricas y
// /api/compras/faltantes-linea para que las cards, el funnel y la tabla por
// línea partan EXACTAMENTE el mismo universo.
//
// Reproduce el recorte de detalle_mes_extraccion.py (verificado contra el
// reporte de OC de Magnus), que la vista no hacía y por eso daba de más:
//
//   1. ORIGEN real del artículo (Nacional / Importado / Fabril / Original /
//      Otros) desde StkFer_Articulos.NacionalImportado, vía
//      lib/compras/origenArticulo.ts — el MISMO criterio que /compras/faltantes
//      y /fabrica/faltantes. Antes se clasificaba con la heurística
//      `Importacion` de /compras/ordenes-pendientes (fecha de OC pactada), que
//      manda a "Nacional" a los proveedores chinos con fecha cargada y deja
//      afuera todo artículo sin OC.
//   2. Solo artículos HABILITADOS (se descartan Suspendido y Baja). El estado
//      llega por fila como `EstadoArticulo` desde indicadores-api
//      (deposito.py detecta el nombre real de la columna en StkFer_Articulos).
//      Si la columna no está, `estadoDisponible` queda en false y NO se filtra
//      nada — mejor de más que perder filas en silencio.
//   3. Se descartan los renglones de pedidos CANCELADOS y los que no tienen
//      estado en Magnus (pedido inexistente o borrado: no se puede confirmar
//      que siga vivo). Un artículo que faltaba SOLO por esos renglones deja de
//      ser faltante.
//
// UNIVERSO (2026-09-03): faltante del mes = TODO artículo con renglón pendiente
// en el mes que pasa el recorte de arriba — el mismo universo del reporte de
// Magnus y de detalle_mes_extraccion.py (762 items en agosto 2026, 405 de ellos
// Nacionales). ANTES se exigía además la marca "sin existencia" de la mesa
// (preparado.faltante_existencia): eso recortaba a ~280 nacionales, un
// subconjunto de lo pendiente, y no cerraba nunca con el reporte. Esa tabla ya
// no interviene en el recorte del mes de /compras (sí sigue siendo la fuente de
// /compras/faltantes, que es la vista operativa de la mesa).
//
// Todo sale de la respuesta de GET /deposito/faltantes que las rutas ya pedían:
// no agrega ninguna consulta — y desde este cambio se ahorra la consulta a
// Postgres que hacían /compras/metricas, /compras/faltantes-linea y
// /compras/detalle-mes.
// ──────────────────────────────────────────────────────────────────────────────

// Mismo criterio de "cancelado" que indicadores-api/deposito.py
// (PATRONES_CANCELADO): los estados de Magnus no son una lista fija.
const PATRONES_CANCELADO = ["CANCEL"];

const ESTADO_HABILITADO = "habilitado";

export interface FilaFaltanteApi {
  CodArticulo: string;
  Proveedor?: string | null;
  TipoArticulo?: string | null;
  EstadoArticulo?: string | null;
  EstadoPedido?: string | null;
  CantPend?: number;
  Importe?: number;
  Linea?: string | number | null;
}

export interface ArticuloMes {
  cod: string;
  proveedor: string | null;
  tipoArticulo: string | null;
  origen: OrigenArticulo;
  habilitado: boolean;
  /** CantPend de los renglones vivos (sin cancelados ni sin estado). */
  unidades: number;
  /** Importe (precio de venta) de esos mismos renglones. */
  importe: number;
  /** CantPend descartada por pedido cancelado o sin estado. */
  unidadesCanceladas: number;
  linea: string | null;
}

export interface FaltantesMes {
  articulos: Map<string, ArticuloMes>;
  /** false = indicadores-api no informó estado de artículo → no se filtra por Habilitado. */
  estadoDisponible: boolean;
  unidadesDescartadas: number;
}

const txt = (v: unknown) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());

export const esCancelado = (estadoPedido: string | null | undefined) => {
  const e = txt(estadoPedido).toUpperCase();
  // Sin estado = pedido que no está en Magnus: se descarta igual que un cancelado.
  if (!e) return true;
  return PATRONES_CANCELADO.some((p) => e.includes(p));
};

/**
 * Agrupa por artículo las filas de GET /deposito/faltantes de un mes.
 * Una sola pasada; el llamador después filtra con `pasaRecorte`.
 */
export function agruparFaltantesMes(rows: FilaFaltanteApi[]): FaltantesMes {
  const articulos = new Map<string, ArticuloMes>();
  let estadoDisponible = false;
  let unidadesDescartadas = 0;

  for (const r of rows) {
    const cod = txt(r.CodArticulo);
    if (!cod) continue;

    let a = articulos.get(cod);
    if (!a) {
      a = {
        cod,
        proveedor: null,
        tipoArticulo: null,
        origen: "otros",
        habilitado: false,
        unidades: 0,
        importe: 0,
        unidadesCanceladas: 0,
        linea: null,
      };
      articulos.set(cod, a);
    }

    if (!a.proveedor && r.Proveedor) a.proveedor = r.Proveedor;
    if (!a.tipoArticulo && r.TipoArticulo) a.tipoArticulo = r.TipoArticulo;
    if (!a.linea && r.Linea != null && txt(r.Linea)) a.linea = txt(r.Linea);

    const estadoArt = txt(r.EstadoArticulo);
    if (estadoArt) {
      estadoDisponible = true;
      if (estadoArt.toLowerCase() === ESTADO_HABILITADO) a.habilitado = true;
    }

    const cant = Number(r.CantPend) || 0;
    if (esCancelado(r.EstadoPedido)) {
      a.unidadesCanceladas += cant;
      unidadesDescartadas += cant;
    } else {
      a.unidades += cant;
      a.importe += Number(r.Importe) || 0;
    }
  }

  // El origen se resuelve una vez por artículo, con el proveedor y el tipo ya
  // consolidados (las filas del mismo artículo pueden traer uno u otro vacío).
  for (const a of articulos.values()) {
    a.origen = origenArticulo({ Proveedor: a.proveedor, tipoArticulo: a.tipoArticulo });
  }

  return { articulos, estadoDisponible, unidadesDescartadas };
}

/**
 * ¿El artículo sigue siendo faltante del mes con el recorte del reporte?
 * (habilitado + sin quedar solo por renglones cancelados). No mira el origen.
 */
export function pasaRecorte(a: ArticuloMes, estadoDisponible: boolean): boolean {
  if (estadoDisponible && !a.habilitado) return false;
  // Faltaba SOLO por pedidos cancelados / sin estado → ya no es faltante.
  if (a.unidades <= 0 && a.unidadesCanceladas > 0) return false;
  return true;
}

/** Orígenes que se ofrecen en el selector de /compras (mismo orden que /compras/faltantes). */
export const ORIGENES_COMPRAS: OrigenArticulo[] = ["nacionales", "importados", "otros"];

export const ORIGEN_LABEL: Record<OrigenArticulo | "todos" | "compras", string> = {
  nacionales: "Nacionales",
  importados: "Importados",
  otros: "Otros",
  fabrica: "Fábrica",
  original: "Original",
  todos: "Todos",
  compras: "Compras",
};

export type OrigenFunnel = OrigenArticulo | "todos" | "compras";

/**
 * Códigos faltantes del mes (todo artículo con renglón pendiente que pasa el
 * recorte), opcionalmente acotados a un origen. Es el universo del reporte de
 * Magnus: no se cruza contra las marcas de la mesa.
 */
export function codigosPorOrigen(
  faltantes: FaltantesMes,
  origen: OrigenFunnel,
): string[] {
  const out: string[] = [];
  for (const a of faltantes.articulos.values()) {
    if (!pasaRecorte(a, faltantes.estadoDisponible)) continue;
    // "compras" = la unión de las solapas del selector (Nacionales +
    // Importados + Otros). Deja AFUERA Fábrica y Original, que no se compran:
    // Fábrica es producción interna y ni siquiera puede aparecer en el set de
    // OC (indicadores-api/compras.py excluye los artículos Fabril), así que
    // contarla en el total sólo servía para inflar el "sin cubrir".
    // "todos" sigue existiendo para quien necesite el universo completo.
    if (origen === "compras") {
      if (!ORIGENES_COMPRAS.includes(a.origen)) continue;
    } else if (origen !== "todos" && a.origen !== origen) {
      continue;
    }
    out.push(a.cod);
  }
  return out.sort();
}
