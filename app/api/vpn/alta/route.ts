import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { altaDispositivo } from "@/lib/vpn/wireguard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Lo llama la app Android "Vicki" (android/vicki) la primera vez que el usuario
// entra estando en el WiFi de la oficina: genera el par de claves del celular,
// crea el peer en el Mikrotik y devuelve la config del túnel. Con sesión
// normal de vicki (el middleware ya exige cookie válida).
export async function POST(req: NextRequest) {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "No autenticado" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const dev = typeof body?.dispositivo === "string" ? body.dispositivo : "";
  const modelo = typeof body?.modelo === "string" ? body.modelo : "";
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(dev)) {
    return NextResponse.json({ error: "dispositivo inválido" }, { status: 400 });
  }

  try {
    const cfg = await altaDispositivo({ uid: s.uid, nombreUsuario: s.nombre, dev, modelo });
    return NextResponse.json(cfg, { headers: { "Cache-Control": "no-store" } });
  } catch (e: any) {
    console.error("[vpn/alta]", e);
    return NextResponse.json({ error: e?.message ?? "No se pudo dar de alta la VPN" }, { status: 502 });
  }
}
