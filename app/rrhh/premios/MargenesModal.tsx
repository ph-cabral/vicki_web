"use client";

import { useEffect, useMemo, useState } from "react";
import { Plus, Trash2, X } from "lucide-react";
import { abrirPicker } from "@/components/ui/abrirPicker";
import {
  AMBITOS,
  AMBITO_LABEL,
  TRAMOS_SUGERIDOS,
  escalaVigente,
  rotuloTramo,
  type Ambito,
  type Escalas,
  type Tramo,
} from "@/lib/rrhh/premioEscala";

// ──────────────────────────────────────────────────────────────────────────────
// Márgenes de premio — tramos "de X a Y errores → resta Z %", una escala por
// ámbito (Preparadores / Mesa de Control).
//
// El formulario NO pide el "desde" de cada tramo: lo calcula (el primero
// arranca en 0 y cada uno sigue al anterior), así la escala no puede quedar con
// huecos ni superpuesta y se carga leyendo lo mismo que se dice en voz alta:
// "hasta 5 no resta nada, hasta 10 resta 25". El último tramo es siempre
// abierto ("en adelante").
//
// Cada guardado escribe la versión del mes elegido en "Vigente desde": rige de
// ese mes en adelante y no toca los meses anteriores, que siguen con la versión
// que tenían. Si ya existe una versión de ese mes, se corrige; si no, se abre
// una nueva. Sólo ADMIN puede guardar (la API lo exige igual, no alcanza con
// esconder el botón): el resto ve la escala en modo lectura.
// ──────────────────────────────────────────────────────────────────────────────

type Fila = { hasta: string; descuento: string };

const pad2 = (n: number) => String(n).padStart(2, "0");
const mesActual = () => {
  const h = new Date();
  return `${h.getFullYear()}-${pad2(h.getMonth() + 1)}`;
};

const aFilas = (tramos: Tramo[]): Fila[] =>
  tramos.map((t) => ({
    hasta: t.hasta === null ? "" : String(t.hasta),
    descuento: String(t.descuento),
  }));

/** Filas del formulario -> tramos con `desde` calculado y último abierto. */
function aTramos(filas: Fila[]): { ok: true; tramos: Tramo[] } | { ok: false; error: string } {
  const tramos: Tramo[] = [];
  let desde = 0;
  for (let i = 0; i < filas.length; i++) {
    const ultima = i === filas.length - 1;
    const f = filas[i];
    const descuento = Number(String(f.descuento).replace(",", "."));
    if (!Number.isFinite(descuento) || descuento < 0 || descuento > 100)
      return { ok: false, error: `Tramo ${i + 1}: el descuento va de 0 a 100 %` };

    let hasta: number | null = null;
    if (!ultima) {
      hasta = Number(f.hasta);
      if (!Number.isInteger(hasta) || hasta < desde)
        return { ok: false, error: `Tramo ${i + 1}: "hasta" tiene que ser un entero de ${desde} o más` };
    }
    tramos.push({ desde, hasta, descuento: Math.round(descuento * 100) / 100 });
    if (hasta !== null) desde = hasta + 1;
  }
  return { ok: true, tramos };
}

/** El "desde" que le toca a la fila i según los "hasta" anteriores. */
function desdeDe(filas: Fila[], i: number): number {
  let desde = 0;
  for (let k = 0; k < i; k++) {
    const h = Number(filas[k].hasta);
    if (!Number.isInteger(h)) return desde;
    desde = h + 1;
  }
  return desde;
}

