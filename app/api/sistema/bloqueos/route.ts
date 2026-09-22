import { NextRequest, NextResponse } from "next/server";

const API_URL =
  process.env.INDICADORES_API_URL ?? "http://indicadores-api:8001";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Estado en vivo del watchdog de bloqueos de Magnus (ver
// indicadores-api/bloqueos.py y ever/sql/magnus_watchdog_bloqueos.sql).
// El GET queda protegido por el módulo "sistema" en middleware.ts; las
// acciones (matar / dejar) viven en ./accion y además exigen ADMIN.
export async function GET(req: NextRequest) {
  const detectar = req.nextUrl.searchParams.get("detectar") ?? "true";
  try {
    const res = await fetch(`${API_URL}/sistema/bloqueos?detectar=${detectar}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => null);
      return NextResponse.json(
        { error: "Error al consultar los bloqueos", detail },
        { status: res.status },
      );
    }
    return NextResponse.json(await res.json());
  } catch (error) {
    console.error("GET /api/sistema/bloqueos", error);
    return NextResponse.json(
      { error: "No se pudo conectar al servicio de indicadores" },
      { status: 503 },
    );
  }
}
