import Link from "next/link";
import { Users, UserPlus, ShieldCheck, Smartphone, Package } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

export const dynamic = "force-dynamic";

const tiles = [
  { href: "/admin/usuarios", icon: Users, title: "Usuarios", desc: "Ver, activar/desactivar y cambiar rol." },
  { href: "/admin/usuarios/nuevo", icon: UserPlus, title: "Nuevo usuario", desc: "Dar de alta vinculado a un legajo." },
  { href: "/admin/permisos", icon: ShieldCheck, title: "Permisos por sector", desc: "Qué módulos habilita cada sector." },
  { href: "/admin/articulos", icon: Package, title: "Artículos", desc: "Artículos sin línea: clasificar patrones nuevos." },
  { href: "/admin/vpn", icon: Smartphone, title: "App Vicki / VPN", desc: "Celulares con acceso desde afuera; bajas." },
];

export default function AdminHome() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
      {tiles.map((t) => (
        <Link key={t.href} href={t.href}>
          <Card className="h-full transition-shadow hover:ring-foreground/20">
            <CardHeader>
              <t.icon className="size-5 text-muted-foreground" />
              <CardTitle>{t.title}</CardTitle>
              <CardDescription>{t.desc}</CardDescription>
            </CardHeader>
          </Card>
        </Link>
      ))}
    </div>
  );
}
