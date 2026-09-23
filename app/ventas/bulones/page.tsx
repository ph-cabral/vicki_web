// /ventas/bulones → /ventas/lineas (2026-09-23).
// La vista de Líneas se mudó a /ventas/lineas. Esta ruta queda sólo como
// redirect para links y favoritos viejos (conserva el ?linea=…). No se lista
// en el menú: está en IGNORE de scripts/gen-nav.mjs.
// Las APIs siguen en /api/ventas/bulones/* (no cambiaron).
import { redirect } from "next/navigation";

export default async function BulonesRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (Array.isArray(v)) v.forEach((x) => qs.append(k, x));
    else if (v != null) qs.set(k, v);
  }
  const q = qs.toString();
  redirect(q ? `/ventas/lineas?${q}` : "/ventas/lineas");
}
