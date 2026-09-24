"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { AlertCircle, ChevronDown, ChevronRight, Download, Loader2, RefreshCw, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InicioButton } from "@/components/ui/InicioButton";
import { UsuarioActual } from "@/components/auth/UsuarioActual";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

// ──────────────────────────────────────────────────────────────────────────────
// Mostradores → Administrar — las líneas de Magnus (Stk_Nivel1, "Línea"). Al abrir
// una línea se traen sus códigos patrón con el detalle (Magnus) y, por patrón:
//   · botón "Mandar a control" → queda pendiente en Mostradores → Control;
//   · fila en verde si ya tiene al menos un control cerrado;
//   · hasta 3 fechas de controles cerrados, una arriba de otra (más nuevo arriba);
//     click en una descarga el Excel de ese control.
// Los patrones se piden por línea al desplegarla (una consulta chica, cacheada
// el detalle en el back) y quedan en memoria mientras la vista está abierta.
// ──────────────────────────────────────────────────────────────────────────────

interface Linea { id: number; nombre: string; patrones: number; controlados: number }
interface Control { id: number; fecha: string | null; tieneArchivo: boolean }
interface Patron {
  codigo: string;
  detalle: string;
  subLinea: string;
  pendiente: boolean;
  controlado: boolean;
  controles: Control[];
}
interface EstadoLinea { cargando: boolean; error: string | null; patrones: Patron[] | null }

const TZ = "America/Argentina/Buenos_Aires";
const fmtFecha = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("es-AR", { timeZone: TZ, day: "2-digit", month: "2-digit", year: "numeric" }) : "—";
const fmtFechaHora = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("es-AR", { timeZone: TZ, dateStyle: "short", timeStyle: "short" }) : "";

// Hasta 3 controles por patrón, uno arriba de otro: el más nuevo arriba, el más viejo abajo.
const MAX_CONTROLES = 3;
const ultimosControles = (cs: Control[]) =>
  [...cs]
    .sort((a, b) => (b.fecha ? Date.parse(b.fecha) : 0) - (a.fecha ? Date.parse(a.fecha) : 0) || b.id - a.id)
    .slice(0, MAX_CONTROLES);

async function pedir<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: "no-store", ...init });
  const json = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok || !json) throw new Error(json?.error ?? `HTTP ${res.status}`);
  return json;
}

const thBase = "px-2.5 py-2 text-[10px] font-semibold uppercase tracking-wider whitespace-nowrap border-b border-zinc-800 text-zinc-500";

