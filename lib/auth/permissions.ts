// Resolución de permisos por sector (lee everwear.sector_permiso).
// Runtime Node (usa prisma). El resultado se "hornea" en la cookie al loguear.
import { prisma } from "@/lib/prisma";
import {
  ALL_MODULE_KEYS,
  ALL_VIEW_HREFS,
  defaultModulosForSector,
  isModuleKey,
  isViewHref,
  normalizarHrefs,
  viewsForModule,
  type ModuleKey,
} from "./modules";

function sanitizeMods(v: unknown): ModuleKey[] {
  if (!Array.isArray(v)) return [];
  return v.filter(isModuleKey);
}

function sanitizeHrefs(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return normalizarHrefs(v.filter((x): x is string => typeof x === "string")).filter(isViewHref);
}

// Para "ocultos" admitimos tanto keys de módulo como hrefs de vista.
function sanitizeOcultos(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return normalizarHrefs(v.filter((x): x is string => typeof x === "string")).filter(
    (x) => isModuleKey(x) || isViewHref(x),
  );
}

export interface PermisosSector {
  mods: ModuleKey[];
  vistas: string[]; // hrefs de sub-vistas permitidas
  ocultos: string[]; // keys/hrefs ocultos del inicio (con acceso)
}

/**
 * Vistas que abre la bandera `usuario.bulonesAccesoTotal` (2026-08-31).
 *
 * La bandera ya existía para que un no-admin vea el 100% de la empresa en
 * /ventas/lineas (ex /ventas/bulones, ver lib/ventas/bulonesAcceso.ts). Desde acá pasa a ser
 * además la LLAVE DE ACCESO a las vistas de bulonería: quien la tiene entra
 * aunque su sector no las tenga habilitadas.
 *
 * Por qué: los permisos de vista son por SECTOR, así que habilitar
 * /ventas/presupuestos en el sector "ventas" se la daría a TODOS los
 * vendedores. El responsable de la línea de bulonería no es un sector, es una
 * persona — y ya está identificada por esta bandera, editable por un admin en
 * /admin/usuarios sin redeploy.
 *
 * Sólo SUMA permisos: no le saca nada a nadie, y un usuario sin la bandera
 * sigue viendo exactamente lo que le da su sector.
 */
const BULONES_MOD: ModuleKey = "ventas";
const BULONES_VISTAS = ["/ventas/lineas", "/ventas/presupuestos"];

/** Todas las vistas de los módulos habilitados (default cuando no hay selección guardada). */
function allViewsForMods(mods: ModuleKey[]): string[] {
  return mods.flatMap((m) => viewsForModule(m).map((v) => v.href));
}

/**
 * Permisos de un sector.
 * - Si hay fila en sector_permiso, manda esa configuración.
 *   - vistas vacías ⇒ "todas las vistas de los módulos habilitados"
 *     (compatibilidad con filas previas a permisos finos).
 * - Si no hay fila, cae al default sugerido (no se persiste hasta que el admin guarde).
 */
export async function permisosForSector(sector?: string | null): Promise<PermisosSector> {
  if (!sector) return { mods: [], vistas: [], ocultos: [] };
  const row = await prisma.sector_permiso.findUnique({ where: { sector } });
  if (!row) {
    const mods = defaultModulosForSector(sector);
    return { mods, vistas: allViewsForMods(mods), ocultos: [] };
  }
  const mods = sanitizeMods(row.modulos as unknown);
  const storedVistas = sanitizeHrefs((row as any).vistas);
  const vistas = storedVistas.length ? storedVistas : allViewsForMods(mods);
  const ocultos = sanitizeOcultos((row as any).ocultos);
  return { mods, vistas, ocultos };
}

/**
 * Permisos efectivos de un usuario: ADMIN ve todo; el resto, por su sector
 * MÁS los extras que le dé su ficha (hoy: bulonesAccesoTotal, ver arriba).
 */
export async function permisosForUsuario(opts: {
  rol: string;
  sector?: string | null;
  bulonesAccesoTotal?: boolean | null;
}): Promise<PermisosSector> {
  if (opts.rol === "ADMIN") {
    return { mods: [...ALL_MODULE_KEYS], vistas: [...ALL_VIEW_HREFS], ocultos: [] };
  }
  const base = await permisosForSector(opts.sector);
  if (!opts.bulonesAccesoTotal) return base;
  // Sin filtrar por isViewHref a propósito: si el nav generado todavía no
  // registró la vista, un href de más en la cookie es inofensivo (el
  // middleware sólo pregunta si está en la lista), mientras que filtrarlo
  // dejaría al responsable de bulonería afuera sin ningún error visible.
  return {
    mods: base.mods.includes(BULONES_MOD) ? base.mods : [...base.mods, BULONES_MOD],
    vistas: [...new Set([...base.vistas, ...BULONES_VISTAS])],
    ocultos: base.ocultos,
  };
}

// --- Compat: helpers viejos que devuelven solo los módulos ---
export async function modulosForSector(sector?: string | null): Promise<ModuleKey[]> {
  return (await permisosForSector(sector)).mods;
}

export async function modulosForUsuario(opts: {
  rol: string;
  sector?: string | null;
}): Promise<ModuleKey[]> {
  return (await permisosForUsuario(opts)).mods;
}
