import { NextRequest, NextResponse } from "next/server";

const API_URL =
  process.env.INDICADORES_API_URL ?? "http://indicadores-api:8001";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Proxy → FastAPI indicadores-api: hora de control por ítem. El widget de
// escritorio de Mesa de Control manda {nroPedido, nroOperario, eventos:[{codigo,
// haceMs, origen, eid}]} con los códigos de artículo del pedido asignado que el
// controlador escaneó o tipeó en Magnus. Se guardan en deposito.control_item_log
// (ver calidad.registrar_control_items). Ruta pública en middleware.ts.
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  try {
    const res = await fetch(`${API_URL}/deposito/control-items`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      return NextResponse.json(
        { error: "No se pudo guardar el control por ítem", detail: data },
        { status: res.status },
      );
    }
    return NextResponse.json(data);
  } catch (error) {
    console.error("POST /api/deposito/errores-mesa/control-items", error);
    return NextResponse.json(
      { error: "No se pudo conectar al servicio de depósito" },
      { status: 503 },
    );
  }
}
