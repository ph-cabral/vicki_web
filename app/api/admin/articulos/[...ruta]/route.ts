import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Proxy ADMIN -> indicadores-api (/articulos/config/*) para la pantalla
// /admin/articulos. Lista blanca de rutas: el segmento nunca se arma con
// texto libre del cliente.
const API_URL = process.env.INDICADORES_API_URL ?? "http://indicadores-api:8001";
const GET_OK = new Set(["resumen", "patrones-nuevos", "articulos", "sub-lineas"]);
const POST_OK = new Set(["asignar-patron", "sincronizar"]);

async function reenviar(
  req: NextRequest,
  ctx: { params: Promise<{ ruta: string[] }> },
  method: "GET" | "POST",
) {
  const g = await requireAdmin();
  if (!g.ok) return NextResponse.json({ error: g.error }, { status: g.status });

  const { ruta } = await ctx.params;
  const destino = ruta.length === 1 ? ruta[0] : "";
  if (!(method === "GET" ? GET_OK : POST_OK).has(destino)) {
    return NextResponse.json({ error: "Ruta inválida" }, { status: 404 });
  }

  const url = `${API_URL}/articulos/config/${destino}${method === "GET" ? req.nextUrl.search : ""}`;
  try {
    const res = await fetch(url, {
      method,
      cache: "no-store",
      signal: AbortSignal.timeout(60000),
      ...(method === "POST"
        ? { headers: { "Content-Type": "application/json" }, body: await req.text() }
        : {}),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      return NextResponse.json(
        { error: typeof j?.detail === "string" ? j.detail : `HTTP ${res.status}` },
        { status: res.status },
      );
    }
    return NextResponse.json(j);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "indicadores-api no responde" }, { status: 502 });
  }
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ ruta: string[] }> }) {
  return reenviar(req, ctx, "GET");
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ ruta: string[] }> }) {
  return reenviar(req, ctx, "POST");
}
