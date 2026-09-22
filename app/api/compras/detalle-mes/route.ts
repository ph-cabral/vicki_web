import { NextRequest, NextResponse } from "next/server";
import {
  agruparFaltantesMes,
  pasaRecorte,
  adaptarFilaFaltantePedido,
  type FilaFaltanteApi,
  type FilaFaltantePedidoApi,
} from "@/lib/compras/faltantesMes";

const API_URL =
  process.env.INDICADORES_API_URL ?? "http://indicadores-api:8001";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// ──────────────────────────────────────────────────────────────────────────────
// /compras/detalle-mes — detalle artículo por artículo del mismo mes que el
// funnel de /api/compras/metricas, para exportar a Excel desde /compras.
//
// Una fila por artículo, con la UNIÓN de los tres conjuntos del mes (todo lo
// que fue faltante, O tuvo OC, O tuvo ingreso). Las columnas que no aplican van
// en 0 / vacío, y `esFaltante` marca cuáles estaban en el set de faltantes —
// así el Excel sirve tanto para leer el funnel (filtrando esFaltante = Sí, que
// es lo que cuentan las cards) como para cruzar TODA la OC del mes contra el
// reporte de Magnus.
//
// Fuentes: exactamente las mismas que /api/compras/metricas, para que los
// totales del Excel cierren con las cards:
//   · Faltantes  → CantPend por artículo de Magnus (GET
//     /deposito/faltantes?historico=1), con el MISMO recorte que las cards
//     (lib/compras/faltantesMes.ts). 2026-09-03: ya no se cruza contra las
//     marcas de la mesa (preparado.faltante_existencia), igual que las cards —
//     el universo es el del reporte de Magnus. `esFaltante`
//     solo queda en true para artículos habilitados cuyo faltante no viene
//     únicamente de pedidos cancelados, y `cantFaltante` no cuenta esos
//     renglones (van aparte en `cantFaltanteCancelada`). Las filas NO se
//     borran: se agregan las columnas `origen` y `estadoArticulo` para poder
//     filtrar en el Excel y ver qué quedó afuera y por qué.
//   · OC         → GET /compras/ordenes-detalle (mismo recorte que
//     /compras/ordenes-mes: FecMovim de la cabecera, sin canceladas, sin
//     Genérico/Fabril) + números de OC, proveedor y descripción.
//   · Ingresos   → GET /compras/ingresos (remitos de ingreso concretados en el
//                  mes: TODOS los tipos de comprobante de ingreso 59/60/61/160/
//                  590, no solo los ligados a una OC — ver ingresos.py)
//     + números de remito.
//
// Las 3 llamadas a Magnus salen EN PARALELO (Promise.all): son independientes
// entre sí y así el export tarda lo que la más lenta, no la suma.
// ──────────────────────────────────────────────────────────────────────────────

