import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";

const API_URL = process.env.INDICADORES_API_URL ?? "http://indicadores-api:8001";

export const dynamic = "force-dynamic";

// Depósito de mostrador: 3 = Ruta, 2 = Lilser (ver indicadores-api/mostradores.py).
const depositoValido = (v: unknown) => {
  const n = Number(v);
  return n === 2 || n === 3 ? n : null;
};

// Conteo en PDA (Mostradores → Control).
//   GET ?deposito=3|2 -> { patrones: [{ controlId, codigo, detalle, linea, total, contados, tomadoPorId, tomadoPor, tomadoAt }],
//             activoId,   // patrón tomado por el usuario de la sesión (o null)
//             articulos: [{ controlId, patron, cod, detalle, barras, contado, contadoAt }] }  // sólo del activo
//   POST { controlId, codArticulo, cantidad } -> { ok, controlId, cod, cantidad, contadoAt }
//   GET ?lista=1 -> sólo patrones + activoId (articulos: []), para el refresco automático de la lista.
// El usuario sale de la sesión, nunca del body.
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autenticado" }, { status: 401 });
  const deposito = depositoValido(req.nextUrl.searchParams.get("deposito"));
  if (!deposito) return NextResponse.json({ error: "Depósito inválido" }, { status: 400 });
  const lista = req.nextUrl.searchParams.get("lista") === "1" ? "&lista=true" : "";
  try {
    const res = await fetch(`${API_URL}/mostradores/conteo?usuarioId=${session.uid}&deposito=${deposito}${lista}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(30000),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      return NextResponse.json(
        { error: typeof json?.detail === "string" ? json.detail : "Error al leer el conteo" },
        { status: res.status },
      );
    }
    return NextResponse.json(json);
  } catch (error) {
    console.error("GET /api/mostradores/conteo", error);
    return NextResponse.json({ error: "No se pudo conectar al servicio" }, { status: 503 });
  }
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autenticado" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as
    | { controlId?: unknown; codArticulo?: unknown; cantidad?: unknown }
    | null;
  const controlId = Number(body?.controlId);
  const codArticulo = typeof body?.codArticulo === "string" ? body.codArticulo.trim() : "";
  const cantidad = Number(body?.cantidad);
  if (!Number.isInteger(controlId) || controlId <= 0 || !codArticulo) {
    return NextResponse.json({ error: "Faltan datos" }, { status: 400 });
  }
  if (!Number.isFinite(cantidad) || cantidad < 0) {
    return NextResponse.json({ error: "Cantidad inválida" }, { status: 400 });
  }

  try {
    const res = await fetch(`${API_URL}/mostradores/conteo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ controlId, codArticulo, cantidad, usuarioId: session.uid }),
      cache: "no-store",
      signal: AbortSignal.timeout(30000),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      return NextResponse.json(
        { error: typeof json?.detail === "string" ? json.detail : "No se pudo guardar" },
        { status: res.status },
      );
    }
    return NextResponse.json(json);
  } catch (error) {
    console.error("POST /api/mostradores/conteo", error);
    return NextResponse.json({ error: "No se pudo conectar al servicio" }, { status: 503 });
  }
}
