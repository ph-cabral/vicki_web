"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Escala de premios por errores — modal "Márgenes" de /rrhh/premios.
 *
 * Los tramos convierten la cantidad de ERRORES del mes en el porcentaje de
 * premio que se le RESTA a la persona (de 0 a 5 errores resta 0 %, de 6 a 10
 * resta 25 %, …). Hay una escala por ámbito: 'preparado' (tabla Preparadores)
 * y 'mesa' (tabla Mesa de Control).
 *
 * VERSIONADO POR MES: cada versión rige DESDE su `vigencia` (YYYY-MM) EN
 * ADELANTE, hasta que haya otra posterior — `escalaVigente()` es la que resuelve
 * eso. Cambiar los números en septiembre no toca agosto: agosto sigue con la
 * versión que tenía. Un mes anterior a la primera versión no tiene escala
 * (premio "—"), no se asume 100 %.
 *
 * El GET trae TODAS las versiones de los dos ámbitos de una vez (la tabla tiene
 * una fila por ámbito y por cambio), así cambiar de mes en la pantalla no
 * vuelve al servidor.
 */
export type Tramo = { desde: number; hasta: number | null; descuento: number };
export type VersionEscala = { vigencia: string; tramos: Tramo[]; actualizado?: string };
export type Ambito = "preparado" | "mesa";
export type Escalas = Record<Ambito, VersionEscala[]>;

export const AMBITOS: Ambito[] = ["preparado", "mesa"];
export const AMBITO_LABEL: Record<Ambito, string> = {
  preparado: "Preparadores",
  mesa: "Mesa de Control",
};

/** Punto de partida del formulario cuando todavía no hay ninguna versión. */
export const TRAMOS_SUGERIDOS: Tramo[] = [
  { desde: 0, hasta: 5, descuento: 0 },
  { desde: 6, hasta: 10, descuento: 25 },
  { desde: 11, hasta: 15, descuento: 50 },
  { desde: 16, hasta: null, descuento: 100 },
];

/** La versión que rige para `mes`: la de `vigencia` más alta que sea <= mes. */
export function escalaVigente(
  versiones: VersionEscala[] | undefined,
  mes: string,
): VersionEscala | null {
  if (!versiones?.length || !mes) return null;
  let elegida: VersionEscala | null = null;
  for (const v of versiones) {
    if (v.vigencia <= mes && (!elegida || v.vigencia > elegida.vigencia)) elegida = v;
  }
  return elegida;
}

/**
 * % que se resta del premio con esa cantidad de errores. Devuelve null cuando
 * no hay escala cargada Y TAMBIÉN cuando ese número de errores no entra en
 * ningún tramo (la escala puede arrancar arriba de 0 o tener un hueco): mejor
 * mostrar "—" que inventar un premio.
 */
export function descuentoDe(tramos: Tramo[] | undefined, errores: number): number | null {
  if (!tramos?.length) return null;
  for (const t of tramos) {
    if (errores >= t.desde && (t.hasta === null || errores <= t.hasta)) return t.descuento;
  }
  // Cayó en un hueco de la escala (o por debajo del primer tramo): sin premio
  // definido. El modal de Márgenes avisa de los huecos al cargarla.
  return null;
}

/** % de premio que le queda a la persona (100 − descuento). */
export function premioDe(tramos: Tramo[] | undefined, errores: number): number | null {
  const d = descuentoDe(tramos, errores);
  return d === null ? null : Math.max(0, Math.round((100 - d) * 100) / 100);
}

export const rotuloTramo = (t: Tramo) =>
  t.hasta === null ? `${t.desde} o más` : t.desde === t.hasta ? `${t.desde}` : `${t.desde} a ${t.hasta}`;

export function usePremioEscala() {
  const [escalas, setEscalas] = useState<Escalas>({ preparado: [], mesa: [] });
  const [puedeEditar, setPuedeEditar] = useState(false);
  const [cargando, setCargando] = useState(false);

  const recargar = useCallback(async () => {
    setCargando(true);
    try {
      const r = await fetch("/api/rrhh/premios/escala", { cache: "no-store" });
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        setEscalas({
          preparado: j.escalas?.preparado ?? [],
          mesa: j.escalas?.mesa ?? [],
        });
        setPuedeEditar(j.puedeEditar === true);
      }
    } catch {
      // Sin escala las tablas se muestran igual, sólo sin la columna de premio.
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => {
    recargar();
  }, [recargar]);

  const guardar = useCallback(
    async (
      ambito: Ambito,
      vigencia: string,
      tramos: Tramo[],
    ): Promise<{ ok: true } | { ok: false; error: string }> => {
      const r = await fetch("/api/rrhh/premios/escala", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ambito, vigencia, tramos }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return { ok: false, error: j?.error || `HTTP ${r.status}` };
      setEscalas((prev) => {
        const otras = prev[ambito].filter((v) => v.vigencia !== vigencia);
        const nueva: VersionEscala = { vigencia, tramos, actualizado: j?.actualizado };
        return {
          ...prev,
          [ambito]: [...otras, nueva].sort((a, b) => a.vigencia.localeCompare(b.vigencia)),
        };
      });
      return { ok: true };
    },
    [],
  );

  const borrar = useCallback(
    async (ambito: Ambito, vigencia: string): Promise<{ ok: true } | { ok: false; error: string }> => {
      const r = await fetch(
        `/api/rrhh/premios/escala?ambito=${ambito}&vigencia=${vigencia}`,
        { method: "DELETE" },
      );
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return { ok: false, error: j?.error || `HTTP ${r.status}` };
      setEscalas((prev) => ({
        ...prev,
        [ambito]: prev[ambito].filter((v) => v.vigencia !== vigencia),
      }));
      return { ok: true };
    },
    [],
  );

  return { escalas, puedeEditar, cargando, recargar, guardar, borrar };
}
