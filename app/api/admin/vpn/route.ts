import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/guard";
import { bajaDispositivo, listarDispositivos } from "@/lib/vpn/wireguard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Celulares con la app Vicki dados de alta en la VPN (peers "vicki-app" del Mikrotik).
export async function GET() {
  const g = await requireAdmin();
  if (!g.ok) return NextResponse.json({ error: g.error }, { status: g.status });
  try {
    return NextResponse.json({ dispositivos: await listarDispositivos() });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Error consultando el Mikrotik" }, { status: 502 });
  }
}

// Baja inmediata: borra el peer. El celular deja de entrar desde afuera; si
// vuelve a abrir la app en el WiFi de la oficina se da de alta de nuevo.
export async function DELETE(req: NextRequest) {
  const g = await requireAdmin();
  if (!g.ok) return NextResponse.json({ error: g.error }, { status: g.status });
  const id = req.nextUrl.searchParams.get("id") ?? "";
  try {
    await bajaDispositivo(id);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "No se pudo dar de baja" }, { status: 502 });
  }
}
