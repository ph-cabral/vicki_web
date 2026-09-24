import { NextResponse } from "next/server";

const API_URL = process.env.INDICADORES_API_URL ?? "http://indicadores-api:8001";

export const dynamic = "force-dynamic";

// Líneas del catálogo con cuántos patrones tienen y cuántos ya se controlaron
// (Mostradores → Administrar). Proxy a indicadores-api /mostradores/lineas.
//   GET -> { lineas: [{ id, nombre, patrones, controlados }] }
export async function GET() {
  try {
    const res = await fetch(`${API_URL}/mostradores/lineas`, {
      cache: "no-store",
      signal: AbortSignal.timeout(30000),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      return NextResponse.json(
        { error: typeof json?.detail === "string" ? json.detail : "Error al leer las líneas" },
        { status: res.status },
      );
    }
    return NextResponse.json(json);
  } catch (error) {
    console.error("GET /api/mostradores/lineas", error);
    return NextResponse.json({ error: "No se pudo conectar al servicio" }, { status: 503 });
  }
}
