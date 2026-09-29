"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  RefreshCw,
  Loader2,
  AlertTriangle,
  Plus,
  Trash2,
  X,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import {
  PageTitle,
  SectionTitle,
  Panel,
  KPI,
  Grid,
  Alert,
  ChartBar,
  ChartDonut,
  PALETTE,
  fmtArs,
  fmtNum,
  fmtShort,
  fmtMes,
  MatrixTable,
  BarrasH,
  BarraPresupuesto,
  TiraMeses,
  type BarraH,
  type MatRow,
  type CeldaMes,
} from "./ui";

// ─────────────────────────────────────────────────────────────────────────────
// Pestaña "Presupuestos" de /finanza — ÓRDENES DE COMPRA POR ÁREA (2026-09-01)
//
// Los "presupuestos por área" de compras SON órdenes de compra: el área es el
// TIPO DE COMPROBANTE con el que se cargó la OC (ORDEN DE COMPRA nacional ·
// IMPO · INDUSTRIA · RRHH · MARKETING · SISTEMAS IT · INGRESO INDUSTRIA A
// COMERCIAL). Antes esta pestaña se armaba de una hoja del Excel financiero
// que se sube a mano; ahora lee la base en vivo
// (/api/finanza/presupuestos → indicadores-api /compras/oc-por-area).
//
// Por eso es la ÚNICA pestaña de /finanza que anda sin Excel cargado: se pide
// sola al montar.
//
// EJERCICIO ANUAL (2026-09-02). Los presupuestos son ANUALES, así que la
// pantalla dejó de tener un rango libre de meses y pasó a tener un selector de
// AÑO: el filtro es siempre enero→diciembre del año elegido y arranca en el año
// EN CURSO, o sea mostrando los presupuestos vigentes. El selector ofrece los
// años anteriores que tengan algún presupuesto cargado (más el actual), que
// salen de leer la tabla de aprobados sin rango — son pocas filas.
// Consecuencia buena: como el presupuesto anual entra entero en el filtro, ya
// no hace falta la segunda consulta del rango largo (`rangoPresupuestos`
// devuelve null) y la pantalla queda en una sola pasada.
//
// Los importes están PESIFICADOS a la cotización de cada OC (las de impo van
// en U$S; un total que mezcla monedas no significa nada). Las OC CANCELADAS
// quedan fuera de todos los totales y se informan al pie.
//
// Dos lecturas distintas conviven acá y no hay que mezclarlas:
//   · GRÁFICO "Importe por área": lo EJECUTADO, agrupado SÓLO por área — el
//     estado de cada OC no corta la barra (el desglose por estado está en el
//     donut y en la tabla).
//   · SECCIÓN "Ejecución del presupuesto": lo ejecutado contra el APROBADO que
//     se carga a mano (/api/finanza/presupuestos/aprobados). Ahí la barra
//     entera es el 100% del presupuesto COMPLETO del área (NO prorrateado) y se
//     rellena con TODO lo gastado dentro del período de ese presupuesto, sin
//     importar el estado de las OC ni qué meses estén filtrados: la pregunta
//     que contesta es "cómo viene el gasto contra el total aprobado", y
//     recortar el filtro no puede cambiar esa respuesta. Para eso, cuando el
//     presupuesto se pasa del filtro se pide una segunda vez /oc-por-area
//     sobre el rango de los presupuestos (una consulta agregada más, no una
//     por área). Cada fila son TRES renglones pegados:
//     la barra, la tira del rango partida mes a mes con lo gastado en cada uno
//     (`serieMes` del área) y el presupuesto que se está usando — antes los
//     presupuestos iban en una tabla al pie y no se sabía cuál era el de cada
//     barra. Si un área tiene varios presupuestos solapando el filtro manda el
//     de MAYOR COBERTURA (el que cubre más de los meses mirados); los otros se
//     listan pero no cuentan.
// ─────────────────────────────────────────────────────────────────────────────

type Acum = {
  items: number;
  ocs: number;
  unidadesPedidas: number;
  unidadesCumplidas: number;
  importe: number;
  importeCumplido: number;
  importePendiente: number;
  importeMonOrig: number;
  importeUsd: number;
};
type EstadoAcum = Acum & { estado: number; nombre: string };
type MesAcum = Acum & { mes: string };
// `serieMes` = un casillero por mes del filtro (incluso los meses sin OC), lo
// que dibuja la tira debajo de la barra. Opcional para no romper si la vista
// queda apuntando a una API vieja.
type AreaAcum = Acum & {
  codigo: number;
  area: string;
  estados: EstadoAcum[];
  serieMes?: MesAcum[];
};
export type OcPorArea = {
  desde: string;
  hasta: string;
  resumen: Acum;
  canceladas: Acum;
  estadosVista: number[];
  porEstado: EstadoAcum[];
  areas: AreaAcum[];
  compradores: (Acum & { codigo: number; comprador: string })[];
  meses: (Acum & { mes: string })[];
};

// Presupuesto aprobado (Postgres, cargado a mano). `montoPeriodo` es el
// prorrateo a los meses del filtro: quedó como DATO INFORMATIVO al pie de la
// barra — lo que mide la barra es `monto`, el presupuesto completo.
type PresupAprobado = {
  id: number;
  codigoArea: number;
  area: string;
  mesDesde: string;
  mesHasta: string;
  monto: number;
  nota: string | null;
  meses: number;
  mesesPeriodo: number;
  montoPeriodo: number;
};

const EST_PENDIENTE = 1;
const EST_CUMPLIDA = 2;
const EST_PARCIAL = 3;
const COLOR_ESTADO: Record<number, string> = {
  1: "#f87171", // pendiente de recibir
  2: "#4ade80", // cumplida
  3: "#facc15", // cumplida parcialmente
  0: "#a1a1aa", // sin confirmar
  5: "#71717a", // eliminada
};

// Etiquetas cortas: el nombre del comprobante en Magnus no entra en un eje
// ("INGRESO INDUSTRIA A COMERCIAL", "ORDEN DE COMPRA SISTEMAS IT"). Se mapea
// por CÓDIGO de comprobante (estable); si aparece uno nuevo cae al nombre
// recortado.
const AREA_CORTA: Record<number, string> = {
  70: "OC Nacionales",
  74: "RRHH",
  75: "OC Impo",
  76: "OC Industria",
  77: "Marketing",
  78: "Sistemas IT",
  80: "Ing.Ind.Comercial",
};
const ESTADO_LABEL: Record<number, string> = {
  0: "Sin confirmar",
  1: "Pendiente",
  2: "Cumplida",
  3: "Cumpl. parcial",
  5: "Eliminada",
};
// Áreas ofrecidas al cargar un presupuesto. Es el mismo catálogo de
// comprobantes de compra de Magnus, fijo acá porque un presupuesto se puede
// cargar para un área que todavía no tuvo ni una OC en el período mirado (y
// entonces no vendría en la respuesta de /oc-por-area).
const AREAS_CATALOGO: { codigo: number; nombre: string }[] = [
  { codigo: 70, nombre: "ORDEN DE COMPRA" },
  { codigo: 75, nombre: "ORDEN DE COMPRA IMPO" },
  { codigo: 76, nombre: "ORDEN COMPRA INDUSTRIA" },
  { codigo: 77, nombre: "ORDEN DE COMPRA MARKETING" },
  { codigo: 74, nombre: "ORDEN COMPRA RRHH" },
  { codigo: 78, nombre: "ORDEN DE COMPRA SISTEMAS IT" },
  { codigo: 80, nombre: "INGRESO INDUSTRIA A COMERCIAL" },
];

