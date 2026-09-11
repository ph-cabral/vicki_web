"use client";

// Modal "Guardar en base de datos" de la pestaña Nómina (2026-09-11).
//
// Extrae el costo (Costos + Bono) del Excel ya cargado en pantalla y lo
// guarda en everwear.nomina_mes para el mes que elija el usuario en la
// grilla de 12 meses ("cuadrilla"). Si ese mes ya tiene datos guardados,
// pide una confirmación explícita antes de pisarlos — la API igual exige
// ADMIN aunque acá se esconda el botón.
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Loader2, Lock, X } from "lucide-react";
import type { ParsedFile } from "@/lib/rrhh/parseXlsx";
import { extraerNomina, esErrorExtraccion, NOMBRES_MES, mesId, labelMes } from "@/lib/rrhh/nomina";

const fmtARS = (n: number) =>
  new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 }).format(n);
const fmtFecha = (iso: string) =>
  new Date(iso).toLocaleString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

/** Busca "<mes> <año>" en el texto de liquidación (ej. "Comercio Agosto 2026") para sugerir el mes. */
function sugerirMes(filas: { liquidacion: string }[]): string | null {
  const texto = filas.find((f) => f.liquidacion)?.liquidacion ?? "";
  const anioMatch = texto.match(/\b(20\d{2})\b/);
  if (!anioMatch) return null;
  const anio = anioMatch[1];
  const idx = NOMBRES_MES.findIndex((n) => texto.toLowerCase().includes(n.toLowerCase()));
  if (idx === -1) return null;
  return mesId(Number(anio), idx);
}

type MesGuardado = { cantEmpleados: number; totalCosto: number; actualizado: string; archivoNombre: string | null };

