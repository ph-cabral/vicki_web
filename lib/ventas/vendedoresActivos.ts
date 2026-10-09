import { prisma } from "@/lib/prisma";

const API_URL =
  process.env.INDICADORES_API_URL ?? "http://indicadores-api:8001";

export interface VendedorCatalogo {
  codigo: number;
  nombre: string | null;
  /** Estado_Desc del maestro empieza con "Habilitado" y el nombre no es "(baja)…". */
  activo: boolean;
  /** Es una persona, no un canal/zona/agrupador (MOSTRADORES, ZONA CBA, …). */
  persona: boolean;
}

/**
 * Catálogo de vendedores de Magnus (maestro `Vendedores`) — proxy a
 * indicadores-api, que es quien lo lee y calcula las banderas
 * `activo`/`persona` (ver fetch_vendedores en ventas.py).
 */
export async function fetchCatalogoVendedores(): Promise<VendedorCatalogo[]> {
  const res = await fetch(`${API_URL}/vendedores`, {
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`indicadores-api /vendedores → HTTP ${res.status}`);
  const j = await res.json();
  return Array.isArray(j?.vendedores) ? j.vendedores : [];
}

/**
 * MOSTRADORES (cód. 92 en `Vendedores`) es un canal, no una persona: no tiene
 * usuario ni legajo, pero factura bajo su propio código en
 * `Ven_CompCabecera.vendedor` y se pidió poder verlo en ventas. Entra al
 * filtro por nombre (cualquier "MOSTRADOR…" habilitado), sin pasar por la
 * condición de usuario/legajo.
 */
function esMostrador(v: VendedorCatalogo): boolean {
  return (v.nombre ?? "").trim().toUpperCase().startsWith("MOSTRADOR");
}

/**
 * Vendedores para el filtro de admin de /ventas/vendedor.
 *
 * DOS condiciones, las dos obligatorias:
 *   1. Magnus (`Vendedores`): habilitado y persona — deja afuera bajas y
 *      seudo-vendedores (MOSTRADORES, ZONA CBA, …).
 *   2. Postgres: tiene un usuario ACTIVO en la app cuyo LEGAJO está en
 *      estado ACTIVO (2026-08-27: "deberían estar solo los
 *      que en postgres legajo están activos").
 *
 * El único puente entre el legajo y el código de vendedor de Magnus es
 * `usuario.vendedorCodigo` (lo asigna un admin en /admin/usuarios), así que
 * la condición 2 implica pasar por `usuario`.
 *
 * CONSECUENCIA a tener presente cuando alguien pregunte "¿por qué no aparece
 * Fulano en el filtro?": un vendedor habilitado en Magnus que todavía no
 * tiene usuario en la app —o lo tiene sin vendedor asignado, o con el legajo
 * en otro estado— NO aparece. Se arregla en Administración → Usuarios, no
 * acá.
 */
export async function listarVendedoresActivos(): Promise<
  (VendedorCatalogo & { mostrador: boolean })[]
> {
  const [catalogo, usuarios] = await Promise.all([
    fetchCatalogoVendedores(),
    prisma.usuario.findMany({
      where: {
        activo: true,
        NOT: { vendedorCodigo: null },
        legajo: { estado: "ACTIVO" },
      },
      select: { vendedorCodigo: true },
    }),
  ]);

  const conLegajoActivo = new Set(
    usuarios
      .map((u) => u.vendedorCodigo)
      .filter((c): c is number => Number.isInteger(c)),
  );

  return catalogo
    .filter(
      (v) =>
        v.activo &&
        ((v.persona && conLegajoActivo.has(v.codigo)) || esMostrador(v)),
    )
    .map((v) => ({ ...v, mostrador: esMostrador(v) }))
    .sort((a, b) => (a.nombre ?? "").localeCompare(b.nombre ?? "", "es"));
}
