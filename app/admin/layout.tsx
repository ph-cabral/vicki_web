import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft, Users, UserPlus, ShieldCheck, UserCog, User, Phone } from "lucide-react";
import { getSession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const s = await getSession();
  if (!s) redirect("/login?returnTo=/admin");
  if (s.rol !== "ADMIN") redirect("/");

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto max-w-4xl px-4 py-3 flex items-center gap-4 flex-wrap">
          <Link href="/" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="size-4" /> Inicio
          </Link>
          <span className="text-sm font-medium">Administración</span>
          <nav className="ml-auto flex items-center gap-1 text-sm">
            <Link href="/admin/usuarios" className="inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 hover:bg-muted">
              <Users className="size-4" /> Usuarios
            </Link>
            <Link href="/admin/usuarios/nuevo" className="inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 hover:bg-muted">
              <UserPlus className="size-4" /> Nuevo
            </Link>
            <Link href="/admin/permisos" className="inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 hover:bg-muted">
              <ShieldCheck className="size-4" /> Permisos
            </Link>
            <Link href="/admin/encargados" className="inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 hover:bg-muted">
              <UserCog className="size-4" /> Encargados
            </Link>
            <Link href="/admin/telefonia" className="inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 hover:bg-muted">
              <Phone className="size-4" /> Telefonía
            </Link>
          </nav>
          {/* Usuario logueado, arriba a la derecha (2026-08-25).
              Acá el layout ya es server component con la sesión resuelta, así
              que no hace falta el fetch de <UsuarioActual />. */}
          <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground whitespace-nowrap">
            <User className="size-4" /> {s.nombre}
          </span>
        </div>
      </header>
      <main className="mx-auto max-w-4xl p-4">{children}</main>
    </div>
  );
}
