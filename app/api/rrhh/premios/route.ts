import { NextRequest, NextResponse } from "next/server";

const API_URL =
  process.env.INDICADORES_API_URL ?? "http://indicadores-api:8001";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Proxy → FastAPI indicadores-api: premios de depósito de UN mes — ítems
// recolectados por preparador (WMS) y renglones controlados por controlador
// (EVERWEAR), con los errores de deposito.errores_mesa imputados a cada uno.
// Ver indicadores-api/premios.py. Va bajo /api/rrhh (no /api/deposito) para
// que el permiso de la vista sea el del módulo RRHH, que es donde vive.
export async function GET(req: NextRequest) {
  const mes = req.nextUrl.searchParams.get("mes");
  if (!mes) {
    return NextResponse.json({ error: "Falta el parámetro 'mes'" }, { status: 400 });
  }
  try {
    const res = await fetch(
      `${API_URL}/rrhh/premios?mes=${encodeURIComponent(mes)}`,
      { cache: "no-store", signal: AbortSignal.timeout(45000) },
    );
    if (!res.ok) {
      const detail = await res.json().catch(() => null);
      return NextResponse.json(
        { error: "Error en API de premios", detail },
        { status: res.status },
      );
    }
    return NextResponse.json(await res.json());
  } catch (error) {
    console.error("GET /api/rrhh/premios", error);
    return NextResponse.json(
      { error: "No se pudo conectar al servicio de indicadores" },
      { status: 503 },
    );
  }
}
