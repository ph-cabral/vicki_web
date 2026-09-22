import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { mesDeFecha, registrarFaltanteMes } from "@/lib/deposito/faltanteMes";

const API_URL =
  process.env.INDICADORES_API_URL ?? "http://indicadores-api:8001";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// ─────────────────────────────────────────────────────────────────────────────
// Fuente de /deposito/faltantes desde 2026-09-22: PEDIDOS de Magnus, no el pick
// de OT del WMS.
//
//   · Entra el pedido Cerrado o Facturado (EstadoPedido 3 / 4). Del pedido
//     CANCELADO no se trae nada.
//   · Entra el renglón cuya CantidadCumplida quedó por debajo de la
//     CantidadPedida. El faltante es esa diferencia.
//   · Un renglón cancelado dentro de un pedido vivo queda con cumplida = 0, así
//     que cuenta entero por la misma regla.
//   · El día lo fija cab.FechaCierre.
//
// Por qué se cambió: la fuente anterior (/deposito/ot-diferencias, OT Picking
// Cumplida del WMS) solo veía lo que el operario llegó a pickear y se persistía
// con ON CONFLICT DO UPDATE, que pisaba la diferencia del día con el valor de
// la corrida siguiente. No servía para saber cuánto faltó en el mes.
//
// Los nombres de campo de la respuesta NO cambian (NroPedOrigen / NroRengOrigen
// / CantPend / …) para que faltantes/check, faltantes/novedad, el histórico y
// compras/faltantes-consumo sigan funcionando sin tocar nada: tratan esa clave
// como opaca. Acá NroPedOrigen = NroMovVenta y NroRengOrigen = NroRenglon de
// Magnus, que es justamente la clave con la que ya se guardan las marcas en
// preparado.faltante_existencia.
//
// Se sigue persistiendo preparado.faltante_wms con el pick de OT (llamada
// aparte, best-effort): /ventas/faltantes lo usa como fallback de "En stock" y
// quedaría sin alimentar si se sacaba de acá.
// ─────────────────────────────────────────────────────────────────────────────

interface FaltanteRow {
  NroMovVenta: number;
  Renglon: number;
  Fecha: string | null;
  Cliente: string | number | null;
  ClienteNombre: string | null;
  Vendedor: string;
  Ubicacion: string;
  CodArticulo: string;
  Nombre: string;
  CantPedida: number;
  CantCumplida: number;
  Diferencia: number;
  PrecioVenta: number;
  Importe: number;
  EstadoPedido: number | null;
  EstadoRenglon: number | null;
  CompCodigo: number | null;
  TipoArticulo: string | null;
  Proveedor: string | null;
  Linea: string | null;
}

interface OtDifRow {
  OTId: number;
  NroMovVenta: number | null;
  Fecha: string | null;
  Operario: string;
  Cliente: string | number | null;
  ClienteNombre: string | null;
  Vendedor: string;
  Ubicacion: string;
  CodArticulo: string;
  Nombre: string;
  Renglon: number;
  CantPedida: number;
  CantCumplida: number;
  Diferencia: number;
  Importe: number;
}

