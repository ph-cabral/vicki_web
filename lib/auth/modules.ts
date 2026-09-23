// Catálogo de módulos de la app + mapeo ruta -> módulo + defaults por sector.
// IMPORTANTE: este archivo NO debe importar nada de Node ("crypto", "fs", prisma, etc.)
// porque también lo usa el middleware, que corre en el runtime edge.

// Árbol de sub-vistas auto-detectado desde app/**/page.tsx (datos planos, sin Node).
import { GENERATED_CHILDREN, GENERATED_MODULES } from "./nav.generated";

// Antes era una unión fija de 11 literales. Pasa a string para permitir módulos
// nuevos detectados automáticamente (carpetas de app/ vía scripts/gen-nav.mjs).
export type ModuleKey = string;

// Nodo de navegación (recursivo): una vista puede tener sub-vistas.
export interface NavNode {
  label: string;
  href: string;
  children?: NavNode[];
}

export interface ModuleDef {
  key: ModuleKey;
  label: string;
  href: string;
  color: string; // clases tailwind para el botón del home
  hasIndex: boolean; // ¿tiene su propio app/<key>/page.tsx? (dashboard del módulo)
  children?: NavNode[]; // sub-vistas (árbol) para el menú animado del home
}

// Color/label manual SOLO para los módulos que querés personalizar.
// Cualquier carpeta nueva en app/ (detectada por gen-nav.mjs) que no esté acá
// se agrega sola con un color default — no hace falta tocar este archivo.
const RAW_MODULES: Omit<ModuleDef, "children" | "hasIndex">[] = [
  {
    key: "manguera",
    label: "Mangueras",
    href: "/manguera",
    color: "bg-orange-600 hover:bg-orange-500",
  },
  {
    key: "deposito",
    label: "Depósito",
    href: "/deposito",
    color: "bg-emerald-700 hover:bg-emerald-600",
  },
  {
    key: "picking",
    label: "Picking",
    href: "/picking",
    color: "bg-purple-700 hover:bg-purple-600",
  },
  {
    key: "compras",
    label: "Compras",
    href: "/compras",
    color: "bg-amber-700 hover:bg-amber-600",
  },
  {
    key: "ventas",
    label: "Ventas",
    href: "/ventas",
    color: "bg-red-700 hover:bg-red-600",
  },
  {
    key: "finanza",
    label: "Finanzas",
    href: "/finanza",
    color: "bg-teal-700 hover:bg-teal-600",
  },
  {
    key: "rrhh",
    label: "RRHH",
    href: "/rrhh",
    color: "bg-indigo-700 hover:bg-indigo-600",
  },
  {
    key: "sorteo",
    label: "Sorteo",
    href: "/sorteo",
    color: "bg-pink-700 hover:bg-pink-600",
  },
  {
    key: "vicki",
    label: "Vicki",
    href: "/vicki",
    color: "bg-slate-700 hover:bg-slate-600",
  },
  {
    key: "buscador",
    label: "Buscador",
    href: "/buscador",
    color: "bg-cyan-700 hover:bg-cyan-600",
  },
  {
    key: "sistema",
    label: "Sistema",
    href: "/sistema",
    color: "bg-rose-700 hover:bg-rose-600",
  },
];

// Paleta default para módulos nuevos que no tienen entrada manual en RAW_MODULES.
const DEFAULT_COLORS = [
  "bg-slate-700 hover:bg-slate-600",
  "bg-cyan-700 hover:bg-cyan-600",
  "bg-emerald-700 hover:bg-emerald-600",
  "bg-amber-700 hover:bg-amber-600",
  "bg-indigo-700 hover:bg-indigo-600",
  "bg-rose-700 hover:bg-rose-600",
];

// hasIndex real de cada módulo (¿tiene su propio app/<key>/page.tsx, o sea un
// dashboard?). Única fuente de verdad: lo calcula gen-nav.mjs escaneando app/
// en cada dev/build — acá sólo se lee, nunca se hardcodea a mano.
const HAS_INDEX: Record<string, boolean> = Object.fromEntries(
  GENERATED_MODULES.map((g) => [g.key, g.hasIndex]),
);

