"use client";

/**
 * /sistema/clientes — buscar un cliente y ver su cuenta del ecommerce.
 *
 * Qué resuelve: cuando un cliente pide su usuario/contraseña del ecommerce, el
 * panel de la tienda no deja VER la contraseña (solo cambiarla) y encima no se
 * puede buscar la cuenta por número de cliente ni por CUIT. Acá, con un solo
 * dato (número, nombre o CUIT), se trae el cliente (Magnus) y su cuenta con
 * usuario y contraseña en claro. SOLO ADMIN (gate en middleware + el route).
 *
 * Ver indicadores-api/ecommerce.py.
 */

import { useCallback, useRef, useState } from "react";
import { Search, Eye, EyeOff, Copy, Check, Loader2, UserRound, ShoppingCart, AlertTriangle } from "lucide-react";
import { InicioButton } from "@/components/ui/InicioButton";
import { UsuarioActual } from "@/components/auth/UsuarioActual";

type Cliente = {
  codigo: number;
  razonSocial: string | null;
  nombreComercial: string | null;
  cuit: string | null;
  email: string | null;
  telefono: string | null;
  domicilio: string | null;
  provincia: string | null;
  vendedor: string | null;
  vendedorCod: number | null;
  activo: boolean;
};
type Cuenta = {
  usuario: string;
  password: string;
  emailCuenta: string | null;
  bloqueado: boolean;
  aprobado: boolean;
  ultimoLogin: string | null;
  alta: string | null;
  cambioPass: string | null;
  nroCliente: number | null;
  cuit: string | null;
};
type Fila = { cliente: Cliente | null; cuenta: Cuenta | null; sinCuenta: boolean };
type Resp = { resultados: Fila[]; total: number; ecommerceOk: boolean; aviso: string | null };

function Copiar({ texto, className = "" }: { texto: string; className?: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      type="button"
      title="Copiar"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(texto);
          setOk(true);
          setTimeout(() => setOk(false), 1200);
        } catch {}
      }}
      className={`inline-flex items-center justify-center rounded-md border border-zinc-700 p-1.5 text-zinc-300 hover:bg-zinc-800 hover:text-yellow-400 transition ${className}`}
    >
      {ok ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
    </button>
  );
}

function Dato({ label, valor, mono = false }: { label: string; valor: string | null; mono?: boolean }) {
  if (!valor) return null;
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</span>
      <span className={`text-sm text-zinc-100 ${mono ? "font-mono" : ""}`}>{valor}</span>
    </div>
  );
}

function CampoCredencial({ label, valor, secreto = false }: { label: string; valor: string; secreto?: boolean }) {
  const [ver, setVer] = useState(false);
  const mostrar = secreto && !ver ? "•".repeat(Math.max(valor.length, 6)) : valor;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</span>
      <div className="flex items-center gap-2">
        <span className="flex-1 rounded-md bg-[#111111] border border-zinc-800 px-3 py-2 font-mono text-base text-yellow-300 break-all select-all">
          {mostrar || "—"}
        </span>
        {secreto && (
          <button
            type="button"
            title={ver ? "Ocultar" : "Ver"}
            onClick={() => setVer((v) => !v)}
            className="inline-flex items-center justify-center rounded-md border border-zinc-700 p-1.5 text-zinc-300 hover:bg-zinc-800 hover:text-yellow-400 transition"
          >
            {ver ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        )}
        <Copiar texto={valor} />
      </div>
    </div>
  );
}

