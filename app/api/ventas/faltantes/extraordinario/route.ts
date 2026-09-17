// Alias de /api/compras/faltantes-extraordinario bajo el módulo "ventas"
// (mismo motivo que ../control/route.ts: sin el módulo "compras" el POST
// devolvía 403 y la decisión sobre un extraordinario no se guardaba).
export { POST } from "@/app/api/compras/faltantes-extraordinario/route";
export const dynamic = "force-dynamic";
