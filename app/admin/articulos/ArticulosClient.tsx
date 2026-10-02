"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, RefreshCw, Search } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";

// ──────────────────────────────────────────────────────────────────────────────
// Configuración de artículos (2026-10-02) — SÓLO ADMIN.
//
// Un artículo creado en Magnus después de la última carga del DePara no está
// en catalogo.articulo (Postgres) y cae en "(Sin línea)" en todos los
// reportes. Acá se ven y se clasifican. La unidad de trabajo es el PATRÓN:
//   · patrón ya clasificado, artículo nuevo  -> "Sincronizar" (sin decidir).
//   · patrón nuevo                           -> elegir sub línea y "Asignar".
// El selector Solo sin línea / Todos y "Solo activos" se recuerdan en este
// navegador. Ver indicadores-api/articulos_config.py.
// ──────────────────────────────────────────────────────────────────────────────

type Situacion = "clasificado" | "conocido" | "nuevo" | "sin_patron";
type Modo = "sin_linea" | "todos";

interface Resumen {
  total: number;
  clasificados: number;
  sinLinea: number;
  conocidos: number;
  nuevos: number;
  sinPatron: number;
  patronesNuevos: number;
}
interface PatronNuevo {
  patron: string;
  detalle: string;
  articulos: number;
  enListaPrecios: number;
  ultimaAlta: string | null;
  ejemplos: { codigo: string; medida: string }[];
}
interface SubLinea {
  id: number;
  subLinea: string;
  lineaId: number;
  linea: string;
  pool: string;
}
interface Item {
  codigo: string;
  medida: string;
  patron: string;
  detallePatron: string;
  estado: number;
  enListaPrecios: boolean;
  alta: string | null;
  situacion: Situacion;
  linea: string | null;
  subLinea: string | null;
}
interface Pagina {
  total: number;
  offset: number;
  limite: number;
  items: Item[];
}

const LIMITE = 100;
const LS_MODO = "admin.articulos.modo";
const LS_ACTIVOS = "admin.articulos.activos";