export default function ClientesPage() {
  const [q, setQ] = useState("");
  const [cargando, setCargando] = useState(false);
  const [data, setData] = useState<Resp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [buscado, setBuscado] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const buscar = useCallback(async () => {
    const texto = q.trim();
    if (!texto) return;
    setCargando(true);
    setError(null);
    setBuscado(texto);
    try {
      const res = await fetch(`/api/sistema/clientes/buscar?q=${encodeURIComponent(texto)}`, {
        cache: "no-store",
      });
      const j = await res.json();
      if (!res.ok) {
        setData(null);
        setError(j?.error ?? "No se pudo buscar");
      } else {
        setData(j as Resp);
      }
    } catch {
      setData(null);
      setError("No se pudo conectar");
    } finally {
      setCargando(false);
    }
  }, [q]);

  return (
    <div className="dark min-h-screen bg-[#111111] text-white">
      <div className="mx-auto max-w-4xl px-4 py-6">
        <div className="mb-5 flex items-center justify-between gap-3">
          <div>
            <h1 className="text-yellow-400 font-bold uppercase tracking-wide">Clientes · Ecommerce</h1>
            <p className="text-sm text-zinc-500">
              Buscá por número de cliente, nombre o CUIT. Trae los datos del cliente y su usuario y contraseña del ecommerce.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <UsuarioActual />
            <InicioButton />
          </div>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            buscar();
          }}
          className="flex items-center gap-2"
        >
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
            <input
              ref={inputRef}
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="N° de cliente, nombre o CUIT…"
              className="w-full rounded-md border border-zinc-700 bg-[#171717] py-2.5 pl-9 pr-3 text-base text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-yellow-500/60"
            />
          </div>
          <button
            type="submit"
            disabled={cargando || !q.trim()}
            className="inline-flex items-center gap-2 rounded-md bg-yellow-400 px-4 py-2.5 font-semibold text-black hover:bg-yellow-300 disabled:opacity-50"
          >
            {cargando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            Buscar
          </button>
        </form>

        {error && (
          <div className="mt-5 rounded-md border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
            {error}
          </div>
        )}

        {data && !error && (
          <div className="mt-5 space-y-4">
            {data.aviso && (
              <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-300">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>No se pudo leer la tienda de ecommerce, muestro solo los datos del cliente. ({data.aviso})</span>
              </div>
            )}

            {data.resultados.length === 0 ? (
              <div className="rounded-md border border-zinc-800 bg-[#171717] px-4 py-8 text-center text-zinc-400">
                Sin resultados para <span className="text-zinc-200">«{buscado}»</span>.
              </div>
            ) : (
              <>
                <div className="text-xs text-zinc-500">
                  {data.total} resultado{data.total === 1 ? "" : "s"}
                  {data.total > data.resultados.length ? ` (mostrando ${data.resultados.length})` : ""}
                </div>
                {data.resultados.map((fila, i) => (
                  <Fila key={`${fila.cuenta?.usuario ?? ""}-${fila.cliente?.codigo ?? i}`} fila={fila} />
                ))}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Fila({ fila }: { fila: Fila }) {
  const c = fila.cliente;
  const cu = fila.cuenta;
  const titulo = c?.razonSocial || c?.nombreComercial || (cu ? `Cuenta ${cu.usuario}` : "—");

  return (
    <div className="overflow-hidden rounded-lg border border-zinc-800 bg-[#171717]">
      <div className="flex items-center justify-between gap-3 border-b border-zinc-800/60 bg-[#1f1f1f] px-4 py-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <UserRound className="h-4 w-4 shrink-0 text-zinc-500" />
          <span className="truncate font-semibold text-zinc-100">{titulo}</span>
          {c && (
            <span className="shrink-0 rounded-md border border-zinc-700 bg-[#111111] px-2 py-0.5 font-mono text-xs text-zinc-400">
              #{c.codigo}
            </span>
          )}
          {c && !c.activo && (
            <span className="shrink-0 rounded-md border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-[11px] text-red-300">
              inactivo
            </span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 p-4 md:grid-cols-2">
        {/* Cliente (Magnus) */}
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-zinc-500">
            <UserRound className="h-3.5 w-3.5" /> Cliente
          </div>
          {c ? (
            <div className="grid grid-cols-2 gap-3">
              <Dato label="Nombre comercial" valor={c.nombreComercial} />
              <Dato label="CUIT" valor={c.cuit} mono />
              <Dato label="Provincia" valor={c.provincia} />
              <Dato label="Vendedor" valor={c.vendedor} />
              <Dato label="Teléfono" valor={c.telefono} />
              <Dato label="Email" valor={c.email} />
              <div className="col-span-2">
                <Dato label="Domicilio" valor={c.domicilio} />
              </div>
            </div>
          ) : (
            <p className="text-sm text-zinc-500">
              La cuenta apunta al cliente {cu?.nroCliente ?? "?"}, que no aparece en Magnus.
            </p>
          )}
        </div>

        {/* Cuenta ecommerce */}
        <div className="space-y-3 md:border-l md:border-zinc-800/60 md:pl-5">
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-zinc-500">
            <ShoppingCart className="h-3.5 w-3.5" /> Ecommerce
          </div>
          {cu ? (
            <div className="space-y-3">
              <CampoCredencial label="Usuario" valor={cu.usuario} />
              <CampoCredencial label="Contraseña" valor={cu.password} secreto />
              <div className="grid grid-cols-2 gap-3 pt-1">
                <Dato label="Email de la cuenta" valor={cu.emailCuenta} />
                <Dato label="Último ingreso" valor={cu.ultimoLogin} />
                <Dato label="Alta" valor={cu.alta} />
                <div className="flex items-end">
                  {cu.bloqueado ? (
                    <span className="rounded-md border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-[11px] text-red-300">
                      bloqueada
                    </span>
                  ) : cu.aprobado ? (
                    <span className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-300">
                      activa
                    </span>
                  ) : (
                    <span className="rounded-md border border-zinc-600/40 bg-zinc-500/10 px-2 py-0.5 text-[11px] text-zinc-400">
                      no aprobada
                    </span>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <p className="text-sm text-zinc-500">Este cliente no tiene cuenta de ecommerce.</p>
          )}
        </div>
      </div>
    </div>
  );
}
