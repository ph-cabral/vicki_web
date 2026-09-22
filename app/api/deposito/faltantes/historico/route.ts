import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const API_URL =
  process.env.INDICADORES_API_URL ?? "http://indicadores-api:8001";

// Histórico mensual de /deposito/faltantes: para reportes (ej. "dame en Excel
// los artículos marcados con/sin existencia de tal mes"), a diferencia de
// GET /api/deposito/faltantes/check que solo trae marcas de UN día.
//
// v2 (2026-07-30): preparado.faltante_wms se pisa con ON CONFLICT (otId,
// renglon) DO UPDATE cada vez que /api/deposito/faltantes vuelve a traer ese
// mismo renglón (mismo OTId) — si para entonces WMS ya "cerró" la diferencia,
// la cantidad guardada ahí queda en 0/limpia aunque el día que se marcó SÍ
// hubiera faltante real. Fix: la cantidad (CantPedida/CantCumplida/Diferencia)
// y el nombre/ubicación ahora se toman EN VIVO de indicadores-api
// /deposito/ot-diferencias, con desde/hasta = todo el mes pedido — la OT que
// alimenta esto es Cumplido/terminal (OTEstado=2, ver SQL_OT_DIFERENCIAS en
// indicadores-api/deposito.py), así que no cambia después de cerrada; sí trae
// TODOS los faltantes del mes, no solo el último persistido. Se cruza por
// (NroMovVenta, Renglon) — en este flujo (WMS ot-diferencias) nroRengOrigen
// ES el Renglon de la OT, a diferencia de /ventas/faltantes donde WMS y
// Magnus numeran distinto (ver "Bug real encontrado 2026-07-10" ahí).
// preparado.faltante_wms queda como fallback best-effort si ese renglón ya no
// aparece en vivo (p.ej. el pedido se anuló en Magnus después).
//
// Proveedor: WMS no lo tiene (gap conocido, ver comentario en
// GET /api/deposito/faltantes). Se resuelve con /compras/ordenes-pendientes
// (mismo dato que usa /compras/faltantes y /ventas/faltantes) — es el
// proveedor de la OC ABIERTA para ese artículo, no necesariamente la que
// cubrió este faltante puntual; si el artículo no tiene OC pendiente hoy,
// sale vacío.
//
// v4 (2026-09-22): desde el cambio de fuente de /deposito/faltantes (pedidos
// Cerrados/Facturados de Magnus en vez del pick de OT del WMS), las marcas
// nuevas de preparado.faltante_existencia tienen nroRengOrigen = NroRenglon DE
// MAGNUS, que NO es el renglón de la OT. Así que la cantidad se busca primero
// en preparado.faltante_pedido (misma clave pedido+renglón de Magnus, escrita
// por /api/deposito/faltantes) y recién si no está se cae a la cruza vieja
// contra ot-diferencias / faltante_wms, que es lo que sigue sirviendo para los
// meses anteriores al cambio.
//
// v3 (2026-07-31): mismo endpoint ahora se consume también desde
// /compras/faltantes (botón "Excel (existencia)"), no solo desde
// /deposito/faltantes. se excluyen acá los renglones cuyo
// pedido es comprobante Magnus 70 o 75 (cab.CompCodigo, expuesto por
// indicadores-api en /deposito/ot-diferencias desde este mismo cambio) —
// aplica a AMBOS consumidores por igual, ya que es el mismo reporte.

interface ExistRow {
  fecha: Date;
  nroPedOrigen: number;
  nroRengOrigen: number;
  codArticulo: string | null;
  existencia: boolean | null;
  malFacturado: boolean | null;
  cantidad: number | null;
}

interface OtDifRow {
  NroMovVenta: number | null;
  Renglon: number;
  Ubicacion: string | null;
  CodArticulo: string;
  Nombre: string | null;
  CantPedida: number;
  CantCumplida: number;
  Diferencia: number;
  Cliente: string | number | null;
  Vendedor: string | null;
  Importe: number;
  CompCodigo: number | null;
}

// Comprobantes Magnus a excluir de este export (2026-07-31).
// Best-effort: solo aplica a renglones resueltos vía ot-diferencias (que ahora
// trae CompCodigo); el fallback preparado.faltante_wms no lo tiene y no se
// filtra por este criterio.
const COMP_CODIGOS_EXCLUIDOS = new Set([70, 75]);

