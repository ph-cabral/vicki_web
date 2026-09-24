import { NextRequest, NextResponse } from "next/server";

const API_URL = process.env.INDICADORES_API_URL ?? "http://indicadores-api:8001";

export const dynamic = "force-dynamic";

// Códigos patrón de UNA línea con detalle, estado y fechas de controles
// (Mostradores → Administrar, al desplegar una línea).
//   GET ?linea=<id> -> { linea, patrones: [{ codigo, detalle, subLinea, pendiente,
//                        controlado, controles: [{ id, fecha, tieneArchivo }] }] }
export async function GET(req: NextRequest) {
  const linea = Number(req.nextUrl.searchParams.get("linea"));
  if (!Number.isInteger(linea) || linea < 1) {
    return NextResponse.json({ error: "Parámetro 'linea' inválido" }, { status: 400 });
  }
  try {
    const res = await fetch(`${API_URL}/mostradores/patrones?linea=${linea}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(30000),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      return NextResponse.json(
        { error: typeof json?.detail === "string" ? json.detail : "Error al leer los patrones" },
        { status: res.status },
      );
    }
    return NextResponse.json(json);
  } catch (error) {
    console.error("GET /api/mostradores/patrones", error);
    return NextResponse.json({ error: "No se pudo conectar al servicio" }, { status: 503 });
  }
}
