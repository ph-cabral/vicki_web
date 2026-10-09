import { redirect } from "next/navigation";

// La vista se renombró a /deposito/streaming (2026-10-09). Esta ruta queda solo
// como redirect para links viejos; no se lista en el menú (IGNORE en
// scripts/gen-nav.mjs).
export default function DepositoDepositoRedirect() {
  redirect("/deposito/streaming");
}
