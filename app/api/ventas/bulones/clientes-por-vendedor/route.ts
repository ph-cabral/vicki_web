import { NextRequest, NextResponse } from "next/server";
import { resolverAccesoBulones } from "@/lib/ventas/bulonesAcceso";
import { aplicarLineaQs, resolverLineaPedida } from "@/lib/ventas/lineasAcceso";

const API_URL =
  process.env.INDICADORES_API_URL ?? "http://indicadores-api:8001";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Proxy -> FastAPI indicadores-api (/ventas/bulones/clientes-por-vendedor) para /ventas/bulones (2026-08-26). Gemelo de la ruta equivalente de /api/ventas/vendedor:
// mismo contrato y MISMA resolución de acceso por vendedor (admin = toda la
// empresa; no-admin = sólo su cartera, resuelto server-side y nunca tomado
// del query string). Lo único distinto es que el backend acota todo a la
// línea elegida (catálogo, `?linea=`) y corta por código patrón. Ver bulones.py.
function aniosPorDefecto(): { anioAnterior: number; anioActual: number } {
  const y = new Date().getFullYear();
  return { anioAnterior: y - 1, anioActual: y };
}

function anioVacio() {
  return {
    cantidad: 0,
    monto: 0,
    meses: Array.from({ length: 12 }, (_, i) => ({ mes: i + 1, cantidad: 0, monto: 0 })),
  };
}


export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const codigo = sp.get("codigo")?.trim();
  if (!codigo) {
    return NextResponse.json({ error: "Falta 'codigo' (vendedor)" }, { status: 400 });
  }

  const acceso = await resolverAccesoBulones();
  if (!acceso.ok) {
    return NextResponse.json({ error: acceso.error }, { status: acceso.status });
  }
  // Acá el vendedor es el EJE de la consulta, no un filtro: un no-admin sólo
  // puede pedir su propio código (si no, vería la cartera de otro).
  if (!acceso.isAdmin && String(acceso.vendedorCodigo ?? "") !== codigo) {
    return NextResponse.json(
      { error: "Sólo podés ver los clientes de tu propia cartera" },
      { status: 403 },
    );
  }

  // Línea del catálogo (2026-09-23): validada contra lo que el usuario
  // tiene habilitado; sin `?linea=` = su línea por defecto (Bulones).
  const lin = await resolverLineaPedida(sp);
  if (!lin.ok) return NextResponse.json({ error: lin.error }, { status: lin.status });

  try {
    const qs = new URLSearchParams({ codigo });
    aplicarLineaQs(qs, lin);
    const res = await fetch(`${API_URL}/ventas/bulones/clientes-por-vendedor?${qs.toString()}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(55000),
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => null);
      const motivo = typeof detail?.detail === "string" ? detail.detail : null;
      return NextResponse.json(
        {
          error: motivo
            ? `Error en API de clientes por vendedor: ${motivo}`
            : "Error en API de clientes por vendedor",
          detail,
        },
        { status: res.status },
      );
    }
    return NextResponse.json(await res.json());
  } catch (error) {
    console.error("GET /api/ventas/bulones/clientes-por-vendedor", error);
    return NextResponse.json(
      { error: "No se pudo conectar al servicio de ventas" },
      { status: 503 },
    );
  }
}
