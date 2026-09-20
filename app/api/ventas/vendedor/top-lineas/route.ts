import { NextRequest, NextResponse } from "next/server";
import { resolverAccesoVendedor, vendedorParam } from "@/lib/ventas/vendedorAcceso";

const API_URL =
  process.env.INDICADORES_API_URL ?? "http://indicadores-api:8001";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Proxy → FastAPI indicadores-api: top líneas por UNIDADES compradas en un
// rango de meses (default: últimos 12), para el ranking debajo de la tabla
// de /ventas/vendedor (2026-08-18: "agregamos vista de
// líneas, al igual que el top, traemos el total de líneas y acá dejamos ver
// solo unidades compradas"). Gemelo de top-clientes/route.ts — mismo
// contrato, misma resolución de acceso; lo único que cambia es la métrica
// (unidades en vez de $) y el eje de agrupación (línea en vez de cliente).
//
// La respuesta trae las DOS métricas: `porUnidades` (ordenado por unidades)
// y `porMonto` (ordenado por $), cada item con `unidades` y `monto`, más
// `totalLineas`/`totalLineasMonto` (cuántas líneas distintas entran en cada
// filtración, mayor que las que se listan). Desde 2026-08-26 el ranking de
// líneas del front tiene su propio botón $ | Unidades y alterna entre las
// dos listas SIN volver a pegarle acá. Ver fetch_top_lineas en ventas.py.
//
// Acceso por vendedor: mismo criterio que /api/ventas/vendedor y
// /api/ventas/vendedor/clientes — se resuelve server-side si quien pide es
// admin (ranking de toda la empresa) o no-admin (solo su vendedorCodigo,
// o sea las líneas que compraron los clientes de su cartera).
function mesActual(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const desde = sp.get("desde")?.trim() || undefined;
  const hasta = sp.get("hasta")?.trim() || undefined;

  const acceso = await resolverAccesoVendedor();
  if (!acceso.ok) {
    return NextResponse.json({ error: acceso.error }, { status: acceso.status });
  }
  if (!acceso.isAdmin && !acceso.vendedorCodigo) {
    // Mismo tratamiento que el resto de las rutas de /ventas/vendedor: sin
    // vendedor asignado todavía = cero clientes visibles, así que tampoco
    // hay líneas que mostrar (no "sin restricción").
    return NextResponse.json({
      desde: desde ?? mesActual(),
      hasta: hasta ?? mesActual(),
      totalLineas: 0,
      totalLineasMonto: 0,
      porUnidades: [],
      porMonto: [],
    });
  }

  try {
    const qs = new URLSearchParams();
    const vend = vendedorParam(sp, acceso);
    if (vend) qs.set("vendedor", vend);
    if (desde) qs.set("desde", desde);
    if (hasta) qs.set("hasta", hasta);
    const res = await fetch(`${API_URL}/ventas/vendedor/top-lineas?${qs.toString()}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(55000),
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => null);
      return NextResponse.json(
        { error: "Error en API de top líneas", detail },
        { status: res.status },
      );
    }
    const data = await res.json();
    // Bonificaciones y ajustes: SOLO ADMIN (2026-09-07). Mismo criterio que
    // /api/ventas/vendedor/top-clientes: sin `ajuste`/`ajusteMes` el pie de
    // la tabla vuelve a ser una sola fila ("Total") y el número no viaja.
    //
    // `total`/`totalMes` (el neto ya calculado por el back) NO se borran
    // (2026-09-20): son el total de la pestaña, no el desglose. Borrarlos
    // dejaba al no-admin sumando filas BRUTAS, y su total de Líneas daba por
    // encima del de Clientes exactamente la bonificación del período.
    if (!acceso.isAdmin) {
      delete (data as Record<string, unknown>).ajuste;
      delete (data as Record<string, unknown>).ajusteMes;
    }
    return NextResponse.json(data);
  } catch (error) {
    console.error("GET /api/ventas/vendedor/top-lineas", error);
    return NextResponse.json(
      { error: "No se pudo conectar al servicio de ventas" },
      { status: 503 },
    );
  }
}
