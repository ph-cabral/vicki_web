// Alias de /api/deposito/faltantes/control bajo el módulo "ventas".
// /ventas/faltantes escribía directo en /api/deposito/..., y el middleware
// corta por prefijo de módulo: un usuario con "ventas" pero sin "deposito"
// recibía 403, el front caía en el catch y recargaba → la fila descartada
// (tacho / duplicado / lo quiere / vendido) volvía a aparecer al segundo.
// Misma lógica y misma tabla (preparado.faltante_control), sin duplicar código.
export { GET, POST } from "@/app/api/deposito/faltantes/control/route";
export const dynamic = "force-dynamic";
