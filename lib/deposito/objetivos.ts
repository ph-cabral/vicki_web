"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Objetivos mensuales del ranking de operarios de /deposito (2026-09-09).
 *
 * Las 3 líneas que se dibujan sobre las barras de Picking / Libre+Reposición /
 * Re-Ubicación. Se guardan por proceso y mes en Postgres
 * (everwear.deposito_objetivo) y se cargan EN MILES desde la pantalla: la API
 * multiplica x1.000 al escribir, así que lo que llega acá ya está en ITEMS,
 * la misma unidad del eje del gráfico.
 *
 * Una sola llamada por proceso trae TODOS los meses del rango (la tabla tiene
 * una fila por proceso y mes), así que cambiar de mes activo no vuelve a pegar
 * al servidor.
 */
export type ObjetivoMes = {
  objetivo: number;
  sobresaliente: number | null;
  bajo: number | null;
};

export type ObjetivosProceso = Record<string, ObjetivoMes>;

/** Items -> texto del formulario ("" si no hay línea cargada). */
export const aItemsTxt = (v: number | null | undefined) =>
  v == null ? "" : String(Math.round(v));

export function useObjetivosDeposito(proceso: string) {
  const [objetivos, setObjetivos] = useState<ObjetivosProceso>({});
  const [puedeEditar, setPuedeEditar] = useState(false);
  const [cargando, setCargando] = useState(false);

  const recargar = useCallback(async () => {
    if (!proceso) return;
    setCargando(true);
    try {
      const r = await fetch(
        `/api/deposito/objetivos?proceso=${encodeURIComponent(proceso)}`,
        { cache: "no-store" },
      );
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        setObjetivos((j.objetivos ?? {}) as ObjetivosProceso);
        setPuedeEditar(j.puedeEditar === true);
      }
    } catch {
      // Sin objetivos el gráfico se dibuja igual, sólo sin líneas.
    } finally {
      setCargando(false);
    }
  }, [proceso]);

  useEffect(() => {
    recargar();
  }, [recargar]);

  /** Guarda (upsert) las 3 líneas de un mes. Los valores van en ITEMS. */
  const guardar = useCallback(
    async (
      mes: string,
      valores: { objetivo: string; sobresaliente: string; bajo: string },
    ): Promise<{ ok: true } | { ok: false; error: string }> => {
      const r = await fetch("/api/deposito/objetivos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proceso, mes, ...valores }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return { ok: false, error: j?.error || `HTTP ${r.status}` };
      setObjetivos((prev) => ({
        ...prev,
        [mes]: {
          objetivo: j.objetivo,
          sobresaliente: j.sobresaliente ?? null,
          bajo: j.bajo ?? null,
        },
      }));
      return { ok: true };
    },
    [proceso],
  );

  const borrar = useCallback(
    async (mes: string): Promise<{ ok: true } | { ok: false; error: string }> => {
      const r = await fetch(
        `/api/deposito/objetivos?proceso=${encodeURIComponent(proceso)}&mes=${mes}`,
        { method: "DELETE" },
      );
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return { ok: false, error: j?.error || `HTTP ${r.status}` };
      setObjetivos((prev) => {
        const next = { ...prev };
        delete next[mes];
        return next;
      });
      return { ok: true };
    },
    [proceso],
  );

  return { objetivos, puedeEditar, cargando, recargar, guardar, borrar };
}
