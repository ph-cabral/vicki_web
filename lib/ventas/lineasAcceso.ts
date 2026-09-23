import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";

/**
 * Qué LÍNEAS del catálogo puede elegir cada usuario en la vista de líneas
 * (/ventas/bulones, en el menú "Líneas") — 2026-09-23.
 *
 *   · ADMIN            → todas las líneas del catálogo.
 *   · no-admin con filas en everwear.usuario_linea_venta → sólo esas.
 *   · no-admin sin filas → sólo la línea por defecto (Bulones), que es lo
 *     que la vista mostraba antes de abrirse a todas.
 *
 * Esto decide QUÉ LÍNEA se puede pedir. QUÉ DATOS se ven adentro (su cartera
 * vs. toda la empresa) lo sigue resolviendo resolverAccesoBulones().
 *
 * El catálogo (id + nombre) sale de indicadores-api (/ventas/lineas/catalogo,
 * cacheado allá 15 min) y acá se memoiza 5 min más por proceso: cada request
 * de la vista valida la línea pedida y no tiene sentido ir a buscar 40 filas
 * que casi no cambian. Los permisos del usuario se leen EN VIVO (una query
 * por PK): un cambio en la configuración surte efecto en la próxima consulta,
 * sin relogin.
 */

const API_URL = process.env.INDICADORES_API_URL ?? "http://indicadores-api:8001";

export interface LineaCatalogo {
  id: number;
  nombre: string;
}

export interface CatalogoLineas {
  lineas: LineaCatalogo[];
  defecto: number | null;
}

const TTL_MS = 5 * 60 * 1000;
let memo: { ts: number; valor: CatalogoLineas } | null = null;

export async function catalogoLineas(): Promise<CatalogoLineas> {
  if (memo && Date.now() - memo.ts < TTL_MS) return memo.valor;
  const res = await fetch(`${API_URL}/ventas/lineas/catalogo`, {
    cache: "no-store",
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Catálogo de líneas: HTTP ${res.status}`);
  const j = await res.json();
  const valor: CatalogoLineas = {
    lineas: Array.isArray(j?.lineas)
      ? j.lineas
          .filter((l: { id?: unknown }) => Number.isInteger(Number(l?.id)))
          .map((l: { id: number; nombre?: string }) => ({
            id: Number(l.id),
            nombre: String(l.nombre ?? "").trim(),
          }))
      : [],
    defecto: Number.isInteger(Number(j?.defecto)) ? Number(j.defecto) : null,
  };
  memo = { ts: Date.now(), valor };
  return valor;
}

/**
 * Nombre visible de una línea. El catálogo tiene nombres repetidos
 * ("Varios" dos veces): a esos se les agrega el id para poder distinguirlos
 * en el selector y en la configuración.
 */
export function etiquetasLineas(lineas: LineaCatalogo[]): LineaCatalogo[] {
  const cuenta = new Map<string, number>();
  for (const l of lineas) cuenta.set(l.nombre.toLowerCase(), (cuenta.get(l.nombre.toLowerCase()) ?? 0) + 1);
  return lineas.map((l) =>
    (cuenta.get(l.nombre.toLowerCase()) ?? 0) > 1 ? { ...l, nombre: `${l.nombre} (#${l.id})` } : l,
  );
}

export type LineasPermitidas =
  | { ok: true; esAdmin: boolean; lineas: LineaCatalogo[]; defecto: number | null }
  | { ok: false; status: number; error: string };

export async function resolverLineasPermitidas(): Promise<LineasPermitidas> {
  const session = await getSession();
  if (!session) return { ok: false, status: 401, error: "No autenticado" };
  let cat: CatalogoLineas;
  try {
    cat = await catalogoLineas();
  } catch (e) {
    console.error("catalogoLineas", e);
    return { ok: false, status: 503, error: "No se pudo leer el catálogo de líneas" };
  }
  const todas = etiquetasLineas(cat.lineas);
  const esAdmin = session.rol === "ADMIN";
  let lineas: LineaCatalogo[];
  if (esAdmin) {
    lineas = todas;
  } else {
    const filas = await prisma.usuario_linea_venta.findMany({
      where: { usuarioId: session.uid },
      select: { lineaId: true },
    });
    const ids = new Set(filas.map((f) => f.lineaId));
    lineas =
      ids.size > 0
        ? todas.filter((l) => ids.has(l.id))
        : todas.filter((l) => l.id === cat.defecto);
  }
  // La de defecto sólo si el usuario la tiene; si no, la primera que pueda ver.
  const defecto = lineas.some((l) => l.id === cat.defecto) ? cat.defecto : lineas[0]?.id ?? null;
  return { ok: true, esAdmin, lineas, defecto };
}

/**
 * "Todas las líneas" (2026-09-23): id reservado 0 — el catálogo arranca en 1.
 * Se ofrece a quien tiene MÁS DE UNA línea habilitada:
 *   · ADMIN → el back no filtra por artículo (toda la venta, igual que el
 *     total de /ventas/vendedor).
 *   · no-admin → la unión de SUS líneas (`lineas` viaja al back como
 *     `?lineas=1,5,9`); nunca ve venta de una línea que no tiene.
 */
export const LINEA_TODAS = 0;
export const NOMBRE_TODAS = "Todas las líneas";

export type LineaResuelta =
  | { ok: true; lineaId: number; lineas: number[] | null }
  | { ok: false; status: number; error: string };

/** Query string para indicadores-api: `linea` + (si corresponde) `lineas`. */
export function aplicarLineaQs(qs: URLSearchParams, lin: { lineaId: number; lineas: number[] | null }) {
  qs.set("linea", String(lin.lineaId));
  if (lin.lineas && lin.lineas.length > 0) qs.set("lineas", lin.lineas.join(","));
}

/**
 * Valida el `?linea=` de una request contra lo que el usuario puede ver.
 * Sin parámetro = su línea por defecto (así /ventas/presupuestos, que pega
 * a los mismos endpoints sin mandar línea, sigue viendo Bulones). Una línea
 * que no tiene habilitada es 403 — nunca se "corrige" en silencio.
 */
export async function resolverLineaPedida(sp: URLSearchParams): Promise<LineaResuelta> {
  const perm = await resolverLineasPermitidas();
  if (!perm.ok) return perm;
  const crudo = sp.get("linea")?.trim();
  if (!crudo) {
    if (perm.defecto == null)
      return { ok: false, status: 403, error: "No tenés ninguna línea habilitada" };
    return { ok: true, lineaId: perm.defecto, lineas: null };
  }
  const id = Number(crudo);
  if (!Number.isInteger(id) || id < 0)
    return { ok: false, status: 400, error: "Parámetro 'linea' inválido" };
  if (id === LINEA_TODAS) {
    if (perm.lineas.length <= 1)
      return { ok: false, status: 403, error: "No tenés habilitada la vista de todas las líneas" };
    return {
      ok: true,
      lineaId: LINEA_TODAS,
      lineas: perm.esAdmin ? null : perm.lineas.map((l) => l.id),
    };
  }
  if (!perm.lineas.some((l) => l.id === id))
    return { ok: false, status: 403, error: "No tenés habilitada esa línea" };
  return { ok: true, lineaId: id, lineas: null };
}
