"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { RefreshCw, AlertCircle, Loader2 } from "lucide-react";
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
const fmtPct = (errores: number, base: number) =>
  base > 0 ? `${((errores / base) * 100).toFixed(2)}%` : "—";

interface Fila { nombre: string; cantidad: number; errores: number }

function ordenar(filas: Fila[], orden: Orden): Fila[] {
  const pct = (f: Fila) => (f.cantidad > 0 ? f.errores / f.cantidad : f.errores > 0 ? Infinity : -1);
  const copia = [...filas];
  if (orden === "nombre") return copia.sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
  if (orden === "errores") return copia.sort((a, b) => b.errores - a.errores || b.cantidad - a.cantidad);
  if (orden === "pct") return copia.sort((a, b) => pct(b) - pct(a) || b.errores - a.errores);
  return copia.sort((a, b) => b.cantidad - a.cantidad);
}

function TablaPremios({
  titulo,
  subtitulo,
  etiquetaNombre,
  etiquetaCantidad,
  filas,
  cargando,
}: {
  titulo: string;
  subtitulo: string;
  etiquetaNombre: string;
  etiquetaCantidad: string;
  filas: Fila[];
  cargando: boolean;
}) {
  const [orden, setOrden] = useState<Orden>("cantidad");
  const ordenadas = useMemo(() => ordenar(filas, orden), [filas, orden]);
  const totCant = filas.reduce((a, f) => a + f.cantidad, 0);
  const totErr = filas.reduce((a, f) => a + f.errores, 0);

  const Th = ({ campo, children, className = "" }: { campo: Orden; children: ReactNode; className?: string }) => (
    <TableHead
      className={`cursor-pointer select-none hover:text-foreground ${orden === campo ? "text-foreground" : "text-muted-foreground"} ${className}`}
      onClick={() => setOrden(campo)}
      title="Ordenar por esta columna"
    >
      {children}
    </TableHead>
  );

  return (
    <section className="rounded-md border">
      <header className="px-4 py-3 border-b">
        <h2 className="text-base font-medium">{titulo}</h2>
        <p className="text-xs text-muted-foreground mt-0.5">{subtitulo}</p>
      </header>
      <Table>
        <TableHeader>
          <TableRow>
            <Th campo="nombre">{etiquetaNombre}</Th>
            <Th campo="cantidad" className="text-right">{etiquetaCantidad}</Th>
            <Th campo="errores" className="text-right">Errores</Th>
            <Th campo="pct" className="text-right">% Error</Th>
          </TableRow>
        </TableHeader>
        <TableBody>
          {cargando && (
            <TableRow>
              <TableCell colSpan={4} className="py-10 text-center text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin inline mr-2" />
                Consultando…
              </TableCell>
            </TableRow>
          )}
          {!cargando && !ordenadas.length && (
            <TableRow>
              <TableCell colSpan={4} className="py-10 text-center text-muted-foreground">
                Sin datos en el mes
              </TableCell>
            </TableRow>
          )}
          {!cargando &&
            ordenadas.map((f) => (
              <TableRow key={f.nombre}>
                <TableCell className="font-medium">{f.nombre}</TableCell>
                <TableCell className="text-right tabular-nums">{fmtNum(f.cantidad)}</TableCell>
                <TableCell className={`text-right tabular-nums ${f.errores > 0 ? "text-destructive" : "text-muted-foreground"}`}>
                  {fmtNum(f.errores)}
                </TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {fmtPct(f.errores, f.cantidad)}
                </TableCell>
              </TableRow>
            ))}
        </TableBody>
        {!cargando && ordenadas.length > 0 && (
          <TableFooter>
            <TableRow>
              <TableCell>TOTAL</TableCell>
              <TableCell className="text-right tabular-nums">{fmtNum(totCant)}</TableCell>
              <TableCell className="text-right tabular-nums">{fmtNum(totErr)}</TableCell>
              <TableCell className="text-right tabular-nums">{fmtPct(totErr, totCant)}</TableCell>
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

  return (
    <div className="container mx-auto px-6 py-8 max-w-6xl">
      <InicioButton label="Inicio" iconSize={16} className="text-sm text-muted-foreground hover:text-foreground transition-colors mb-4" />
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-medium">Premios</h1>
          <p className="text-sm text-muted-foreground mt-1">
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
            className="cursor-pointer bg-background border rounded-md px-3 py-1.5 text-sm outline-none focus:border-foreground/40 transition-colors"
          />
          <Button variant="outline" size="icon" onClick={() => cargar(mes)} disabled={cargando} title="Recargar">
            <RefreshCw className={`h-4 w-4 ${cargando ? "animate-spin" : ""}`} />
          </Button>
          <UsuarioActual className="text-muted-foreground" />
        </div>
      </header>

      {error && (
        <div className="mb-4 flex items-center gap-2 text-sm text-destructive bg-destructive/10 rounded px-3 py-2">
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
        />
        <TablaPremios
          titulo="Mesa de Control"
          subtitulo="Renglones controlados y errores que se le escaparon (detectados por Calidad)."
          etiquetaNombre="Controlador"
          etiquetaCantidad="Controlado (renglones)"
          filas={mesa}
          cargando={cargando}
        />
      </div>
    </div>
  );
}
