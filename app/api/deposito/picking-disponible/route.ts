import { NextRequest, NextResponse } from "next/server";

const API_URL =
  process.env.INDICADORES_API_URL ?? "http://indicadores-api:8001";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Proxy → FastAPI indicadores-api: cartel de armado. Por cada OT de Picking
// viva (ya asignada a un armador, la haya tomado o no), qué hay realmente para
// tomar en la POSICIÓN de picking de cada renglón: disponible | pedido |
// a reponer. Distinto de /api/deposito/reposicion-ot, que compara contra el
// stock del depósito entero. ?dias acota la antigüedad de la OT; ?todos=1 trae
// todos los renglones y no sólo los que tienen problema.
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const qs = new URLSearchParams();
  const dias = sp.get("dias");
  const todos = sp.get("todos");
  if (dias) qs.set("dias", dias);
  if (todos) qs.set("todos", todos);

  try {
    const res = await fetch(
      `${API_URL}/deposito/picking-disponible?${qs.toString()}`,
      { cache: "no-store", signal: AbortSignal.timeout(45000) },
    );
    if (!res.ok) {
      const detail = await res.json().catch(() => null);
      return NextResponse.json(
        { error: "Error en API de depósito (picking disponible)", detail },
        { status: res.status },
      );
    }
    return NextResponse.json(await res.json());
  } catch (error) {
    console.error("GET /api/deposito/picking-disponible", error);
    return NextResponse.json(
      { error: "No se pudo conectar al servicio de depósito" },
      { status: 503 },
    );
  }
}
