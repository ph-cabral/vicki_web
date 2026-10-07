import { NextRequest, NextResponse } from "next/server";
import { resolverAccesoVendedor, vendedorParam } from "@/lib/ventas/vendedorAcceso";

const API_URL =
  process.env.INDICADORES_API_URL ?? "http://indicadores-api:8001";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Proxy → FastAPI indicadores-api: top clientes por MONTO ($) en un rango
// de meses (default: últimos 12 — 2026-08-18), para el
// ranking debajo de la tabla de /ventas/vendedor. Ver fetch_top_clientes en
// ventas.py. `desde`/`hasta` ("YYYY-MM") pasan directo del front — el rango
// en sí (y su default) lo resuelve el back, acá solo se reenvían si vienen.
//
// La respuesta trae `porMonto` (top N) y `totalClientes` (cuántos clientes
// distintos entran en la filtración, mayor que los que se listan). El
// ranking por unidades se sacó a propósito: ahora vive en
// /api/ventas/vendedor/top-lineas, agrupado por línea de artículo.
//
// Acceso por vendedor: mismo criterio que /api/ventas/vendedor y
// /api/ventas/vendedor/clientes — se resuelve server-side si quien pide es
// admin (ranking de toda la empresa) o no-admin (solo su vendedorCodigo,
// ranking dentro de su propio portfolio de clientes).
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
    // vendedor asignado todavía = cero clientes visibles, no "sin
    // restricción".
    return NextResponse.json({
      desde: desde ?? mesActual(),
      hasta: hasta ?? mesActual(),
      totalClientes: 0,
      porMonto: [],
    });
  }

  try {
    const qs = new URLSearchParams();
    const vend = vendedorParam(sp, acceso);
    if (vend) qs.set("vendedor", vend);
    if (desde) qs.set("desde", desde);
    if (hasta) qs.set("hasta", hasta);
    const res = await fetch(`${API_URL}/ventas/vendedor/top-clientes?${qs.toString()}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(55000),
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => null);
      return NextResponse.json(
        { error: "Error en API de top clientes", detail },
        { status: res.status },
      );
    }
    const data = await res.json();
    // Bonificaciones y ajustes: SOLO ADMIN (2026-09-07). El pie
    // "venta bruta → bonificaciones y ajustes → venta neta" es información de
    // dirección, así que a un no-admin no le viaja el número: sin
    // `ajuste`/`ajusteMes` el front arma el pie de una sola fila ("Total"),
    // que es el comportamiento de siempre. Se filtra acá, no en el front,
    // para que el dato no esté en la respuesta.
    if (!acceso.isAdmin) {
      delete (data as Record<string, unknown>).ajuste;
      delete (data as Record<string, unknown>).ajusteMes;
      delete (data as Record<string, unknown>).ajusteM1;
      delete (data as Record<string, unknown>).ajusteM2;
    }
    return NextResponse.json(data);
  } catch (error) {
    console.error("GET /api/ventas/vendedor/top-clientes", error);
    return NextResponse.json(
      { error: "No se pudo conectar al servicio de ventas" },
      { status: 503 },
    );
  }
}