// RAW_MODULES (manual, con color/label a medida) + lo que gen-nav.mjs detectó en
// app/ y todavía no está en RAW_MODULES (color default, rotando la paleta).
const ALL_RAW: Omit<ModuleDef, "children">[] = [
  ...RAW_MODULES.map((m) => ({ ...m, hasIndex: HAS_INDEX[m.key] ?? true })),
  ...GENERATED_MODULES.filter(
    (g) => !RAW_MODULES.some((m) => m.key === g.key),
  ).map((g, i) => ({
    key: g.key,
    label: g.label,
    href: g.href,
    color: DEFAULT_COLORS[i % DEFAULT_COLORS.length],
    hasIndex: g.hasIndex,
  })),
];

export const MODULES: ModuleDef[] = ALL_RAW.map((m) => ({
  ...m,
  children: GENERATED_CHILDREN[m.key] ?? [],
}));

export const ALL_MODULE_KEYS: ModuleKey[] = MODULES.map((m) => m.key);

// ----- Vistas (sub-rutas) de cada módulo, para permisos finos -----
export interface ViewRef {
  mod: ModuleKey;
  label: string;
  href: string;
}

function flattenNodes(mod: ModuleKey, nodes: NavNode[] | undefined): ViewRef[] {
  if (!nodes) return [];
  return nodes.flatMap((n) => [
    { mod, label: n.label, href: n.href },
    ...flattenNodes(mod, n.children),
  ]);
}

export const VIEWS: ViewRef[] = MODULES.flatMap((m) =>
  flattenNodes(m.key, m.children),
);

export const ALL_VIEW_HREFS: string[] = VIEWS.map((v) => v.href);

export function viewsForModule(key: ModuleKey): ViewRef[] {
  return VIEWS.filter((v) => v.mod === key);
}

/** Vista (sub-ruta) más específica a la que pertenece un pathname, o null. */
export function viewForPath(pathname: string): ViewRef | null {
  let best: ViewRef | null = null;
  for (const v of VIEWS) {
    if (pathname === v.href || pathname.startsWith(v.href + "/")) {
      if (!best || v.href.length > best.href.length) best = v;
    }
  }
  return best;
}

export function isModuleKey(v: unknown): v is ModuleKey {
  return typeof v === "string" && (ALL_MODULE_KEYS as string[]).includes(v);
}

/**
 * Hrefs de vistas que cambiaron de URL → href nuevo. Se aplica al leer
 * permisos de sector, ocultos y la cookie de sesión, así que lo guardado con
 * el href viejo sigue valiendo sin re-loguear ni re-guardar nada.
 */
export const LEGACY_VIEW_HREFS: Record<string, string> = {
  "/ventas/bulones": "/ventas/lineas", // 2026-09-23
};

export function normalizarHref(h: string): string {
  return LEGACY_VIEW_HREFS[h] ?? h;
}

/** Normaliza una lista de hrefs (sin duplicar). Deja pasar undefined (cookies viejas). */
export function normalizarHrefs<T extends string[] | undefined>(l: T): T {
  if (!Array.isArray(l)) return l;
  return [...new Set(l.map(normalizarHref))] as T;
}

export function isViewHref(v: unknown): v is string {
  return typeof v === "string" && ALL_VIEW_HREFS.includes(v);
}

export function moduleLabel(key: ModuleKey): string {
  return MODULES.find((m) => m.key === key)?.label ?? key;
}

// Payload que viaja firmado en la cookie de sesión.
export interface SessionPayload {
  uid: number; // usuario.id
  dni: string;
  nombre: string;
  rol: "ADMIN" | "USUARIO";
  mods: ModuleKey[]; // módulos habilitados, resueltos al iniciar sesión
  vistas?: string[]; // hrefs de sub-vistas permitidas (cookies viejas no la traen)
  ocultos?: string[]; // keys de módulo / hrefs de vista ocultos del inicio (tienen acceso)
  iat: number; // epoch (segundos)
  exp: number; // epoch (segundos)
}