// Ejercicio = año calendario. El filtro de la pantalla es siempre ene→dic.
const anioActual = () => new Date().getFullYear();
const eneroDe = (a: number) => `${a}-01`;
const diciembreDe = (a: number) => `${a}-12`;
const anioDe = (ym: string) => Number(ym.slice(0, 4));

const clip = (s: string, n = 22) => (s.length > n ? s.slice(0, n) + "…" : s);
const est = (a: AreaAcum, cod: number) => a.estados.find((e) => e.estado === cod);
const areaCorta = (codigo: number, nombre: string) =>
  AREA_CORTA[codigo] ??
  clip(nombre.replace(/^ORDEN\s+(DE\s+)?COMPRA/i, "OC").trim(), 18);
const rotulo = (p: PresupAprobado) =>
  p.mesDesde === p.mesHasta
    ? fmtMes(p.mesDesde)
    : `${fmtMes(p.mesDesde)} → ${fmtMes(p.mesHasta)}`;

const idxMes = (ym: string) =>
  Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1;
// Techo de la ventana que se pide aparte para medir las barras: un presupuesto
// no pasa de 36 meses, pero varios encadenados sí podrían — y no vale barrer
// años de OC para dibujar una barra.
const MAX_MESES_SERIE = 60;
/**
 * Ventana que hay que leer para medir las barras: la unión de los períodos de
 * los presupuestos que caen en el filtro. Devuelve `null` cuando el filtro ya
 * la cubre (o cuando se va de MAX_MESES_SERIE) y entonces no se pide nada.
 */
function rangoPresupuestos(apr: PresupAprobado[], dsd: string, hst: string) {
  let desde = "";
  let hasta = "";
  for (const p of apr) {
    if (p.mesesPeriodo <= 0) continue;
    if (!desde || p.mesDesde < desde) desde = p.mesDesde;
    if (!hasta || p.mesHasta > hasta) hasta = p.mesHasta;
  }
  if (!desde || !hasta) return null;
  if (desde >= dsd && hasta <= hst) return null;
  if (idxMes(hasta) - idxMes(desde) + 1 > MAX_MESES_SERIE) return null;
  return { desde, hasta };
}

