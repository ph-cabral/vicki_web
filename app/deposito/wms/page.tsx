import { redirect } from "next/navigation";

// Los gráficos WMS se mudaron a /sistema/wms (2026-10-09). Esta ruta queda solo
// como redirect para links viejos; no se lista en el menú (IGNORE en
// scripts/gen-nav.mjs).
export default function DepositoWmsRedirect() {
  redirect("/sistema/wms");
}