export function MargenesModal({
  escalas,
  puedeEditar,
  mesVista,
  onGuardar,
  onBorrar,
  onCerrar,
}: {
  escalas: Escalas;
  puedeEditar: boolean;
  /** Mes que está mirando la pantalla — sirve de referencia, no de default. */
  mesVista: string;
  onGuardar: (
    ambito: Ambito,
    vigencia: string,
    tramos: Tramo[],
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  onBorrar: (ambito: Ambito, vigencia: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  onCerrar: () => void;
}) {
  const [ambito, setAmbito] = useState<Ambito>("preparado");
  // Default: el mes en curso. Un cambio rige de hoy en adelante; para corregir
  // una escala vieja hay que elegir su mes a mano.
  const [vigencia, setVigencia] = useState(() => (puedeEditar ? mesActual() : mesVista));
  const [filas, setFilas] = useState<Fila[]>([]);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  const versiones = escalas[ambito] ?? [];
  const existente = useMemo(
    () => versiones.find((v) => v.vigencia === vigencia) ?? null,
    [versiones, vigencia],
  );
  const enVigor = useMemo(() => escalaVigente(versiones, vigencia), [versiones, vigencia]);

  // Al cambiar de ámbito o de mes: si ya hay una versión de ese mes se edita
  // esa; si no, se parte de la que está rigiendo (o de la sugerida, si no hay
  // ninguna cargada todavía).
  useEffect(() => {
    const base = existente?.tramos ?? enVigor?.tramos ?? TRAMOS_SUGERIDOS;
    setFilas(aFilas(base));
    setError(null);
  }, [existente, enVigor]);

  // El aviso de "guardado" se limpia sólo al moverse de ámbito o de mes: si se
  // limpiara en el efecto de arriba, guardar lo borraría al instante (guardar
  // actualiza la escala y vuelve a correr ese efecto).
  useEffect(() => {
    setAviso(null);
  }, [ambito, vigencia]);

  const setFila = (i: number, campo: keyof Fila, valor: string) =>
    setFilas((prev) => prev.map((f, k) => (k === i ? { ...f, [campo]: valor } : f)));

  const agregar = () =>
    setFilas((prev) => {
      if (!prev.length) return [{ hasta: "", descuento: "0" }];
      // El nuevo tramo se inserta ANTES del abierto: el "en adelante" siempre
      // queda al final.
      const ultimo = prev[prev.length - 1];
      return [...prev.slice(0, -1), { hasta: "", descuento: "0" }, ultimo];
    });

  const quitar = (i: number) =>
    setFilas((prev) => (prev.length <= 1 ? prev : prev.filter((_, k) => k !== i)));

  const guardar = async () => {
    const v = aTramos(filas);
    if (!v.ok) {
      setError(v.error);
      return;
    }
    setGuardando(true);
    setError(null);
    const r = await onGuardar(ambito, vigencia, v.tramos);
    setGuardando(false);
    if (r.ok) setAviso(`Guardado. Rige desde ${vigencia} en adelante.`);
    else setError(r.error);
  };

  const borrar = async () => {
    setGuardando(true);
    setError(null);
    const r = await onBorrar(ambito, vigencia);
    setGuardando(false);
    if (r.ok) setAviso(`Se quitó la versión de ${vigencia}. Vuelve a regir la anterior.`);
    else setError(r.error);
  };

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 p-4"
      onClick={onCerrar}
    >
      <div
        className="w-full max-w-lg rounded-xl border border-zinc-800 bg-[#171717] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 border-b border-zinc-800 px-5 py-4">
          <div className="flex-1">
            <h3 className="text-sm font-semibold text-zinc-100">Márgenes de premio</h3>
            <p className="mt-1 text-[11px] text-zinc-500">
              Cuántos errores del mes restan qué porcentaje del premio. Cada cambio rige{" "}
              <strong className="text-zinc-400">desde el mes elegido en adelante</strong>: los meses
              anteriores se siguen calculando con la escala que tenían.
            </p>
          </div>
          <button
            type="button"
            onClick={onCerrar}
            className="text-zinc-500 hover:text-zinc-200 transition-colors"
            title="Cerrar"
          >
            <X size={16} />
          </button>
        </div>

        {/* Ámbito */}
        <div className="flex gap-1 border-b border-zinc-800 px-5 pt-3">
          {AMBITOS.map((a) => (
            <button
              key={a}
              type="button"
              onClick={() => setAmbito(a)}
              className={`-mb-px border-b-2 px-3 py-2 text-xs transition-colors ${
                ambito === a
                  ? "border-yellow-400 font-medium text-yellow-400"
                  : "border-transparent text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {AMBITO_LABEL[a]}
            </button>
          ))}
        </div>

        <div className="space-y-4 px-5 py-4">
          <label className="block">
            <span className="text-xs font-medium text-zinc-300">Vigente desde</span>
            <input
              type="month"
              value={vigencia}
              onChange={(e) => setVigencia(e.target.value)}
              onClick={abrirPicker}
              disabled={!puedeEditar}
              className="mt-1.5 w-full cursor-pointer rounded-lg border border-zinc-700 bg-[#1f1f1f] px-3 py-2 text-sm text-zinc-100 outline-none focus:border-yellow-400 disabled:opacity-60 [color-scheme:dark]"
            />
            <span className="mt-1 block text-[11px] text-zinc-600">
              {existente
                ? "Ya hay una versión de este mes: guardar la corrige."
                : enVigor
                  ? `Hoy rige la versión de ${enVigor.vigencia}. Guardar abre una nueva desde ${vigencia}.`
                  : "Todavía no hay ninguna escala cargada para este ámbito."}
            </span>
          </label>

          {/* Tramos */}
          <div className="rounded-lg border border-zinc-800 overflow-hidden">
            <div className="grid grid-cols-[1fr_auto] items-center gap-2 bg-[#1f1f1f] px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
              <span>Errores del mes</span>
              <span>Resta del premio</span>
            </div>
            <div className="divide-y divide-zinc-800/60">
              {filas.map((f, i) => {
                const ultima = i === filas.length - 1;
                const desde = desdeDe(filas, i);
                return (
                  <div key={i} className="flex items-center gap-2 px-3 py-2 text-sm">
                    <span className="w-10 shrink-0 text-right tabular-nums text-zinc-500">
                      {desde}
                    </span>
                    {ultima ? (
                      <span className="flex-1 text-xs text-zinc-500">o más (en adelante)</span>
                    ) : (
                      <>
                        <span className="text-xs text-zinc-600">a</span>
                        <input
                          type="number"
                          min={desde}
                          step={1}
                          value={f.hasta}
                          onChange={(e) => setFila(i, "hasta", e.target.value)}
                          disabled={!puedeEditar}
                          className="w-20 rounded-md border border-zinc-700 bg-[#1f1f1f] px-2 py-1 text-right tabular-nums text-zinc-100 outline-none focus:border-yellow-400 disabled:opacity-60"
                        />
                        <span className="flex-1 text-xs text-zinc-600">errores</span>
                      </>
                    )}
                    <input
                      type="number"
                      min={0}
                      max={100}
                      step="any"
                      value={f.descuento}
                      onChange={(e) => setFila(i, "descuento", e.target.value)}
                      disabled={!puedeEditar}
                      className="w-20 rounded-md border border-zinc-700 bg-[#1f1f1f] px-2 py-1 text-right tabular-nums text-zinc-100 outline-none focus:border-yellow-400 disabled:opacity-60"
                    />
                    <span className="text-xs text-zinc-500">%</span>
                    {puedeEditar && (
                      <button
                        type="button"
                        onClick={() => quitar(i)}
                        disabled={filas.length <= 1}
                        title="Quitar tramo"
                        className="text-zinc-600 hover:text-red-400 transition-colors disabled:opacity-30"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
            {puedeEditar && (
              <button
                type="button"
                onClick={agregar}
                className="flex w-full items-center justify-center gap-1.5 border-t border-zinc-800 bg-[#1f1f1f] px-3 py-2 text-xs text-zinc-400 hover:text-yellow-400 transition-colors"
              >
                <Plus size={13} />
                Agregar tramo
              </button>
            )}
          </div>

          {/* Cómo queda leído en criollo */}
          {(() => {
            const v = aTramos(filas);
            if (!v.ok) return null;
            return (
              <p className="text-[11px] leading-relaxed text-zinc-500">
                {v.tramos.map((t, i) => (
                  <span key={i}>
                    {i > 0 && " · "}
                    {rotuloTramo(t)} err. → cobra{" "}
                    <strong className="text-zinc-300">{Math.max(0, 100 - t.descuento)}%</strong>
                  </span>
                ))}
              </p>
            );
          })()}

          {error && (
            <div className="rounded-lg border border-red-400/40 bg-red-400/5 px-3 py-2 text-xs text-red-300">
              {error}
            </div>
          )}
          {aviso && !error && (
            <div className="rounded-lg border border-emerald-400/40 bg-emerald-400/5 px-3 py-2 text-xs text-emerald-300">
              {aviso}
            </div>
          )}

          {!puedeEditar && (
            <p className="text-[11px] text-zinc-600">
              Sólo un administrador puede cargar o cambiar los márgenes.
            </p>
          )}

          {/* Historial de versiones del ámbito */}
          {versiones.length > 0 && (
            <div className="text-[11px] text-zinc-600">
              Versiones cargadas:{" "}
              {versiones.map((v) => (
                <button
                  key={v.vigencia}
                  type="button"
                  onClick={() => setVigencia(v.vigencia)}
                  className={`mr-1.5 rounded px-1.5 py-0.5 transition-colors ${
                    v.vigencia === vigencia
                      ? "bg-yellow-400/15 text-yellow-300"
                      : "text-zinc-400 hover:text-yellow-400"
                  }`}
                >
                  {v.vigencia}
                </button>
              ))}
            </div>
          )}
        </div>

        {puedeEditar && (
          <div className="flex items-center justify-between gap-2 border-t border-zinc-800 px-5 py-3">
            {existente ? (
              <button
                type="button"
                onClick={borrar}
                disabled={guardando}
                className="text-xs text-zinc-500 hover:text-red-400 transition-colors disabled:opacity-40"
              >
                Quitar la versión de {vigencia}
              </button>
            ) : (
              <span />
            )}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onCerrar}
                className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 transition-colors"
              >
                Cerrar
              </button>
              <button
                type="button"
                onClick={guardar}
                disabled={guardando}
                className="rounded-md bg-yellow-400 px-4 py-1.5 text-xs font-semibold text-black hover:bg-yellow-300 disabled:opacity-50 transition-colors"
              >
                {guardando ? "Guardando…" : existente ? "Guardar cambios" : "Crear versión"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
