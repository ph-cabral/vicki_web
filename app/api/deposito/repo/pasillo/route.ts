import { NextRequest, NextResponse } from "next/server";

const API_URL =
  process.env.INDICADORES_API_URL ?? "http://indicadores-api:8001";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Proxy → FastAPI indicadores-api: lo que hay que reponer en un pasillo, cada
// artículo con TODAS sus ubicaciones de guardado para elegir y su posición de
// picking de destino. Lo consume el widget "Falta en Picking 2" al apretar
// "armar OT".
//
// Se diferencia de /picking-disponible/armar-ot en que ahí el sistema elige
// sola la ubicación (y parte el renglón); acá manda la lista completa y elige
// el operario, que es el que sabe si el pallet está accesible.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const pasillo = sp.get("pasillo");
  if (!pasillo) {
    return NextResponse.json(
      { error: "Falta el parámetro pasillo" },
      { status: 400, headers: CORS },
    );
  }
  const qs = new URLSearchParams({ pasillo });
  const dias = sp.get("dias");
  if (dias) qs.set("dias", dias);

  try {
    const res = await fetch(`${API_URL}/deposito/repo/pasillo?${qs.toString()}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(45000),
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => null);
      return NextResponse.json(
        { error: "Error en API de depósito (armado de repo)", detail },
        { status: res.status, headers: CORS },
      );
    }
    return NextResponse.json(await res.json(), { headers: CORS });
  } catch (error) {
    console.error("GET /api/deposito/repo/pasillo", error);
    return NextResponse.json(
      { error: "No se pudo conectar al servicio de depósito" },
      { status: 503, headers: CORS },
    );
  }
}
