import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/guard";

const API_URL =
  process.env.INDICADORES_API_URL ?? "http://indicadores-api:8001";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Buscador de clientes + cuenta de ecommerce (usuario y contraseña). Datos
// sensibles: SOLO ADMIN. El middleware ya fuerza ADMIN para /api/sistema/clientes
// (isAdminPath en lib/auth/modules.ts); acá se revalida por las dudas.
// Ver indicadores-api/ecommerce.py.
export async function GET(req: NextRequest) {
  const g = await requireAdmin();
  if (!g.ok) return NextResponse.json({ error: g.error }, { status: g.status });

  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
  if (!q) return NextResponse.json({ resultados: [], total: 0, ecommerceOk: true, aviso: null });
  const limit = req.nextUrl.searchParams.get("limit") ?? "50";

  const qs = new URLSearchParams({ q, limit });
  try {
    const res = await fetch(`${API_URL}/sistema/clientes/buscar?${qs}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(25000),
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => null);
      return NextResponse.json(
        { error: "Error al buscar el cliente", detail },
        { status: res.status },
      );
    }
    return NextResponse.json(await res.json());
  } catch (error) {
    console.error("GET /api/sistema/clientes/buscar", error);
    return NextResponse.json(
      { error: "No se pudo conectar al servicio de indicadores" },
      { status: 503 },
    );
  }
}
