"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Escala de premios por % de error — modal "Márgenes" de /rrhh/premios.
 *
 * La escala NO se carga por cantidad de errores sino por el **% de error** que
 * ya muestra la tabla (errores / ítems preparados × 100). Cada tramo se define
 * con UN solo número: el % de error hasta donde llega. El tramo arranca donde
 * terminó el anterior (el primero, en 0) y el último queda abierto:
 *
 *   hasta 0,05 %  -> resta 10 %
 *   hasta 2 %     -> resta 20 %   (o sea: de 0,05 % a 2 %)
 *   de ahí en más -> resta 50 %
 *
 * El tope **entra** en su tramo (`<=`) y el siguiente arranca por encima: con
 * la escala de arriba, 0,05 % exacto resta 10 %, no 20 %.
 *
 * Lo que se resta se aplica a la CANTIDAD (ítems preparados o renglones
 * controlados): la última columna de la tabla es `cantidad − margen`, o sea
 * cantidad × (1 − descuento/100). Hay una escala por ámbito: 'preparado'
 * (tabla Preparadores) y 'mesa' (tabla Mesa de Control).
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
export type Tramo = {
  /** % de error hasta donde llega el tramo (incluido). null = el último, sin tope. */
  hasta: number | null;
  /** % que se le resta a la cantidad en ese tramo. */
  descuento: number;
};
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
  { hasta: 0.05, descuento: 10 },
  { hasta: 2, descuento: 20 },
  { hasta: null, descuento: 50 },
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
 * % de error de una fila: errores / cantidad × 100, **redondeado a 2 decimales**
 * — exactamente el número que muestra la columna "% Error". Se redondea a
 * propósito: el tramo tiene que salir del valor que la persona ve en pantalla,
 * si no un 0,0501 % que se muestra como "0,05 %" caería en el tramo siguiente y
 * el premio parecería mal calculado.
 */
export function pctError(errores: number, cantidad: number): number | null {
  if (!(cantidad > 0)) return null;
  return Math.round((errores / cantidad) * 100 * 100) / 100;
}

/**
 * % que se le resta a la cantidad según el % de error. Los tramos están
 * ordenados: gana el primero cuyo tope alcance ese % (el último, sin tope,
 * junta todo lo que sobra). null = no hay escala cargada.
 */
export function descuentoDe(tramos: Tramo[] | undefined, pct: number | null): number | null {
  if (!tramos?.length || pct === null) return null;
  for (const t of tramos) {
    if (t.hasta === null || pct <= t.hasta) return t.descuento;
  }
  // Sin tramo abierto al final, cualquier % por encima del último tope queda
  // afuera: se lleva el descuento del último cargado (el más alto).
  return tramos[tramos.length - 1].descuento;
}

/** Cantidad que queda después del margen: cantidad × (1 − descuento/100). */
export function premiadoDe(
  tramos: Tramo[] | undefined,
  cantidad: number,
  errores: number,
): { descuento: number; premiado: number; margen: number } | null {
  const d = descuentoDe(tramos, pctError(errores, cantidad));
  if (d === null) return null;
  const margen = Math.round((cantidad * d) / 100);
  return { descuento: d, premiado: Math.max(0, cantidad - margen), margen };
}

const fmtPct = (n: number) =>
  n.toLocaleString("es-AR", { maximumFractionDigits: 2 });

/** "0 a 0,05 %" / "0,05 a 2 %" / "2 % o más" — `previo` es el tope anterior. */
export function rotuloTramo(t: Tramo, previo: number): string {
  return t.hasta === null
    ? `más de ${fmtPct(previo)} %`
    : `${fmtPct(previo)} a ${fmtPct(t.hasta)} %`;
}

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