async function getJson(url: string) {
  const res = await fetch(url, {
    cache: "no-store",
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

// mes = "YYYY-MM" (o null/inválido → mes actual). Mismo helper que metricas.
function mesRange(mes: string | null) {
  const now = new Date();
  const valido = mes && /^\d{4}-\d{2}$/.test(mes);
  const [yStr, mStr] = (
    valido ? (mes as string) : `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`
  ).split("-");
  const ultimoDia = new Date(Number(yStr), Number(mStr), 0).getDate();
  return {
    mes: `${yStr}-${mStr}`,
    desde: `${yStr}-${mStr}-01`,
    hasta: `${yStr}-${mStr}-${String(ultimoDia).padStart(2, "0")}`,
  };
}

const r2 = (n: number) => Math.round(n * 100) / 100;

interface Fila {
  codArticulo: string;
  nombre: string | null;
  proveedor: string | null;
  /** nacionales | importados | fabrica | original | otros (origenArticulo). */
  origen: string | null;
  /** Habilitado | Suspendido | Baja (o null si Magnus no lo informó). */
  estadoArticulo: string | null;
  esFaltante: boolean;
  cantFaltante: number;
  /** CantPend que quedó afuera por pedido cancelado o sin estado. */
  cantFaltanteCancelada: number;
  cantOC: number;
  nroOCs: string[];
  fechaUltimaOC: string | null;
  cantIngresada: number;
  nroRemitos: string[];
  fechaUltimoIngreso: string | null;
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const { mes, desde, hasta } = mesRange(sp.get("mes"));
  const qs = `desde=${encodeURIComponent(desde)}&hasta=${encodeURIComponent(hasta)}`;

  // Las 3 fuentes de Magnus, en paralelo y best-effort (si una falla, esa
  // columna queda vacía y se avisa por `warns` — no se rompe el export).
  const [faltRes, ocRes, ingRes] = await Promise.allSettled([
    getJson(`${API_URL}/deposito/faltante-pedidos?${qs}`),
    getJson(`${API_URL}/compras/ordenes-detalle?${qs}`),
    getJson(`${API_URL}/compras/ingresos?${qs}`),
  ]);

  const warns: string[] = [];
  const filas = new Map<string, Fila>();
  const fila = (cod: string): Fila => {
    let f = filas.get(cod);
    if (!f) {
      f = {
        codArticulo: cod,
        nombre: null,
        proveedor: null,
        origen: null,
        estadoArticulo: null,
        esFaltante: false, // se resuelve abajo, con el recorte aplicado
        cantFaltante: 0,
        cantFaltanteCancelada: 0,
        cantOC: 0,
        nroOCs: [],
        fechaUltimaOC: null,
        cantIngresada: 0,
        nroRemitos: [],
        fechaUltimoIngreso: null,
      };
      filas.set(cod, f);
    }
    return f;
  };

  // Faltantes: unidades pendientes + nombre/proveedor (mismo dato que usa la
  // card "Unidades faltantes" — se suma por artículo).
  const faltRows = faltRes.status === "fulfilled"
    ? ((faltRes.value.rows ?? []) as FilaFaltantePedidoApi[]).map(adaptarFilaFaltantePedido)
    : [];
  const faltMes = agruparFaltantesMes(faltRows);
  if (faltRes.status === "fulfilled") {
    // Nombre por artículo: no lo agrupa faltantesMes (no lo necesita el funnel).
    const nombres = new Map<string, string>();
    for (const r of faltRows) {
      const cod = (r.CodArticulo ?? "").trim();
      if (cod && r.Nombre && !nombres.has(cod)) nombres.set(cod, r.Nombre);
    }
    // Todo artículo con renglón pendiente entra al Excel, tenga OC/ingreso o no.
    for (const a of faltMes.articulos.values()) {
      const f = fila(a.cod);
      f.cantFaltante += a.unidades;
      f.cantFaltanteCancelada += a.unidadesCanceladas;
      f.origen = a.origen;
      f.estadoArticulo = faltMes.estadoDisponible
        ? (a.habilitado ? "Habilitado" : "No habilitado")
        : null;
      f.esFaltante = pasaRecorte(a, faltMes.estadoDisponible);
      const nom = nombres.get(a.cod);
      if (!f.nombre && nom) f.nombre = nom;
      if (!f.proveedor && a.proveedor) f.proveedor = a.proveedor;
    }
  } else {
    warns.push("No se pudieron leer las unidades faltantes del mes");
    console.error("GET /api/compras/detalle-mes — deposito/faltantes", faltRes.reason);
  }

  // OC del mes: cantidad pedida + números de OC.
  if (ocRes.status === "fulfilled") {
    for (const r of (ocRes.value.rows ?? []) as {
      CodArticulo: string;
      Nombre?: string | null;
      Proveedor?: string | null;
      CantidadOC?: number;
      NroOCs?: string[];
      FechaUltimaOC?: string | null;
    }[]) {
      const cod = (r.CodArticulo ?? "").trim();
      if (!cod) continue;
      const f = fila(cod);
      f.cantOC += Number(r.CantidadOC) || 0;
      f.nroOCs = [...new Set([...f.nroOCs, ...(r.NroOCs ?? [])])].sort();
      f.fechaUltimaOC = r.FechaUltimaOC ?? f.fechaUltimaOC;
      if (!f.nombre && r.Nombre) f.nombre = r.Nombre;
      if (!f.proveedor && r.Proveedor) f.proveedor = r.Proveedor;
    }
  } else {
    warns.push("No se pudieron leer las órdenes de compra del mes");
    console.error("GET /api/compras/detalle-mes — ordenes-detalle", ocRes.reason);
  }

  // Ingresos del mes: cantidad ingresada + números de remito.
  if (ingRes.status === "fulfilled") {
    for (const r of (ingRes.value.rows ?? []) as {
      CodArticulo: string;
      Proveedor?: string | null;
      CantidadIngresada?: number;
      NroRemitos?: string[];
      FechaUltimoIngreso?: string | null;
    }[]) {
      const cod = (r.CodArticulo ?? "").trim();
      if (!cod) continue;
      const f = fila(cod);
      f.cantIngresada += Number(r.CantidadIngresada) || 0;
      f.nroRemitos = [...new Set([...f.nroRemitos, ...(r.NroRemitos ?? [])])].sort();
      f.fechaUltimoIngreso = r.FechaUltimoIngreso ?? f.fechaUltimoIngreso;
      if (!f.proveedor && r.Proveedor) f.proveedor = r.Proveedor;
    }
  } else {
    warns.push("No se pudieron leer los ingresos del mes");
    console.error("GET /api/compras/detalle-mes — ingresos", ingRes.reason);
  }

  const rows = [...filas.values()]
    .map((f) => ({
      ...f,
      cantFaltante: r2(f.cantFaltante),
      cantFaltanteCancelada: r2(f.cantFaltanteCancelada),
      cantOC: r2(f.cantOC),
      cantIngresada: r2(f.cantIngresada),
    }))
    .sort((a, b) => a.codArticulo.localeCompare(b.codArticulo));

  return NextResponse.json({
    mes,
    desde,
    hasta,
    warns,
    total: rows.length,
    totales: {
      faltantes: rows.filter((r) => r.esFaltante).length,
      conOC: rows.filter((r) => r.cantOC > 0).length,
      ingresados: rows.filter((r) => r.cantIngresada > 0).length,
      unidadesFaltantes: r2(rows.reduce((a, r) => a + r.cantFaltante, 0)),
      unidadesOC: r2(rows.reduce((a, r) => a + r.cantOC, 0)),
      unidadesIngresadas: r2(rows.reduce((a, r) => a + r.cantIngresada, 0)),
    },
    rows,
  });
}
