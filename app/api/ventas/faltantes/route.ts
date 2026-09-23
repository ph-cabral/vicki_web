import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolverAccesoVendedor, vendedorParam } from "@/lib/ventas/vendedorAcceso";
import { fetchCarteraClientes } from "@/lib/ventas/cartera";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const API_URL =
  process.env.INDICADORES_API_URL ?? "http://indicadores-api:8001";

// Ancla del cruce con OC — mismo corte que /compras/faltantes (OC_DESDE_DEFAULT
// en faltantes-consumo/route.ts). Mantener sincronizados.
const OC_DESDE = "2026-06-26";

// Piso de OC para la FECHA DE ARRIBO (2026-09-23). Ya no se usa OC_DESDE acá:
// ordenes-pendientes filtra renglón Estado=1 (pendiente de recibir), así que
// una OC anterior al 26/06 que sigue abierta es mercadería en camino real
// (típico importación) y su entrega pactada es la que vale. Con el corte en
// OC_DESDE quedaba afuera y la vista tomaba la OC siguiente. Volumen: todo lo
// abierto en Magnus son ~2.200 renglones (más viejo: marzo 2026).
const OC_ARRIBO_DESDE = "2020-01-01";

// ──────────────────────────────────────────────────────────────────────────────
// GET /api/ventas/faltantes — agrega server-side todo lo que necesita
//   /ventas/faltantes (Tabla 1 y Tabla 2). NO escribe nada acá; solo LEE:
//     · indicadores-api /deposito/faltantes      (renglones + fecha del día)
//     · indicadores-api /compras/ingresos         (remitos de ingreso x OC ya
//       concretados, agregado por artículo — solo para Tabla 2)
//     · preparado.faltante_existencia             (¿sin existencia?)
//     · preparado.faltante_control                (fechaArribo, clienteQuiere, vendido)
//     · preparado.faltante_extraordinario          (flag de COMPRAS, por
//       artículo+CLIENTE desde 2026-09-16 — antes era por artículo entero y
//       hacía calificar acá los renglones de CUALQUIER cliente del artículo,
//       no solo el que compras marcó; no se toca esa tabla, solo se consulta)
//     · indicadores-api /compras/ordenes-pendientes (OC "por llegar" de Magnus:
//       la entrega pactada del renglón (FecEntregaPactada, literal, sin +2,
//       nacional o importación) de la OC abierta más vieja vale como arribo
//       AUTOMÁTICO; sin entrega pactada cae a la fecha de la OC;
//       la carga manual en /compras/faltantes — faltante_control — la PISA
//       cuando compras conoce la fecha real)
//
//   Tabla 1 — regla de entrada: sin existencia + clienteQuiere aún sin
//   responder + (ya tiene fecha de arribo [manual u OC] O [compras lo marcó
//   extraordinario Y el "comprar" de faltante_extraordinario todavía está sin
//   decidir]). La
//   decisión de comprar se toma acá mismo (ver decidir() en el page.tsx) y
//   apenas se decide, la fila deja de calificar por la vía extraordinario.
//
//   RECORTE POR VENDEDOR: un usuario ADMIN ve todo (y puede acotarse a la
//   cartera de UN vendedor con `?vendedor=<codigo>`, el selector del header);
//   uno que no es admin ve solo
//   los faltantes de SUS clientes (cartera del vendedor asignado en
//   /admin/usuarios — mismo criterio zona ∪ historial que /ventas/vendedor,
//   definido en cartera.py). Se recorta lo antes posible, sobre `rows`, para
//   que todo el resto del armado trabaje sobre el subconjunto chico. Un
//   no-admin sin vendedorCodigo asignado ve CERO (nunca "todos"), y la
//   respuesta trae `isAdmin`/`sinVendedor` para que la vista sepa en qué modo
//   está.
//
//   Tabla 2 ("listos", rows→listos) — regla de entrada (3 requisitos):
//     1) fechaArribo cargada (faltante_control)
//     2) clienteQuiere === true (faltante_control)
//     3) el artículo aparece en un remito de ingreso x OC con fecha >= a la
//        fecha del faltante (indicadores-api /compras/ingresos)
//   Sale de Tabla 2 apenas se decide "vendido" (true o false, cualquiera).
// ──────────────────────────────────────────────────────────────────────────────

interface FaltanteRow {
  NroPedOrigen: number;
  NroRengOrigen: number;
  CodArticulo: string;
  Nombre: string;
  CantPend: number;
  Cliente: number | string | null;
  ClienteNombre: string | null;
  // Vendedor de la cabecera del pedido (Ped_Usu_Arma). Solo para mostrar en la
  // vista de admin — el recorte por usuario va por cartera, no por este campo.
  Vendedor: string | null;
  Importe: number;
  Fecha: string | null;
}

