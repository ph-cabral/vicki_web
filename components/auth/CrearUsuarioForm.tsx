"use client";

import { useState } from "react";
import { Search, UserPlus, CheckCircle2, AlertCircle } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";

type Lookup = {
  found: boolean;
  bootstrap?: boolean;
  legajoId?: number;
  nombre?: string;
  sector?: string | null;
  estado?: string;
  yaTieneUsuario?: boolean;
  modulos?: string[];
};

const MODULO_LABEL: Record<string, string> = {
  fabrica: "Fábrica",
  deposito: "Depósito",
  finanza: "Finanzas",
  rrhh: "RRHH",
  sistema: "Sistema",
  vicki: "Vicki",
};

export function CrearUsuarioForm({
  mode,
  onCreated,
}: {
  mode: "admin" | "bootstrap";
  onCreated?: (u: { dni: string; nombre: string; rol: string }) => void;
}) {
  const [dni, setDni] = useState("");
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const [buscando, setBuscando] = useState(false);
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [rolAdmin, setRolAdmin] = useState(false);
  const [creando, setCreando] = useState(false);

  const puedeCrear =
    !!lookup?.found &&
    !lookup.yaTieneUsuario &&
    password.length >= 6 &&
    password === password2;

  async function buscar() {
    const q = dni.trim();
    if (!q) return;
    setBuscando(true);
    setLookup(null);
    setPassword("");
    setPassword2("");
    try {
      const r = await fetch(`/api/auth/legajo?dni=${encodeURIComponent(q)}`);
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error ?? "Error al buscar");
      setLookup(data);
      if (!data.found) toast.error("No hay legajo con ese DNI");
      else if (data.yaTieneUsuario) toast.warning("Ese legajo ya tiene usuario");
    } catch (e: any) {
      toast.error(e?.message ?? "No se pudo buscar el legajo");
    } finally {
      setBuscando(false);
    }
  }

  async function crear() {
    if (!puedeCrear) return;
    setCreando(true);
    try {
      const r = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dni: dni.trim(),
          password,
          rol: mode === "bootstrap" || rolAdmin ? "ADMIN" : "USUARIO",
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error ?? "Error al crear");
      toast.success(`Usuario de ${data.usuario?.nombre ?? "la persona"} creado`);
      onCreated?.({
        dni: dni.trim(),
        nombre: data.usuario?.nombre ?? lookup?.nombre ?? "",
        rol: data.usuario?.rol ?? "USUARIO",
      });
      // reset para cargar otro
      setDni("");
      setLookup(null);
      setPassword("");
      setPassword2("");
      setRolAdmin(false);
    } catch (e: any) {
      toast.error(e?.message ?? "No se pudo crear el usuario");
    } finally {
      setCreando(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Paso 1: DNI */}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="dni">Nº de documento (DNI)</Label>
        <div className="flex gap-2">
          <Input
            id="dni"
            inputMode="numeric"
            placeholder="Ej: 30123456"
            value={dni}
            onChange={(e) => setDni(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && buscar()}
          />
          <Button type="button" variant="outline" onClick={buscar} disabled={buscando || !dni.trim()}>
            <Search /> {buscando ? "Buscando…" : "Buscar"}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Se valida contra un legajo existente de everwear y se completa el nombre.
        </p>
      </div>

      {/* Paso 2: resultado del legajo */}
      {lookup?.found && (
        <div className="rounded-lg border border-border p-3 flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="size-4 text-emerald-600" />
            <span className="font-medium">{lookup.nombre}</span>
            {lookup.estado && lookup.estado !== "ACTIVO" && (
              <span className="text-xs rounded bg-amber-100 text-amber-800 px-1.5 py-0.5">
                {lookup.estado}
              </span>
            )}
          </div>
          <div className="text-sm text-muted-foreground">
            Sector: <span className="text-foreground">{lookup.sector || "— (sin sector)"}</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {(lookup.modulos ?? []).length === 0 ? (
              <span className="text-xs text-muted-foreground">
                Sin módulos por ahora (ajustables en Permisos por sector).
              </span>
            ) : (
              (lookup.modulos ?? []).map((m) => (
                <span key={m} className="text-xs rounded-full bg-secondary px-2 py-0.5">
                  {MODULO_LABEL[m] ?? m}
                </span>
              ))
            )}
          </div>
          {lookup.yaTieneUsuario && (
            <div className="flex items-center gap-1.5 text-sm text-destructive">
              <AlertCircle className="size-4" /> Este legajo ya tiene un usuario.
            </div>
          )}
        </div>
      )}

      {lookup && !lookup.found && (
        <div className="flex items-center gap-1.5 text-sm text-destructive">
          <AlertCircle className="size-4" /> No se encontró un legajo con ese DNI.
        </div>
      )}

      {/* Paso 3: contraseña */}
      {lookup?.found && !lookup.yaTieneUsuario && (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="pass">Contraseña</Label>
              <Input
                id="pass"
                type="password"
                placeholder="mín. 6 caracteres"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="pass2">Repetir contraseña</Label>
              <Input
                id="pass2"
                type="password"
                value={password2}
                onChange={(e) => setPassword2(e.target.value)}
              />
            </div>
          </div>
          {password2.length > 0 && password !== password2 && (
            <p className="text-xs text-destructive">Las contraseñas no coinciden.</p>
          )}

          {mode === "admin" && (
            <Label className="cursor-pointer">
              <Checkbox checked={rolAdmin} onCheckedChange={(v) => setRolAdmin(Boolean(v))} />
              Dar permisos de administrador (acceso total + gestión de usuarios)
            </Label>
          )}
          {mode === "bootstrap" && (
            <p className="text-xs text-muted-foreground">
              Este primer usuario se crea como <strong>administrador</strong>.
            </p>
          )}

          <Button type="button" onClick={crear} disabled={!puedeCrear || creando}>
            <UserPlus /> {creando ? "Creando…" : "Crear usuario"}
          </Button>
        </div>
      )}
    </div>
  );
}
