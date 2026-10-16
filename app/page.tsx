import Link from "next/link";
import { redirect } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { getSession } from "@/lib/auth/session";
import { MODULES, type NavNode } from "@/lib/auth/modules";
import { LogoutButton } from "@/components/auth/LogoutButton";
import { HomeMenu, type MenuNode } from "@/components/home/HomeMenu";

export const dynamic = "force-dynamic";

export default async function Home() {
  const s = await getSession();
  if (!s) redirect("/login");

  const isAdmin = s.rol === "ADMIN";
  const vistas = s.vistas; // cookies viejas: undefined ⇒ se muestran todas
  const ocultos = new Set(s.ocultos ?? []);

  // Poda recursiva del árbol: deja sólo vistas permitidas y no ocultas.
  const filterNodes = (nodes: NavNode[] | undefined): MenuNode[] =>
    (nodes ?? [])
      .filter(
        (n) =>
          (isAdmin || !Array.isArray(vistas) || vistas.includes(n.href)) &&
          !ocultos.has(n.href),
      )
      .map((n) => ({ label: n.label, href: n.href, children: filterNodes(n.children) }));

  // Módulos visibles (habilitados y no ocultos) con su árbol podado.
  const tree: MenuNode[] = MODULES.filter(
    (m) => (isAdmin || s.mods.includes(m.key)) && !ocultos.has(m.key),
  ).map((m) => ({
    label: m.label,
    href: m.href,
    color: m.color,
    hasIndex: m.hasIndex,
    children: filterNodes(m.children),
  }));

  return (
    <div className="min-h-screen bg-gray-950 flex flex-col">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3">
        <span className="text-white/90 text-sm font-medium min-w-0 truncate">{s.nombre}</span>
        <span className="rounded-full bg-white/10 px-2 py-0.5 text-xs text-white/70">
          {s.rol === "ADMIN" ? "Administrador" : "Usuario"}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {s.rol === "ADMIN" && (
            <Link
              href="/admin"
              className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm text-white/80 hover:bg-white/10 hover:text-white transition-colors"
            >
              <ShieldCheck className="size-4" /> Administración
            </Link>
          )}
          <LogoutButton />
        </div>
      </header>

      <main className="flex-1 flex flex-col items-center justify-center gap-8 px-4 pb-16">
        <h1 className="text-white text-3xl font-bold tracking-tight text-center">
          EverWear · Sistema interno
        </h1>

        <HomeMenu modules={tree} />
      </main>
    </div>
  );
}
