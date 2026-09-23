import { NextRequest, NextResponse } from "next/server";
import { resolverAccesoBulones } from "@/lib/ventas/bulonesAcceso";
import { aplicarLineaQs, resolverLineaPedida } from "@/lib/ventas/lineasAcceso";

const API_URL =
  process.env.INDICADORES_API_URL ?? "http://indicadores-api:8001";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Proxy -> FastAPI indicadores-api (/ventas/bulones/top-patrones) para /ventas/bulones (2026-08-26). Gemelo de la ruta equivalente de /api/ventas/vendedor:
// mismo contrato y MISMA resolución de acceso por vendedor (admin = toda la
// empresa; no-admin = sólo su cartera, resuelto server-side y nunca tomado
// del query string). Lo único distinto es que el backend acota todo a la
// línea elegida (catálogo, `?linea=`) y corta por código patrón. Ver bulones.py.
function mesActual(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}


export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const desde = sp.get("desde")?.trim() || undefined;
  const hasta = sp.get("hasta")?.trim() || undefined;

  const acceso = await resolverAccesoBulones();
  if (!acceso.ok) {
    return NextResponse.json({ error: acceso.error }, { status: acceso.status });
  }
  if (!acceso.isAdmin && !acceso.vendedorCodigo) {
    // Sin vendedor asignado todavía = cero clientes visibles (no "sin
    // restricción"), mismo criterio que /api/ventas/vendedor/*.
    return NextResponse.json({
      // Mismo shape que el back: `desde`/`hasta` son el acumulado (null si
      // no se pidió un rango y no hay meses cerrados) y `mesActual` es la
      // columna del mes en curso.
      desde: desde ?? null,
      hasta: hasta ?? null,
      mesActual: mesActual(),
      totalPatrones: 0,
      totalPatronesMonto: 0,
      porUnidades: [],
      porMonto: [],
    });
  }

  // Línea del catálogo (2026-09-23): validada contra lo que el usuario
  // tiene habilitado; sin `?linea=` = su línea por defecto (Bulones).
  const lin = await resolverLineaPedida(sp);
  if (!lin.ok) return NextResponse.json({ error: lin.error }, { status: lin.status });

  try {
    const qs = new URLSearchParams();
    aplicarLineaQs(qs, lin);
    if (!acceso.isAdmin) qs.set("vendedor", String(acceso.vendedorCodigo));
    if (desde) qs.set("desde", desde);
    if (hasta) qs.set("hasta", hasta);
    const res = await fetch(`${API_URL}/ventas/bulones/top-patrones?${qs.toString()}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(55000),
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => null);
      const motivo = typeof detail?.detail === "string" ? detail.detail : null;
      return NextResponse.json(
        {
          error: motivo
            ? `Error en API de top códigos patrón: ${motivo}`
            : "Error en API de top códigos patrón",
          detail,
        },
        { status: res.status },
      );
    }
    return NextResponse.json(await res.json());
  } catch (error) {
    console.error("GET /api/ventas/bulones/top-patrones", error);
    return NextResponse.json(
      { error: "No se pudo conectar al servicio de ventas" },
      { status: 503 },
    );
  }
}
