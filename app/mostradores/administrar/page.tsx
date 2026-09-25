"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, ChevronDown, ChevronRight, ClipboardList, Download, Loader2, RefreshCw, Send, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InicioButton } from "@/components/ui/InicioButton";
import { UsuarioActual } from "@/components/auth/UsuarioActual";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

// ──────────────────────────────────────────────────────────────────────────────
// Mostradores → Administrar — las líneas de Magnus (Stk_Nivel1, "Línea") separadas
// en dos solapas:
//   · "Por controlar": líneas con algún patrón sin control cerrado; al abrirlas
//     muestra SÓLO esos patrones.
//   · "Controlados": líneas con algún patrón controlado; al abrirlas muestra SÓLO
//     los patrones con ≥1 control cerrado (fila verde + hasta 3 fechas, click →
//     Excel del control).
// La columna "Fechas de control" (Excel descargable) se ve en las dos solapas.
// En las dos, "Mandar a control" deja el patrón pendiente para el PDA.
// Panel derecho "En control": avance general (patrones controlados / total) y,
// por cada patrón pendiente, quién lo está contando y el % de avance
// (artículos contados / artículos del patrón). Se refresca cada 5 s y al
// volver a la pestaña; si un patrón se finalizó en el PDA recarga las líneas.
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
interface EnControl {
  id: number;
  codigo: string;
  detalle: string;
  linea: string;
  mandadoAt: string | null;
  mandadoPor: string;
  tomadoPor: string; // usuario que lo tomó en el PDA ("" = nadie)
  total: number;
  contados: number;
  avance: number;
  usuarios: { nombre: string; contados: number }[];
  ultimoConteoAt: string | null;
}
type Vista = "pendientes" | "controlados";

const TZ = "America/Argentina/Buenos_Aires";
const fmtFecha = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("es-AR", { timeZone: TZ, day: "2-digit", month: "2-digit", year: "numeric" }) : "—";
const fmtFechaHora = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("es-AR", { timeZone: TZ, dateStyle: "short", timeStyle: "short" }) : "";
const fmtN = (n: number) => n.toLocaleString("es-AR");
const fmtPct = (n: number) => `${n.toLocaleString("es-AR", { maximumFractionDigits: 1 })}%`;
const pct = (a: number, b: number) => (b > 0 ? (a * 100) / b : 0);

// Hasta 3 controles por patrón, uno arriba de otro: el más nuevo arriba, el más viejo abajo.
const MAX_CONTROLES = 3;
const ultimosControles = (cs: Control[]) =>
  [...cs]
    .sort((a, b) => (b.fecha ? Date.parse(b.fecha) : 0) - (a.fecha ? Date.parse(a.fecha) : 0) || b.id - a.id)
    .slice(0, MAX_CONTROLES);

const REFRESCO_PANEL_MS = 5_000;

async function pedir<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: "no-store", ...init });
  const json = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok || !json) throw new Error(json?.error ?? `HTTP ${res.status}`);
  return json;
}

const thBase = "px-2.5 py-2 text-[10px] font-semibold uppercase tracking-wider whitespace-nowrap border-b border-zinc-800 text-zinc-500";

function Barra({ valor, clase = "bg-yellow-400" }: { valor: number; clase?: string }) {
  return (
    <div className="h-1.5 w-full rounded-full bg-zinc-800 overflow-hidden">
      <div className={`h-full rounded-full ${clase} transition-[width] duration-500`} style={{ width: `${Math.min(100, Math.max(0, valor))}%` }} />
    </div>
  );
}

