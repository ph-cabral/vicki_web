import { NextResponse } from "next/server";

const API_URL = process.env.INDICADORES_API_URL ?? "http://indicadores-api:8001";

export const dynamic = "force-dynamic";

// Patrones en control (pendientes) con avance — panel derecho de Mostradores → Administrar.
//   GET -> { pendientes: [{ id, codigo, detalle, lineaId, linea, mandadoAt, mandadoPor,
//                          total, contados, avance, usuarios: [{ nombre, contados }], ultimoConteoAt }] }
export async function GET() {
  try {
    const res = await fetch(`${API_URL}/mostradores/pendientes`, {
      cache: "no-store",
      signal: AbortSignal.timeout(30000),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      return NextResponse.json(
        { error: typeof json?.detail === "string" ? json.detail : "Error al leer los pendientes" },
        { status: res.status },
      );
    }
    return NextResponse.json(json);
  } catch (error) {
    console.error("GET /api/mostradores/pendientes", error);
    return NextResponse.json({ error: "No se pudo conectar al servicio" }, { status: 503 });
  }
}
