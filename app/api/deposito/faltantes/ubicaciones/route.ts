import { NextRequest, NextResponse } from "next/server";

const API_URL =
  process.env.INDICADORES_API_URL ?? "http://indicadores-api:8001";

export const dynamic = "force-dynamic";

// Proxy → FastAPI indicadores-api: todas las ubicaciones de un artículo (sin
// filtrar) con stock > 0. Lo consume el modal de /deposito/faltantes.
export async function GET(req: NextRequest) {
  const articulo = req.nextUrl.searchParams.get("articulo");
  if (!articulo)
    return NextResponse.json({ error: "falta articulo" }, { status: 400 });
  try {
    const res = await fetch(
      `${API_URL}/deposito/articulo/ubicaciones?articulo=${encodeURIComponent(articulo)}`,
      { cache: "no-store", signal: AbortSignal.timeout(20000) },
    );
    if (!res.ok) {
      const detail = await res.json().catch(() => null);
      return NextResponse.json(
        { error: "Error en API de ubicaciones", detail },
        { status: res.status },
      );
    }
    return NextResponse.json(await res.json());
  } catch (error) {
    console.error("GET /api/deposito/faltantes/ubicaciones", error);
    return NextResponse.json(
      { error: "No se pudo conectar al servicio de depósito" },
      { status: 503 },
    );
  }
}