export function PresupuestosTab() {
  // Ejercicio en curso por defecto. `desde`/`hasta` se derivan: la pantalla ya
  // no tiene rango libre de meses.
  const [anio, setAnio] = useState(anioActual);
  const desde = eneroDe(anio);
  const hasta = diciembreDe(anio);
  // Años ofrecidos en el selector: los que tienen algún presupuesto cargado,
  // más el actual. Salen de leer la tabla de aprobados SIN rango (pocas filas).
  const [anios, setAnios] = useState<number[]>(() => [anioActual()]);
  const [d, setD] = useState<OcPorArea | null>(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aprobados, setAprobados] = useState<PresupAprobado[]>([]);
  // OC de TODO el período de los presupuestos que entran en el filtro (no sólo
  // de los meses mirados): es contra eso que se llena la barra del 100 %.
  // `null` = el filtro ya cubre esos meses y alcanza con `d`.
  const [ocPresup, setOcPresup] = useState<OcPorArea | null>(null);
  const [esAdmin, setEsAdmin] = useState(false);
  const [modal, setModal] = useState(false);
  // Área cuyo detalle de OC se está mirando (modal). null = cerrado. Lleva su
  // propio rango: el del PRESUPUESTO de esa fila (no el filtro de pantalla),
  // que es la pregunta que contesta el modal — "qué OC entran en este
  // presupuesto". Sin presupuesto cargado cae al año filtrado.
  const [detalle, setDetalle] = useState<{
    codigo: number;
    area: string;
    desde: string;
    hasta: string;
    periodo: string | null;
  } | null>(null);

  const cargar = useCallback(async (dsd: string, hst: string) => {
    setCargando(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ desde: dsd, hasta: hst });
      // Las dos mitades del cuadro (ejecutado y aprobado) se piden en
      // paralelo: son fuentes distintas y ninguna depende de la otra.
      const [resOc, resApr] = await Promise.all([
        fetch(`/api/finanza/presupuestos?${qs}`, { cache: "no-store" }),
        fetch(`/api/finanza/presupuestos/aprobados?${qs}`, { cache: "no-store" }),
      ]);
      const json = await resOc.json();
      if (!resOc.ok) throw new Error(json?.error ?? "No se pudieron traer las OC");
      setD(json as OcPorArea);
      // Que falte la tabla de presupuestos no puede voltear la vista de OC.
      const jsonApr = resApr.ok ? await resApr.json().catch(() => null) : null;
      const apr: PresupAprobado[] = jsonApr?.presupuestos ?? [];
      setAprobados(apr);

      // La barra mide contra el 100 % del presupuesto, así que lo gastado tiene
      // que ser el de TODO el período del presupuesto y no el de los meses
      // filtrados (recortando el filtro bajaba el % y parecía que se gastó
      // menos de lo que se gastó). Se pide UNA sola vez sobre la unión de los
      // períodos que entran en el filtro y después cada área se recorta con su
      // propio rango: es la misma consulta agregada de siempre (GROUP BY mes ×
      // comprobante × estado), no una por área. Si el filtro ya cubre todo, no
      // se pide nada.
      const rango = rangoPresupuestos(apr, dsd, hst);
      if (!rango) {
        setOcPresup(null);
      } else {
        const resP = await fetch(
          `/api/finanza/presupuestos?${new URLSearchParams(rango)}`,
          { cache: "no-store" },
        );
        // Que falle el rango largo no puede voltear la vista: se cae al filtro.
        setOcPresup(
          resP.ok ? ((await resP.json().catch(() => null)) as OcPorArea | null) : null,
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error inesperado");
      setD(null);
      setOcPresup(null);
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => {
    cargar(desde, hasta);
  }, [cargar, desde, hasta]);

  // Años con presupuesto cargado, para el selector. Se pide UNA vez al montar
  // (sin rango = todos los presupuestos, que son unas pocas filas de Postgres)
  // y se recalcula sólo al crear/borrar uno. Un año sin presupuestos no se
  // ofrece: no habría nada que mirar.
  const cargarAnios = useCallback(async () => {
    try {
      const r = await fetch("/api/finanza/presupuestos/aprobados", {
        cache: "no-store",
      });
      if (!r.ok) return;
      const j = await r.json().catch(() => null);
      const lista: PresupAprobado[] = j?.presupuestos ?? [];
      const set = new Set<number>([anioActual()]);
      for (const p of lista) {
        set.add(anioDe(p.mesDesde));
        set.add(anioDe(p.mesHasta));
      }
      setAnios([...set].sort((a, b) => b - a));
    } catch {
      /* el selector se queda con el año actual: no vale voltear la vista */
    }
  }, []);

  useEffect(() => {
    cargarAnios();
  }, [cargarAnios]);

  // El alta/baja de presupuestos es sólo ADMIN (lo vuelve a chequear la API;
  // esto es nada más para no mostrar botones que van a dar 403).
  useEffect(() => {
    let vivo = true;
    fetch("/api/auth/me", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (vivo) setEsAdmin(j?.usuario?.rol === "ADMIN");
      })
      .catch(() => {});
    return () => {
      vivo = false;
    };
  }, []);

  const vista = useMemo(() => {
    if (!d) return null;
    const r = d.resumen;
    const porEstado = new Map(d.porEstado.map((e) => [e.estado, e]));
    const cumpl = porEstado.get(EST_CUMPLIDA);
    const pend = porEstado.get(EST_PENDIENTE);
    const parcial = porEstado.get(EST_PARCIAL);

    const donut = d.porEstado.map((e) => ({
      name: `${ESTADO_LABEL[e.estado] ?? e.nombre} (${fmtNum(e.items)})`,
      value: e.items,
      color: COLOR_ESTADO[e.estado] ?? PALETTE[e.estado % PALETTE.length],
    }));

    // Una barra POR ÁREA, sin abrir por estado: el gráfico responde "cuánta
    // plata mueve cada área", y el estado se mira en el donut y en la tabla.
    // El detalle por estado queda en el tooltip para no perderlo.
    const barras: BarraH[] = d.areas
      .filter((a) => a.importe > 0)
      .map((a, i) => ({
        label: areaCorta(a.codigo, a.area),
        value: a.importe,
        color: PALETTE[i % PALETTE.length],
        hint:
          `${a.area}: ${fmtArs(a.importe)} · ${fmtNum(a.ocs)} OC · ` +
          `${fmtNum(a.items)} items — ` +
          a.estados
            .filter((e) => e.importe > 0)
            .map((e) => `${ESTADO_LABEL[e.estado] ?? e.nombre} ${fmtShort(e.importe)}`)
            .join(" · "),
      }))
      .sort((x, y) => y.value - x.value);

    const rows: MatRow[] = d.areas.map((a) => {
      const p = est(a, EST_PENDIENTE);
      const c = est(a, EST_CUMPLIDA);
      const pa = est(a, EST_PARCIAL);
      return {
        label: a.area,
        cells: [
          p ? <span className="text-red-400">{fmtNum(p.items)}</span> : "—",
          p ? <span className="text-red-400">{fmtArs(p.importe)}</span> : "—",
          c ? <span className="text-green-400">{fmtNum(c.items)}</span> : "—",
          c ? <span className="text-green-400">{fmtArs(c.importe)}</span> : "—",
          pa ? `${fmtNum(pa.items)} / ${fmtShort(pa.importe)}` : "—",
          fmtNum(a.ocs),
          <strong key="t">{fmtNum(a.items)}</strong>,
          <strong key="i">{fmtArs(a.importe)}</strong>,
        ],
      };
    });
    rows.push({
      label: "TOTAL",
      bold: true,
      rowTone: "total",
      cells: [
        fmtNum(pend?.items ?? 0),
        <span key="p" className="text-red-400">
          {fmtArs(pend?.importe ?? 0)}
        </span>,
        fmtNum(cumpl?.items ?? 0),
        <span key="c" className="text-green-400">
          {fmtArs(cumpl?.importe ?? 0)}
        </span>,
        `${fmtNum(parcial?.items ?? 0)} / ${fmtShort(parcial?.importe ?? 0)}`,
        fmtNum(r.ocs),
        fmtNum(r.items),
        fmtArs(r.importe),
      ],
    });

    const evo = d.meses.map((m) => ({
      mes: fmtMes(m.mes),
      Recibido: m.importeCumplido,
      Pendiente: m.importePendiente,
    }));

    return { d, r, cumpl, pend, parcial, donut, barras, rows, evo };
  }, [d]);

  // Ejecución del presupuesto: una fila por área, mezclando las que tienen OC
  // con las que sólo tienen presupuesto cargado (un área que aprobó plata y no
  // gastó nada tiene que verse, justamente).
  //
  // Cuando un área tiene MÁS DE UN presupuesto solapando el filtro (el anual
  // viejo y uno nuevo que arranca a mitad del rango, típicamente) manda el de
  // MAYOR COBERTURA: el que cubre más meses de los que se están mirando. Con 5
  // meses en pantalla y un presupuesto nuevo que sólo pisa 1, la barra se mide
  // contra el que pisa los otros 4. Sumar los dos daba un aprobado que no
  // existe en ningún mes; los demás quedan listados abajo, pero no cuentan.
  const ejecucion = useMemo(() => {
    const mesesFiltro = (d?.meses ?? []).map((m) => m.mes);

    // Serie mensual con la que se MIDE LA BARRA: la del rango largo si hizo
    // falta pedirlo, y si no la del filtro (que ya cubre los presupuestos).
    const fuente = ocPresup ?? d;
    const serieLarga = new Map<number, MesAcum[]>(
      (fuente?.areas ?? []).map((a) => [a.codigo, a.serieMes ?? []]),
    );
    const haySerie = [...serieLarga.values()].some((s) => s.length > 0);
    /** Gastado dentro del período del presupuesto, mire los meses que mire el filtro. */
    const gastoDelPresupuesto = (
      codigo: number,
      p: PresupAprobado,
      enFiltro: number,
    ) => {
      // API vieja sin `serieMes`: no hay con qué recortar, queda lo del filtro.
      if (!haySerie) return enFiltro;
      let total = 0;
      for (const m of serieLarga.get(codigo) ?? [])
        if (m.mes >= p.mesDesde && m.mes <= p.mesHasta) total += m.importe;
      return total;
    };

    const porArea = new Map<number, PresupAprobado[]>();
    for (const p of aprobados) {
      if (p.mesesPeriodo <= 0) continue;
      const l = porArea.get(p.codigoArea);
      if (l) l.push(p);
      else porArea.set(p.codigoArea, [p]);
    }
    // Más meses cubiertos primero; a igual cobertura gana el más reciente.
    for (const l of porArea.values())
      l.sort(
        (a, b) =>
          b.mesesPeriodo - a.mesesPeriodo || b.mesDesde.localeCompare(a.mesDesde),
      );

    type Fila = {
      codigo: number;
      area: string;
      /** Lo que llena la barra: gastado en TODO el período del presupuesto. */
      ejecutado: number;
      /** Sólo los meses filtrados (tira de meses y áreas sin presupuesto). */
      ejecutadoFiltro: number;
      /** El presupuesto COMPLETO, sin prorratear. */
      aprobado: number;
      /** El de mayor cobertura: el único que mide la barra. */
      presupuesto: PresupAprobado | null;
      /** Los otros del mismo área que caen en el filtro (informativos). */
      otros: PresupAprobado[];
      meses: CeldaMes[];
    };

    const celdas = (serie: MesAcum[] | undefined, p: PresupAprobado | null): CeldaMes[] => {
      const gasto = new Map((serie ?? []).map((m) => [m.mes, m.importe]));
      return mesesFiltro.map((mes) => ({
        mes,
        importe: gasto.get(mes) ?? 0,
        // Sin presupuesto no hay ventana contra qué contrastar: todos parejos.
        dentro: !p || (mes >= p.mesDesde && mes <= p.mesHasta),
      }));
    };

    const filas = new Map<number, Fila>();
    for (const a of d?.areas ?? []) {
      const lista = porArea.get(a.codigo) ?? [];
      const elegido = lista[0] ?? null;
      filas.set(a.codigo, {
        codigo: a.codigo,
        area: a.area,
        ejecutado: elegido
          ? gastoDelPresupuesto(a.codigo, elegido, a.importe)
          : a.importe,
        ejecutadoFiltro: a.importe,
        aprobado: elegido?.monto ?? 0,
        presupuesto: elegido,
        otros: lista.slice(1),
        meses: celdas(a.serieMes, elegido),
      });
    }
    // Áreas que presupuestaron y no gastaron un peso en el período.
    for (const [cod, lista] of porArea) {
      if (filas.has(cod)) continue;
      const elegido = lista[0];
      // Sin OC en el filtro, pero puede haber gastado en otros meses del
      // presupuesto: eso igual llena la barra.
      filas.set(cod, {
        codigo: cod,
        area: elegido.area,
        ejecutado: gastoDelPresupuesto(cod, elegido, 0),
        ejecutadoFiltro: 0,
        aprobado: elegido.monto,
        presupuesto: elegido,
        otros: lista.slice(1),
        meses: celdas(undefined, elegido),
      });
    }

    const lista = [...filas.values()].sort(
      (x, y) => (y.aprobado || y.ejecutado) - (x.aprobado || x.ejecutado),
    );
    const totalAprobado = lista.reduce((s, f) => s + f.aprobado, 0);
    // El total que se compara contra el aprobado cuenta SÓLO las áreas con
    // presupuesto: sumarle las que no tienen daba un porcentaje contra una base
    // que no existe.
    const totalEjecutado = lista.reduce(
      (s, f) => s + (f.aprobado > 0 ? f.ejecutado : 0),
      0,
    );
    // Las áreas sin presupuesto se dibujan relativas entre ellas, con lo del filtro.
    const referencia = Math.max(
      0,
      ...lista.filter((f) => f.aprobado <= 0).map((f) => f.ejecutadoFiltro),
    );
    return { lista, totalAprobado, totalEjecutado, referencia };
  }, [d, aprobados, ocPresup]);

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3 mb-5">
        <PageTitle
          title="Presupuestos / Órdenes de Compra"
          sub="Presupuestos anuales por área (tipo de comprobante) — datos en vivo de Magnus, importes pesificados a la cotización de cada OC"
        />
        <div className="flex items-end gap-2 pb-1">
          <label className="flex flex-col text-[10px] uppercase tracking-wider text-zinc-500">
            Ejercicio
            <select
              value={anio}
              onChange={(e) => setAnio(Number(e.target.value))}
              className="mt-1 bg-[#171717] border border-zinc-800 rounded-md px-2.5 py-1.5 text-[12px] text-zinc-200 focus:border-yellow-400/60 outline-none tabular-nums"
            >
              {anios.map((a) => (
                <option key={a} value={a}>
                  {a}
                  {a === anioActual() ? " (en curso)" : ""}
                </option>
              ))}
            </select>
          </label>
          <button
            onClick={() => cargar(desde, hasta)}
            disabled={cargando}
            className="flex items-center gap-2 bg-[#171717] border border-zinc-800 hover:border-yellow-400/60 rounded-md px-3 py-1.5 text-[12px] text-zinc-300 disabled:opacity-50"
          >
            {cargando ? (
              <Loader2 size={13} className="animate-spin text-yellow-400" />
            ) : (
              <RefreshCw size={13} />
            )}
            Actualizar
          </button>
        </div>
      </div>

      {error && (
        <Alert tone="red">
          <AlertTriangle size={14} className="mt-px shrink-0" />
          {error}
        </Alert>
      )}

      {!error && !vista && (
        <div className="flex items-center justify-center gap-3 py-24 text-zinc-600 text-sm">
          {cargando ? (
            <>
              <Loader2 size={16} className="animate-spin text-yellow-400" />
              Consultando órdenes de compra…
            </>
          ) : (
            "Sin órdenes de compra en el período"
          )}
        </div>
      )}

      {vista && (
        <>
          <Grid cols={4}>
            <KPI
              label="Total items OC"
              value={fmtNum(vista.r.items)}
              sub={`${fmtNum(vista.r.ocs)} órdenes · ${fmtMes(vista.d.desde)}${
                vista.d.desde === vista.d.hasta ? "" : ` → ${fmtMes(vista.d.hasta)}`
              }`}
              accent="neutral"
            />
            <KPI
              label="Órdenes cumplidas"
              value={fmtNum(vista.cumpl?.items ?? 0)}
              sub={`${fmtShort(vista.r.importeCumplido)} recibido`}
              accent="green"
            />
            <KPI
              label="Pendientes de recibir"
              value={fmtNum(vista.pend?.items ?? 0)}
              sub={`${fmtShort(vista.r.importePendiente)} pendiente`}
              accent="red"
            />
            <KPI
              label="Importe total OC"
              value={fmtShort(vista.r.importe)}
              sub={
                ejecucion.totalAprobado > 0
                  ? `${fmtShort(ejecucion.totalAprobado)} presupuestado (total aprobado)`
                  : vista.r.importeUsd > 0
                    ? `incluye ${fmtShort(vista.r.importeUsd)} de OC en U$S`
                    : "valor total comprometido"
              }
              accent="yellow"
            />
          </Grid>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-5">
            <Panel title="Estado de órdenes" accent="(items)">
              <ChartDonut
                data={vista.donut}
                height={280}
                fmt={(n) => fmtNum(n)}
              />
            </Panel>
            <Panel title="Importe por área" accent="($ · total por área)">
              <BarrasH data={vista.barras} labelWidth={150} />
            </Panel>
          </div>

          <SectionTitle>📋 Resumen de Órdenes de Compra por Área</SectionTitle>

          {vista.pend && vista.pend.items > 0 && (
            <div className="mb-3">
              <Alert tone="amber">
                <AlertTriangle size={14} className="mt-px shrink-0" />
                <span>
                  {fmtNum(vista.pend.items)} items pendientes de recibir por{" "}
                  {fmtArs(vista.pend.importe)}. Mayor concentración en{" "}
                  {[...vista.d.areas]
                    .filter((a) => (est(a, EST_PENDIENTE)?.importe ?? 0) > 0)
                    .sort(
                      (a, b) =>
                        (est(b, EST_PENDIENTE)?.importe ?? 0) -
                        (est(a, EST_PENDIENTE)?.importe ?? 0),
                    )
                    .slice(0, 2)
                    .map(
                      (a) =>
                        `${a.area} (${fmtShort((est(a, EST_PENDIENTE)?.importe ?? 0))})`,
                    )
                    .join(" y ")}
                  .
                </span>
              </Alert>
            </div>
          )}

          <MatrixTable
            firstLabel="Área"
            head={[
              "Pend. items",
              "Importe pend. ($)",
              "Cumplida items",
              "Importe cumpl. ($)",
              "Cumpl. parcial",
              "OC",
              "Items",
              "Importe total ($)",
            ]}
            rows={vista.rows}
          />

          <div className="flex items-center gap-3 mt-7 mb-3">
            <span className="text-[13px] font-semibold text-zinc-100">
              🎯 Ejecución del presupuesto por área
            </span>
            <span className="flex-1 h-px bg-zinc-800" />
            {esAdmin && (
              <button
                onClick={() => setModal(true)}
                className="flex items-center gap-1.5 bg-[#171717] border border-zinc-800 hover:border-yellow-400/60 rounded-md px-2.5 py-1 text-[11px] text-zinc-300"
              >
                <Plus size={12} className="text-yellow-400" />
                Crear presupuesto
              </button>
            )}
          </div>

          <p className="text-[11px] text-zinc-600 mb-3">
            La barra es el 100 % del presupuesto anual del área y se rellena con
            todo lo gastado dentro de su período, cumplido o no. Abajo de cada
            barra, el ejercicio partido mes a mes con lo gastado en cada uno
            (encendidos los meses que cubre el presupuesto) y el presupuesto que
            se está usando. Click en la fila: se abren las órdenes de compra que
            entran en el período de ese presupuesto. Si un área tiene varios
            presupuestos en el año, manda el que cubre más meses; los otros
            quedan listados sin contar.
            {ejecucion.totalAprobado > 0 && (
              <>
                {" "}
                Total: {fmtArs(ejecucion.totalEjecutado)} ejecutado sobre{" "}
                {fmtArs(ejecucion.totalAprobado)} aprobado (
                {(
                  (ejecucion.totalEjecutado / ejecucion.totalAprobado) *
                  100
                ).toLocaleString("es-AR", { maximumFractionDigits: 0 })}{" "}
                %).
              </>
            )}
          </p>

          {ejecucion.totalAprobado === 0 && (
            <div className="mb-3">
              <Alert tone="neutral">
                Todavía no hay presupuestos aprobados cargados para el ejercicio{" "}
                {anio}
                {esAdmin
                  ? ": creá uno con “Crear presupuesto” y las barras pasan a medir el consumo."
                  : ". Las barras muestran el importe relativo de cada área."}
              </Alert>
            </div>
          )}

          <div className="mt-1">
            {ejecucion.lista.map((f) => {
              // El modal se abre con el RANGO DEL PRESUPUESTO de la fila: la
              // pregunta al clickear una barra es "qué OC entran en este
              // presupuesto", no "qué OC hay en el filtro". Sin presupuesto
              // cargado no hay período asignado y queda el año mirado.
              const dsd = f.presupuesto?.mesDesde ?? desde;
              const hst = f.presupuesto?.mesHasta ?? hasta;
              const abrir = () =>
                setDetalle({
                  codigo: f.codigo,
                  area: f.area,
                  desde: dsd,
                  hasta: hst,
                  periodo: f.presupuesto ? rotulo(f.presupuesto) : null,
                });
              return (
                // Toda la fila abre el detalle de OC del área (modal con las OC
                // del período del presupuesto, agrupadas por mes). Es un div y
                // no un <button> porque adentro hay botones propios (borrar
                // presupuesto), que cortan la propagación.
                <div
                key={f.codigo}
                role="button"
                tabIndex={0}
                title={
                  f.presupuesto
                    ? `Ver las órdenes de compra de ${f.area} en el período del presupuesto (${rotulo(f.presupuesto)})`
                    : `Ver las órdenes de compra de ${f.area}`
                }
                onClick={abrir}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    abrir();
                  }
                }}
                className="mb-3 rounded-md px-2 py-1 -mx-2 cursor-pointer hover:bg-[#141414] focus:outline-none focus:ring-1 focus:ring-yellow-400/40"
              >
                <BarraPresupuesto
                  label={f.area}
                  ejecutado={f.ejecutado}
                  aprobado={f.aprobado}
                  referencia={ejecucion.referencia}
                  fmt={(n) => fmtShort(n)}
                />
                {f.meses.length > 1 && (
                  <TiraMeses meses={f.meses} fmt={(n) => fmtShort(n)} />
                )}
                {/* El presupuesto va PEGADO a su barra, no en una tabla aparte
                    al pie: con varias áreas cargadas había que ir y volver
                    para saber cuál era el de cada barra. */}
                {f.presupuesto && (
                  <div className="ml-[198px] mt-1 space-y-0.5">
                    {[f.presupuesto, ...f.otros].map((p, i) => (
                      <div
                        key={p.id}
                        className={`flex items-center gap-2 text-[10px] ${
                          i === 0 ? "text-zinc-400" : "text-zinc-600"
                        }`}
                      >
                        <span
                          className={
                            i === 0 ? "text-yellow-400/70" : "text-zinc-700"
                          }
                        >
                          ▸
                        </span>
                        <span className="tabular-nums">{rotulo(p)}</span>
                        <span className="text-zinc-700">·</span>
                        <span className="tabular-nums">
                          {fmtArs(p.monto)} aprobado
                        </span>
                        <span className="text-zinc-700">·</span>
                        {i === 0 && (
                          <>
                            <span className="tabular-nums text-yellow-400/80">
                              {fmtArs(f.ejecutado)} gastado en el período (
                              {((f.ejecutado / p.monto) * 100).toLocaleString(
                                "es-AR",
                                { maximumFractionDigits: 0 },
                              )}{" "}
                              %)
                            </span>
                            <span className="text-zinc-700">·</span>
                          </>
                        )}
                        {/* El prorrateo ya NO mide la barra: queda como dato de
                            cuánto del presupuesto cae en los meses mirados. */}
                        <span className="tabular-nums text-zinc-500">
                          {p.mesesPeriodo === p.meses
                            ? "entra completo en el filtro"
                            : `${fmtArs(p.montoPeriodo)} en el filtro (${p.mesesPeriodo}/${p.meses} meses)`}
                        </span>
                        {p.nota && (
                          <span className="text-zinc-600 truncate">— {p.nota}</span>
                        )}
                        {i > 0 && (
                          <span className="rounded border border-zinc-800 px-1 text-[9px] text-zinc-600">
                            menor cobertura · no se usa
                          </span>
                        )}
                        {esAdmin && (
                          <button
                            title="Borrar presupuesto"
                            onClick={async (e) => {
                              e.stopPropagation();
                              await fetch(
                                `/api/finanza/presupuestos/aprobados?id=${p.id}`,
                                { method: "DELETE" },
                              );
                              cargar(desde, hasta);
                              cargarAnios();
                            }}
                            className="text-zinc-700 hover:text-red-400"
                          >
                            <Trash2 size={11} />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                </div>
              );
            })}
          </div>

          {vista.d.meses.length > 1 && (
            <>
              <SectionTitle>📈 Evolución mensual</SectionTitle>
              <Panel>
                <ChartBar
                  data={vista.evo}
                  xKey="mes"
                  height={260}
                  series={[
                    { key: "Recibido", name: "Recibido", color: COLOR_ESTADO[2], stackId: "a" },
                    { key: "Pendiente", name: "Pendiente", color: COLOR_ESTADO[1], stackId: "a" },
                  ]}
                />
              </Panel>
            </>
          )}

          <SectionTitle>👤 Por comprador</SectionTitle>
          <MatrixTable
            firstLabel="Comprador"
            head={["OC", "Items", "Recibido ($)", "Pendiente ($)", "Importe total ($)"]}
            rows={vista.d.compradores.map((c) => ({
              label: c.comprador,
              cells: [
                fmtNum(c.ocs),
                fmtNum(c.items),
                <span key="r" className="text-green-400">
                  {fmtArs(c.importeCumplido)}
                </span>,
                <span key="p" className="text-red-400">
                  {fmtArs(c.importePendiente)}
                </span>,
                <strong key="t">{fmtArs(c.importe)}</strong>,
              ],
            }))}
          />

          <p className="text-[11px] text-zinc-600 mt-4 leading-relaxed">
            Fuente: Com_OrdCompCabecera / Com_OrdCompRenglones (Magnus, lectura
            en vivo). El área es el tipo de comprobante de la OC. Importe = suma
            de (unidades pedidas × precio del renglón neto de bonificaciones),
            pesificado a la cotización de cada OC. Los presupuestos aprobados no
            están en Magnus: se cargan a mano y viven en Postgres.
            {vista.d.canceladas.items > 0 && (
              <>
                {" "}
                Fuera del cuadro: {fmtNum(vista.d.canceladas.items)} items de OC
                canceladas por {fmtArs(vista.d.canceladas.importe)}.
              </>
            )}
          </p>
        </>
      )}

      {detalle && (
        <ModalDetalleOC
          codigo={detalle.codigo}
          area={detalle.area}
          desde={detalle.desde}
          hasta={detalle.hasta}
          periodo={detalle.periodo}
          onCerrar={() => setDetalle(null)}
        />
      )}

      {modal && (
        <ModalPresupuesto
          anio={anio}
          anios={anios}
          onCerrar={() => setModal(false)}
          onGuardado={() => {
            setModal(false);
            cargar(desde, hasta);
            cargarAnios();
          }}
        />
      )}
    </div>
  );
}

// ─── Detalle de OC del área (modal por acordeones de mes) ────────────────────
// Se abre al hacer click en cualquier fila de "Ejecución del presupuesto"
// (2026-09-02). Trae las OC del área en el PERÍODO DEL PRESUPUESTO de esa fila
// — el mismo rango contra el que se mide la barra, no el filtro de pantalla:
// clickear una barra pregunta "qué OC entran en este presupuesto", así que el
// total del modal tiene que cerrar con el "gastado en el período" de la barra.
// Si el área no tiene presupuesto cargado no hay período asignado y queda el
// ejercicio mirado. Una fila por OC (cabecera), agrupadas en acordeones por mes
// como en /compras/faltantes: uno solo abierto a la vez, y arranca abierto el
// primer mes CON OC (que es el más nuevo: la API devuelve los meses al revés).
//
// El recorte es el mismo del agregado (canceladas afuera, importes pesificados
// a la cotización de cada OC), así lo que suma el modal cierra con la tira de
// meses de la fila.
//
// Cierre: click en el fondo, botón X o Escape.

type OcDetalleFila = {
  oc: number;
  mes: string;
  numero: string;
  fecha: string | null;
  estado: number;
  estadoNombre: string;
  proveedor: string | null;
  comprador: string | null;
  observacion: string | null;
  pedidoProveedor: string | null;
  /** Detalle Complementario de los renglones (Com_DetalleComplement). */
  detalle: string | null;
  moneda: number;
  cotizacion: number;
  items: number;
  importe: number;
  importeCumplido: number;
  importePendiente: number;
  importeMonOrig: number;
};
type OcDetalleMes = {
  mes: string;
  ocs: number;
  items: number;
  importe: number;
  importeCumplido: number;
  importePendiente: number;
  ordenes: OcDetalleFila[];
};
type OcDetalle = {
  codigo: number;
  desde: string;
  hasta: string;
  truncado: boolean;
  maximo: number;
  resumen: { ocs: number; items: number; importe: number };
  meses: OcDetalleMes[];
};

const fmtFecha = (iso: string | null) => {
  if (!iso) return "—";
  const [a, m, d] = iso.split("-");
  return `${d}/${m}/${a}`;
};

function ModalDetalleOC({
  codigo,
  area,
  desde,
  hasta,
  periodo,
  onCerrar,
}: {
  codigo: number;
  area: string;
  desde: string;
  hasta: string;
  /** Rótulo del presupuesto que definió el rango. null = no tiene. */
  periodo: string | null;
  onCerrar: () => void;
}) {
  const [data, setData] = useState<OcDetalle | null>(null);
  const [cargando, setCargando] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [abierto, setAbierto] = useState<string | null>(null);

  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCerrar();
    };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [onCerrar]);

  useEffect(() => {
    let vivo = true;
    setCargando(true);
    setErr(null);
    const qs = new URLSearchParams({ codigo: String(codigo), desde, hasta });
    fetch(`/api/finanza/presupuestos/detalle?${qs}`, { cache: "no-store" })
      .then(async (r) => {
        const j = await r.json().catch(() => null);
        if (!r.ok) throw new Error(j?.error ?? "No se pudo traer el detalle");
        return j as OcDetalle;
      })
      .then((j) => {
        if (!vivo) return;
        setData(j);
        // Arranca abierto el primer mes con OC (el más nuevo del rango).
        setAbierto(j.meses.find((m) => m.ocs > 0)?.mes ?? null);
      })
      .catch((e) => {
        if (vivo) setErr(e instanceof Error ? e.message : "Error inesperado");
      })
      .finally(() => {
        if (vivo) setCargando(false);
      });
    return () => {
      vivo = false;
    };
  }, [codigo, desde, hasta]);

  // Los meses sin una sola OC no ocupan un acordeón vacío.
  const meses = (data?.meses ?? []).filter((m) => m.ocs > 0);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 p-4 overflow-y-auto"
      onClick={onCerrar}
    >
      <div
        className="w-full max-w-5xl my-6 bg-[#171717] border border-zinc-800 rounded-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-zinc-800">
          <div className="min-w-0">
            <h3 className="text-yellow-400 font-semibold text-sm uppercase tracking-wide truncate">
              {area}
            </h3>
            <p className="text-[11px] text-zinc-500 mt-0.5">
              {periodo ? "Período del presupuesto: " : "Órdenes de compra de "}
              {fmtMes(desde)}
              {desde === hasta ? "" : ` → ${fmtMes(hasta)}`}
              {data && (
                <>
                  {" · "}
                  {fmtNum(data.resumen.ocs)} OC · {fmtNum(data.resumen.items)}{" "}
                  items ·{" "}
                  <span className="text-zinc-300">
                    {fmtArs(data.resumen.importe)}
                  </span>
                </>
              )}
            </p>
          </div>
          <button
            onClick={onCerrar}
            className="text-zinc-600 hover:text-zinc-300 shrink-0"
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-5">
          {err && (
            <Alert tone="red">
              <AlertTriangle size={14} className="mt-px shrink-0" />
              {err}
            </Alert>
          )}

          {cargando && (
            <div className="flex items-center justify-center gap-3 py-16 text-zinc-600 text-sm">
              <Loader2 size={16} className="animate-spin text-yellow-400" />
              Consultando órdenes de compra…
            </div>
          )}

          {!cargando && !err && meses.length === 0 && (
            <div className="py-16 text-center text-sm text-zinc-500">
              Esta área no tiene órdenes de compra en el período.
            </div>
          )}

          {data?.truncado && (
            <div className="mb-3">
              <Alert tone="amber">
                <AlertTriangle size={14} className="mt-px shrink-0" />
                Se muestran las primeras {fmtNum(data.maximo)} órdenes del
                período del presupuesto.
              </Alert>
            </div>
          )}

          <div className="flex flex-col gap-2">
            {meses.map((m) => {
              const open = abierto === m.mes;
              return (
                <div
                  key={m.mes}
                  className="rounded-xl border border-zinc-800 overflow-hidden"
                >
                  {/* Acordeón: click abre este mes y cierra el resto. */}
                  <button
                    type="button"
                    onClick={() => setAbierto((x) => (x === m.mes ? null : m.mes))}
                    className="w-full flex items-center justify-between gap-3 px-4 py-2.5 bg-[#1A1A1A] text-left hover:bg-[#222] transition-colors"
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      {open ? (
                        <ChevronDown size={15} className="text-zinc-500 shrink-0" />
                      ) : (
                        <ChevronRight size={15} className="text-zinc-500 shrink-0" />
                      )}
                      <span className="font-medium text-zinc-100 truncate">
                        {fmtMes(m.mes)}
                      </span>
                      <span className="text-[11px] text-zinc-500 shrink-0">
                        {fmtNum(m.ocs)} OC · {fmtNum(m.items)} items
                      </span>
                    </span>
                    <span className="text-sm tabular-nums text-zinc-300 shrink-0">
                      {fmtArs(m.importe)}
                    </span>
                  </button>

                  {open && (
                    <div className="border-t border-zinc-800 overflow-x-auto">
                      <table className="w-full text-[11px]">
                        <thead>
                          <tr className="text-zinc-500 uppercase tracking-wider text-[10px] bg-[#141414]">
                            <th className="text-left font-medium px-3 py-2">Fecha</th>
                            <th className="text-left font-medium px-3 py-2">
                              Nº movimiento
                            </th>
                            <th className="text-left font-medium px-3 py-2">
                              Proveedor
                            </th>
                            <th className="text-left font-medium px-3 py-2">Estado</th>
                            <th className="text-right font-medium px-3 py-2">Monto</th>
                            <th className="text-left font-medium px-3 py-2">
                              Detalle / observación
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {m.ordenes.map((o) => (
                            <tr
                              key={o.oc}
                              className="border-t border-zinc-900 hover:bg-[#1b1b1b]"
                            >
                              <td className="px-3 py-1.5 tabular-nums text-zinc-400 whitespace-nowrap">
                                {fmtFecha(o.fecha)}
                              </td>
                              <td className="px-3 py-1.5 tabular-nums text-zinc-200 whitespace-nowrap">
                                {o.numero}
                              </td>
                              <td
                                className="px-3 py-1.5 text-zinc-300 max-w-[220px] truncate"
                                title={o.proveedor ?? ""}
                              >
                                {o.proveedor ?? "—"}
                              </td>
                              <td className="px-3 py-1.5 whitespace-nowrap">
                                <span
                                  style={{
                                    color: COLOR_ESTADO[o.estado] ?? "#a1a1aa",
                                  }}
                                >
                                  {ESTADO_LABEL[o.estado] ?? o.estadoNombre}
                                </span>
                              </td>
                              <td className="px-3 py-1.5 text-right tabular-nums text-zinc-100 whitespace-nowrap">
                                {fmtArs(o.importe)}
                                {/* Las OC de impo se cargan en U$S: se muestra
                                    el pesificado y, al lado, el original. */}
                                {o.moneda !== 1 && o.cotizacion > 1 && (
                                  <span className="block text-[9px] text-zinc-600">
                                    U$S {fmtNum(o.importeMonOrig)} @{" "}
                                    {fmtNum(o.cotizacion)}
                                  </span>
                                )}
                              </td>
                              <td
                                className="px-3 py-1.5 text-zinc-400 max-w-[320px] truncate"
                                title={
                                  [o.detalle, o.observacion]
                                    .filter(Boolean)
                                    .join(" · ")
                                }
                              >
                                {[o.detalle, o.observacion]
                                  .filter(Boolean)
                                  .join(" · ") ||
                                  (o.pedidoProveedor
                                    ? `Pedido prov. ${o.pedidoProveedor}`
                                    : "—")}
                                {o.comprador && (
                                  <span className="text-zinc-600">
                                    {" "}
                                    · {o.comprador}
                                  </span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <p className="text-[10px] text-zinc-600 mt-4 leading-relaxed">
            Una fila por orden de compra. Monto = suma de los renglones
            (unidades pedidas × precio neto de bonificaciones), pesificado a la
            cotización de la OC. Las OC canceladas quedan afuera, igual que en
            los totales de la pantalla.
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── Alta de presupuesto aprobado ────────────────────────────────────────────
// El monto se carga en MILLONES a propósito (no hay que escribir los ceros); la
// API lo multiplica antes de guardar. El período NO se elige mes a mes: los
// presupuestos son ANUALES, así que se elige el EJERCICIO y se guarda
// enero→diciembre de ese año. (La API sigue aceptando rangos libres — los
// presupuestos viejos cargados a mano se siguen leyendo igual.) Se ofrece el
// año en curso, el siguiente y los que ya tienen algo cargado.
function ModalPresupuesto({
  anio,
  anios,
  onCerrar,
  onGuardado,
}: {
  anio: number;
  anios: number[];
  onCerrar: () => void;
  onGuardado: () => void;
}) {
  const [codigo, setCodigo] = useState(AREAS_CATALOGO[0].codigo);
  const [ejercicio, setEjercicio] = useState(anio);
  const mesDesde = eneroDe(ejercicio);
  const mesHasta = diciembreDe(ejercicio);
  const opciones = useMemo(
    () =>
      [...new Set([...anios, anioActual(), anioActual() + 1, anio])].sort(
        (a, b) => b - a,
      ),
    [anios, anio],
  );
  const [millones, setMillones] = useState("");
  const [nota, setNota] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const monto = Number(millones.replace(/\./g, "").replace(",", "."));
  const valido = Number.isFinite(monto) && monto > 0;

  const guardar = async () => {
    if (!valido) return;
    setGuardando(true);
    setErr(null);
    try {
      const res = await fetch("/api/finanza/presupuestos/aprobados", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          codigoArea: codigo,
          area: AREAS_CATALOGO.find((a) => a.codigo === codigo)?.nombre ?? "",
          mesDesde,
          mesHasta,
          montoMillones: monto,
          nota: nota || null,
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error ?? "No se pudo guardar");
      onGuardado();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error inesperado");
    } finally {
      setGuardando(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onCerrar}
    >
      <div
        className="w-full max-w-md bg-[#171717] border border-zinc-800 rounded-lg p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-yellow-400 font-semibold text-sm uppercase tracking-wide">
            Crear presupuesto
          </h3>
          <button onClick={onCerrar} className="text-zinc-600 hover:text-zinc-300">
            <X size={16} />
          </button>
        </div>

        <label className="block text-[11px] uppercase tracking-wider text-zinc-500 mb-3">
          Área
          <select
            value={codigo}
            onChange={(e) => setCodigo(Number(e.target.value))}
            className="block w-full mt-1 bg-[#111] border border-zinc-800 rounded-md px-2.5 py-1.5 text-[12px] text-zinc-200 focus:border-yellow-400/60 outline-none"
          >
            {AREAS_CATALOGO.map((a) => (
              <option key={a.codigo} value={a.codigo}>
                {a.nombre}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-[11px] uppercase tracking-wider text-zinc-500 mb-1">
          Ejercicio (anual)
          <select
            value={ejercicio}
            onChange={(e) => setEjercicio(Number(e.target.value))}
            className="block w-full mt-1 bg-[#111] border border-zinc-800 rounded-md px-2.5 py-1.5 text-[12px] text-zinc-200 focus:border-yellow-400/60 outline-none tabular-nums"
          >
            {opciones.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
        <p className="text-[10px] text-zinc-600 mb-3">
          Se guarda para todo el año: {fmtMes(mesDesde)} → {fmtMes(mesHasta)}.
        </p>

        <label className="block text-[11px] uppercase tracking-wider text-zinc-500 mb-1">
          Monto aprobado (en millones)
          <span className="flex items-center gap-1.5 mt-1 bg-[#111] border border-zinc-800 rounded-md px-2.5 py-1.5 focus-within:border-yellow-400/60">
            <span className="text-zinc-500 text-[12px]">$</span>
            <input
              value={millones}
              onChange={(e) => setMillones(e.target.value)}
              inputMode="decimal"
              placeholder="250"
              className="flex-1 bg-transparent border-0 outline-none text-[12px] text-zinc-200"
            />
            <span className="text-zinc-500 text-[12px]">M</span>
          </span>
        </label>
        <p className="text-[10px] text-zinc-600 mb-3">
          {valido
            ? `Se guarda como ${fmtArs(monto * 1e6)}`
            : "Se carga en millones: 250 = $ 250.000.000"}
        </p>

        <label className="block text-[11px] uppercase tracking-wider text-zinc-500 mb-4">
          Nota (opcional)
          <input
            value={nota}
            onChange={(e) => setNota(e.target.value)}
            maxLength={200}
            className="block w-full mt-1 bg-[#111] border border-zinc-800 rounded-md px-2.5 py-1.5 text-[12px] text-zinc-200 focus:border-yellow-400/60 outline-none"
          />
        </label>

        {err && (
          <div className="mb-3">
            <Alert tone="red">
              <AlertTriangle size={14} className="mt-px shrink-0" />
              {err}
            </Alert>
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            onClick={onCerrar}
            className="px-3 py-1.5 text-[12px] text-zinc-400 hover:text-zinc-200"
          >
            Cancelar
          </button>
          <button
            onClick={guardar}
            disabled={!valido || guardando}
            className="flex items-center gap-2 bg-yellow-400/10 border border-yellow-400/40 hover:border-yellow-400 rounded-md px-3 py-1.5 text-[12px] text-yellow-400 disabled:opacity-40"
          >
            {guardando && <Loader2 size={13} className="animate-spin" />}
            Guardar
          </button>
        </div>
      </div>
    </div>
  );
}
