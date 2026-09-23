import { NextResponse } from "next/server";
import { resolverLineasPermitidas } from "@/lib/ventas/lineasAcceso";

export const dynamic = "force-dynamic";

// Líneas que el usuario logueado puede elegir en la vista de líneas
// (/ventas/bulones) — 2026-09-23. ADMIN: todas; el resto, las habilitadas en
// la configuración (sin configurar = sólo Bulones). Ver lib/ventas/lineasAcceso.ts.
//   GET -> { lineas: [{ id, nombre }], defecto, esAdmin, todas }
// `todas` (2026-09-23): si el selector ofrece "Todas las líneas" (id 0) —
// sólo con más de una línea habilitada.
export async function GET() {
  const perm = await resolverLineasPermitidas();
  if (!perm.ok) return NextResponse.json({ error: perm.error }, { status: perm.status });
  return NextResponse.json({ lineas: perm.lineas, defecto: perm.defecto, esAdmin: perm.esAdmin, todas: perm.lineas.length > 1 });
}
