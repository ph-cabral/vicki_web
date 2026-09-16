// Genera lib/auth/nav.generated.ts escaneando app/ en busca de page.tsx.
// Corre en build (Node), NO en edge. modules.ts sólo importa el resultado (datos planos).
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APP = join(ROOT, "app");

// Rutas accesibles pero que NO se listan en el árbol (home/permisos).
// /deposito/wms: migrada a /deposito/deposito (sidebar wms/mesas) 2026-07-31,
// queda solo como redirect para links viejos — no se lista en el menú.
const IGNORE = new Set(["/deposito/faltantes/control", "/deposito/wms"]);

// Etiquetas lindas por segmento (acentos, siglas). Lo que no esté acá va Capitalizado.
const LABELS = {
  wms: "WMS",
  deposito: "Depósito",
  rrhh: "RRHH",
  evaluacion: "Evaluación",
  duplicadas: "Duplicadas",
  faltantes: "Faltantes",
  metricas: "Métricas",
  pedidos: "Pedidos",
  stock: "Stock",
  corte: "Corte",
  picker: "Picker",
  armar: "Armar",
  dashboard: "Dashboard",
  asistencia: "Asistencia",
  legajos: "Legajos",
  relojes: "Relojes",
  telefono: "Teléfono",
};
const label = (seg) =>
  LABELS[seg] ?? seg.charAt(0).toUpperCase() + seg.slice(1);

const hasPage = (dir) =>
  ["page.tsx", "page.jsx", "page.ts"].some((f) => {
    try {
      return statSync(join(dir, f)).isFile();
    } catch {
      return false;
    }
  });
const subdirs = (dir) => {
  let e = [];
  try {
    e = readdirSync(dir);
  } catch {
    return [];
  }
  return e
    .filter(
      (n) =>
        !(
          n.startsWith("[") ||
          n.startsWith("(") ||
          n.startsWith("_") ||
          ["api", "components", "nuevo", "editar"].includes(n)
        ),
    )
    .filter((n) => {
      try {
        return statSync(join(dir, n)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
};

// Módulos de primer nivel = carpetas de app/ con page.tsx (directo o en subárbol),
// salvo las técnicas que NUNCA son módulos del home. AJUSTAR esta lista si hace
// falta (ej: si existe app/login o app/admin y no aparecen todavía, agregalas).
const EXCLUDE_MODULES = new Set(["admin", "db", "login"]);
const MODULE_KEYS = subdirs(APP).filter((k) => !EXCLUDE_MODULES.has(k));

// Construye NavNode[] recursivo para las SUB-rutas de una carpeta.
function walk(dir, href) {
  const out = [];
  for (const seg of subdirs(dir)) {
    const childDir = join(dir, seg);
    const childHref = `${href}/${seg}`;
    if (!hasPage(childDir)) {
      out.push(...walk(childDir, childHref));
      continue;
    } // carpeta sin page: aplanar hijos
    if (IGNORE.has(childHref)) continue;
    const node = { label: label(seg), href: childHref };
    const kids = walk(childDir, childHref);
    if (kids.length) node.children = kids;
    out.push(node);
  }
  return out;
}

const GEN = {};
for (const key of MODULE_KEYS) GEN[key] = walk(join(APP, key), `/${key}`);

// Módulos detectados, listos para que modules.ts arme los botones del home
// (label/color se pueden overridear a mano en RAW_MODULES; si no, usa default).
// hasIndex = el módulo tiene su propio app/<key>/page.tsx (su "dashboard").
// Lo usa HomeMenu para decidir el colapso: si hasIndex es true, el botón
// central SIEMPRE entra al módulo (dashboard + vistas hijas como satélites),
// aunque tenga una sola vista hija — nunca se lo salta. Si es false (el
// módulo no tiene página propia, ej. "fabrica") sí conviene bajar un nivel,
// porque navegar a esa ruta rompería (404).
const GENERATED_MODULES = MODULE_KEYS.map((key) => ({
  key,
  label: label(key),
  href: `/${key}`,
  hasIndex: hasPage(join(APP, key)),
}));

const banner =
  "// AUTO-GENERADO por scripts/gen-nav.mjs — NO editar a mano.\n" +
  "// Se regenera en cada dev/build. Escanea app/**/page.tsx.\n";
const body =
  `import type { NavNode } from "./modules";\n\n` +
  `export const GENERATED_CHILDREN: Record<string, NavNode[]> = ${JSON.stringify(GEN, null, 2)};\n\n` +
  `export const GENERATED_MODULES: { key: string; label: string; href: string; hasIndex: boolean }[] = ${JSON.stringify(GENERATED_MODULES, null, 2)};\n`;
writeFileSync(join(ROOT, "lib/auth/nav.generated.ts"), banner + body);
console.log("nav.generated.ts OK");