interface PedidoRow {
  nroMovVenta: number;
  nroRenglon: number;
  nombre: string | null;
  cliente: number | null;
  clienteNombre: string | null;
  ubicacion: string | null;
  vendedor: string | null;
  cantPedida: unknown;
  cantCumplida: unknown;
  diferencia: unknown;
  importe: unknown;
  compCodigo: number | null;
}

interface WmsRow {
  nroPedOrigen: number | null;
  nroRengOrigen: number;
  codArticulo: string;
  nombre: string | null;
  cliente: string | null;
  ubicacion: string | null;
  vendedor: string | null;
  cantPedida: unknown;
  importe: unknown;
}

interface OcPendienteRow {
  CodArticulo: string;
  Proveedor: string | null;
}

export async function GET(req: NextRequest) {
  const mes = req.nextUrl.searchParams.get("mes"); // "YYYY-MM"
  const m = /^(\d{4})-(\d{2})$/.exec(mes ?? "");
  if (!m) {
    return NextResponse.json(
      { error: "mes requerido, formato YYYY-MM" },
      { status: 400 },
    );
  }
  const anio = Number(m[1]);
  const mesNum = Number(m[2]); // 1-12
  const desde = new Date(Date.UTC(anio, mesNum - 1, 1));
  const hasta = new Date(Date.UTC(anio, mesNum, 1)); // exclusivo (1er día del mes siguiente)
  const desdeStr = desde.toISOString().slice(0, 10);
  const hastaInclStr = new Date(hasta.getTime() - 86400000)
    .toISOString()
    .slice(0, 10);

  try {
    const [existRows, pedRows, wmsRows, otJson, ocJson] = await Promise.all([
      prisma.faltante_existencia.findMany({
        where: {
          fecha: { gte: desde, lt: hasta },
          OR: [{ existencia: { not: null } }, { malFacturado: true }],
        },
        orderBy: [{ fecha: "asc" }, { nroPedOrigen: "asc" }],
        select: {
          fecha: true,
          nroPedOrigen: true,
          nroRengOrigen: true,
          codArticulo: true,
          existencia: true,
          malFacturado: true,
          cantidad: true,
        },
      }),
      // Fuente nueva: el detalle del faltante por pedido+renglón de Magnus, del
      // mes pedido. 1 range scan sobre el índice de fecha. Best-effort: la
      // tabla puede no estar creada todavía.
      prisma.$queryRaw<PedidoRow[]>`
        SELECT "nroMovVenta", "nroRenglon", nombre, cliente, "clienteNombre",
               ubicacion, vendedor, "cantPedida", "cantCumplida", diferencia,
               importe, "compCodigo"
        FROM preparado.faltante_pedido
        WHERE fecha >= ${desde} AND fecha < ${hasta}
      `.catch(() => [] as PedidoRow[]),
      // Fallback (best-effort, puede no existir la tabla en algún ambiente).
      prisma.$queryRaw<WmsRow[]>`
        SELECT DISTINCT ON ("nroPedOrigen", "codArticulo")
               "nroPedOrigen", "nroRengOrigen", "codArticulo", nombre,
               cliente, ubicacion, vendedor, "cantPedida", importe
        FROM preparado.faltante_wms
        ORDER BY "nroPedOrigen", "codArticulo", "updatedAt" DESC
      `.catch(() => [] as WmsRow[]),
      // Fuente EN VIVO: todos los renglones OT Cumplida con diferencia del mes.
      fetch(
        `${API_URL}/deposito/ot-diferencias?desde=${desdeStr}&hasta=${hastaInclStr}`,
        { cache: "no-store", signal: AbortSignal.timeout(45000) },
      )
        .then((r) => (r.ok ? r.json() : { rows: [] }))
        .catch(() => ({ rows: [] })),
      // Proveedor best-effort (OC abierta actual por artículo).
      fetch(`${API_URL}/compras/ordenes-pendientes`, {
        cache: "no-store",
        signal: AbortSignal.timeout(45000),
      })
        .then((r) => (r.ok ? r.json() : { rows: [] }))
        .catch(() => ({ rows: [] })),
    ]);

    const pedByKey = new Map<string, PedidoRow>();
    for (const r of pedRows) {
      pedByKey.set(`${r.nroMovVenta}-${r.nroRenglon}`, r);
    }

    const wmsByKey = new Map<
      string,
      {
        nombre: string;
        cliente: string;
        ubicacion: string;
        vendedor: string;
        cantPedida: number;
        importe: number;
      }
    >();
    for (const r of wmsRows) {
      if (r.nroPedOrigen === null) continue;
      const cod = (r.codArticulo ?? "").trim();
      if (!cod) continue;
      wmsByKey.set(`${r.nroPedOrigen}-${cod}`, {
        nombre: r.nombre ?? "",
        cliente: r.cliente ?? "",
        ubicacion: r.ubicacion ?? "",
        vendedor: r.vendedor ?? "",
        cantPedida: Number(r.cantPedida ?? 0),
        importe: Number(r.importe ?? 0),
      });
    }

    // Clave real (NroMovVenta, Renglon) — mismos números que nroPedOrigen /
    // nroRengOrigen en preparado.faltante_existencia (ver comentario arriba).
    const otByKey = new Map<
      string,
      {
        nombre: string;
        ubicacion: string;
        cliente: string;
        vendedor: string;
        cantPedida: number;
        cantCumplida: number;
        diferencia: number;
        importe: number;
        compCodigo: number | null;
      }
    >();
    for (const r of (otJson?.rows ?? []) as OtDifRow[]) {
      if (r.NroMovVenta === null) continue;
      otByKey.set(`${r.NroMovVenta}-${r.Renglon}`, {
        nombre: r.Nombre ?? "",
        ubicacion: r.Ubicacion ?? "",
        cliente: r.Cliente == null ? "" : String(r.Cliente),
        vendedor: r.Vendedor ?? "",
        cantPedida: Number(r.CantPedida ?? 0),
        cantCumplida: Number(r.CantCumplida ?? 0),
        diferencia: Number(r.Diferencia ?? 0),
        importe: Number(r.Importe ?? 0),
        compCodigo: r.CompCodigo ?? null,
      });
    }

    const proveedorPorArticulo = new Map<string, string>();
    for (const r of (ocJson?.rows ?? []) as OcPendienteRow[]) {
      const cod = (r.CodArticulo ?? "").trim();
      if (cod && r.Proveedor) proveedorPorArticulo.set(cod, r.Proveedor);
    }

    const rows = existRows
      .filter((r: ExistRow) => {
        const k = `${r.nroPedOrigen}-${r.nroRengOrigen}`;
        const comp = pedByKey.get(k)?.compCodigo ?? otByKey.get(k)?.compCodigo;
        return !(comp != null && COMP_CODIGOS_EXCLUIDOS.has(comp));
      })
      .map((r: ExistRow) => {
        const cod = (r.codArticulo ?? "").trim();
        const k = `${r.nroPedOrigen}-${r.nroRengOrigen}`;
        // Orden de preferencia: faltante_pedido (fuente actual, clave de
        // Magnus) → ot-diferencias en vivo → faltante_wms (meses viejos).
        const p = pedByKey.get(k);
        const ot = p ? undefined : otByKey.get(k);
        const w = p || ot ? undefined : wmsByKey.get(`${r.nroPedOrigen}-${cod}`);
        const num = (v: unknown) => (v == null ? null : Number(v));
        return {
          fecha: r.fecha.toISOString().slice(0, 10),
          nroPedOrigen: r.nroPedOrigen,
          nroRengOrigen: r.nroRengOrigen,
          codArticulo: cod,
          nombre: p?.nombre ?? ot?.nombre ?? w?.nombre ?? "",
          ubicacion: p?.ubicacion ?? ot?.ubicacion ?? w?.ubicacion ?? "",
          cliente:
            p?.clienteNombre ??
            (p?.cliente != null ? String(p.cliente) : undefined) ??
            ot?.cliente ??
            w?.cliente ??
            "",
          vendedor: p?.vendedor ?? ot?.vendedor ?? w?.vendedor ?? "",
          proveedor: proveedorPorArticulo.get(cod) ?? "",
          cantidad: r.cantidad, // cantidad tipeada a mano (opcional, puede venir vacía)
          cantPedida: num(p?.cantPedida) ?? ot?.cantPedida ?? w?.cantPedida ?? null,
          cantCumplida: num(p?.cantCumplida) ?? ot?.cantCumplida ?? null,
          // = lo que faltó de verdad ese renglón
          diferencia: num(p?.diferencia) ?? ot?.diferencia ?? null,
          importe: num(p?.importe) ?? ot?.importe ?? w?.importe ?? 0,
          existencia: r.existencia,
          malFacturado: r.malFacturado,
        };
      });

    return NextResponse.json({
      mes,
      desde: desdeStr,
      hasta: hastaInclStr,
      total: rows.length,
      rows,
    });
  } catch (error) {
    console.error("GET /api/deposito/faltantes/historico", error);
    return NextResponse.json(
      { error: "Error al leer histórico" },
      { status: 500 },
    );
  }
}
