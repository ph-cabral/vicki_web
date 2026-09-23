import { NextRequest, NextResponse } from "next/server";

const API_URL =
  process.env.INDICADORES_API_URL ?? "http://indicadores-api:8001";

export const dynamic = "force-dynamic";
export const maxDuration = 20;

// Proxy → FastAPI indicadores-api: polling del widget de Mesa de Control
// (cada ~30 s). Latido del operario + estado de los clientes reservados para
// él (reserva por cliente, ver indicadores-api/control_asignacion.py).
// Ej: /api/deposito/errores-mesa/grupo?nroOperario=185
export async function GET(req: NextRequest) {
  const nro = req.nextUrl.searchParams.get("nroOperario");
  if (!nro || !/^\d+$/.test(nro)) {
    return NextResponse.json({ error: "Falta 'nroOperario'" }, { status: 400 });
  }
  try {
    const res = await fetch(
      `${API_URL}/deposito/errores-mesa/grupo?nroOperario=${encodeURIComponent(nro)}`,
      { cache: "no-store", signal: AbortSignal.timeout(15000) },
    );
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      return NextResponse.json(
        { error: "No se pudo leer el grupo del cliente", detail: data },
        { status: res.status },
      );
    }
    return NextResponse.json(data);
  } catch (error) {
    console.error("GET /api/deposito/errores-mesa/grupo", error);
    return NextResponse.json(
      { error: "No se pudo conectar al servicio de depósito" },
      { status: 503 },
    );
  }
}
