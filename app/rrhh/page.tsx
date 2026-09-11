"use client";

import { useState, useRef, useCallback, useMemo, useDeferredValue } from "react";
import {
  Users, RefreshCw, CalendarX, DollarSign, SearchCheck,
  BookOpen, Target, Clock, Trash2, UploadCloud, Loader2, AlertTriangle, Plus, X,
} from "lucide-react";
import { InicioButton } from "@/components/ui/InicioButton";
import CollapsibleTable from "@/app/rrhh/components/CollapsibleTable";
import HeadcountTab from "@/app/rrhh/components/tabs/HeadcountTab";
import NominaTab from "@/app/rrhh/components/tabs/NominaTab";
import AusentismoTab from "@/app/rrhh/components/tabs/AusentismoTab";
import HsExtrasTab from "@/app/rrhh/components/tabs/HsExtrasTab";
import ReclutamientoTab from "@/app/rrhh/components/tabs/ReclutamientoTab";
import GuardarNominaModal from "@/app/rrhh/components/tabs/GuardarNominaModal";
import { useRrhhData } from "@/lib/rrhh/store";
import { parseXlsxFile, FILE_TYPE_LABELS, type ParsedFile, type DetectedFileType } from "@/lib/rrhh/parseXlsx";
import { UsuarioActual } from "@/components/auth/UsuarioActual";

// ── Tabs (sin "Carga de Datos": la carga es global por drag&drop) ─────────────
// Sin "Resumen": la pestaña se sacó (2026-09-11) — "Empleados" (headcount) ya
// no depende de subir un Excel, así que pasó a ser la pestaña de apertura.
const TABS = [
  { id: "headcount", label: "Empleados", icon: Users },
  { id: "nomina", label: "Nómina", icon: DollarSign },
  { id: "ausentismo", label: "Ausentismo", icon: CalendarX },
  { id: "hs_extras", label: "Hs. Extra", icon: Clock },
  { id: "rotacion", label: "Rotación", icon: RefreshCw },
  { id: "reclutamiento", label: "Reclutamiento", icon: SearchCheck },
  { id: "capacitacion", label: "Capacitación", icon: BookOpen },
  { id: "kpis", label: "KPIs Custom", icon: Target },
] as const;
type TabId = (typeof TABS)[number]["id"];

const TAB_TO_TYPE: Partial<Record<TabId, DetectedFileType>> = {
  ausentismo: "ausentismos", nomina: "sueldos", hs_extras: "hs_extras",
};
const TAB_TITLES: Record<DetectedFileType, string> = {
  empleados: "Empleados", ausentismos: "Ausentismo", sueldos: "Nómina / Sueldos", hs_extras: "Horas Extra", desconocido: "",
};