// Fila cruda de GET /deposito/faltante-pedidos (indicadores-api/deposito.py,
// fetch_faltante_pedidos) — fuente desde 2026-09-22: pedidos Cerrados/
// Facturados de Magnus, YA NO Ven_PedRenPendientes. Se adapta a FaltanteRow
// más abajo (mapFaltantePedido): esta vista no usa EstadoPedido/TipoArticulo/
// Proveedor/Línea, así que el mapeo es directo. Un renglón cancelado a nivel
// línea (EstadoRenglon=4) dentro de un pedido Cerrado/Facturado llega con
// CantCumplida=0 y cuenta ENTERO como faltante — a propósito, ver
// [[faltante-pedidos-cerrados-vs-compras-consumo]] en memoria.
interface FaltantePedidoRow {
  NroMovVenta: number;
  Renglon: number;
  CodArticulo: string;
  Nombre: string;
  Diferencia: number;
  Cliente: number | string | null;
  ClienteNombre: string | null;
  Vendedor: string | null;
  Importe: number;
  Fecha: string | null;
}
function mapFaltantePedido(r: FaltantePedidoRow): FaltanteRow {
  return {
    NroPedOrigen: r.NroMovVenta,
    NroRengOrigen: r.Renglon,
    CodArticulo: r.CodArticulo,
    Nombre: r.Nombre,
    CantPend: r.Diferencia,
    Cliente: r.Cliente,
    ClienteNombre: r.ClienteNombre,
    Vendedor: r.Vendedor,
    Importe: r.Importe,
    Fecha: r.Fecha,
  };
}

// Fila cruda de preparado.faltante_wms (fallback de "En stock" cuando el
// renglón ya no matchea en Magnus).
interface WmsRow {
  nroPedOrigen: number | null;
  nroRengOrigen: number;
  codArticulo: string;
  nombre: string;
  cliente: string;
  clienteNombre: string | null;
  vendedor: string | null;
  cantPedida: unknown;
  importe: unknown;
  fecha: Date;
}