export default function GuardarNominaModal({
  file,
  onCerrar,
  onGuardado,
}: {
  file: ParsedFile;
  onCerrar: () => void;
  onGuardado: () => void;
}) {
  const extraido = useMemo(() => extraerNomina(file), [file]);
  const errorExtraccion = esErrorExtraccion(extraido) ? extraido.error : null;
  const resumen = esErrorExtraccion(extraido) ? null : { cantEmpleados: extraido.cantEmpleados, totalCosto: extraido.totalCosto };

  const [puedeEditar, setPuedeEditar] = useState<boolean | null>(null);
  const [mesesGuardados, setMesesGuardados] = useState<Record<string, MesGuardado>>({});
  const [cargandoInicial, setCargandoInicial] = useState(true);

  useEffect(() => {
    let cancelado = false;
    fetch("/api/rrhh/nomina")
      .then((r) => r.json())
      .then((d) => {
        if (cancelado) return;
        setPuedeEditar(Boolean(d.puedeEditar));
        const m: Record<string, MesGuardado> = {};
        for (const f of d.meses ?? []) {
          m[f.mes] = { cantEmpleados: f.cantEmpleados, totalCosto: f.total, actualizado: f.actualizado, archivoNombre: f.archivoNombre };
        }
        setMesesGuardados(m);
      })
      .catch(() => { if (!cancelado) setPuedeEditar(false); })
      .finally(() => { if (!cancelado) setCargandoInicial(false); });
    return () => { cancelado = true; };
  }, []);

  const sugerencia = useMemo(
    () => (esErrorExtraccion(extraido) ? null : sugerirMes(extraido.filas)),
    [extraido],
  );
  const [anio, setAnio] = useState(() => Number(sugerencia?.split("-")[0]) || new Date().getFullYear());
  const [mesElegido, setMesElegido] = useState<string | null>(null);
  const [confirmando, setConfirmando] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  const ocupado = mesElegido ? mesesGuardados[mesElegido] : null;

  const elegirMes = (mes: string) => {
    setError(null);
    setMesElegido(mes);
    setConfirmando(Boolean(mesesGuardados[mes]));
  };

  const guardar = async (confirmar: boolean) => {
    if (esErrorExtraccion(extraido) || !mesElegido) return;
    setGuardando(true);
    setError(null);
    try {
      const res = await fetch("/api/rrhh/nomina", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mes: mesElegido,
          archivoNombre: file.fileName,
          filas: extraido.filas,
          confirmar,
        }),
      });
      const data = await res.json();
      if (res.status === 409 && data.requiereConfirmacion) {
        setConfirmando(true);
        setMesesGuardados((prev) => ({ ...prev, [mesElegido]: data.existente }));
        return;
      }
      if (!res.ok) {
        setError(data.error ?? "No se pudo guardar");
        return;
      }
      setOk(true);
      setTimeout(onGuardado, 900);
    } catch {
      setError("No se pudo guardar (error de red)");
    } finally {
      setGuardando(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[120] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-lg rounded-2xl border border-zinc-800 bg-[#1A1A1A] shadow-xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800">
          <h3 className="text-yellow-400 font-bold uppercase tracking-wide text-sm">Guardar nómina en la base</h3>
          <button onClick={onCerrar} className="text-zinc-600 hover:text-zinc-300"><X size={18} /></button>
        </div>

        <div className="px-5 py-5 space-y-5">
          {errorExtraccion ? (
            <div className="flex items-start gap-2 text-sm text-red-400">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" /> {errorExtraccion}
            </div>
          ) : resumen ? (
            <p className="text-sm text-zinc-400">
              <span className="text-zinc-200 font-semibold">{resumen.cantEmpleados}</span> empleados ·{" "}
              costo total <span className="text-yellow-400 font-semibold">{fmtARS(resumen.totalCosto)}</span>{" "}
              <span className="text-zinc-600">({file.fileName})</span>
            </p>
          ) : null}

          {cargandoInicial ? (
            <div className="flex items-center gap-2 text-zinc-500 text-sm py-6 justify-center">
              <Loader2 size={16} className="animate-spin" /> Cargando meses guardados…
            </div>
          ) : puedeEditar === false ? (
            <div className="flex items-center gap-2 text-sm text-zinc-400 bg-zinc-900/60 rounded-lg px-3 py-2.5">
              <Lock size={14} className="text-zinc-500 shrink-0" />
              Sólo un administrador puede guardar o reemplazar la nómina de un mes.
            </div>
          ) : !errorExtraccion && !ok && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Mes al que corresponden estos datos</span>
                <div className="flex items-center gap-1">
                  <button onClick={() => setAnio((a) => a - 1)} className="text-zinc-500 hover:text-zinc-200"><ChevronLeft size={16} /></button>
                  <span className="text-sm text-zinc-300 w-12 text-center">{anio}</span>
                  <button onClick={() => setAnio((a) => a + 1)} className="text-zinc-500 hover:text-zinc-200"><ChevronRight size={16} /></button>
                </div>
              </div>
              <div className="grid grid-cols-4 gap-2">
                {NOMBRES_MES.map((nombre, idx) => {
                  const mes = mesId(anio, idx);
                  const guardado = mesesGuardados[mes];
                  const activo = mesElegido === mes;
                  return (
                    <button
                      key={mes}
                      onClick={() => elegirMes(mes)}
                      className={`relative rounded-lg border px-2 py-2.5 text-xs font-medium transition-colors ${
                        activo
                          ? "border-yellow-400 bg-yellow-400/10 text-yellow-400"
                          : "border-zinc-800 text-zinc-300 hover:border-zinc-600"
                      }`}
                    >
                      {nombre.slice(0, 3)}
                      {guardado && (
                        <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-yellow-400/70" title="Ya tiene datos" />
                      )}
                    </button>
                  );
                })}
              </div>
              {sugerencia && !mesElegido && (
                <p className="text-xs text-zinc-600 mt-2">
                  Sugerido según el archivo: <span className="text-zinc-400">{labelMes(sugerencia)}</span>
                </p>
              )}
            </div>
          )}

          {confirmando && ocupado && !ok && (
            <div className="flex items-start gap-2 text-sm text-orange-300 bg-orange-400/10 border border-orange-400/30 rounded-lg px-3 py-2.5">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <span>
                {labelMes(mesElegido!)} ya tiene datos guardados ({ocupado.cantEmpleados} empleados,{" "}
                {fmtARS(ocupado.totalCosto)}, cargado el {fmtFecha(ocupado.actualizado)}). Esta acción los va a{" "}
                <b>reemplazar</b>.
              </span>
            </div>
          )}

          {error && <p className="text-sm text-red-400">{error}</p>}

          {ok && (
            <div className="flex items-center gap-2 text-sm text-green-400 py-2">
              <CheckCircle2 size={18} /> Guardado.
            </div>
          )}
        </div>

        {!ok && !errorExtraccion && puedeEditar && (
          <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-zinc-800">
            <button onClick={onCerrar} className="text-sm text-zinc-400 hover:text-zinc-200 px-3 py-2">Cancelar</button>
            <button
              disabled={!mesElegido || guardando}
              onClick={() => guardar(confirmando)}
              className="flex items-center gap-2 text-sm font-semibold bg-yellow-400 text-black rounded-lg px-4 py-2 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-yellow-300 transition-colors"
            >
              {guardando && <Loader2 size={14} className="animate-spin" />}
              {confirmando ? "Reemplazar" : "Guardar"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
