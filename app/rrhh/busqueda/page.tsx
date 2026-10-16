"use client";

// /rrhh/busqueda — búsquedas de personal.
//  - Se crean búsquedas (el título es el puesto a cubrir; área opcional).
//  - Se vinculan postulantes que ya ingresaron por el mail de selección
//    (rag_system.candidato) buscándolos por nombre / email / DNI / teléfono.
//  - Por postulante: fechas con tipo (entrevista, preocupacional, psicotécnico,
//    ingreso programado) y estado + motivo.
//  - Rechazado / Desistió / Malas referencias / Descartado => el chat de selección
//    (Vicki) deja de recomendar a esa persona, en cualquier búsqueda.
// API: app/api/rrhh/busquedas/**, app/api/rrhh/busqueda-postulantes/**.
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CalendarPlus, FileText, Loader2, Plus, RefreshCw, Search, Trash2, UserPlus, UserSearch, X,
} from "lucide-react";
import { InicioButton } from "@/components/ui/InicioButton";
import { UsuarioActual } from "@/components/auth/UsuarioActual";
import {
  ESTADOS_POSTULANTE, ESTADO_LABEL, ESTADOS_EXCLUYENTES, TIPOS_EVENTO, TIPO_EVENTO_LABEL,
  type EstadoPostulante, type TipoEvento,
} from "@/lib/rrhh/busqueda";

type Evento = { id: number; tipo: TipoEvento; fecha: string; nota: string | null };
type Postulante = {
  id: number; candidatoId: number; estado: EstadoPostulante; motivo: string | null;
  eventos: Evento[];
  candidato: { nombre: string; email: string | null; telefono: string | null; dni: string | null; documentoId: number | null };
};
type BusquedaRes = {
  id: number; titulo: string; descripcion: string | null; estado: "ABIERTA" | "CERRADA";
  abiertaEn: string; cerradaEn: string | null; puestoId: number | null;
  puesto: { id: number; nombre: string } | null;
  areaId: number | null; area: { id: number; nombre: string } | null;
  motivoId: number | null; motivo: { id: number; nombre: string } | null;
  conteo: Record<string, number>;
};
type BusquedaDet = BusquedaRes & { postulantes: Postulante[] };
type Puesto = { id: number; nombre: string; sector?: { area?: { id: number } | null } | null };
type Area = { id: number; nombre: string };
type Motivo = { id: number; nombre: string };
type CandRes = {
  id: number; nombre: string; email: string | null; telefono: string | null; dni: string | null;
  estadosExcluyentes: EstadoPostulante[];
};

const COLOR_ESTADO: Record<EstadoPostulante, string> = {
  EN_PROCESO: "border-sky-500/40 bg-sky-500/10 text-sky-300",
  RECHAZADO: "border-red-500/40 bg-red-500/10 text-red-300",
  DESISTIO: "border-zinc-500/40 bg-zinc-500/10 text-zinc-300",
  MALAS_REFERENCIAS: "border-orange-500/40 bg-orange-500/10 text-orange-300",
  DESCARTADO: "border-zinc-600/60 bg-zinc-700/20 text-zinc-400",
};

const inputCls = "w-full bg-zinc-950 border border-zinc-700 text-zinc-200 text-sm rounded-lg px-3 py-2 outline-none focus:border-yellow-400 transition-colors";
const fmtFecha = (iso: string) =>
  new Date(iso).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" });
const fmtDia = (iso: string) => new Date(iso).toLocaleDateString("es-AR");

async function api<T = unknown>(url: string, method: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(j?.error ?? `HTTP ${r.status}`);
  return j as T;
}

