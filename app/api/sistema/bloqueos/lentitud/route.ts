import { NextRequest, NextResponse } from "next/server";

const API_URL =
  process.env.INDICADORES_API_URL ?? "http://indicadores-api:8001";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Registro de lentitud / timeouts / errores / deadlocks + episodios de bloqueo
// (pestaña "Lentitud y errores" de /sistema/bloqueos). Ver
// indicadores-api/bloqueos.py → fetch_lentitud.
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const qs = new URLSearchParams({
    dias: sp.get("dias") ?? "7",
    limite: sp.get("limite") ?? "200",
  });
  const tipo = sp.get("tipo");
  if (tipo) qs.set("tipo", tipo);
  try {
    const res = await fetch(`${API_URL}/sistema/bloqueos/lentitud?${qs}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => null);
      return NextResponse.json(
        { error: "Error al consultar el registro de lentitud", detail },
        { status: res.status },
      );
    }
    return NextResponse.json(await res.json());
  } catch (error) {
    console.error("GET /api/sistema/bloqueos/lentitud", error);
    return NextResponse.json(
      { error: "No se pudo conectar al servicio de indicadores" },
      { status: 503 },
    );
  }
}