/** Mantiene vivo preparado.faltante_wms (fallback de /ventas/faltantes). */
async function persistirOtWms(desde: string | null, hasta: string | null) {
  const qs = new URLSearchParams();
  if (desde) qs.set("desde", desde);
  if (hasta) qs.set("hasta", hasta);
  const res = await fetch(
    `${API_URL}/deposito/ot-diferencias${qs.toString() ? `?${qs}` : ""}`,
    { cache: "no-store", signal: AbortSignal.timeout(45000) },
  );
  if (!res.ok) return;
  const json = (await res.json()) as { rows: OtDifRow[] };
  const raw = json.rows ?? [];
  if (!raw.length) return;
  const values = raw.map(
    (r) =>
      Prisma.sql`(${r.Fecha}::date, ${r.OTId}, ${r.Renglon}, ${r.NroMovVenta}, ${r.Renglon}, ${r.Operario}, ${String(r.Cliente ?? "")}, ${r.ClienteNombre ?? null}, ${r.Vendedor}, ${r.Ubicacion}, ${r.CodArticulo}, ${r.Nombre ?? ""}, ${r.CantPedida}, ${r.CantCumplida}, ${r.Diferencia}, ${r.Importe ?? 0}, now())`,
  );
  await prisma.$executeRaw`
    INSERT INTO preparado.faltante_wms
      (fecha, "otId", renglon, "nroPedOrigen", "nroRengOrigen", operario, cliente, "clienteNombre", vendedor, ubicacion, "codArticulo", nombre, "cantPedida", "cantCumplida", diferencia, importe, "updatedAt")
    VALUES ${Prisma.join(values)}
    ON CONFLICT ("otId", renglon) DO UPDATE SET
      nombre         = EXCLUDED.nombre,
      "clienteNombre" = COALESCE(EXCLUDED."clienteNombre", preparado.faltante_wms."clienteNombre"),
      vendedor       = COALESCE(NULLIF(EXCLUDED.vendedor, ''), preparado.faltante_wms.vendedor),
      "cantPedida"   = EXCLUDED."cantPedida",
      "cantCumplida" = EXCLUDED."cantCumplida",
      diferencia     = EXCLUDED.diferencia,
      importe        = EXCLUDED.importe,
      "updatedAt"    = now()
  `;
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const qs = new URLSearchParams();
  const desde = sp.get("desde");
  const hasta = sp.get("hasta");
  if (desde) qs.set("desde", desde);
  if (hasta) qs.set("hasta", hasta);

  let json: {
    desde: string | null;
    hasta: string | null;
    rows: FaltanteRow[];
    resumen?: Record<string, number>;
  };
  try {
    const res = await fetch(
      `${API_URL}/deposito/faltante-pedidos${qs.toString() ? `?${qs}` : ""}`,
      { cache: "no-store", signal: AbortSignal.timeout(45000) },
    );
    if (!res.ok) {
      const detail = await res.json().catch(() => null);
      return NextResponse.json(
        { error: "Error en API de depósito (faltante-pedidos)", detail },
        { status: res.status },
      );
    }
    json = await res.json();
  } catch (error) {
    console.error("GET /api/deposito/faltantes", error);
    return NextResponse.json(
      { error: "No se pudo conectar al servicio de depósito" },
      { status: 503 },
    );
  }

  const raw = json.rows ?? [];

  // ── Persistencia del detalle (best-effort: la tabla puede no estar creada) ──
  let persistWarn = false;
  if (raw.length) {
    try {
      const CH = 500; // un INSERT por tanda, no una query por fila
      for (let i = 0; i < raw.length; i += CH) {
        const values = raw.slice(i, i + CH).map(
          (r) =>
            Prisma.sql`(${r.NroMovVenta}, ${r.Renglon}, ${r.Fecha}::date, ${r.CodArticulo}, ${r.Nombre ?? ""}, ${r.Cliente == null ? null : Number(r.Cliente)}, ${r.ClienteNombre ?? null}, ${r.Vendedor ?? ""}, ${r.Ubicacion ?? ""}, ${r.CompCodigo}, ${r.EstadoPedido}, ${r.EstadoRenglon}, ${r.CantPedida}, ${r.CantCumplida}, ${r.Diferencia}, ${r.PrecioVenta}, ${r.Importe}, now())`,
        );
        await prisma.$executeRaw`
          INSERT INTO preparado.faltante_pedido
            ("nroMovVenta", "nroRenglon", fecha, "codArticulo", nombre, cliente, "clienteNombre", vendedor, ubicacion, "compCodigo", "estadoPedido", "estadoRenglon", "cantPedida", "cantCumplida", diferencia, precio, importe, "updatedAt")
          VALUES ${Prisma.join(values)}
          ON CONFLICT ("nroMovVenta", "nroRenglon") DO UPDATE SET
            fecha           = EXCLUDED.fecha,
            nombre          = EXCLUDED.nombre,
            "clienteNombre" = COALESCE(EXCLUDED."clienteNombre", preparado.faltante_pedido."clienteNombre"),
            vendedor        = COALESCE(NULLIF(EXCLUDED.vendedor, ''), preparado.faltante_pedido.vendedor),
            "estadoPedido"  = EXCLUDED."estadoPedido",
            "estadoRenglon" = EXCLUDED."estadoRenglon",
            "cantPedida"    = EXCLUDED."cantPedida",
            "cantCumplida"  = EXCLUDED."cantCumplida",
            diferencia      = EXCLUDED.diferencia,
            precio          = EXCLUDED.precio,
            importe         = EXCLUDED.importe,
            "updatedAt"     = now()
        `;
      }
    } catch (e) {
      persistWarn = true;
      console.error("persist faltante_pedido", e);
    }
  }

  // ── Registro del acumulado mensual ─────────────────────────────────────────
  // Se dispara con cada lectura de la vista (idempotente: recalcula el mes
  // entero y pisa). El registro diario garantizado lo hace el job que pega a
  // POST /api/deposito/faltantes/mes — esto es el refuerzo, no la garantía.
  let mesWarn = false;
  const mes = mesDeFecha(json.hasta ?? json.desde);
  if (mes) {
    try {
      const r = await registrarFaltanteMes(mes);
      mesWarn = !r.guardado;
    } catch (e) {
      mesWarn = true;
      console.error("registrarFaltanteMes desde /api/deposito/faltantes", e);
    }
  }

  // ── faltante_wms (fallback de /ventas/faltantes) ───────────────────────────
  try {
    await persistirOtWms(json.desde, json.hasta);
  } catch (e) {
    console.error("persist faltante_wms", e);
  }

  const rows = raw
    .map((r) => ({
      NroPedOrigen: r.NroMovVenta,
      NroRengOrigen: r.Renglon,
      Ubicacion: r.Ubicacion,
      CodArticulo: r.CodArticulo,
      Nombre: r.Nombre ?? "",
      CantPend: r.Diferencia,
      Cliente: r.Cliente,
      ClienteNombre: r.ClienteNombre ?? null,
      Importe: r.Importe ?? 0,
      TipoArticulo: r.TipoArticulo ?? null,
      Preparador: null as string | null, // el pedido no dice quién pickeó
      Linea: r.Linea ?? null,
      Proveedor: r.Proveedor ?? null,
      Vendedor: r.Vendedor,
      Fecha: r.Fecha,
      CantPedida: r.CantPedida,
      CantCumplida: r.CantCumplida,
      Cancelado: r.EstadoRenglon === 4,
    }))
    .sort((a, b) =>
      String(a.Ubicacion) < String(b.Ubicacion)
        ? -1
        : String(a.Ubicacion) > String(b.Ubicacion)
          ? 1
          : 0,
    );

  return NextResponse.json({
    fecha: json.hasta ?? json.desde,
    desde: json.desde,
    hasta: json.hasta,
    total: rows.length,
    rows,
    resumen: json.resumen ?? null,
    persistWarn,
    mesWarn,
  });
}