// ── Tabla genérica (memoizada + búsqueda diferida) ────────────────────────────
function DataTable({ file }: { file: ParsedFile }) {
  const [search, setSearch] = useState("");
  const q = useDeferredValue(search);
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return file.rows;
    return file.rows.filter((row) => file.columns.some((col) => String(row[col] ?? "").toLowerCase().includes(s)));
  }, [file, q]);
  const shown = useMemo(() => filtered.slice(0, 100), [filtered]);

  return (
    <div className="overflow-hidden">
      <div className="px-4 py-3 border-b border-zinc-800 flex items-center gap-3">
        <input
          type="text" placeholder="Buscar..." value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="bg-zinc-950 border border-zinc-700 text-zinc-200 text-sm rounded-lg px-3 py-1.5 outline-none focus:border-yellow-400 w-56 transition-colors"
        />
        <span className="text-xs text-zinc-600 ml-auto">{filtered.length} de {file.rows.length} filas</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-zinc-900/80">
              {file.columns.map((col, index) => (
                <th key={`${col}-${index}`} className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-zinc-500 whitespace-nowrap border-b border-zinc-800">{col}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, i) => (
              <tr key={i} className="border-b border-zinc-800/50 hover:bg-zinc-900/40 transition-colors">
                {file.columns.map((col) => (
                  <td key={col} className="px-4 py-2.5 text-zinc-300 whitespace-nowrap">
                    {row[col] !== null && row[col] !== undefined ? String(row[col]) : "—"}
                  </td>
                ))}
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={file.columns.length} className="px-4 py-8 text-center text-zinc-600 text-sm">Sin resultados</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {filtered.length > 100 && (
        <div className="px-4 py-2 text-xs text-zinc-600 border-t border-zinc-800">Mostrando primeras 100 filas de {filtered.length}</div>
      )}
    </div>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────
function EmptyState({ onUpload }: { onUpload: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 gap-4 text-center">
      <UploadCloud size={48} className="text-zinc-700" />
      <div>
        <p className="text-zinc-400 font-medium">No hay datos cargados</p>
        <p className="text-zinc-600 text-sm mt-1">
          Arrastrá el Excel a cualquier parte, o{" "}
          <button onClick={onUpload} className="text-yellow-400 hover:underline">hacé clic para seleccionar</button>.
        </p>
      </div>
    </div>
  );
}

export default function RrhhDashboardPage() {
  const { data, setFiles, removeFile, clearAll, hydrated } = useRrhhData();
  const [activeTab, setActiveTab] = useState<TabId>("headcount");
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSources, setShowSources] = useState(false);
  // Excel de sueldos recién soltado/seleccionado: dispara el modal "a qué mes
  // corresponde" apenas se detecta, sin esperar a que se entre a la pestaña
  // Nómina ni a que también esté cargado el archivo de empleados (2026-09-11).
  const [nominaModalFile, setNominaModalFile] = useState<ParsedFile | null>(null);
  const dragCount = useRef(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const loadedCount = Object.keys(data).length;
  const openUpload = useCallback(() => inputRef.current?.click(), []);

  const processFiles = useCallback(async (files: File[]) => {
    const xlsx = files.filter((f) => /\.(xlsx|xls)$/i.test(f.name));
    if (!xlsx.length) return;
    setUploading(true); setError(null);
    try {
      const results = await Promise.allSettled(xlsx.map((f) => parseXlsxFile(f)));
      const ok: ParsedFile[] = [];
      let ignored = 0;
      results.forEach((r) => {
        if (r.status === "fulfilled" && r.value.type !== "desconocido") ok.push(r.value);
        else ignored++;
      });
      if (ok.length) setFiles(ok);
      // Sueldos recién cargado -> preguntar a qué mes corresponde ya mismo,
      // sin esperar un click extra en la pestaña Nómina.
      const sueldos = ok.find((f) => f.type === "sueldos");
      if (sueldos) setNominaModalFile(sueldos);
      if (!ok.length) setError("No se reconoció ningún archivo (tipo desconocido o ilegible).");
      else if (ignored) setError(`${ok.length} cargado(s), ${ignored} ignorado(s).`);
    } catch {
      setError("Error al procesar el archivo.");
    } finally {
      setUploading(false);
    }
  }, [setFiles]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); dragCount.current = 0; setDragging(false);
    processFiles(Array.from(e.dataTransfer.files));
  }, [processFiles]);

  // Contenido memoizado: no se recomputa al arrastrar/subir/abrir popover.
  const renderTab = useCallback((tab: TabId) => {
    // Empleados / Ausentismo / Hs. Extra ya no dependen del Excel subido:
    // leen en vivo de Postgres y se renderizan siempre.
    if (tab === "headcount") return <HeadcountTab />;
    if (tab === "ausentismo") return <AusentismoTab />;
    if (tab === "hs_extras") return <HsExtrasTab />;
    if (tab === "reclutamiento") return <ReclutamientoTab />;
    const type = TAB_TO_TYPE[tab];
    if (type && data[type]) {
      const f = data[type]!;
      return (
        <div>
          <div className="mb-5">
            <h2 className="text-yellow-400 font-bold text-xl uppercase tracking-wide">{TAB_TITLES[type]}</h2>
            <p className="text-zinc-500 text-sm mt-1">{f.rows.length} registros · {f.fileName}</p>
          </div>
          <div className="space-y-6">
            {/* fileEmpleados es opcional: sin él no se puede armar "Neto promedio
                por área" (necesita el cruce por nombre con ese archivo), pero el
                guardado en base y el histórico "Costo de Nómina mes a mes" no
                dependen de subirlo — usan el área real del legajo en la BBDD. */}
            {type === "sueldos" && <NominaTab file={f} fileEmpleados={data.empleados} />}
            <CollapsibleTable file={f} renderTable={(file) => <DataTable file={file} />} />
          </div>
        </div>
      );
    }
    if (type) return <EmptyState onUpload={openUpload} />;
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-3 text-center">
        <Target size={40} className="text-zinc-700" />
        <p className="text-zinc-500 text-sm">Sección en desarrollo</p>
      </div>
    );
  }, [data, openUpload]);

  const content = useMemo(() => (hydrated ? renderTab(activeTab) : null), [hydrated, renderTab, activeTab]);

  return (
    <div
      className="min-h-screen bg-[#111111] text-white relative"
      onDragEnter={(e) => { e.preventDefault(); dragCount.current++; setDragging(true); }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={(e) => { e.preventDefault(); dragCount.current--; if (dragCount.current <= 0) setDragging(false); }}
      onDrop={onDrop}
    >
      <input ref={inputRef} type="file" multiple accept=".xlsx,.xls" className="hidden"
        onChange={(e) => { if (e.target.files) processFiles(Array.from(e.target.files)); e.target.value = ""; }} />

      {dragging && (
        <div className="fixed inset-0 z-[100] bg-black/70 backdrop-blur-sm flex items-center justify-center pointer-events-none">
          <div className="flex flex-col items-center gap-4 border-2 border-dashed border-yellow-400 rounded-2xl px-16 py-12">
            <UploadCloud size={56} className="text-yellow-400" />
            <p className="text-lg font-semibold text-zinc-100">Soltá los Excel para cargar</p>
            <p className="text-sm text-zinc-500">empleados · ausentismos · sueldos · hs_extras — se detecta el tipo</p>
          </div>
        </div>
      )}

      {(uploading || error) && (
        <div className="fixed bottom-6 right-6 z-[110]">
          {uploading && (
            <div className="flex items-center gap-3 bg-[#1A1A1A] border border-yellow-400/40 rounded-xl px-5 py-3 text-sm text-zinc-200">
              <Loader2 size={16} className="animate-spin text-yellow-400" /> Procesando Excel…
            </div>
          )}
          {!uploading && error && (
            <div className="flex items-center gap-3 bg-[#1A1A1A] border border-yellow-400/40 rounded-xl px-5 py-3 text-sm text-zinc-300">
              <AlertTriangle size={16} className="text-yellow-400" /> {error}
            </div>
          )}
        </div>
      )}

      {nominaModalFile && (
        <GuardarNominaModal
          file={nominaModalFile}
          onCerrar={() => setNominaModalFile(null)}
          onGuardado={() => setNominaModalFile(null)}
        />
      )}

      <header className="sticky top-0 z-50 bg-[#1A1A1A] border-b-[3px] border-yellow-400 flex items-center justify-between px-8 h-16">
        <div className="flex items-center gap-4">
          <InicioButton />
          <span className="font-bold text-yellow-400 text-2xl tracking-wide uppercase">
            EVER WEAR <span className="text-sm tracking-[3px] font-normal">S.A.</span>
          </span>
          <div className="w-px h-7 bg-yellow-400/30" />
          <span className="text-zinc-500 text-sm">Dashboard de Recursos Humanos — Directorio</span>
        </div>

        <div className="flex items-center gap-2">
          <button onClick={openUpload} className="flex items-center gap-1.5 text-xs text-zinc-300 bg-zinc-800 border border-zinc-700 hover:border-yellow-400/60 rounded-full px-3 py-1.5 transition-colors">
            <Plus size={14} className="text-yellow-400" /> Cargar Excel
          </button>

          {hydrated && loadedCount > 0 && (
            <div className="relative">
              <button onClick={() => setShowSources((v) => !v)}
                className="flex items-center gap-2 bg-zinc-800 border border-zinc-700 rounded-full px-4 py-1.5 text-xs text-yellow-400 font-semibold">
                <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse" />
                {loadedCount} fuente{loadedCount > 1 ? "s" : ""}
              </button>
              {showSources && (
                <div className="absolute right-0 mt-2 w-72 rounded-xl border border-zinc-700 bg-[#1A1A1A] shadow-xl p-3 z-[60]">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[11px] uppercase tracking-wider text-zinc-500 font-semibold">Fuentes cargadas</span>
                    <button onClick={() => { clearAll(); setShowSources(false); }} className="flex items-center gap-1 text-[11px] text-red-400 hover:text-red-300">
                      <Trash2 size={12} /> Limpiar todo
                    </button>
                  </div>
                  <div className="space-y-1.5">
                    {(Object.keys(data) as DetectedFileType[]).map((type) => {
                      const f = data[type]; if (!f) return null;
                      return (
                        <div key={type} className="flex items-center gap-2 text-xs bg-zinc-800/60 rounded-lg px-3 py-2">
                          <span className="text-yellow-400 font-medium">{FILE_TYPE_LABELS[type]}</span>
                          <span className="text-zinc-500 truncate">· {f.rows.length} filas</span>
                          <button onClick={() => removeFile(type)} className="ml-auto text-zinc-600 hover:text-red-400" title="Quitar"><X size={13} /></button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
          <UsuarioActual />
        </div>
      </header>

      <nav className="bg-[#242424] border-b border-zinc-800 px-8 flex gap-0 overflow-x-auto">
        {TABS.map(({ id, label, icon: Icon }) => {
          const type = TAB_TO_TYPE[id];
          const hasData = type && data[type];
          return (
            <button key={id} onClick={() => setActiveTab(id)}
              className={`flex items-center gap-2 px-5 py-4 text-sm font-medium border-b-[3px] whitespace-nowrap transition-all duration-100 ${
                activeTab === id ? "text-yellow-400 border-yellow-400" : "text-zinc-500 border-transparent hover:text-zinc-200"
              }`}>
              <Icon size={15} />{label}
              {hasData && <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 ml-0.5" />}
            </button>
          );
        })}
      </nav>

      <main className="max-w-[1400px] mx-auto px-8 py-8">{content}</main>
    </div>
  );
}