async function api<T>(ruta: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/admin/articulos/${ruta}`, { cache: "no-store", ...init });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j?.error ?? `HTTP ${res.status}`);
  return j as T;
}

const fechaAr = (iso: string | null) => {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
};

const n = (v: number) => v.toLocaleString("es-AR");

function Situ({ it }: { it: Item }) {
  if (it.situacion === "clasificado")
    return (
      <span>
        {it.linea} <span className="text-muted-foreground">›</span> {it.subLinea}
      </span>
    );
  if (it.situacion === "conocido")
    return (
      <span className="text-amber-600 dark:text-amber-400">
        Falta sincronizar → {it.linea} › {it.subLinea}
      </span>
    );
  if (it.situacion === "nuevo")
    return <span className="text-red-600 dark:text-red-400">Sin línea (patrón nuevo)</span>;
  return <span className="text-muted-foreground">Sin patrón en Magnus</span>;
}

export function ArticulosClient() {
  const [modo, setModo] = useState<Modo>("sin_linea");
  const [activos, setActivos] = useState(true);
  const [prefsListas, setPrefsListas] = useState(false);
  const [q, setQ] = useState("");
  const [qDeb, setQDeb] = useState("");
  const [offset, setOffset] = useState(0);

  const [resumen, setResumen] = useState<Resumen | null>(null);
  const [patrones, setPatrones] = useState<PatronNuevo[]>([]);
  const [subLineas, setSubLineas] = useState<SubLinea[]>([]);
  const [pagina, setPagina] = useState<Pagina | null>(null);
  const [cargandoTop, setCargandoTop] = useState(true);
  const [cargandoLista, setCargandoLista] = useState(true);
  const [elegida, setElegida] = useState<Record<string, string>>({});
  const [ocupado, setOcupado] = useState<string | null>(null);
  const reqLista = useRef(0);

  // Preferencias de este navegador (sin ellas funciona igual: default = sólo sin línea + activos).
  useEffect(() => {
    try {
      const m = localStorage.getItem(LS_MODO);
      if (m === "sin_linea" || m === "todos") setModo(m);
      const a = localStorage.getItem(LS_ACTIVOS);
      if (a === "0" || a === "1") setActivos(a === "1");
    } catch {}
    setPrefsListas(true);
  }, []);

  const guardarPref = (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {}
  };

  useEffect(() => {
    const t = setTimeout(() => setQDeb(q.trim()), 350);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    setOffset(0);
  }, [modo, activos, qDeb]);

  const cargarTop = useCallback(async () => {
    setCargandoTop(true);
    try {
      const a = activos ? "true" : "false";
      const [r, p] = await Promise.all([
        api<Resumen>(`resumen?activos=${a}`),
        api<{ patrones: PatronNuevo[] }>(`patrones-nuevos?activos=${a}`),
      ]);
      setResumen(r);
      setPatrones(p.patrones);
    } catch (e: any) {
      toast.error(e?.message ?? "No se pudo cargar el resumen");
    } finally {
      setCargandoTop(false);
    }
  }, [activos]);

  const cargarLista = useCallback(async () => {
    const mi = ++reqLista.current;
    setCargandoLista(true);
    try {
      const qs = new URLSearchParams({
        modo,
        activos: activos ? "true" : "false",
        offset: String(offset),
        limite: String(LIMITE),
      });
      if (qDeb) qs.set("q", qDeb);
      const p = await api<Pagina>(`articulos?${qs.toString()}`);
      if (mi === reqLista.current) setPagina(p);
    } catch (e: any) {
      if (mi === reqLista.current) toast.error(e?.message ?? "No se pudo cargar los artículos");
    } finally {
      if (mi === reqLista.current) setCargandoLista(false);
    }
  }, [modo, activos, qDeb, offset]);

  useEffect(() => {
    api<{ subLineas: SubLinea[] }>("sub-lineas")
      .then((r) => setSubLineas(r.subLineas))
      .catch((e) => toast.error(e?.message ?? "No se pudieron cargar las sub líneas"));
  }, []);

  useEffect(() => {
    if (prefsListas) cargarTop();
  }, [prefsListas, cargarTop]);

  useEffect(() => {
    if (prefsListas) cargarLista();
  }, [prefsListas, cargarLista]);

  const recargar = () => {
    cargarTop();
    cargarLista();
  };

  const porLinea = useMemo(() => {
    const m = new Map<string, SubLinea[]>();
    for (const s of subLineas) {
      const k = `${s.linea} (${s.pool})`;
      const arr = m.get(k);
      if (arr) arr.push(s);
      else m.set(k, [s]);
    }
    return [...m.entries()];
  }, [subLineas]);

  async function asignar(p: PatronNuevo) {
    const sub = Number(elegida[p.patron]);
    if (!Number.isInteger(sub) || sub <= 0) {
      toast.error("Elegí una sub línea");
      return;
    }
    setOcupado(p.patron);
    try {
      const r = await api<{ articulos: number }>("asignar-patron", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ patron: p.patron, subLineaId: sub }),
      });
      toast.success(`Patrón ${p.patron}: ${n(r.articulos)} artículos clasificados`);
      setElegida((e) => {
        const c = { ...e };
        delete c[p.patron];
        return c;
      });
      recargar();
    } catch (e: any) {
      toast.error(e?.message ?? "No se pudo asignar");
    } finally {
      setOcupado(null);
    }
  }

  async function sincronizar() {
    setOcupado("sync");
    try {
      const r = await api<{ articulos: number; patrones: number }>("sincronizar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      toast.success(`${n(r.articulos)} artículos sincronizados (${n(r.patrones)} patrones)`);
      recargar();
    } catch (e: any) {
      toast.error(e?.message ?? "No se pudo sincronizar");
    } finally {
      setOcupado(null);
    }
  }

  const desde = pagina && pagina.total ? pagina.offset + 1 : 0;
  const hasta = pagina ? Math.min(pagina.offset + pagina.limite, pagina.total) : 0;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-medium">Configuración de artículos</h1>
        <p className="text-sm text-muted-foreground">
          Artículos de Magnus que todavía no están en el catálogo (Pool › Línea › Sub línea ›
          Patrón) y por eso salen como «Sin línea» en los reportes. Clasificar un patrón
          clasifica todos sus artículos.
        </p>
      </div>

      {/* Resumen */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          ["Sin línea", resumen?.sinLinea],
          ["Falta sincronizar", resumen?.conocidos],
          ["Patrones nuevos", resumen?.patronesNuevos],
          ["Sin patrón en Magnus", resumen?.sinPatron],
        ].map(([t, v]) => (
          <div key={t as string} className="rounded-lg px-3 py-2 ring-1 ring-foreground/10">
            <div className="text-xs text-muted-foreground">{t}</div>
            <div className="text-xl font-medium tabular-nums">
              {typeof v === "number" ? n(v) : "…"}
            </div>
          </div>
        ))}
      </div>

      {/* Sincronizar */}
      {!!resumen?.conocidos && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg px-3 py-2 ring-1 ring-foreground/10">
          <p className="flex-1 text-sm">
            <b>{n(resumen.conocidos)}</b> artículos nuevos tienen un patrón que ya está
            clasificado: se cargan en su misma sub línea, sin decidir nada.
          </p>
          <Button size="sm" onClick={sincronizar} disabled={ocupado !== null}>
            {ocupado === "sync" ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            Sincronizar
          </Button>
        </div>
      )}

      {/* Patrones nuevos */}
      {patrones.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium">
            Patrones nuevos ({n(patrones.length)}) — elegí la sub línea
          </h2>
          <div className="flex flex-col divide-y divide-border rounded-lg ring-1 ring-foreground/10">
            {patrones.map((p) => (
              <div key={p.patron} className="flex flex-col gap-2 px-3 py-2 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <div className="text-sm">
                    <span className="font-mono">{p.patron}</span> · {p.detalle || "(sin nombre)"}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {n(p.articulos)} art.
                    {p.enListaPrecios > 0 && ` · ${n(p.enListaPrecios)} en lista de precios`}
                    {p.ultimaAlta && ` · último alta ${fechaAr(p.ultimaAlta)}`}
                    {p.ejemplos.length > 0 &&
                      ` · ej: ${p.ejemplos.map((e) => e.medida || e.codigo).join(" / ")}`}
                  </div>
                </div>
                <select
                  value={elegida[p.patron] ?? ""}
                  onChange={(e) => setElegida((s) => ({ ...s, [p.patron]: e.target.value }))}
                  disabled={ocupado !== null}
                  className="h-8 w-full rounded-lg border border-border bg-background px-2 text-sm sm:w-64"
                >
                  <option value="">Sub línea…</option>
                  {porLinea.map(([grupo, subs]) => (
                    <optgroup key={grupo} label={grupo}>
                      {subs.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.subLinea}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                <Button
                  size="sm"
                  onClick={() => asignar(p)}
                  disabled={ocupado !== null || !elegida[p.patron]}
                >
                  {ocupado === p.patron && <Loader2 className="size-4 animate-spin" />}
                  Asignar
                </Button>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Listado */}
      <section className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <div className="inline-flex rounded-lg ring-1 ring-foreground/10 p-0.5">
            {(
              [
                ["sin_linea", "Solo sin línea"],
                ["todos", "Todos"],
              ] as [Modo, string][]
            ).map(([m, t]) => (
              <button
                key={m}
                type="button"
                onClick={() => {
                  setModo(m);
                  guardarPref(LS_MODO, m);
                }}
                className={`rounded-md px-3 py-1 text-sm ${
                  modo === m ? "bg-primary text-primary-foreground" : "hover:bg-muted"
                }`}
              >
                {t}
              </button>
            ))}
          </div>
          <label className="inline-flex items-center gap-2 text-sm">
            <Checkbox
              checked={activos}
              onCheckedChange={(v) => {
                setActivos(!!v);
                guardarPref(LS_ACTIVOS, v ? "1" : "0");
              }}
            />
            Solo activos
          </label>
          <div className="relative ml-auto w-full sm:w-64">
            <Search className="pointer-events-none absolute left-2 top-2 size-4 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Código, descripción, patrón, línea…"
              className="pl-8"
            />
          </div>
        </div>

        <div className="overflow-x-auto rounded-lg ring-1 ring-foreground/10">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Código</th>
                <th className="px-3 py-2 font-medium">Descripción</th>
                <th className="px-3 py-2 font-medium">Patrón</th>
                <th className="px-3 py-2 font-medium">Línea › Sub línea</th>
                <th className="px-3 py-2 font-medium">Alta</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {cargandoLista && !pagina ? (
                <tr>
                  <td colSpan={5} className="px-3 py-8 text-center text-muted-foreground">
                    <Loader2 className="mx-auto size-5 animate-spin" />
                  </td>
                </tr>
              ) : pagina && pagina.items.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-3 py-8 text-center text-muted-foreground">
                    {modo === "sin_linea" && !qDeb
                      ? "No hay artículos sin línea."
                      : "Sin resultados."}
                  </td>
                </tr>
              ) : (
                pagina?.items.map((it) => (
                  <tr key={it.codigo} className={cargandoLista ? "opacity-50" : ""}>
                    <td className="whitespace-nowrap px-3 py-1.5 font-mono text-xs">
                      {it.codigo}
                      {it.estado !== 1 && (
                        <span className="ml-1 text-muted-foreground">(inactivo)</span>
                      )}
                    </td>
                    <td className="px-3 py-1.5">{it.medida || "—"}</td>
                    <td className="px-3 py-1.5">
                      <span className="font-mono text-xs">{it.patron || "—"}</span>
                      {it.detallePatron && (
                        <span className="block text-xs text-muted-foreground">{it.detallePatron}</span>
                      )}
                    </td>
                    <td className="px-3 py-1.5">
                      <Situ it={it} />
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-xs text-muted-foreground">
                      {fechaAr(it.alta)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>
            {pagina ? `${n(desde)}–${n(hasta)} de ${n(pagina.total)}` : ""}
          </span>
          {(cargandoLista || cargandoTop) && <Loader2 className="size-4 animate-spin" />}
          <div className="ml-auto flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={!pagina || pagina.offset === 0 || cargandoLista}
              onClick={() => setOffset((o) => Math.max(0, o - LIMITE))}
            >
              Anterior
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!pagina || pagina.offset + pagina.limite >= pagina.total || cargandoLista}
              onClick={() => setOffset((o) => o + LIMITE)}
            >
              Siguiente
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}