export async function GET(req: Request) {
  const acceso = await resolverAccesoVendedor();
  if (!acceso.ok)
    return NextResponse.json({ error: acceso.error }, { status: acceso.status });
  const soloVendedor = !acceso.isAdmin;
  // `vendedorParam` resuelve los dos casos de una: el no-admin queda pegado a
  // SU vendedorCodigo (no puede elegir) y el admin usa el `?vendedor=` del
  // selector del header — vacío = toda la empresa, como siempre. Para el admin
  // es comodidad de lectura, no seguridad: ya puede ver todo.
  const vendedorCodigo = vendedorParam(new URL(req.url).searchParams, acceso);
  if (soloVendedor && !vendedorCodigo)
    return NextResponse.json({
      fecha: null,
      rows: [],
      listos: [],
      isAdmin: false,
      sinVendedor: true,
    });

  try {
    // Cartera del vendedor logueado en paralelo con la consulta pesada de
    // faltantes: no suma latencia. Si falla, queda vacía → cero filas (nunca
    // se cae del lado de mostrar clientes ajenos).
    const carteraPromise: Promise<Set<number> | null> = vendedorCodigo
      ? fetchCarteraClientes(Number(vendedorCodigo)).catch((e) => {
          console.error("GET /api/ventas/faltantes cartera", e);
          return new Set<number>();
        })
      : Promise.resolve(null);
    // Rango HISTÓRICO desde el ancla, NO el último snapshot: un renglón
    // faltante sale de Ven_PedRenPendientes apenas el pedido se factura
    // (vive ~1 día), así que con el snapshot del día se perdían todos los
    // faltantes de días anteriores aunque siguieran sin responder.
    const hoy = new Date().toISOString().slice(0, 10);
    // Fuente 2026-09-22: /deposito/faltante-pedidos (pedidos Cerrados/
    // Facturados de Magnus), no más /deposito/faltantes (Ven_PedRenPendientes)
    // — ver mapFaltantePedido arriba. Ya no hace falta "histórico": cada
    // renglón aparece una sola vez con su FechaCierre fija, no hay snapshots
    // que reconstruir.
    const res = await fetch(
      `${API_URL}/deposito/faltante-pedidos?desde=${OC_DESDE}&hasta=${hoy}`,
      {
        cache: "no-store",
        signal: AbortSignal.timeout(45000),
      },
    );
    if (!res.ok) {
      const detail = await res.json().catch(() => null);
      return NextResponse.json(
        { error: "Error en API de depósito (faltantes)", detail },
        { status: res.status },
      );
    }
    const fj = await res.json();
    const rowsTodos: FaltanteRow[] = ((fj.rows ?? []) as FaltantePedidoRow[]).map(mapFaltantePedido);
    const fecha: string | null = fj.hasta ?? fj.desde ?? null;
    if (!fecha)
      return NextResponse.json({ fecha: null, rows: [], listos: [], isAdmin: !soloVendedor });

    // Recorte por cartera (no-admin). `Cliente` es el CodCliente de Magnus.
    const cartera = await carteraPromise;
    const rows: FaltanteRow[] = cartera
      ? rowsTodos.filter((r) => cartera.has(Number(r.Cliente)))
      : rowsTodos;

    const [existRows, ctrlRows, extraRows, ingresosJson, ocJson, wmsRows] = await Promise.all([
      // faltante_existencia SÍ tiene modelo Prisma (columnas reales snake_case,
      // mapeadas) → usar el client, no SQL crudo con comillas camelCase.
      // NO exact-match por fecha: la marca puede haberse escrito con la fecha
      // rolling del renglón (no necesariamente "hoy") — se toma la más nueva
      // por renglón, igual patrón que ctrlRows más abajo.
      prisma.faltante_existencia.findMany({
        where: { fecha: { lte: new Date(hoy) }, oculto: false },
        select: { nroPedOrigen: true, codArticulo: true, existencia: true, fecha: true },
        orderBy: { fecha: "asc" },
      }),
      prisma.$queryRaw<
        {
          nroPedOrigen: number;
          nroRengOrigen: number;
          codArticulo: string | null;
          fechaArribo: string | null;
          clienteQuiere: boolean | null;
          vendido: boolean | null;
          irrelevante: boolean | null;
          duplicado: boolean | null;
        }[]
      >`
        SELECT DISTINCT ON ("nroPedOrigen", "nroRengOrigen")
               "nroPedOrigen", "nroRengOrigen", "codArticulo",
               to_char("fechaArribo", 'YYYY-MM-DD') AS "fechaArribo",
               "clienteQuiere",
               "vendido",
               "irrelevante",
               "duplicado"
        FROM preparado.faltante_control
        ORDER BY "nroPedOrigen", "nroRengOrigen", "updatedAt" DESC
      `,
      prisma.$queryRaw<
        {
          codArticulo: string;
          codCliente: string;
          extraordinario: boolean;
          comprar: boolean | null;
          fecha: Date;
        }[]
      >`
        SELECT DISTINCT ON ("codArticulo", "codCliente")
               "codArticulo", "codCliente", extraordinario, comprar, fecha
        FROM preparado.faltante_extraordinario
        ORDER BY "codArticulo", "codCliente", "updatedAt" DESC
      `,
      // Remitos de ingreso x OC desde la fecha del faltante (regla Tabla 2,
      // requisito 3). Si falla (SQL Server caído), Tabla 2 queda vacía pero
      // Tabla 1 sigue funcionando (no se corta el fetch principal).
      // desde el ancla (los faltantes ahora abarcan varios días, no un snapshot)
      fetch(`${API_URL}/compras/ingresos?desde=${OC_DESDE}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(45000),
      })
        .then((r) => (r.ok ? r.json() : { rows: [] }))
        .catch(() => ({ rows: [] })),
      // OC pendientes (arribo automático). Best-effort: si falla, solo quedan
      // los arribos manuales de faltante_control.
      fetch(`${API_URL}/compras/ordenes-pendientes?desde=${OC_ARRIBO_DESDE}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(45000),
      })
        .then((r) => (r.ok ? r.json() : { rows: [] }))
        .catch(() => ({ rows: [] })),
      // Fallback para "con existencia" (enStock) cuando el renglón ya no
      // matchea en `rows` (Magnus, fuente vieja) — pasa cuando la marca viene
      // de WMS ot-diferencias (fuente real de faltante_existencia) y Magnus
      // ya no lo tiene pendiente. preparado.faltante_wms la persiste
      // automático GET /api/deposito/faltantes. Best-effort: la tabla puede
      // no existir aún en algún ambiente.
      (async (): Promise<WmsRow[]> => {
        try {
          return await prisma.$queryRaw<WmsRow[]>`
            SELECT DISTINCT ON ("nroPedOrigen", "codArticulo")
                   "nroPedOrigen", "nroRengOrigen", "codArticulo", nombre, cliente,
                   "clienteNombre", vendedor, "cantPedida", importe, fecha
            FROM preparado.faltante_wms
            ORDER BY "nroPedOrigen", "codArticulo", "updatedAt" DESC
          `;
        } catch {
          // Ambiente sin la columna "clienteNombre" todavía
          // (sql/deposito_faltante_wms_cliente_nombre.sql): se sigue sirviendo
          // el resto — el nombre cae al fallback de más abajo.
          return await prisma.$queryRaw<WmsRow[]>`
            SELECT DISTINCT ON ("nroPedOrigen", "codArticulo")
                   "nroPedOrigen", "nroRengOrigen", "codArticulo", nombre, cliente,
                   NULL::text AS "clienteNombre", vendedor, "cantPedida", importe, fecha
            FROM preparado.faltante_wms
            ORDER BY "nroPedOrigen", "codArticulo", "updatedAt" DESC
          `.catch(() => [] as WmsRow[]);
        }
      })(),
    ]);

    // Última marca de existencia por renglón (existRows viene asc por fecha,
    // sin exact-match — ver comentario arriba).
    // OJO clave: NroRengOrigen NO sirve acá. faltante_existencia se escribe desde
    // /deposito/faltantes (fuente WMS ot-diferencias) con nroRengOrigen =
    // OTItemNroRenglon (numeración interna de WMS), mientras que `rows` de acá
    // abajo viene del fetch_faltantes VIEJO (Magnus Ven_PedRenPendientes), cuyo
    // NroRengOrigen es el renglón real del pedido de venta — otra numeración,
    // mismo nombre de campo. NroPedOrigen (=NroMovVenta) sí coincide en ambas
    // fuentes, así que se cruza por NroPedOrigen+CodArticulo (trimeado). Bug real
    // encontrado 2026-07-10: por esto los renglones marcados "En exist." en
    // /deposito/faltantes no aparecían en /ventas/faltantes "Ingresados".
    const existLatest = new Map<string, boolean | null>();
    for (const r of existRows)
      existLatest.set(`${r.nroPedOrigen}-${(r.codArticulo ?? "").trim()}`, r.existencia);

    // Descarta marcas ya resueltas: si el pedido de venta (VenFer_PedidoReng)
    // termino cumpliendo el articulo -total o de mas- por otra via (otro
    // remito/OT sobre el mismo renglon), la marca de faltante_existencia queda
    // vieja pero nunca se invalida sola (ver
    // faltantes-sobrecumplimiento-vigente). Caso real 2026-09-17: pedido
    // 754472 / ASA4002, pedido 40, cumplido 50 — seguia figurando acá.
    // Best-effort: si el endpoint falla, se sigue mostrando como antes.
    const resuelto = new Set<string>();
    const pedidosMarcados = [
      ...new Set(existRows.map((r) => r.nroPedOrigen)),
    ];
    if (pedidosMarcados.length) {
      try {
        const rCumplido = await fetch(
          `${API_URL}/deposito/pedidos-cumplido-real?pedidos=${pedidosMarcados.join(",")}`,
          { cache: "no-store", signal: AbortSignal.timeout(20000) },
        );
        if (rCumplido.ok) {
          const j = await rCumplido.json();
          for (const row of (j?.rows ?? []) as {
            NroMovVenta: number;
            CodArticulo: string;
            CantidadPedida: number;
            CantidadCumplida: number;
          }[]) {
            if (row.CantidadPedida > 0 && row.CantidadCumplida >= row.CantidadPedida) {
              resuelto.add(`${row.NroMovVenta}-${row.CodArticulo}`);
            }
          }
        }
      } catch (e) {
        console.error("GET /api/ventas/faltantes — cumplido-real", e);
      }
    }

    const sin = new Set<string>();
    for (const [k, ex] of existLatest) if (ex === false && !resuelto.has(k)) sin.add(k);
    // existencia=true: fue error de preparado (SÍ había en depósito). No pasa
    // por compras — se muestra como "arribado" automático (fechaArribo
    // sintético "EN_STOCK") directo en Tabla 1 / Ingresados.
    const con = new Set<string>();
    for (const [k, ex] of existLatest) if (ex === true && !resuelto.has(k)) con.add(k);

    type Ctrl = {
      fechaArribo: string | null;
      clienteQuiere: boolean | null;
      vendido: boolean | null;
      irrelevante: boolean | null;
      duplicado: boolean | null;
    };
    const ctrl = new Map<string, Ctrl>();
    // Fallback por (pedido, artículo) — sin exigir que NroRengOrigen coincida.
    // `rows` (más abajo) sale de una consulta FRESCA a /deposito/faltantes; la
    // fila se guardó en faltante_control con el NroRengOrigen vigente AL
    // MOMENTO de cargar el Arribo en /compras/faltantes (resolveBucketRenglones,
    // ver lib/faltantesArribo.ts). Si Ven_PedRenPendientes renumera el renglón
    // pendiente de un pedido multi-línea entre esa carga y esta lectura (p.ej.
    // porque otra línea del mismo pedido se facturó y el resto se corrió), el
    // match exacto por renglón falla aunque el dato SÍ esté en Postgres — mismo
    // patrón de bug ya encontrado y resuelto para "existencia" (ver keyArt en
    // /api/compras/faltantes-consumo, comentario "Bug real encontrado
    // 2026-07-10"). Solo se guarda acá lo que trae fechaArribo (lo único que
    // este fallback necesita cubrir).
    const ctrlPorArt = new Map<string, Ctrl>();
    for (const r of ctrlRows) {
      const val: Ctrl = {
        fechaArribo: r.fechaArribo,
        clienteQuiere: r.clienteQuiere,
        vendido: r.vendido,
        irrelevante: r.irrelevante,
        duplicado: r.duplicado,
      };
      ctrl.set(`${r.nroPedOrigen}-${r.nroRengOrigen}`, val);
      const cod = (r.codArticulo ?? "").trim();
      if (cod && val.fechaArribo) ctrlPorArt.set(`${r.nroPedOrigen}-${cod}`, val);
    }

    // Lotes = una OC puntual por artículo (indicadores-api/compras.py,
    // fetch_ordenes_pendientes). A diferencia del pool agregado de antes (una
    // sola fecha por artículo, la más temprana de CUALQUIER OC pendiente sin
    // importar cuándo se hizo), acá se guarda cada OC por separado para poder
    // elegir, por FALTANTE puntual, solo la que se hizo DESPUÉS de que ese
    // faltante apareció — ver arriboParaFaltante más abajo.
    interface OcLote {
      FechaOC: string | null;
      FechaEntrega: string | null;
      Importacion?: boolean;
      NroOC?: string | null;
      // Algún renglón del artículo en esta OC sigue en estado 1 (pendiente
      // de recibir). undefined = indicadores-api sin el campo todavía.
      Abierto?: boolean;
    }
    const ocLotesPorArt = new Map<string, OcLote[]>();
    // Fallback si indicadores-api todavía no tiene "Lotes" (desfasaje de
    // deploy entre servicios): agregado viejo, sin filtrar por fecha —
    // mismo comportamiento que antes de este cambio, nunca peor.
    const ocAgregadoPorArt = new Map<string, OcLote>();
    for (const r of (ocJson?.rows ?? []) as {
      CodArticulo?: string;
      FechaEntrega?: string | null;
      FechaOC?: string | null;
      Importacion?: boolean;
      Lotes?: OcLote[];
    }[]) {
      const cod = String(r.CodArticulo ?? "").trim();
      if (!cod) continue;
      if (r.Lotes) ocLotesPorArt.set(cod, r.Lotes);
      else
        ocAgregadoPorArt.set(cod, {
          FechaOC: r.FechaOC ?? null,
          FechaEntrega: r.FechaEntrega ?? null,
          Importacion: r.Importacion,
        });
    }

    // Arribo automático por OC (historia): 2026-07-27 se sumaban 2 días a la
    // entrega; 2026-09-16 se filtraba a OC hechas después del faltante;
    // 2026-09-22 pasó a la OC abierta más vieja; 2026-09-23 fecha literal.
    // Hoy en Córdoba (yyyy-mm-dd), para distinguir entregas vencidas.
    const hoyISO = new Date().toLocaleDateString("sv-SE", {
      timeZone: "America/Argentina/Buenos_Aires",
    });
    // 2026-09-22 — criterio vigente: la fecha de arribo es la de la OC MÁS
    // VIEJA (FecMovim, desempate por N° de OC) que tenga el artículo con el
    // renglón en estado 1 (pendiente de recibir): su entrega pactada
    // (ver fechaLote, 2026-09-23). Cuando ese
    // renglón pasa a cualquier otro estado (cumplido, cerrado con saldo,
    // OC cancelada/anulada) deja de venir en los lotes abiertos y la fecha
    // pasa sola a la OC siguiente. Ya NO se filtra por "OC hecha después
    // del faltante" ni se prefiere la entrega no vencida: manda la más vieja
    // abierta. Sin OC abierta → cae al arribo manual (faltante_control).
    // Desde 2026-09-23 el piso de OC es OC_ARRIBO_DESDE y la fecha es la
    // entrega pactada literal (sin +2), ver fechaLote.
    // 2026-09-23 — la fecha es la ENTREGA PACTADA del renglón tal cual está
    // en Magnus (Com_OrdCompRenglones.FecEntregaPactada), SIN +2 días y
    // también para importación: si compras reprograma la fecha en la OC, la
    // vista muestra esa. Solo si el renglón no tiene entrega pactada cae a la
    // fecha de la OC (FecMovim). Se devuelve además el N° de OC de donde sale.
    const fechaLote = (l: OcLote): string | null => l.FechaEntrega ?? l.FechaOC ?? null;
    const arriboOcParaFaltante = (
      cod: string,
      fechaFaltante: string | null,
    ): { fecha: string; nroOC: string | null; pactada: boolean } | null => {
      const lotes = ocLotesPorArt.get(cod);
      if (lotes?.length && lotes.some((l) => l.Abierto !== undefined)) {
        const abierta = lotes
          .filter((l) => l.Abierto === true)
          .sort((a, b) =>
            (a.FechaOC ?? "").localeCompare(b.FechaOC ?? "") ||
            (a.NroOC ?? "").localeCompare(b.NroOC ?? ""),
          )[0];
        if (!abierta) return null;
        const f = fechaLote(abierta);
        return f ? { fecha: f, nroOC: abierta.NroOC ?? null, pactada: !!abierta.FechaEntrega } : null;
      }
      // Fallback (indicadores-api sin "Abierto", desfasaje de deploy):
      // criterio anterior, con la fecha literal.
      if (!lotes?.length) {
        const agregado = ocAgregadoPorArt.get(cod);
        if (!agregado) return null;
        const f = fechaLote(agregado);
        return f ? { fecha: f, nroOC: null, pactada: !!agregado.FechaEntrega } : null;
      }
      const elegibles = fechaFaltante
        ? lotes.filter((l) => l.FechaOC && l.FechaOC >= fechaFaltante)
        : lotes;
      let mejor: OcLote | null = null;
      let mejorFuturo: OcLote | null = null;
      for (const l of elegibles) {
        const f = fechaLote(l);
        if (!f) continue;
        if (mejor === null || f < fechaLote(mejor)!) mejor = l;
        if (f >= hoyISO && (mejorFuturo === null || f < fechaLote(mejorFuturo)!)) mejorFuturo = l;
      }
      const l = mejorFuturo ?? mejor;
      return l ? { fecha: fechaLote(l)!, nroOC: l.NroOC ?? null, pactada: !!l.FechaEntrega } : null;
    };
    const arriboParaFaltante = (cod: string, fechaFaltante: string | null): string | null =>
      arriboOcParaFaltante(cod, fechaFaltante)?.fecha ?? null;

    // Artículos con remito de ingreso x OC ya concretado (Tabla 2, requisito 3).
    const ingresados = new Set<string>(
      (ingresosJson?.rows ?? [])
        .map((r: { CodArticulo?: string }) =>
          String(r.CodArticulo ?? "").trim(),
        )
        .filter(Boolean),
    );

    // Por (artículo, CLIENTE) — 2026-09-16: solo mientras comprar esté sin
    // decidir (null). Apenas compras/ventas lo resuelve (true o false), deja
    // de calificar acá. Antes esto era solo por artículo y hacía calificar
    // los renglones de CUALQUIER cliente de ese artículo, no solo el que
    // compras marcó como extraordinario.
    const extraMap = new Map<
      string,
      { comprar: boolean | null; fecha: string }
    >();
    for (const r of extraRows) {
      const cliente = (r.codCliente ?? "").trim();
      if (!cliente) continue; // fila legado (marca vieja por artículo entero) — sin cliente no hay con qué cruzar
      if (r.extraordinario)
        extraMap.set(`${r.codArticulo}__${cliente}`, {
          comprar: r.comprar,
          fecha: r.fecha.toISOString().slice(0, 10),
        });
    }

    // Última fila WMS (faltante_wms) por nroPedOrigen+codArticulo — fallback
    // de enStock cuando el renglón "con existencia" no matchea en `rows`
    // (Magnus).
    const wmsLatest = new Map<
      string,
      {
        nroPedOrigen: number;
        nroRengOrigen: number;
        codArticulo: string;
        nombre: string;
        cliente: string;
        clienteNombre: string | null;
        vendedor: string | null;
        cantPedida: number;
        importe: number;
        fecha: string;
      }
    >();
    for (const r of wmsRows) {
      if (r.nroPedOrigen === null) continue;
      const cod = (r.codArticulo ?? "").trim();
      wmsLatest.set(`${r.nroPedOrigen}-${cod}`, {
        nroPedOrigen: r.nroPedOrigen,
        nroRengOrigen: r.nroRengOrigen,
        codArticulo: cod,
        nombre: r.nombre ?? "",
        cliente: r.cliente ?? "",
        clienteNombre: r.clienteNombre || null,
        vendedor: r.vendedor || null,
        cantPedida: Number(r.cantPedida ?? 0),
        importe: Number(r.importe ?? 0),
        fecha:
          r.fecha instanceof Date
            ? r.fecha.toISOString().slice(0, 10)
            : String(r.fecha).slice(0, 10),
      });
    }

    const out = rows
      .filter((r) => sin.has(`${r.NroPedOrigen}-${r.CodArticulo.trim()}`))
      // irrelevante (botón basurero, Tabla 1): descarte definitivo, no vuelve
      // a entrar aunque clienteQuiere siga en null.
      .filter(
        (r) => !ctrl.get(`${r.NroPedOrigen}-${r.NroRengOrigen}`)?.irrelevante,
      )
      // duplicado: factura duplicada (botón "Duplicado"), descarte definitivo
      // igual que irrelevante — no vuelve a entrar.
      .filter(
        (r) => !ctrl.get(`${r.NroPedOrigen}-${r.NroRengOrigen}`)?.duplicado,
      )
      .map((r) => {
        const cExact = ctrl.get(`${r.NroPedOrigen}-${r.NroRengOrigen}`);
        const cArt = ctrlPorArt.get(`${r.NroPedOrigen}-${r.CodArticulo.trim()}`);
        const c = cExact ?? cArt;
        // Match por (artículo, CLIENTE) — 2026-09-16: solo el renglón del
        // cliente que compras marcó como extraordinario califica acá, no
        // cualquier renglón de ese artículo (ver comentario de extraMap).
        const extra = extraMap.get(`${r.CodArticulo.trim()}__${String(r.Cliente ?? "").trim()}`);
        const extraordinario = !!extra && extra.comprar === null;
        // fechaArribo por separado de `c`: el match exacto por renglón puede
        // EXISTIR (ctrl se llena para TODO renglón, tenga o no arribo — hace
        // falta para clienteQuiere/irrelevante/duplicado) pero con
        // fechaArribo=null si ese renglón quedó reciclado por Magnus para OTRO
        // artículo. Si usáramos `c?.fechaArribo` (objeto completo con ??), ese
        // null exacto tapaba el fallback por artículo (cArt) aunque cArt SÍ
        // tuviera el arribo cargado — la fila caía al estimado de OC (badge
        // "OC", el que se ve como "fecha de despacho") en vez del manual.
        // Bug real 2026-07-24: /compras/faltantes con arribo cargado, /ventas
        // /faltantes seguía mostrando el estimado incluso después de deployar.
        const manual = cExact?.fechaArribo ?? cArt?.fechaArribo ?? null;
        // 2026-09-16 — "siempre en vivo": se invierte la prioridad de arriba.
        // El estimado recalculado desde la OC vigente en Magnus
        // (`arriboParaFaltante`, ver más arriba — ya filtrado a solo las OC
        // hechas después de r.Fecha) manda siempre que exista; lo cargado a
        // mano en /compras/faltantes queda como último fallback, para cuando
        // ya no hay OC elegible para este faltante. Antes lo manual pisaba
        // siempre al estimado y quedaba clavado aunque Magnus reprogramara la
        // OC (caso real: arribo confirmado en julio, OC movida a septiembre
        // en Magnus, la vista seguía mostrando julio).
        const liveOc = arriboOcParaFaltante(r.CodArticulo.trim(), r.Fecha);
        const live = liveOc?.fecha ?? null;
        return {
          ...r,
          fechaArribo: live ?? manual ?? null,
          arriboOC: live !== null,
          arriboNroOC: liveOc?.nroOC ?? null,
          arriboPactada: liveOc?.pactada ?? false,
          clienteQuiere: c?.clienteQuiere ?? null,
          extraordinario,
          extraordinarioFecha: extra?.fecha ?? null,
        };
      })
      .filter(
        (r) =>
          r.clienteQuiere === null &&
          (r.fechaArribo !== null || r.extraordinario),
      );

    // Tabla 2: sin existencia + clienteQuiere=true + fechaArribo + ya llegó por
    // remito (CodArticulo en /compras/ingresos) + vendido aún sin decidir.
    const listos = rows
      .filter((r) => sin.has(`${r.NroPedOrigen}-${r.CodArticulo.trim()}`))
      .map((r) => {
        const cExact = ctrl.get(`${r.NroPedOrigen}-${r.NroRengOrigen}`);
        const cArt = ctrlPorArt.get(`${r.NroPedOrigen}-${r.CodArticulo.trim()}`);
        const c = cExact ?? cArt;
        const manual = cExact?.fechaArribo ?? cArt?.fechaArribo ?? null;
        return {
          ...r,
          // Mismo criterio "siempre en vivo" que Tabla 1 (2026-09-16): el
          // estimado de OC (`arriboParaFaltante`, ya filtrado a solo las OC
          // hechas después de r.Fecha) manda por sobre lo cargado a mano;
          // `manual` queda de último fallback. fechaArribo mira cExact y
          // cArt por separado — ver comentario en Tabla 1 arriba (mismo bug:
          // objeto exacto con fechaArribo=null tapaba el fallback).
          fechaArribo: arriboParaFaltante(r.CodArticulo.trim(), r.Fecha) ?? manual ?? null,
          clienteQuiere: c?.clienteQuiere ?? null,
          vendido: c?.vendido ?? null,
          yaIngreso: ingresados.has(r.CodArticulo.trim()),
        };
      })
      .filter(
        (r) =>
          r.clienteQuiere === true &&
          r.fechaArribo !== null &&
          r.yaIngreso &&
          r.vendido === null,
      );

    // existencia=true: error de preparado, no pasa por compras. "Arribado"
    // automático con fechaArribo sintético = "EN_STOCK" (ver fmtAr en el
    // front). Mismo gate de salida que Tabla 1 (clienteQuiere aún null).
    //
    // `con` viene de faltante_existencia, cuya fuente REAL es WMS
    // ot-diferencias (pedida≠cumplida en la OT) — NO Magnus. `rows` acá abajo
    // sigue siendo Magnus (fetch_faltantes viejo): un renglón "con existencia"
    // puede no tener match ahí (ya facturado / fuera de la ventana OC_DESDE en
    // Magnus) aunque WMS sí lo haya marcado hoy. Por eso arma en dos pasadas:
    // primero desde `rows` cuando matchea (dato real de Magnus); lo que queda
    // sin match se arma desde preparado.faltante_wms — Nombre resuelto (join
    // StkFer_Articulos en indicadores-api) e Importe APROXIMADO (último
    // PrecioVenta visto para ese CodArticulo en cualquier pedido de
    // Ven_PedRenPendientes, no hay tabla de lista de precios en el proyecto).
    const conKeysConRow = new Set<string>();
    const enStockDeRows = rows
      .filter((r) => {
        const k = `${r.NroPedOrigen}-${r.CodArticulo.trim()}`;
        if (!con.has(k)) return false;
        conKeysConRow.add(k);
        return true;
      })
      .filter(
        (r) => !ctrl.get(`${r.NroPedOrigen}-${r.NroRengOrigen}`)?.irrelevante,
      )
      // duplicado: factura duplicada (botón "Duplicado"), descarte definitivo
      // igual que irrelevante — no vuelve a entrar.
      .filter(
        (r) => !ctrl.get(`${r.NroPedOrigen}-${r.NroRengOrigen}`)?.duplicado,
      )
      .map((r) => {
        const c = ctrl.get(`${r.NroPedOrigen}-${r.NroRengOrigen}`);
        return {
          ...r,
          fechaArribo: "EN_STOCK" as const,
          arriboOC: false,
          clienteQuiere: c?.clienteQuiere ?? null,
          extraordinario: false,
          extraordinarioFecha: null,
        };
      })
      .filter((r) => r.clienteQuiere === null);

    // Código de cliente → nombre, con lo que ya vino de Magnus en esta misma
    // respuesta (sin consultas extra). Solo se usa como fallback abajo.
    const nombrePorCliente = new Map<string, string>();
    for (const r of rowsTodos) {
      const cod = String(r.Cliente ?? "").trim();
      const nom = (r.ClienteNombre ?? "").trim();
      if (cod && nom && !nombrePorCliente.has(cod)) nombrePorCliente.set(cod, nom);
    }

    const enStockDeWms: typeof enStockDeRows = [];
    for (const [key, ex] of existLatest) {
      if (ex !== true || conKeysConRow.has(key)) continue;
      const w = wmsLatest.get(key);
      if (!w) continue; // ni Magnus ni faltante_wms lo tienen — no hay con qué mostrarlo
      // faltante_wms.cliente guarda el CodCliente (texto) — mismo recorte por
      // cartera que `rows`, que esta rama no atraviesa.
      if (cartera && !cartera.has(Number(w.cliente))) continue;
      const c = ctrl.get(`${w.nroPedOrigen}-${w.nroRengOrigen}`);
      if (c?.irrelevante || c?.duplicado) continue;
      if ((c?.clienteQuiere ?? null) !== null) continue;
      enStockDeWms.push({
        NroPedOrigen: w.nroPedOrigen,
        NroRengOrigen: w.nroRengOrigen,
        CodArticulo: w.codArticulo,
        Nombre: w.nombre,
        CantPend: w.cantPedida,
        Cliente: w.cliente || null,
        // El nombre viene de faltante_wms (lo resuelve indicadores-api contra
        // Magnus). Para las filas persistidas ANTES de que existiera esa
        // columna se cae al nombre que ya trajo cualquier renglón del mismo
        // cliente en esta misma respuesta, y recién en última instancia al
        // código — que es lo que se veía antes en TODAS estas tarjetas.
        ClienteNombre:
          w.clienteNombre || nombrePorCliente.get(String(w.cliente ?? "").trim()) || w.cliente || null,
        // Las filas persistidas antes de que indicadores-api resolviera el
        // vendedor contra MAGNUS_SITD.dbo.Vendedores pueden traer el CÓDIGO;
        // un valor puramente numérico no es un nombre → se muestra "—" hasta
        // que la próxima pasada de /deposito/faltantes lo actualice.
        Vendedor: /^\d+$/.test((w.vendedor ?? "").trim()) ? null : w.vendedor || null,
        Importe: w.importe,
        Fecha: w.fecha,
        fechaArribo: "EN_STOCK" as const,
        arriboOC: false,
        clienteQuiere: null,
        extraordinario: false,
        extraordinarioFecha: null,
      });
    }

    // Últimos códigos sin nombre real (ni faltante_wms.clienteNombre ni el
    // fallback de `rowsTodos` los resolvió, así que arriba quedó el CÓDIGO
    // pisando el nombre). En vez de una consulta a Magnus por cada fila —
    // acá puede haber varias decenas — se junta la lista de códigos ÚNICOS
    // sin resolver y se pide UNA sola vez en batch (IN (...)) a
    // indicadores-api. Best-effort: si Magnus no responde, quedan con el
    // código como hasta ahora, no se corta el resto de la respuesta.
    const codigosSinNombre = [
      ...new Set(
        enStockDeWms
          .filter((r) => r.Cliente != null && r.ClienteNombre === r.Cliente)
          .map((r) => String(r.Cliente)),
      ),
    ];
    if (codigosSinNombre.length > 0) {
      try {
        const r = await fetch(
          `${API_URL}/clientes/nombres?codigos=${codigosSinNombre.join(",")}`,
          { cache: "no-store", signal: AbortSignal.timeout(10000) },
        );
        if (r.ok) {
          const { nombres } = (await r.json()) as { nombres: Record<string, string> };
          for (const row of enStockDeWms) {
            const cod = row.Cliente != null ? String(row.Cliente) : "";
            const nom = nombres[cod];
            if (nom && row.ClienteNombre === row.Cliente) row.ClienteNombre = nom;
          }
        }
      } catch {
        // sin nombre esta vuelta — se sigue viendo el código, como antes.
      }
    }

    const enStock = [...enStockDeRows, ...enStockDeWms];

    return NextResponse.json({
      fecha,
      rows: [...out, ...enStock],
      listos,
      isAdmin: !soloVendedor,
    });
  } catch (error) {
    console.error("GET /api/ventas/faltantes", error);
    return NextResponse.json(
      { error: "No se pudo conectar al servicio de depósito" },
      { status: 503 },
    );
  }
}
