"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { RefreshCw, AlertCircle, Loader2, Percent } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InicioButton } from "@/components/ui/InicioButton";
import { UsuarioActual } from "@/components/auth/UsuarioActual";
import { abrirPicker } from "@/components/ui/abrirPicker";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { esFilaProductiva } from "@/lib/deposito/parseDeposito";
import {
  descuentoDe,
  escalaVigente,
  pctError,
  usePremioEscala,
  type VersionEscala,
} from "@/lib/rrhh/premioEscala";
import { MargenesModal } from "./MargenesModal";

// ──────────────────────────────────────────────────────────────────────────────
// Premios — productividad y errores del mes, por persona. Dos tablas:
//
//   · Preparadores → ítems recolectados en OT de Picking (WMS) y los errores
//     del mes que se le imputan (deposito.errores_mesa por Operario, los dos
//     orígenes: lo detecte la mesa o Calidad, el error es del preparador).
//   · Mesa de Control → renglones controlados (EVERWEAR) y los errores que se
//     le escaparon (sólo origen='calidad', imputados al Controlador real del
//     pedido).
//
// Todo llega ya agregado (una fila por persona) de GET /api/rrhh/premios
// → indicadores-api/premios.py; acá no se agrega nada, sólo se ordena y se
// calcula el %. El recorte de gerentes/no-operativos se hace con
// esFilaProductiva() de lib/deposito/parseDeposito.ts, la misma regla que
// /deposito y /deposito/pedidos, para que la lista de preparadores sea la
// misma en las tres vistas.
//
// La columna "% Error" se pinta con un gradiente continuo verde (0%) → rojo
// (100%), clampeado, en vez de un color fijo — así el ojo capta la magnitud
// del error sin leer el número. La escala de márgenes (botón "Márgenes",
// versionada por mes en lib/rrhh/premioEscala.ts) sigue existiendo para el
// cálculo de premio en el back, pero ya no se muestra como columna acá.
// ──────────────────────────────────────────────────────────────────────────────

interface PreparadorRow { operario: string; items: number; errores: number }
interface MesaRow { controlador: string; codigo: number | null; renglones: number; errores: number }
interface Premios { mes: string; preparadores: PreparadorRow[]; mesa: MesaRow[] }

type Orden = "cantidad" | "errores" | "pct" | "nombre";

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Mes anterior al actual, en 'YYYY-MM' — el default de la vista. */
function mesAnterior(): string {
  const h = new Date();
  const d = new Date(h.getFullYear(), h.getMonth() - 1, 1);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

const MESES = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];
function nombreMes(mes: string): string {
  const [a, m] = mes.split("-").map(Number);
  return m >= 1 && m <= 12 ? `${MESES[m - 1]} ${a}` : mes;
}

const fmtNum = (n: number) => n.toLocaleString("es-AR");
const fmtPct = (errores: number, base: number) => {
  const p = pctError(errores, base);
  return p === null ? "—" : `${p.toFixed(2)}%`;
};

interface Fila { nombre: string; cantidad: number; errores: number }

function ordenar(filas: Fila[], orden: Orden): Fila[] {
  const pct = (f: Fila) => (f.cantidad > 0 ? f.errores / f.cantidad : f.errores > 0 ? Infinity : -1);
  const copia = [...filas];
  if (orden === "nombre") return copia.sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
  if (orden === "errores") return copia.sort((a, b) => b.errores - a.errores || b.cantidad - a.cantidad);
  if (orden === "pct") return copia.sort((a, b) => pct(b) - pct(a) || b.errores - a.errores);
  return copia.sort((a, b) => b.cantidad - a.cantidad);
}

/** Interpola RGB entre dos colores, t en [0, 1]. */
function mezclarColor(a: [number, number, number], b: [number, number, number], t: number): string {
  const r = Math.round(a[0] + (b[0] - a[0]) * t);
  const g = Math.round(a[1] + (b[1] - a[1]) * t);
  const bl = Math.round(a[2] + (b[2] - a[2]) * t);
  return `rgb(${r}, ${g}, ${bl})`;
}

/** Gradiente continuo verde (0%) → rojo (100%) para el % de error, clampeado. */
const VERDE: [number, number, number] = [63, 185, 80]; // #3fb950
const AMBAR: [number, number, number] = [217, 168, 46]; // punto medio
const ROJO: [number, number, number] = [248, 81, 73]; // #f85149
function colorGradientePct(pct: number): string {
  const t = Math.max(0, Math.min(100, pct)) / 100;
  return t <= 0.5 ? mezclarColor(VERDE, AMBAR, t / 0.5) : mezclarColor(AMBAR, ROJO, (t - 0.5) / 0.5);
}

