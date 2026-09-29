import { NextRequest, NextResponse } from "next/server";

const API_URL = process.env.INDICADORES_API_URL ?? "http://indicadores-api:8001";

export const dynamic = "force-dynamic";

// Depósito de mostrador: 3 = Ruta, 2 = Lilser (ver indicadores-api/mostradores.py).
const depositoValido = (v: unknown) => {
  const n = Number(v);
  return n === 2 || n === 3 ? n : null;
};

// Líneas del catálogo con cuántos patrones tienen y cuántos ya se controlaron
// (Mostradores → Administrar). Proxy a indicadores-api /mostradores/lineas.
//   GET ?deposito=3|2 -> { lineas: [{ id, nombre, patrones, controlados }] }
export async function GET(req: NextRequest) {
  const deposito = depositoValido(req.nextUrl.searchParams.get("deposito"));
  if (!deposito) return NextResponse.json({ error: "Depósito inválido" }, { status: 400 });
  try {
    const res = await fetch(`${API_URL}/mostradores/lineas?deposito=${deposito}`, {
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
