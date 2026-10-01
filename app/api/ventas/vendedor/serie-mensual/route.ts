import { NextRequest, NextResponse } from "next/server";
import { resolverAccesoVendedor, vendedorParam } from "@/lib/ventas/vendedorAcceso";

const API_URL =
  process.env.INDICADORES_API_URL ?? "http://indicadores-api:8001";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Proxy → FastAPI indicadores-api: unidades y $ por MES y por LÍNEA de los
// últimos 12 meses (con el mes en curso, parcial), para el gráfico "Venta por
// mes" de /ventas/vendedor (2026-10-01). Ver fetch_serie_mensual en ventas.py.
//
// Acceso: mismo criterio que top-lineas — un no-admin SIEMPRE ve su propio
// vendedorCodigo (el `?vendedor=` que mande se ignora, ver vendedorParam);
// un admin ve toda la empresa o el vendedor que eligió en el filtro del
// header. Un no-admin sin vendedor asignado ve la serie vacía (no "toda la
// empresa").
export async function GET(req: NextRequest) {
  const acceso = await resolverAccesoVendedor();
  if (!acceso.ok) {
    return NextResponse.json({ error: acceso.error }, { status: acceso.status });
  }
  if (!acceso.isAdmin && !acceso.vendedorCodigo) {
    return NextResponse.json({
      meses: [],
      mesActual: "",
      lineas: [],
      totalUnidades: [],
      totalMonto: [],
    });
  }

  try {
    const qs = new URLSearchParams();
    const vend = vendedorParam(req.nextUrl.searchParams, acceso);
    if (vend) qs.set("vendedor", vend);
    const res = await fetch(
      `${API_URL}/ventas/vendedor/serie-mensual${qs.toString() ? `?${qs.toString()}` : ""}`,
      { cache: "no-store", signal: AbortSignal.timeout(55000) },
    );
    if (!res.ok) {
      const detail = await res.json().catch(() => null);
      return NextResponse.json(
        { error: "Error en API de serie mensual", detail },
        { status: res.status },
      );
    }
    return NextResponse.json(await res.json());
  } catch (error) {
    console.error("GET /api/ventas/vendedor/serie-mensual", error);
    return NextResponse.json(
      { error: "No se pudo conectar al servicio de ventas" },
      { status: 503 },
    );
  }
}