export default function BusquedaPage() {
  const [lista, setLista] = useState<BusquedaRes[]>([]);
  const [puestos, setPuestos] = useState<Puesto[]>([]);
  const [areas, setAreas] = useState<Area[]>([]);
  const [motivos, setMotivos] = useState<Motivo[]>([]);
  const [selId, setSelId] = useState<number | null>(null);
  const [det, setDet] = useState<BusquedaDet | null>(null);
  const [loading, setLoading] = useState(true);
  const [aviso, setAviso] = useState<string | null>(null);
  const [nueva, setNueva] = useState<{ titulo: string; areaId: string; motivoId: string; descripcion: string } | null>(null);
  const [verCerradas, setVerCerradas] = useState(false);

  const avisar = useCallback((m: string) => { setAviso(m); setTimeout(() => setAviso(null), 7000); }, []);

  const cargarLista = useCallback(async () => {
    setLoading(true);
    try {
      const j = await api<BusquedaRes[] | { tablaWarn?: string }>("/api/rrhh/busquedas", "GET");
      if (Array.isArray(j)) setLista(j);
      else { setLista([]); if (j.tablaWarn) avisar(`⚠️ ${j.tablaWarn}`); }
    } catch (e) { avisar(`❌ ${e instanceof Error ? e.message : e}`); }
    finally { setLoading(false); }
  }, [avisar]);

  const cargarDet = useCallback(async (id: number) => {
    try { setDet(await api<BusquedaDet>(`/api/rrhh/busquedas/${id}`, "GET")); }
    catch (e) { avisar(`❌ ${e instanceof Error ? e.message : e}`); }
  }, [avisar]);

  useEffect(() => { cargarLista(); }, [cargarLista]);
  useEffect(() => {
    api<Puesto[]>("/api/rrhh/puestos", "GET").then((p) => setPuestos(Array.isArray(p) ? p : [])).catch(() => {});
    api<Area[]>("/api/rrhh/areas", "GET").then((a) => setAreas(Array.isArray(a) ? a : [])).catch(() => {});
    api<Motivo[]>("/api/rrhh/busquedas/motivos", "GET").then((m) => setMotivos(Array.isArray(m) ? m : [])).catch(() => {});
  }, []);
  useEffect(() => { if (selId != null) cargarDet(selId); else setDet(null); }, [selId, cargarDet]);

  const refrescar = useCallback(async () => { await cargarLista(); if (selId != null) await cargarDet(selId); }, [cargarLista, cargarDet, selId]);

  async function crear() {
    if (!nueva?.titulo.trim()) return;
    try {
      const b = await api<{ id: number }>("/api/rrhh/busquedas", "POST", {
        titulo: nueva.titulo.trim(), descripcion: nueva.descripcion || null,
        // si el puesto escrito es uno del catálogo, se vincula solo
        puestoId: puestos.find((p) => p.nombre.toLowerCase() === nueva.titulo.trim().toLowerCase())?.id ?? null,
        areaId: nueva.areaId ? Number(nueva.areaId) : null,
        motivoId: nueva.motivoId ? Number(nueva.motivoId) : null,
      });
      setNueva(null);
      await cargarLista();
      setSelId(b.id);
    } catch (e) { avisar(`❌ ${e instanceof Error ? e.message : e}`); }
  }

  const visibles = useMemo(
    () => lista.filter((b) => verCerradas || b.estado === "ABIERTA"),
    [lista, verCerradas],
  );

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-200">
      <div className="border-b border-zinc-800 bg-zinc-900/60 px-4 py-3 flex items-center gap-3">
        <InicioButton />
        <UserSearch size={18} className="text-yellow-400" />
        <h1 className="text-sm font-semibold uppercase tracking-wider">Búsquedas de personal</h1>
        <button onClick={refrescar} className="ml-auto text-zinc-400 hover:text-yellow-400 p-2" title="Refrescar">
          {loading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
        </button>
        <UsuarioActual />
      </div>
      {aviso && <div className="mx-4 mt-3 rounded-lg border border-yellow-500/40 bg-yellow-500/10 px-4 py-2 text-sm text-yellow-200">{aviso}</div>}

      <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-4 p-4">
        {/* ── lista de búsquedas ── */}
        <aside className="rounded-xl border border-zinc-800 bg-zinc-900/40 self-start">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-zinc-800">
            <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Búsquedas</span>
            <button
              onClick={() => setNueva({ titulo: "", areaId: "", motivoId: "", descripcion: "" })}
              className="ml-auto inline-flex items-center gap-1 rounded-lg bg-yellow-400 px-3 py-1.5 text-xs font-semibold text-zinc-950 hover:bg-yellow-300"
            ><Plus size={13} /> Nueva</button>
          </div>
          <label className="flex items-center gap-2 px-4 py-2 text-xs text-zinc-500 border-b border-zinc-800/60">
            <input type="checkbox" className="accent-yellow-400" checked={verCerradas} onChange={(e) => setVerCerradas(e.target.checked)} />
            Mostrar cerradas
          </label>
          <div className="divide-y divide-zinc-800/60">
            {visibles.map((b) => {
              const total = Object.values(b.conteo).reduce((a, n) => a + n, 0);
              return (
                <button
                  key={b.id}
                  onClick={() => setSelId(b.id)}
                  className={`w-full text-left px-4 py-3 hover:bg-zinc-800/50 ${selId === b.id ? "bg-zinc-800/70" : ""}`}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-zinc-100 truncate">{b.titulo}</span>
                    {b.estado === "CERRADA" && <span className="text-[10px] uppercase text-zinc-500 border border-zinc-700 rounded px-1">Cerrada</span>}
                  </div>
                  <div className="mt-0.5 text-[11px] text-zinc-500">
                    {b.area?.nombre ? `${b.area.nombre} · ` : ""}{b.motivo?.nombre ? `${b.motivo.nombre} · ` : ""}desde {fmtDia(b.abiertaEn)} · {total} postulante{total === 1 ? "" : "s"}
                    {b.conteo.EN_PROCESO ? ` · ${b.conteo.EN_PROCESO} en proceso` : ""}
                  </div>
                </button>
              );
            })}
            {!loading && visibles.length === 0 && <div className="px-4 py-6 text-sm text-zinc-600">No hay búsquedas.</div>}
          </div>
        </aside>

        {/* ── detalle ── */}
        <main className="min-w-0">
          {!det ? (
            <div className="rounded-xl border border-dashed border-zinc-800 py-24 text-center text-sm text-zinc-600">
              Elegí una búsqueda o creá una nueva.
            </div>
          ) : (
            <Detalle
              key={det.id}
              det={det}
              areas={areas}
              motivos={motivos}
              onMotivoCreado={(m) => setMotivos((l) => [...l, m].sort((a, b) => a.nombre.localeCompare(b.nombre, "es")))}
              avisar={avisar}
              onCambio={refrescar}
              onBorrada={() => { setSelId(null); cargarLista(); }}
            />
          )}
        </main>
      </div>

      {nueva && (
        <Modal titulo="Nueva búsqueda" onClose={() => setNueva(null)}>
          <label className="block text-xs text-zinc-500 mb-1">Puesto *</label>
          <input className={inputCls} autoFocus list="busq-puestos" value={nueva.titulo} placeholder="Ej: Vendedor mostrador"
            onChange={(e) => {
              const v = e.target.value;
              const pu = puestos.find((p) => p.nombre.toLowerCase() === v.trim().toLowerCase());
              // si es un puesto del catálogo, completa el área de su sector
              setNueva({ ...nueva, titulo: v, areaId: pu?.sector?.area?.id ? String(pu.sector.area.id) : nueva.areaId });
            }} />
          <datalist id="busq-puestos">
            {puestos.map((p) => <option key={p.id} value={p.nombre} />)}
          </datalist>
          <label className="block text-xs text-zinc-500 mb-1 mt-3">Área (opcional)</label>
          <select className={inputCls} value={nueva.areaId} onChange={(e) => setNueva({ ...nueva, areaId: e.target.value })}>
            <option value="">Sin área</option>
            {areas.map((a) => <option key={a.id} value={a.id}>{a.nombre}</option>)}
          </select>
          <label className="block text-xs text-zinc-500 mb-1 mt-3">Motivo (opcional)</label>
          <MotivoSelect
            value={nueva.motivoId ? Number(nueva.motivoId) : null}
            motivos={motivos}
            onChange={(id) => setNueva({ ...nueva, motivoId: id ? String(id) : "" })}
            onCreado={(m) => setMotivos((l) => [...l, m].sort((a, b) => a.nombre.localeCompare(b.nombre, "es")))}
            avisar={avisar}
            className={inputCls}
          />
          <label className="block text-xs text-zinc-500 mb-1 mt-3">Notas</label>
          <textarea className={`${inputCls} min-h-[70px]`} value={nueva.descripcion} onChange={(e) => setNueva({ ...nueva, descripcion: e.target.value })} />
          <div className="mt-5 flex justify-end gap-2">
            <button onClick={() => setNueva(null)} className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800">Cancelar</button>
            <button onClick={crear} disabled={!nueva.titulo.trim()} className="rounded-lg bg-yellow-400 px-4 py-2 text-sm font-semibold text-zinc-950 hover:bg-yellow-300 disabled:opacity-50">Crear</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// Select de motivo con "+" para agregar uno nuevo al catálogo (queda disponible para todos).
function MotivoSelect({ value, motivos, onChange, onCreado, avisar, className }: {
  value: number | null; motivos: Motivo[]; onChange: (id: number | null) => void;
  onCreado: (m: Motivo) => void; avisar: (m: string) => void; className: string;
}) {
  const [agregando, setAgregando] = useState(false);
  const [texto, setTexto] = useState("");
  const [guardando, setGuardando] = useState(false);

  async function agregar() {
    const nombre = texto.trim();
    if (!nombre || guardando) return;
    setGuardando(true);
    try {
      const m = await api<Motivo>("/api/rrhh/busquedas/motivos", "POST", { nombre });
      if (!motivos.some((x) => x.id === m.id)) onCreado(m);
      onChange(m.id);
      setTexto(""); setAgregando(false);
    } catch (e) { avisar(`❌ ${e instanceof Error ? e.message : e}`); }
    finally { setGuardando(false); }
  }

  if (agregando) {
    return (
      <div className="flex items-center gap-1">
        <input
          className={className} autoFocus value={texto} maxLength={80} placeholder="Nuevo motivo"
          onChange={(e) => setTexto(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); agregar(); }
            if (e.key === "Escape") { setAgregando(false); setTexto(""); }
          }}
        />
        <button type="button" onClick={agregar} disabled={!texto.trim() || guardando}
          className="rounded-lg bg-yellow-400 px-2.5 py-2 text-xs font-semibold text-zinc-950 hover:bg-yellow-300 disabled:opacity-50">
          {guardando ? <Loader2 size={14} className="animate-spin" /> : "OK"}
        </button>
        <button type="button" onClick={() => { setAgregando(false); setTexto(""); }}
          className="p-2 text-zinc-500 hover:text-zinc-200" title="Cancelar"><X size={14} /></button>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1">
      <select className={className} value={value ?? ""} title="Motivo de la búsqueda"
        onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
        <option value="">Sin motivo</option>
        {motivos.map((m) => <option key={m.id} value={m.id}>{m.nombre}</option>)}
      </select>
      <button type="button" onClick={() => setAgregando(true)} title="Agregar motivo"
        className="rounded-lg border border-zinc-700 p-2 text-zinc-300 hover:bg-zinc-800 hover:text-yellow-400"><Plus size={14} /></button>
    </div>
  );
}

// ───────────────────────────── detalle de una búsqueda ─────────────────────────────
function Detalle({ det, areas, motivos, onMotivoCreado, avisar, onCambio, onBorrada }: {
  det: BusquedaDet; areas: Area[]; motivos: Motivo[]; onMotivoCreado: (m: Motivo) => void; avisar: (m: string) => void;
  onCambio: () => Promise<void>; onBorrada: () => void;
}) {
  const [q, setQ] = useState("");
  const [res, setRes] = useState<CandRes[] | null>(null);
  const [buscando, setBuscando] = useState(false);

  // búsqueda de postulantes con debounce
  useEffect(() => {
    const t = q.trim();
    if (t.length < 2) { setRes(null); return; }
    setBuscando(true);
    const h = setTimeout(async () => {
      try { setRes(await api<CandRes[]>(`/api/rrhh/busquedas/candidatos?q=${encodeURIComponent(t)}`, "GET")); }
      catch (e) { avisar(`❌ ${e instanceof Error ? e.message : e}`); }
      finally { setBuscando(false); }
    }, 300);
    return () => clearTimeout(h);
  }, [q, avisar]);

  const vinculados = useMemo(() => new Set(det.postulantes.map((p) => p.candidatoId)), [det.postulantes]);

  async function vincular(c: CandRes) {
    try {
      await api(`/api/rrhh/busquedas/${det.id}/postulantes`, "POST", { candidatoId: c.id });
      setQ(""); setRes(null);
      await onCambio();
    } catch (e) { avisar(`❌ ${e instanceof Error ? e.message : e}`); }
  }
  async function cambiarBusqueda(data: Record<string, unknown>) {
    try { await api(`/api/rrhh/busquedas/${det.id}`, "PATCH", data); await onCambio(); }
    catch (e) { avisar(`❌ ${e instanceof Error ? e.message : e}`); }
  }
  async function borrar() {
    if (!confirm(`¿Borrar la búsqueda "${det.titulo}" con sus postulantes y fechas? Los CVs no se tocan.`)) return;
    try { await api(`/api/rrhh/busquedas/${det.id}`, "DELETE"); onBorrada(); }
    catch (e) { avisar(`❌ ${e instanceof Error ? e.message : e}`); }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-lg text-zinc-100 font-semibold">{det.titulo}</h2>
          <span className={`text-[10px] uppercase rounded border px-1.5 py-0.5 ${det.estado === "ABIERTA" ? "border-emerald-500/40 text-emerald-300" : "border-zinc-600 text-zinc-400"}`}>
            {det.estado === "ABIERTA" ? "Abierta" : `Cerrada ${det.cerradaEn ? fmtDia(det.cerradaEn) : ""}`}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <select
              className="bg-zinc-950 border border-zinc-700 text-zinc-300 text-xs rounded-lg px-2 py-1.5"
              value={det.areaId ?? ""}
              onChange={(e) => cambiarBusqueda({ areaId: e.target.value ? Number(e.target.value) : null })}
              title="Área"
            >
              <option value="">Sin área</option>
              {areas.map((a) => <option key={a.id} value={a.id}>{a.nombre}</option>)}
            </select>
            <MotivoSelect
              value={det.motivoId}
              motivos={motivos}
              onChange={(id) => cambiarBusqueda({ motivoId: id })}
              onCreado={onMotivoCreado}
              avisar={avisar}
              className="bg-zinc-950 border border-zinc-700 text-zinc-300 text-xs rounded-lg px-2 py-1.5"
            />
            <button
              onClick={() => cambiarBusqueda({ estado: det.estado === "ABIERTA" ? "CERRADA" : "ABIERTA" })}
              className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
            >{det.estado === "ABIERTA" ? "Cerrar búsqueda" : "Reabrir"}</button>
            <button onClick={borrar} className="text-zinc-500 hover:text-red-400 p-1.5" title="Borrar búsqueda"><Trash2 size={15} /></button>
          </div>
        </div>
        <div className="mt-1 text-[12px] text-zinc-500">Abierta el {fmtDia(det.abiertaEn)}{det.descripcion ? ` · ${det.descripcion}` : ""}</div>

        {/* vincular postulante */}
        <div className="mt-4 relative">
          <div className="flex items-center gap-2">
            <Search size={14} className="text-zinc-500" />
            <input
              className={inputCls}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Vincular postulante: nombre, email, DNI o teléfono (ingresados por el mail de selección)"
            />
            {buscando && <Loader2 size={14} className="animate-spin text-zinc-500" />}
          </div>
          {res && (
            <div className="absolute z-20 mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 shadow-2xl max-h-80 overflow-y-auto divide-y divide-zinc-800">
              {res.length === 0 && <div className="px-3 py-3 text-sm text-zinc-500">Sin resultados.</div>}
              {res.map((c) => {
                const ya = vinculados.has(c.id);
                return (
                  <div key={c.id} className="flex items-center gap-3 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-zinc-100 truncate">{c.nombre}</div>
                      <div className="text-[11px] text-zinc-500 truncate">
                        {[c.email, c.telefono, c.dni && `DNI ${c.dni}`].filter(Boolean).join(" · ")}
                      </div>
                      {c.estadosExcluyentes.length > 0 && (
                        <div className="mt-0.5 text-[11px] text-orange-300">
                          ⚠ Figura como {c.estadosExcluyentes.map((e) => ESTADO_LABEL[e]).join(" / ")} en otra búsqueda
                        </div>
                      )}
                    </div>
                    <button
                      disabled={ya}
                      onClick={() => vincular(c)}
                      className="inline-flex items-center gap-1 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-40"
                    ><UserPlus size={13} /> {ya ? "Vinculado" : "Vincular"}</button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* postulantes */}
      <div className="space-y-3">
        {det.postulantes.map((p) => (
          <PostulanteCard key={p.id} p={p} avisar={avisar} onCambio={onCambio} />
        ))}
        {det.postulantes.length === 0 && (
          <div className="rounded-xl border border-dashed border-zinc-800 py-10 text-center text-sm text-zinc-600">
            Todavía no hay postulantes vinculados.
          </div>
        )}
      </div>
    </div>
  );
}

// ───────────────────────────── postulante ─────────────────────────────
function PostulanteCard({ p, avisar, onCambio }: {
  p: Postulante; avisar: (m: string) => void; onCambio: () => Promise<void>;
}) {
  const [estado, setEstado] = useState<EstadoPostulante>(p.estado);
  const [motivo, setMotivo] = useState(p.motivo ?? "");
  const [guardando, setGuardando] = useState(false);
  const [ev, setEv] = useState<{ tipo: TipoEvento | ""; fecha: string; nota: string } | null>(null);

  const sucio = estado !== p.estado || motivo.trim() !== (p.motivo ?? "");
  const excluye = ESTADOS_EXCLUYENTES.includes(estado);

  async function guardar() {
    setGuardando(true);
    try {
      await api(`/api/rrhh/busqueda-postulantes/${p.id}`, "PATCH", { estado, motivo: motivo.trim() || null });
      await onCambio();
    } catch (e) { avisar(`❌ ${e instanceof Error ? e.message : e}`); }
    finally { setGuardando(false); }
  }
  async function desvincular() {
    if (!confirm(`¿Quitar a ${p.candidato.nombre} de esta búsqueda? Se pierden sus fechas y estado acá.`)) return;
    try { await api(`/api/rrhh/busqueda-postulantes/${p.id}`, "DELETE"); await onCambio(); }
    catch (e) { avisar(`❌ ${e instanceof Error ? e.message : e}`); }
  }
  async function agregarFecha() {
    if (!ev?.tipo || !ev.fecha) { avisar("Elegí a qué corresponde la fecha y cuándo es."); return; }
    try {
      await api(`/api/rrhh/busqueda-postulantes/${p.id}/eventos`, "POST", {
        tipo: ev.tipo, fecha: new Date(ev.fecha).toISOString(), nota: ev.nota || null,
      });
      setEv(null);
      await onCambio();
    } catch (e) { avisar(`❌ ${e instanceof Error ? e.message : e}`); }
  }
  async function quitarFecha(id: number) {
    try { await api(`/api/rrhh/busqueda-postulantes/${p.id}/eventos/${id}`, "DELETE"); await onCambio(); }
    catch (e) { avisar(`❌ ${e instanceof Error ? e.message : e}`); }
  }

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-zinc-100">{p.candidato.nombre}</span>
            <span className={`text-[10px] uppercase rounded border px-1.5 py-0.5 ${COLOR_ESTADO[p.estado]}`}>{ESTADO_LABEL[p.estado]}</span>
          </div>
          <div className="text-[11px] text-zinc-500">
            {[p.candidato.email, p.candidato.telefono, p.candidato.dni && `DNI ${p.candidato.dni}`].filter(Boolean).join(" · ") || "Sin datos de contacto"}
          </div>
        </div>
        {p.candidato.documentoId != null && (
          <a href={`/api/vicki/cv/${p.candidato.documentoId}/file`} target="_blank" rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-yellow-400" title="Ver CV">
            <FileText size={14} /> CV
          </a>
        )}
        <button onClick={desvincular} className="text-zinc-500 hover:text-red-400 p-1" title="Quitar de la búsqueda"><X size={15} /></button>
      </div>

      {/* estado + motivo */}
      <div className="mt-3 grid grid-cols-1 md:grid-cols-[200px_1fr_auto] gap-2 items-start">
        <select className={inputCls} value={estado} onChange={(e) => setEstado(e.target.value as EstadoPostulante)}>
          {ESTADOS_POSTULANTE.map((e) => <option key={e} value={e}>{ESTADO_LABEL[e]}</option>)}
        </select>
        <input className={inputCls} value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Motivo (opcional)" />
        <button onClick={guardar} disabled={!sucio || guardando}
          className="rounded-lg bg-yellow-400 px-4 py-2 text-sm font-semibold text-zinc-950 hover:bg-yellow-300 disabled:opacity-40">
          {guardando ? <Loader2 size={14} className="animate-spin" /> : "Guardar"}
        </button>
      </div>
      {excluye && (
        <div className="mt-1.5 text-[11px] text-orange-300">
          Con este estado el chat de selección deja de recomendar a esta persona (en todas las búsquedas).
        </div>
      )}

      {/* fechas */}
      <div className="mt-3 border-t border-zinc-800/70 pt-3">
        <div className="flex items-center gap-2">
          <span className="text-[11px] uppercase tracking-wider text-zinc-500">Fechas</span>
          <button onClick={() => setEv({ tipo: "", fecha: "", nota: "" })}
            className="ml-auto inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-yellow-400">
            <CalendarPlus size={13} /> Agregar fecha
          </button>
        </div>
        {p.eventos.length === 0 && !ev && <div className="mt-1 text-xs text-zinc-600">Sin fechas registradas.</div>}
        <ul className="mt-1 space-y-1">
          {p.eventos.map((e) => (
            <li key={e.id} className="group flex items-center gap-2 text-sm">
              <span className="w-40 shrink-0 text-zinc-300">{TIPO_EVENTO_LABEL[e.tipo]}</span>
              <span className="text-zinc-400">{fmtFecha(e.fecha)}</span>
              {e.nota && <span className="text-zinc-500 truncate">· {e.nota}</span>}
              <button onClick={() => quitarFecha(e.id)} className="ml-auto opacity-0 group-hover:opacity-100 text-zinc-500 hover:text-red-400" title="Quitar"><Trash2 size={13} /></button>
            </li>
          ))}
        </ul>
        {ev && (
          <div className="mt-2 grid grid-cols-1 md:grid-cols-[180px_200px_1fr_auto] gap-2 items-start">
            <select className={inputCls} value={ev.tipo} onChange={(e) => setEv({ ...ev, tipo: e.target.value as TipoEvento })}>
              <option value="">¿A qué corresponde?</option>
              {TIPOS_EVENTO.map((t) => <option key={t} value={t}>{TIPO_EVENTO_LABEL[t]}</option>)}
            </select>
            <input type="datetime-local" className={inputCls} value={ev.fecha} onChange={(e) => setEv({ ...ev, fecha: e.target.value })} />
            <input className={inputCls} value={ev.nota} onChange={(e) => setEv({ ...ev, nota: e.target.value })} placeholder="Nota (opcional)" />
            <div className="flex gap-1">
              <button onClick={agregarFecha} className="rounded-lg bg-yellow-400 px-3 py-2 text-sm font-semibold text-zinc-950 hover:bg-yellow-300">Agregar</button>
              <button onClick={() => setEv(null)} className="rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800">×</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Modal({ titulo, onClose, children }: { titulo: string; onClose: () => void; children?: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 p-4 overflow-y-auto" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl border border-zinc-700 bg-zinc-900 p-5 mt-10 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-300">{titulo}</h2>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200"><X size={16} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}