export default function AdministrarPage() {
  const [lineas, setLineas] = useState<Linea[]>([]);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [vista, setVista] = useState<Vista>("pendientes");
  const [abiertas, setAbiertas] = useState<Set<number>>(new Set());
  const [estado, setEstado] = useState<Record<number, EstadoLinea>>({});
  const [enviando, setEnviando] = useState<string | null>(null);

  const [enControl, setEnControl] = useState<EnControl[] | null>(null);
  const [panelCargando, setPanelCargando] = useState(false);
  const [panelError, setPanelError] = useState<string | null>(null);
  const idsEnControl = useRef<Set<number> | null>(null);
  const abiertasRef = useRef(abiertas);
  abiertasRef.current = abiertas;

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

  const recargarTodo = useCallback(async () => {
    await cargarLineas();
    // Las líneas cerradas quedan con datos viejos: se descartan para que se
    // vuelvan a pedir al abrirlas.
    const abiertasAhora = abiertasRef.current;
    setEstado((s) => Object.fromEntries(Object.entries(s).filter(([k]) => abiertasAhora.has(Number(k)))));
    await Promise.all([...abiertasAhora].map((id) => cargarPatrones(id)));
  }, [cargarLineas, cargarPatrones]);

  const panelEnVuelo = useRef(false);
  const cargarPanel = useCallback(async () => {
    if (panelEnVuelo.current) return; // refresco de 5 s: no se apilan pedidos lentos
    panelEnVuelo.current = true;
    setPanelCargando(true);
    try {
      const j = await pedir<{ pendientes: EnControl[] }>("/api/mostradores/pendientes");
      setEnControl(j.pendientes);
      setPanelError(null);
      // Si algún patrón salió de control (se finalizó en el PDA) o entró desde
      // otra sesión cambian controlados / "En control": se recargan líneas y
      // patrones abiertos (sólo cuando cambia el conjunto, no en cada refresco).
      const nuevos = new Set(j.pendientes.map((p) => p.id));
      const antes = idsEnControl.current;
      idsEnControl.current = nuevos;
      if (antes && (antes.size !== nuevos.size || [...antes].some((id) => !nuevos.has(id)))) recargarTodo();
    } catch (e) {
      setPanelError(e instanceof Error ? e.message : "No se pudo cargar");
    } finally {
      panelEnVuelo.current = false;
      setPanelCargando(false);
    }
  }, [recargarTodo]);

  useEffect(() => {
    cargarLineas();
  }, [cargarLineas]);

  useEffect(() => {
    cargarPanel();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") cargarPanel();
    }, REFRESCO_PANEL_MS);
    const alVolver = () => {
      if (document.visibilityState === "visible") cargarPanel();
    };
    document.addEventListener("visibilitychange", alVolver);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", alVolver);
    };
  }, [cargarPanel]);

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
      cargarPanel();
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo mandar a control");
    } finally {
      setEnviando(null);
    }
  };

  // Totales y líneas de cada solapa.
  const tot = useMemo(() => {
    let patrones = 0;
    let controlados = 0;
    let lineasPend = 0;
    let lineasCtrl = 0;
    for (const l of lineas) {
      patrones += l.patrones;
      controlados += l.controlados;
      if (l.patrones - l.controlados > 0) lineasPend++;
      if (l.controlados > 0) lineasCtrl++;
    }
    return { patrones, controlados, porControlar: patrones - controlados, lineasPend, lineasCtrl };
  }, [lineas]);

  const lineasVista = useMemo(
    () => lineas.filter((l) => (vista === "pendientes" ? l.patrones - l.controlados > 0 : l.controlados > 0)),
    [lineas, vista],
  );

  const solapa = (v: Vista, titulo: string, patrones: number, nLineas: number) => {
    const activa = vista === v;
    return (
      <button
        type="button"
        onClick={() => setVista(v)}
        className={`flex-1 sm:flex-none rounded-md px-4 py-2 text-left transition-colors ${
          activa ? "bg-[#262626] text-yellow-400" : "text-zinc-500 hover:text-zinc-300"
        }`}
      >
        <div className="text-xs font-semibold uppercase tracking-wider">{titulo}</div>
        <div className="text-[11px] tabular-nums text-zinc-500 mt-0.5">
          {fmtN(patrones)} patrones · {fmtN(nLineas)} líneas
        </div>
      </button>
    );
  };

  const avanceGeneral = pct(tot.controlados, tot.patrones);

  return (
    <div className="dark min-h-screen bg-[#111111] text-white">
      <div className="w-full mx-auto px-4 sm:px-6 py-8">
        <InicioButton label="Inicio" iconSize={16} className="text-sm text-zinc-500 hover:text-yellow-400 transition-colors mb-4" />
        <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-yellow-400 font-bold text-xl uppercase tracking-wide">Mostradores · Administrar</h1>
            <p className="text-sm text-zinc-500 mt-1">Líneas y códigos patrón con el estado de su control.</p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="icon"
              onClick={() => {
                recargarTodo();
                cargarPanel();
              }}
              disabled={cargando}
              title="Recargar"
            >
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

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px] 2xl:grid-cols-[minmax(0,1fr)_400px] items-start">
          {/* ── Líneas / patrones ─────────────────────────────────────────── */}
          <div className="min-w-0">
            <div className="mb-3 inline-flex w-full sm:w-auto gap-1 rounded-lg bg-[#171717] border border-zinc-800 p-1">
              {solapa("pendientes", "Por controlar", tot.porControlar, tot.lineasPend)}
              {solapa("controlados", "Controlados", tot.controlados, tot.lineasCtrl)}
            </div>

            <section className="rounded-lg bg-[#171717] border border-zinc-800 overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow className="bg-[#1f1f1f] hover:bg-[#1f1f1f]">
                    <TableHead className={thBase}>Línea</TableHead>
                    <TableHead className={`${thBase} text-right`}>{vista === "pendientes" ? "Por controlar" : "Controlados"}</TableHead>
                    <TableHead className={`${thBase} text-right`}>Total patrones</TableHead>
                    <TableHead className={`${thBase} w-40 hidden sm:table-cell`}>Avance</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {cargando && !lineas.length && (
                    <TableRow>
                      <TableCell colSpan={4} className="py-10 text-center text-zinc-600">
                        <Loader2 className="h-4 w-4 animate-spin inline mr-2" />
                        Consultando…
                      </TableCell>
                    </TableRow>
                  )}
                  {!cargando && lineas.length > 0 && !lineasVista.length && (
                    <TableRow>
                      <TableCell colSpan={4} className="py-10 text-center text-zinc-600">
                        {vista === "pendientes" ? "No quedan patrones por controlar" : "Todavía no hay patrones controlados"}
                      </TableCell>
                    </TableRow>
                  )}
                  {lineasVista.map((l) => {
                    const abierta = abiertas.has(l.id);
                    const st = estado[l.id];
                    const cantidad = vista === "pendientes" ? l.patrones - l.controlados : l.controlados;
                    const av = pct(l.controlados, l.patrones);
                    const patronesVista = st?.patrones?.filter((p) => (vista === "pendientes" ? !p.controlado : p.controlado)) ?? null;
                    return (
                      <Fragment key={l.id}>
                        <TableRow className="cursor-pointer border-b border-zinc-800/60 hover:bg-[#1f1f1f]" onClick={() => alternar(l.id)}>
                          <TableCell className="px-2.5 text-zinc-100">
                            <span className="inline-flex items-center gap-1.5">
                              {abierta ? <ChevronDown className="h-4 w-4 text-yellow-400" /> : <ChevronRight className="h-4 w-4 text-zinc-500" />}
                              {l.nombre}
                            </span>
                          </TableCell>
                          <TableCell
                            className={`px-2.5 text-right tabular-nums font-medium ${vista === "pendientes" ? "text-amber-300" : "text-[#3fb950]"}`}
                          >
                            {fmtN(cantidad)}
                          </TableCell>
                          <TableCell className="px-2.5 text-right tabular-nums text-zinc-400">{fmtN(l.patrones)}</TableCell>
                          <TableCell className="px-2.5 hidden sm:table-cell">
                            <div className="flex items-center gap-2">
                              <Barra valor={av} clase="bg-[#3fb950]" />
                              <span className="w-11 shrink-0 text-right text-[11px] tabular-nums text-zinc-500">{fmtPct(Math.round(av))}</span>
                            </div>
                          </TableCell>
                        </TableRow>
                        {abierta && (
                          <TableRow className="hover:bg-transparent border-b border-zinc-800">
                            <TableCell colSpan={4} className="p-0 bg-[#131313]">
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
                              {patronesVista && !patronesVista.length && (
                                <div className="py-6 text-center text-zinc-600">
                                  {vista === "pendientes" ? "No quedan patrones por controlar en esta línea" : "Ningún patrón controlado en esta línea"}
                                </div>
                              )}
                              {patronesVista && patronesVista.length > 0 && (
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
                                    {patronesVista.map((p) => (
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
                                              {p.controlado ? "Volver a controlar" : "Mandar a control"}
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

          {/* ── Panel derecho: en control ──────────────────────────────────── */}
          <aside className="order-first lg:order-none lg:sticky lg:top-6 flex flex-col gap-4">
            <section className="rounded-lg bg-[#171717] border border-zinc-800 p-4">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Avance general</div>
              <div className="mt-2 flex items-baseline justify-between gap-2">
                <span className="text-2xl font-bold tabular-nums text-[#3fb950]">{fmtPct(Math.round(avanceGeneral * 10) / 10)}</span>
                <span className="text-xs tabular-nums text-zinc-400">
                  {fmtN(tot.controlados)} de {fmtN(tot.patrones)} patrones
                </span>
              </div>
              <div className="mt-2">
                <Barra valor={avanceGeneral} clase="bg-[#3fb950]" />
              </div>
              <div className="mt-2 text-[11px] tabular-nums text-zinc-500">
                Faltan {fmtN(tot.porControlar)} patrones por controlar
              </div>
            </section>

            <section className="rounded-lg bg-[#171717] border border-zinc-800 overflow-hidden">
              <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-zinc-800 bg-[#1f1f1f]">
                <div className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-yellow-400">
                  <ClipboardList className="h-4 w-4" />
                  En control
                  {enControl && <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] tabular-nums text-zinc-300">{enControl.length}</span>}
                </div>
                {panelCargando && !enControl && <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-500" />}
              </div>

              {panelError && (
                <div className="m-3 flex items-center gap-2 text-xs text-[#f85149]">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  {panelError}
                </div>
              )}
              {!enControl && !panelError && (
                <div className="py-8 text-center text-sm text-zinc-600">
                  <Loader2 className="h-4 w-4 animate-spin inline mr-2" />
                  Consultando…
                </div>
              )}
              {enControl && !enControl.length && (
                <div className="py-8 px-4 text-center text-sm text-zinc-600">No hay patrones en control</div>
              )}
              {enControl && enControl.length > 0 && (
                <ul className="divide-y divide-zinc-800 max-h-[calc(100vh-18rem)] overflow-y-auto">
                  {enControl.map((c) => {
                    const completo = c.total > 0 && c.contados >= c.total;
                    return (
                      <li key={c.id} className="px-4 py-3">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="text-sm text-zinc-100">
                              <span className="tabular-nums font-semibold">{c.codigo}</span>
                              {c.detalle && <span className="text-zinc-300"> · {c.detalle}</span>}
                            </div>
                            {c.linea && <div className="text-[11px] text-zinc-500 truncate">{c.linea}</div>}
                          </div>
                          <span className={`shrink-0 text-sm font-bold tabular-nums ${completo ? "text-[#3fb950]" : c.contados > 0 ? "text-yellow-400" : "text-zinc-500"}`}>
                            {fmtPct(c.avance)}
                          </span>
                        </div>
                        <div className="mt-2">
                          <Barra valor={c.avance} clase={completo ? "bg-[#3fb950]" : "bg-yellow-400"} />
                        </div>
                        <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px] tabular-nums text-zinc-500">
                          <span>
                            {fmtN(c.contados)} de {fmtN(c.total)} artículos
                          </span>
                          {completo && (
                            <span className="inline-flex items-center gap-1 text-[#3fb950]">
                              <CheckCircle2 className="h-3 w-3" />
                              Listo para finalizar
                            </span>
                          )}
                        </div>
                        {c.tomadoPor && (
                          <div className="mt-2 inline-flex items-center gap-1 rounded border border-yellow-400/40 bg-yellow-400/10 px-1.5 py-0.5 text-[11px] text-yellow-300">
                            Tomado por <b className="font-semibold">{c.tomadoPor}</b>
                          </div>
                        )}
                        <div className="mt-2 flex flex-col gap-0.5">
                          {c.usuarios.length === 0 ? (
                            <span className="inline-flex items-center gap-1.5 text-xs text-zinc-600">
                              <User className="h-3 w-3" />
                              Sin empezar
                            </span>
                          ) : (
                            c.usuarios.map((u) => (
                              <span key={u.nombre} className="inline-flex items-center gap-1.5 text-xs text-zinc-300">
                                <User className="h-3 w-3 text-zinc-500" />
                                <span className="truncate">{u.nombre}</span>
                                {c.usuarios.length > 1 && <span className="tabular-nums text-zinc-500">· {fmtN(u.contados)}</span>}
                              </span>
                            ))
                          )}
                        </div>
                        {c.ultimoConteoAt && (
                          <div className="mt-1 text-[10px] text-zinc-600">Último conteo {fmtFechaHora(c.ultimoConteoAt)}</div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </aside>
        </div>
      </div>
    </div>
  );
}