export default function AdministrarPage() {
  const [lineas, setLineas] = useState<Linea[]>([]);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [abiertas, setAbiertas] = useState<Set<number>>(new Set());
  const [estado, setEstado] = useState<Record<number, EstadoLinea>>({});
  const [enviando, setEnviando] = useState<string | null>(null);

  const cargarLineas = useCallback(async () => {
    setCargando(true);
    setError(null);
    try {
      const j = await pedir<{ lineas: Linea[] }>("/api/mostradores/lineas");
      setLineas(j.lineas);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo cargar");
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => {
    cargarLineas();
  }, [cargarLineas]);

  const cargarPatrones = useCallback(async (id: number) => {
    setEstado((s) => ({ ...s, [id]: { cargando: true, error: null, patrones: s[id]?.patrones ?? null } }));
    try {
      const j = await pedir<{ patrones: Patron[] }>(`/api/mostradores/patrones?linea=${id}`);
      setEstado((s) => ({ ...s, [id]: { cargando: false, error: null, patrones: j.patrones } }));
    } catch (e) {
      setEstado((s) => ({
        ...s,
        [id]: { cargando: false, error: e instanceof Error ? e.message : "No se pudo cargar", patrones: s[id]?.patrones ?? null },
      }));
    }
  }, []);

  const alternar = (id: number) => {
    const abierta = abiertas.has(id);
    setAbiertas((prev) => {
      const n = new Set(prev);
      if (abierta) n.delete(id);
      else n.add(id);
      return n;
    });
    if (!abierta && !estado[id]?.patrones && !estado[id]?.cargando) cargarPatrones(id);
  };

  const recargarTodo = async () => {
    await cargarLineas();
    await Promise.all([...abiertas].map((id) => cargarPatrones(id)));
  };

  const mandar = async (lineaId: number, codigo: string) => {
    setEnviando(codigo);
    try {
      await pedir("/api/mostradores/mandar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ codigoPatron: codigo }),
      });
      setEstado((s) => {
        const e = s[lineaId];
        if (!e?.patrones) return s;
        return {
          ...s,
          [lineaId]: { ...e, patrones: e.patrones.map((p) => (p.codigo === codigo ? { ...p, pendiente: true } : p)) },
        };
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo mandar a control");
    } finally {
      setEnviando(null);
    }
  };

  return (
    <div className="dark min-h-screen bg-[#111111] text-white">
      <div className="container mx-auto px-6 py-8 max-w-6xl">
        <InicioButton label="Inicio" iconSize={16} className="text-sm text-zinc-500 hover:text-yellow-400 transition-colors mb-4" />
        <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-yellow-400 font-bold text-xl uppercase tracking-wide">Mostradores · Administrar</h1>
            <p className="text-sm text-zinc-500 mt-1">Líneas y códigos patrón con el estado de su control.</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="icon" onClick={recargarTodo} disabled={cargando} title="Recargar">
              <RefreshCw className={`h-4 w-4 ${cargando ? "animate-spin" : ""}`} />
            </Button>
            <UsuarioActual className="text-muted-foreground" />
          </div>
        </header>

        {error && (
          <div className="mb-4 flex items-center gap-2 text-sm text-[#f85149] bg-[#f85149]/10 border border-[#f85149]/30 rounded px-3 py-2">
            <AlertCircle className="h-4 w-4 shrink-0" />
            {error}
          </div>
        )}

        <section className="rounded-lg bg-[#171717] border border-zinc-800 overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="bg-[#1f1f1f] hover:bg-[#1f1f1f]">
                <TableHead className={thBase}>Línea</TableHead>
                <TableHead className={`${thBase} text-right`}>Patrones</TableHead>
                <TableHead className={`${thBase} text-right`}>Controlados</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {cargando && !lineas.length && (
                <TableRow>
                  <TableCell colSpan={3} className="py-10 text-center text-zinc-600">
                    <Loader2 className="h-4 w-4 animate-spin inline mr-2" />
                    Consultando…
                  </TableCell>
                </TableRow>
              )}
              {lineas.map((l) => {
                const abierta = abiertas.has(l.id);
                const st = estado[l.id];
                return (
                  <Fragment key={l.id}>
                    <TableRow
                      className="cursor-pointer border-b border-zinc-800/60 hover:bg-[#1f1f1f]"
                      onClick={() => alternar(l.id)}
                    >
                      <TableCell className="px-2.5 text-zinc-100">
                        <span className="inline-flex items-center gap-1.5">
                          {abierta ? <ChevronDown className="h-4 w-4 text-yellow-400" /> : <ChevronRight className="h-4 w-4 text-zinc-500" />}
                          {l.nombre}
                        </span>
                      </TableCell>
                      <TableCell className="px-2.5 text-right tabular-nums text-zinc-200">{l.patrones.toLocaleString("es-AR")}</TableCell>
                      <TableCell
                        className={`px-2.5 text-right tabular-nums ${l.patrones > 0 && l.controlados === l.patrones ? "text-[#3fb950] font-medium" : l.controlados > 0 ? "text-zinc-200" : "text-zinc-600"}`}
                      >
                        {l.controlados.toLocaleString("es-AR")}
                      </TableCell>
                    </TableRow>
                    {abierta && (
                      <TableRow className="hover:bg-transparent border-b border-zinc-800">
                        <TableCell colSpan={3} className="p-0 bg-[#131313]">
                          {st?.cargando && !st.patrones && (
                            <div className="py-6 text-center text-zinc-600">
                              <Loader2 className="h-4 w-4 animate-spin inline mr-2" />
                              Consultando…
                            </div>
                          )}
                          {st?.error && (
                            <div className="m-3 flex items-center gap-2 text-sm text-[#f85149]">
                              <AlertCircle className="h-4 w-4 shrink-0" />
                              {st.error}
                            </div>
                          )}
                          {st?.patrones && !st.patrones.length && (
                            <div className="py-6 text-center text-zinc-600">La línea no tiene códigos patrón</div>
                          )}
                          {st?.patrones && st.patrones.length > 0 && (
                            <Table>
                              <TableHeader>
                                <TableRow className="hover:bg-transparent">
                                  <TableHead className={`${thBase} pl-8`}>Código patrón</TableHead>
                                  <TableHead className={thBase}>Detalle</TableHead>
                                  <TableHead className={thBase}>Control</TableHead>
                                  <TableHead className={thBase}>Fechas de control</TableHead>
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {st.patrones.map((p) => (
                                  <TableRow
                                    key={p.codigo}
                                    className={`border-b border-zinc-800/60 align-top ${p.controlado ? "bg-emerald-900/30 hover:bg-emerald-900/40" : "hover:bg-[#1a1a1a]"}`}
                                  >
                                    <TableCell className="pl-8 px-2.5 tabular-nums text-zinc-100">{p.codigo}</TableCell>
                                    <TableCell className="px-2.5 text-zinc-300">{p.detalle || <span className="text-zinc-600">—</span>}</TableCell>
                                    <TableCell className="px-2.5">
                                      {p.pendiente ? (
                                        <span className="text-xs text-amber-400">En control</span>
                                      ) : (
                                        <button
                                          type="button"
                                          disabled={enviando === p.codigo}
                                          onClick={() => mandar(l.id, p.codigo)}
                                          className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:border-yellow-400 hover:text-yellow-400 transition-colors disabled:opacity-50"
                                        >
                                          {enviando === p.codigo ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
                                          Mandar a control
                                        </button>
                                      )}
                                    </TableCell>
                                    <TableCell className="px-2.5">
                                      {p.controles.length === 0 ? (
                                        <span className="text-zinc-600">—</span>
                                      ) : (
                                        <div className="flex flex-col items-start gap-0.5">
                                          {ultimosControles(p.controles).map((c) =>
                                            c.tieneArchivo ? (
                                              <a
                                                key={c.id}
                                                href={`/api/mostradores/controles/${c.id}/excel`}
                                                title={`Descargar el Excel del control (${fmtFechaHora(c.fecha)})`}
                                                className="inline-flex items-center gap-1 text-xs tabular-nums text-emerald-300 hover:text-yellow-400 hover:underline transition-colors"
                                              >
                                                <Download className="h-3 w-3" />
                                                {fmtFecha(c.fecha)}
                                              </a>
                                            ) : (
                                              <span key={c.id} className="text-xs tabular-nums text-zinc-400">
                                                {fmtFecha(c.fecha)}
                                              </span>
                                            ),
                                          )}
                                        </div>
                                      )}
                                    </TableCell>
                                  </TableRow>
                                ))}
                              </TableBody>
                            </Table>
                          )}
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        </section>
      </div>
    </div>
  );
}
