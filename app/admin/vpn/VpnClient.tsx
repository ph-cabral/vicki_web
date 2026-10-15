"use client";

import { useEffect, useState } from "react";
import { Copy, Download, KeyRound, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";

type Dispositivo = {
  id: string;
  uid: number | null;
  dev: string;
  nombre: string;
  modelo: string;
  ip: string;
  ultimoHandshake: string | null;
  deshabilitado: boolean;
};

type UsuarioLite = { id: number; nombre: string; dni: string; activo: boolean };

function PreAlta({ onGenerado }: { onGenerado: () => void }) {
  const [usuarios, setUsuarios] = useState<UsuarioLite[]>([]);
  const [filtro, setFiltro] = useState("");
  const [uid, setUid] = useState<number | null>(null);
  const [generando, setGenerando] = useState(false);
  const [resultado, setResultado] = useState<{ nombre: string; codigo: string } | null>(null);

  useEffect(() => {
    fetch("/api/admin/usuarios", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setUsuarios((d.items ?? []).filter((u: UsuarioLite) => u.activo)))
      .catch(() => {});
  }, []);

  const f = filtro.trim().toLowerCase();
  const lista = usuarios.filter((u) => !f || u.nombre.toLowerCase().includes(f) || u.dni.includes(f)).slice(0, 8);

  async function generar() {
    if (!uid) return;
    setGenerando(true);
    try {
      const r = await fetch("/api/admin/vpn/pre-alta", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uid }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error ?? "Error");
      setResultado({ nombre: j.nombre, codigo: j.codigo });
      onGenerado();
    } catch (e: any) {
      toast.error(e?.message ?? "No se pudo generar el código");
    } finally {
      setGenerando(false);
    }
  }

  const mensaje = resultado
    ? `Hola ${resultado.nombre.split(" ")[0]}! Instalá la app Vicki (APK adjunto). Al abrirla tocá "Pegar código de acceso" ` +
      `y pegá este código:\n\n${resultado.codigo}\n\nDespués iniciá sesión con tu usuario de siempre.`
    : "";

  return (
    <div className="space-y-3 rounded-md border border-border p-3">
      <div className="flex items-center gap-2 font-medium">
        <KeyRound className="size-4" /> Alta remota (para quien no está en la oficina)
      </div>
      <p className="text-sm text-muted-foreground">
        Genera un código con el acceso VPN del usuario. Se lo mandás junto con el APK; lo pega en la app y listo.
        Volver a generar invalida el código anterior de esa persona.
      </p>
      <div className="flex flex-wrap items-start gap-2">
        <div className="relative">
          <input
            value={filtro}
            onChange={(e) => {
              setFiltro(e.target.value);
              setUid(null);
              setResultado(null);
            }}
            placeholder="Buscar usuario (nombre o DNI)"
            className="w-64 rounded-md border border-border bg-background px-3 py-1.5 text-sm"
          />
          {f && !uid && lista.length > 0 && (
            <div className="absolute z-10 mt-1 w-64 rounded-md border border-border bg-background shadow">
              {lista.map((u) => (
                <button
                  key={u.id}
                  onClick={() => {
                    setUid(u.id);
                    setFiltro(u.nombre);
                  }}
                  className="block w-full px-3 py-1.5 text-left text-sm hover:bg-muted"
                >
                  {u.nombre} <span className="text-muted-foreground">· {u.dni}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          onClick={generar}
          disabled={!uid || generando}
          className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
        >
          {generando ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />} Generar código
        </button>
      </div>
      {resultado && (
        <div className="space-y-2">
          <textarea
            readOnly
            value={mensaje}
            rows={7}
            className="w-full rounded-md border border-border bg-muted/30 p-2 font-mono text-xs"
          />
          <button
            onClick={() => {
              navigator.clipboard.writeText(mensaje).then(
                () => toast.success("Mensaje copiado"),
                () => toast.error("No se pudo copiar"),
              );
            }}
            className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
          >
            <Copy className="size-4" /> Copiar mensaje
          </button>
        </div>
      )}
    </div>
  );
}

export function VpnClient() {
  const [items, setItems] = useState<Dispositivo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [borrando, setBorrando] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/admin/vpn", { cache: "no-store" });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error ?? "Error");
      setItems(d.dispositivos);
    } catch (e: any) {
      setError(e?.message ?? "No se pudo consultar el Mikrotik");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function baja(d: Dispositivo) {
    if (!window.confirm(`¿Dar de baja la VPN de ${d.nombre} (${d.modelo})?`)) return;
    setBorrando(d.id);
    try {
      const r = await fetch(`/api/admin/vpn?id=${encodeURIComponent(d.id)}`, { method: "DELETE" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error ?? "Error");
      toast.success("Dispositivo dado de baja");
      setItems((prev) => prev.filter((x) => x.id !== d.id));
    } catch (e: any) {
      toast.error(e?.message ?? "No se pudo dar de baja");
    } finally {
      setBorrando(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <h1 className="text-lg font-semibold">App Vicki · VPN</h1>
        <a
          href="/apk/vicki.apk"
          download
          className="ml-auto inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
        >
          <Download className="size-4" /> APK
        </a>
        <button
          onClick={load}
          className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
        >
          <RefreshCw className="size-4" /> Actualizar
        </button>
      </div>
      <p className="text-sm text-muted-foreground">
        Cada celular se da de alta solo la primera vez que abre la app en el WiFi de la oficina. Desde afuera entra
        por WireGuard y solo llega a vicki. Dar de baja corta el acceso externo al instante.
      </p>

      <PreAlta onGenerado={load} />

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Consultando el Mikrotik…
        </div>
      ) : error ? (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm">{error}</div>
      ) : items.length === 0 ? (
        <div className="text-sm text-muted-foreground">Todavía no hay celulares dados de alta.</div>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left">
              <tr>
                <th className="px-3 py-2">Usuario</th>
                <th className="px-3 py-2">Celular</th>
                <th className="px-3 py-2">IP VPN</th>
                <th className="px-3 py-2">Último handshake</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {items.map((d) => (
                <tr key={d.id} className="border-t border-border">
                  <td className="px-3 py-2">{d.nombre}</td>
                  <td className="px-3 py-2 text-muted-foreground">{d.modelo}</td>
                  <td className="px-3 py-2 font-mono">{d.ip}</td>
                  <td className="px-3 py-2">{d.ultimoHandshake ? `hace ${d.ultimoHandshake}` : "nunca"}</td>
                  <td className="px-3 py-2 text-right">
                    <button
                      onClick={() => baja(d)}
                      disabled={borrando === d.id}
                      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-red-500 hover:bg-red-500/10 disabled:opacity-50"
                    >
                      {borrando === d.id ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                      Baja
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
