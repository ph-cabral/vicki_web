"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Objetivos de venta por VENDEDOR y MES de una línea (2026-09-09).
 *
 * Los usa la pestaña "Pulso" de /ventas/bulones. Se guardan en Postgres
 * (everwear.ventas_objetivo) una fila por vendedor, línea y mes, y DESDE
 * 2026-09-17 el objetivo puede cargarse en $ ("pesos", columna `objetivo`,
 * la pantalla lo carga EN MILES y la API multiplica x1.000) y/o en UNIDADES
 * (columna `objetivoUnidades`, sin escala) — los dos son independientes,
 * un vendedor puede tener uno solo, el otro, los dos, o ninguno.
 *
 * En el RANKING (ver PulsoTab.tsx) se muestra un solo tipo por vendedor:
 * si sólo tiene uno cargado, ese (sea cual sea la vista $/Unidades elegida
 * arriba); si tiene los dos, el que coincide con la vista elegida.
 *
 * Una sola llamada trae TODOS los vendedores y TODOS los meses de la línea (la
 * tabla son unos cientos de filas por año), así que mover el selector de
 * período no vuelve a pegarle al servidor: el objetivo de un rango es una
 * suma en memoria.
 */
export type TipoObjetivo = "pesos" | "unidades";

export interface ObjetivoMes {
  pesos?: number;
  unidades?: number;
}

export type ObjetivosLinea = Record<string, Record<string, ObjetivoMes>>;

export const MIL = 1_000;

/** Formatea un valor guardado para poblar el formulario: $ se muestra en
 * MILES (1.500 = $ 1.500.000), unidades se muestra tal cual. "" si no hay. */
export const aTexto = (v: number | null | undefined, tipo: TipoObjetivo) =>
  v == null ? "" : tipo === "pesos" ? String(Math.round((v / MIL) * 100) / 100) : String(Math.round(v));

/** Lista de meses 'YYYY-MM' entre dos extremos, inclusive. */
export function mesesEntre(desde: string, hasta: string): string[] {
  if (!desde || !hasta || hasta < desde) return desde ? [desde] : [];
  const out: string[] = [];
  let [a, m] = desde.split("-").map(Number);
  for (let i = 0; i < 120; i++) {
    const ym = `${a}-${String(m).padStart(2, "0")}`;
    out.push(ym);
    if (ym >= hasta) break;
    m += 1;
    if (m > 12) {
      m = 1;
      a += 1;
    }
  }
  return out;
}