function TablaPremios({
  titulo,
  subtitulo,
  etiquetaNombre,
  etiquetaCantidad,
  filas,
  cargando,
  escala,
}: {
  titulo: string;
  subtitulo: string;
  etiquetaNombre: string;
  etiquetaCantidad: string;
  filas: Fila[];
  cargando: boolean;
  /** Versión de la escala que rige para el mes que se está mirando. */
  escala: VersionEscala | null;
}) {
  const [orden, setOrden] = useState<Orden>("cantidad");
  const tramos = escala?.tramos;
  const ordenadas = useMemo(() => ordenar(filas, orden), [filas, orden]);
  const totCant = filas.reduce((a, f) => a + f.cantidad, 0);
  const totErr = filas.reduce((a, f) => a + f.errores, 0);

  const Th = ({ campo, children, className = "" }: { campo: Orden; children: ReactNode; className?: string }) => (
    <TableHead
      className={`cursor-pointer select-none px-2.5 py-2 text-[10px] font-semibold uppercase tracking-wider whitespace-nowrap border-b border-zinc-800 hover:text-zinc-200 ${orden === campo ? "text-yellow-400" : "text-zinc-500"} ${className}`}
      onClick={() => setOrden(campo)}
      title="Ordenar por esta columna"
    >
      {children}
    </TableHead>
  );

  return (
    <section className="rounded-lg bg-[#171717] border border-zinc-800 overflow-hidden">
      <header className="px-4 py-3 border-b border-zinc-800">
        <h2 className="text-yellow-400 font-bold text-sm uppercase tracking-wide">{titulo}</h2>
        <p className="text-xs text-zinc-500 mt-1">{subtitulo}</p>
        <p className="text-[11px] text-zinc-600 mt-1">
          {escala
            ? `Escala vigente desde ${escala.vigencia}`
            : "Sin escala de premios para este mes"}
        </p>
      </header>
      <Table>
        <TableHeader>
          <TableRow className="bg-[#1f1f1f] hover:bg-[#1f1f1f]">
            <Th campo="nombre">{etiquetaNombre}</Th>
            <Th campo="cantidad" className="text-right">{etiquetaCantidad}</Th>
            <Th campo="errores" className="text-right">Errores</Th>
            <Th campo="pct" className="text-right">% Error</Th>
          </TableRow>
        </TableHeader>
        <TableBody>
          {cargando && (
            <TableRow>
              <TableCell colSpan={4} className="py-10 text-center text-zinc-600">
                <Loader2 className="h-4 w-4 animate-spin inline mr-2" />
                Consultando…
              </TableCell>
            </TableRow>
          )}
          {!cargando && !ordenadas.length && (
            <TableRow>
              <TableCell colSpan={4} className="py-10 text-center text-zinc-600">
                Sin datos en el mes
              </TableCell>
            </TableRow>
          )}
          {!cargando &&
            ordenadas.map((f) => {
              const pct = pctError(f.errores, f.cantidad);
              const descuento = descuentoDe(tramos, pct);
              return (
                <TableRow key={f.nombre} className="border-b border-zinc-800/60 hover:bg-[#1f1f1f]">
                  <TableCell className="px-2.5 text-zinc-100">{f.nombre}</TableCell>
                  <TableCell className="px-2.5 text-right tabular-nums text-zinc-200">{fmtNum(f.cantidad)}</TableCell>
                  <TableCell className={`px-2.5 text-right tabular-nums ${f.errores > 0 ? "text-[#f85149]" : "text-zinc-600"}`}>
                    {fmtNum(f.errores)}
                  </TableCell>
                  <TableCell
                    className="px-2.5 text-right tabular-nums font-medium"
                    style={pct === null ? undefined : { color: colorGradientePct(pct) }}
                    title={descuento === null ? "Sin escala de márgenes para este mes" : `Tramo: −${descuento}% de premio`}
                  >
                    {fmtPct(f.errores, f.cantidad)}
                    {descuento !== null && descuento > 0 && (
                      <span className="ml-1 text-[10px] font-normal text-zinc-500">
                        −{descuento}%
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
        </TableBody>
        {!cargando && ordenadas.length > 0 && (
          <TableFooter className="bg-[#1f1f1f]">
            <TableRow className="hover:bg-[#1f1f1f]">
              <TableCell className="px-2.5 font-semibold text-zinc-200 border-t border-zinc-700">TOTAL</TableCell>
              <TableCell className="px-2.5 text-right tabular-nums font-semibold text-yellow-400 border-t border-zinc-700">{fmtNum(totCant)}</TableCell>
              <TableCell className="px-2.5 text-right tabular-nums font-semibold text-zinc-200 border-t border-zinc-700">{fmtNum(totErr)}</TableCell>
              <TableCell
                className="px-2.5 text-right tabular-nums font-semibold border-t border-zinc-700"
                style={totCant > 0 ? { color: colorGradientePct((totErr / totCant) * 100) } : undefined}
              >
                {fmtPct(totErr, totCant)}
              </TableCell>
            </TableRow>
          </TableFooter>
        )}
      </Table>
    </section>
  );
}

export default function PremiosPage() {
  const [mes, setMes] = useState(mesAnterior);
  const [data, setData] = useState<Premios | null>(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [margenes, setMargenes] = useState(false);
  const { escalas, puedeEditar, guardar, borrar } = usePremioEscala();

  const cargar = useCallback(async (m: string) => {
    setCargando(true);
    setError(null);
    try {
      const res = await fetch(`/api/rrhh/premios?mes=${m}`, { cache: "no-store" });
      const json = (await res.json().catch(() => null)) as (Premios & { error?: string }) | null;
      if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);
      setData(json);
    } catch (e) {
      setData(null);
      setError(e instanceof Error ? e.message : "No se pudo cargar");
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => {
    if (mes) cargar(mes);
  }, [mes, cargar]);

  // Preparadores: mismo recorte de gerentes/no-operativos que /deposito.
  const preparadores = useMemo<Fila[]>(
    () =>
      (data?.preparadores ?? [])
        .filter((r) => esFilaProductiva(r.operario, "Picking"))
        .map((r) => ({ nombre: r.operario, cantidad: r.items, errores: r.errores })),
    [data],
  );
  const mesa = useMemo<Fila[]>(
    () => (data?.mesa ?? []).map((r) => ({ nombre: r.controlador, cantidad: r.renglones, errores: r.errores })),
    [data],
  );

  // La escala que regía en el mes que se está mirando (no la de hoy): un mes ya
  // liquidado se sigue viendo con los márgenes que tenía.
  const escalaPrep = useMemo(() => escalaVigente(escalas.preparado, mes), [escalas, mes]);
  const escalaMesa = useMemo(() => escalaVigente(escalas.mesa, mes), [escalas, mes]);

  return (
    // `dark` + el mismo fondo #111111 que /deposito, /compras y /ventas: los
    // componentes de shadcn (Table, Button, Input) resuelven sus variables
    // contra el bloque .dark de globals.css, así que alcanza con envolver.
    <div className="dark min-h-screen bg-[#111111] text-white">
    <div className="container mx-auto px-6 py-8 max-w-6xl">
      <InicioButton label="Inicio" iconSize={16} className="text-sm text-zinc-500 hover:text-yellow-400 transition-colors mb-4" />
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-yellow-400 font-bold text-xl uppercase tracking-wide">Premios</h1>
          <p className="text-sm text-zinc-500 mt-1">
            Preparado y controlado de {nombreMes(mes)}, con los errores de cada uno.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="month"
            value={mes}
            max={`${new Date().getFullYear()}-${pad2(new Date().getMonth() + 1)}`}
            onChange={(e) => setMes(e.target.value)}
            onClick={abrirPicker}
            className="cursor-pointer bg-zinc-900 border border-zinc-700 text-zinc-200 rounded-md px-3 py-1.5 text-sm outline-none focus:border-yellow-400 transition-colors [color-scheme:dark]"
          />
          <button
            type="button"
            onClick={() => setMargenes(true)}
            title={puedeEditar ? "Cargar o corregir los tramos de errores y el % de premio" : "Ver los márgenes de premio"}
            className="flex items-center gap-1.5 rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:border-yellow-400 hover:text-yellow-400 transition-colors"
          >
            <Percent size={14} />
            Márgenes
          </button>
          <Button variant="outline" size="icon" onClick={() => cargar(mes)} disabled={cargando} title="Recargar">
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

      <div className="grid gap-6 lg:grid-cols-2">
        <TablaPremios
          titulo="Preparadores"
          subtitulo="Ítems recolectados en OT de Picking y errores detectados sobre lo que preparó."
          etiquetaNombre="Preparador"
          etiquetaCantidad="Preparado (ítems)"
          filas={preparadores}
          cargando={cargando}
          escala={escalaPrep}
        />
        <TablaPremios
          titulo="Mesa de Control"
          subtitulo="Renglones controlados y errores que se le escaparon (detectados por Calidad)."
          etiquetaNombre="Controlador"
          etiquetaCantidad="Controlado (renglones)"
          filas={mesa}
          cargando={cargando}
          escala={escalaMesa}
        />
      </div>

      {margenes && (
        <MargenesModal
          escalas={escalas}
          puedeEditar={puedeEditar}
          mesVista={mes}
          onGuardar={guardar}
          onBorrar={borrar}
          onCerrar={() => setMargenes(false)}
        />
      )}
    </div>
    </div>
  );
}