// Prefijo de ruta -> módulo. Cubre la página y su API (/api/<mod>).
// OJO: esto sigue siendo manual. Un módulo nuevo (auto-detectado arriba) que no
// tenga entrada acá queda sin protección de permisos en el middleware — agregar
// las 2 líneas correspondientes cuando se cree una carpeta nueva en app/.
const ROUTE_MODULE: { prefix: string; mod: ModuleKey }[] = [
  { prefix: "/manguera", mod: "manguera" },
  { prefix: "/api/manguera", mod: "manguera" },
  { prefix: "/api/reportes", mod: "manguera" }, // ranking de cortes
  { prefix: "/fabrica", mod: "manguera" },
  { prefix: "/api/fabrica", mod: "manguera" },
  { prefix: "/deposito", mod: "deposito" },
  { prefix: "/api/deposito", mod: "deposito" },
  { prefix: "/picking", mod: "picking" },
  { prefix: "/api/picking", mod: "picking" },
  { prefix: "/compras", mod: "compras" },
  { prefix: "/api/compras", mod: "compras" },
  { prefix: "/ventas", mod: "ventas" },
  { prefix: "/api/ventas", mod: "ventas" },
  { prefix: "/finanza", mod: "finanza" },
  { prefix: "/api/finanza", mod: "finanza" },
  { prefix: "/rrhh", mod: "rrhh" },
  { prefix: "/api/rrhh", mod: "rrhh" },
  { prefix: "/api/foto", mod: "rrhh" },
  { prefix: "/sorteo", mod: "sorteo" },
  { prefix: "/api/sorteo", mod: "sorteo" },
  { prefix: "/vicki", mod: "vicki" },
  { prefix: "/api/vicki", mod: "vicki" },
  { prefix: "/buscador", mod: "buscador" },
  { prefix: "/api/buscador", mod: "buscador" },
  { prefix: "/sistema", mod: "sistema" },
  { prefix: "/api/sistema", mod: "sistema" },
];

/** Módulo requerido por una ruta, o null si no exige un módulo en particular. */
export function moduleForPath(pathname: string): ModuleKey | null {
  for (const r of ROUTE_MODULE) {
    if (pathname === r.prefix || pathname.startsWith(r.prefix + "/"))
      return r.mod;
  }
  return null;
}

/** Rutas exclusivas de admin (rol ADMIN), además de cualquier /admin/*. */
export function isAdminPath(pathname: string): boolean {
  return (
    pathname === "/db" ||
    pathname.startsWith("/db/") ||
    pathname === "/admin" ||
    pathname.startsWith("/admin/") ||
    pathname.startsWith("/api/admin") ||
    pathname.startsWith("/api/db") ||
    pathname === "/sistema/clientes" ||
    pathname.startsWith("/sistema/clientes/") ||
    pathname.startsWith("/api/sistema/clientes")
  );
}

// Módulos sugeridos por sector. Se ofrecen como default editable la primera vez;
// el admin los ajusta en /admin/permisos. La clave se compara en minúsculas.
export const DEFAULT_SECTOR_MODULOS: Record<string, ModuleKey[]> = {
  deposito: ["deposito", "picking"],
  depósito: ["deposito", "picking"],
  logistica: ["deposito", "picking"],
  logística: ["deposito", "picking"],
  fabrica: ["manguera"],
  fábrica: ["manguera"],
  produccion: ["manguera"],
  producción: ["manguera"],
  rrhh: ["rrhh"],
  "recursos humanos": ["rrhh"],
  administracion: ["finanza", "rrhh", "buscador"],
  administración: ["finanza", "rrhh", "buscador"],
  sistemas: ["sistema"],
  soporte: ["sistema"],
  finanzas: ["finanza"],
  comercial: ["buscador"],
  ventas: ["buscador", "ventas"],
  gerencia: ALL_MODULE_KEYS,
  direccion: ALL_MODULE_KEYS,
  dirección: ALL_MODULE_KEYS,
};

export function defaultModulosForSector(sector?: string | null): ModuleKey[] {
  if (!sector) return [];
  return DEFAULT_SECTOR_MODULOS[sector.trim().toLowerCase()] ?? [];
}