export function useObjetivosVentas(linea: string) {
  const [objetivos, setObjetivos] = useState<ObjetivosLinea>({});
  const [puedeEditar, setPuedeEditar] = useState(false);
  const [cargando, setCargando] = useState(false);

  const recargar = useCallback(async () => {
    if (!linea) return;
    setCargando(true);
    try {
      const r = await fetch(`/api/ventas/objetivos?linea=${encodeURIComponent(linea)}`, {
        cache: "no-store",
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        setObjetivos((j.objetivos ?? {}) as ObjetivosLinea);
        setPuedeEditar(j.puedeEditar === true);
      }
    } catch {
      // Sin objetivos el ranking se muestra igual, sólo sin la columna.
    } finally {
      setCargando(false);
    }
  }, [linea]);

  useEffect(() => {
    recargar();
  }, [recargar]);

  /**
   * Guarda el rango completo de un vendedor PARA UN SOLO TIPO ($ o
   * unidades) — el otro tipo, si el vendedor lo tiene cargado, no se toca.
   * Cada mes va en el formato de ese tipo (miles si es "pesos", unidades si
   * es "unidades"); un mes con el valor vacío borra SÓLO ese tipo en ese
   * mes (si el otro tipo sigue teniendo algo, la fila no desaparece). Es una
   * sola llamada: el back lo resuelve en una transacción para que un
   * objetivo de varios meses no quede a medias.
   */
  const guardar = useCallback(
    async (
      vendedor: number,
      tipo: TipoObjetivo,
      meses: { mes: string; valor: string }[],
    ): Promise<{ ok: true } | { ok: false; error: string }> => {
      const r = await fetch("/api/ventas/objetivos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ linea, vendedor, tipo, meses }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return { ok: false, error: j?.error || `HTTP ${r.status}` };
      setObjetivos((prev) => {
        const clave = String(vendedor);
        const delVendedor: Record<string, ObjetivoMes> = { ...(prev[clave] ?? {}) };
        for (const m of (j.borrados ?? []) as string[]) {
          const mes = { ...(delVendedor[m] ?? {}) };
          delete mes[tipo];
          if (Object.keys(mes).length === 0) delete delVendedor[m];
          else delVendedor[m] = mes;
        }
        for (const [m, v] of Object.entries((j.valores ?? {}) as Record<string, number>))
          delVendedor[m] = { ...(delVendedor[m] ?? {}), [tipo]: v };
        const next = { ...prev, [clave]: delVendedor };
        if (Object.keys(delVendedor).length === 0) delete next[clave];
        return next;
      });
      return { ok: true };
    },
    [linea],
  );

  /** Borra de un saque el objetivo de UN TIPO del vendedor en el rango (el otro tipo queda igual). */
  const borrarRango = useCallback(
    async (
      vendedor: number,
      tipo: TipoObjetivo,
      desde: string,
      hasta: string,
    ): Promise<{ ok: true } | { ok: false; error: string }> => {
      const qs = new URLSearchParams({
        linea,
        vendedor: String(vendedor),
        tipo,
        desde,
        hasta,
      });
      const r = await fetch(`/api/ventas/objetivos?${qs.toString()}`, { method: "DELETE" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return { ok: false, error: j?.error || `HTTP ${r.status}` };
      setObjetivos((prev) => {
        const clave = String(vendedor);
        if (!prev[clave]) return prev;
        const delVendedor: Record<string, ObjetivoMes> = { ...prev[clave] };
        for (const m of mesesEntre(desde, hasta)) {
          if (!delVendedor[m]) continue;
          const mes = { ...delVendedor[m] };
          delete mes[tipo];
          if (Object.keys(mes).length === 0) delete delVendedor[m];
          else delVendedor[m] = mes;
        }
        const next = { ...prev };
        if (Object.keys(delVendedor).length === 0) delete next[clave];
        else next[clave] = delVendedor;
        return next;
      });
      return { ok: true };
    },
    [linea],
  );

  return { objetivos, puedeEditar, cargando, recargar, guardar, borrarRango };
}

/**
 * Objetivo de un vendedor para un rango de meses, DE UN SOLO TIPO ($ o
 * unidades): la SUMA de los meses que tengan ese tipo cargado. Devuelve
 * `null` si no hay ninguno — así la pantalla distingue "sin objetivo" de
 * "objetivo cero".
 */
export function objetivoDelRango(
  objetivos: ObjetivosLinea,
  vendedor: number | string,
  meses: string[],
  tipo: TipoObjetivo,
): number | null {
  const delVendedor = objetivos[String(vendedor)];
  if (!delVendedor) return null;
  let total = 0;
  let hay = false;
  for (const m of meses) {
    const v = delVendedor[m]?.[tipo];
    if (v != null) {
      total += v;
      hay = true;
    }
  }
  return hay ? total : null;
}

/** true si el vendedor tiene ALGO cargado (en cualquiera de los dos tipos) en el rango. */
export function tieneObjetivo(objetivos: ObjetivosLinea, vendedor: number | string, meses: string[]): boolean {
  return (
    objetivoDelRango(objetivos, vendedor, meses, "pesos") != null ||
    objetivoDelRango(objetivos, vendedor, meses, "unidades") != null
  );
}

/**
 * Clave de línea con la que se guardan los objetivos (everwear.ventas_objetivo.linea)
 * — 2026-09-23, cuando la vista pasó a tener selector de línea.
 *
 * Bulones conserva "BULONERIA" (la clave con la que ya hay objetivos
 * cargados); el resto de las líneas usa `LINEA_<id>` del catálogo, porque
 * hay nombres repetidos ("Varios" dos veces) y el nombre puede cambiar al
 * recargar el DePara, el id no.
 */
export function claveObjetivoLinea(linea: { id: number; nombre: string }): string {
  return /^bulon/i.test(linea.nombre.trim()) ? "BULONERIA" : `LINEA_${linea.id}`;
}
