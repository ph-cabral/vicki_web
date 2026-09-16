"use client";
import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import {
  Loader2, RefreshCw, AlertTriangle, PackageCheck, CalendarRange, Check,
  ChevronDown, ChevronRight, Flag, RotateCw, ShoppingCart, Undo2, CalendarCheck,
  Download, Trash2, X, Globe, Search, ArrowRight,
} from "lucide-react";
import { exportarFaltantesCompras } from "@/lib/compras/exportFaltantes";
import { origenArticulo, type OrigenArticulo } from "@/lib/compras/origenArticulo";
import { exportarFaltantesExistencia } from "@/lib/deposito/exportFaltantesExistencia";
import { InicioButton } from "@/components/ui/InicioButton";
import { DateRangeField } from "@/components/ui/date-range-field";
import { UsuarioActual } from "@/components/auth/UsuarioActual";
import { abrirPicker } from "@/components/ui/abrirPicker";

// ──────────────────────────────────────────────────────────────────────────────
// /compras/faltantes — faltantes "sin existencia" por (artículo, día).
//   "Faltan" y "En OC" se muestran BRUTOS, sin restarse entre sí (pedido
//   2026-07-28) — la resta contra OC/stock se sigue calculando, pero
//   solo por dentro, para decidir el color de fondo de cada fila (ver estado).
//
//   · Rango "Desde/Hasta": default hoy/hoy. Ampliar "Desde" hacia atrás para ver
//     faltantes de días anteriores. Cada renglón cuenta una sola vez, en su DÍA
//     DE APARICIÓN (no se doble-cuenta el mismo renglón dos veces).
//   · "Faltan" es ACUMULADO bruto por artículo: faltan[día] = faltan[día-1] +
//     lo nuevo de ese día, y NUNCA se resetea ni se le resta la OC/el stock
//     (ver faltantes-consumo/route.ts punto 4). "En OC" tampoco se le resta
//     nada: es el total pendiente de esa OC tal cual.
//   · Extraordinario/Comprar (preparado.faltante_extraordinario, por
//     artículo+día+CLIENTE — 2026-09-16): el botón 🚩 de cada fila abre un
//     modal para elegir DE QUÉ CLIENTE es el pedido extraordinario (un
//     cliente pidió mucho más de lo habitual) y con qué cantidad (editable,
//     por defecto todo lo que ese cliente tiene pendiente en el bucket). Solo
//     esa cantidad se separa — el resto del faltante del artículo (los demás
//     clientes) sigue la compra normal, no desaparece de la tabla. La
//     decisión de comprar o no la porción extraordinaria se toma en
//     /ventas/faltantes; recién cuando "comprar" deja de ser null, el botón
//     "Extraordinario" del header (gira la tarjeta) la muestra en el
//     reverso, una fila por (bucket, cliente). Ahí queda hasta que compras la
//     desmarca a mano (la cantidad vuelve a sumar al faltante normal).
//
//   Color de fila por estado del DÍA (4 reglas, 2026-07-27):
//     · (sin fila) → el STOCK SOLO (sin la OC) cubrió el acumulado en algún
//       momento: no es problema de compras, el backend directamente NO manda
//       ese bucket (resueltoPorStock, ver faltantes-consumo/route.ts punto
//       4b). Se compara contra la marca de agua del stock, así que el
//       artículo tampoco vuelve cuando esa mercadería se vende.
//     · verde  → OC + stock juntos cubren TODO el acumulado (descubierto = 0,
//       estado "completo") pero el stock por sí solo NO alcanzaba — hizo
//       falta la OC. NO se muestra en "Todos" (2026-08-28): ya está
//       satisfecho, sale solo de la tabla apenas ingresa la mercadería. Queda
//       accesible con el chip "Cubiertos" (filtro=completo), en verde.
//     · rojo   → sigue descubierto y HAY algo de OC cargada, pero no alcanza
//       ni sumando el stock (estado "incompleto").
//     · sin color → sigue descubierto y NO hay ninguna OC pendiente (estado
//       "sin_orden"). Antes pintaba rojo igual que "incompleto"; ahora es
//       neutro (ver rowCls) para no mezclar "ya hay algo en camino" con
//       "no hay nada pedido todavía".
//
//   Columna "Ingresado" (2026-09-03): unidades que YA entraron por remito en el
//   período (indicadores-api /compras/ingresos, agregado por artículo). Es un
//   total del artículo, no del día: se repite en todos los buckets de ese
//   artículo. El universo son TODOS los tipos de comprobante de ingreso
//   (59 RMTOxCPA.D · 60 RMTOxORD · 61 REM AV S.F · 160 · 590 REM IN LIL), no
//   solo los remitos ligados a una OC — mismo universo que el reporte de
//   remitos del mes de Magnus y que la card "Ingresados" de /compras. El
//   tooltip lista remito por remito (N° · fecha · cantidad).
//
//   Fecha de arribo (columna "Arribo"): se carga acá a nivel artículo+día y se
//   aplica (fan-out) a todos los renglones de ese bucket en
//   preparado.faltante_control (/api/compras/faltantes-arribo). Por defecto
//   un bucket con TODOS sus renglones ya con fecha de arribo se oculta de esta
//   vista — botón "Ver con arribo" para corroborar los que ya se pasaron.
//   Cargar esa fecha es además el "pase a compras": queda registrado con la
//   foto del bucket en preparado.faltante_pase_compras y se consulta por mes
//   en /compras/pases (comparación fin de mes: pasado a compras vs comprado).
//   Reemplaza a /deposito/faltantes/control (ahora redirige acá). "¿Cliente lo
//   quiere?" se sigue decidiendo en /ventas/faltantes, sin cambios.
//   El consumo por día se guarda solo (preparado.faltante_oc_consumo).
// ──────────────────────────────────────────────────────────────────────────────

type Estado = "completo" | "incompleto" | "sin_orden" | "entregado";
type Filtro = "todos" | Estado;
// Origen del artículo (r.tipoArticulo, Magnus): el botón cicla
// Nacionales → Importados → Otros (sin tipo cargado o tipo desconocido; se
// saltea si no hay ninguno). NO se muestran acá: Fábrica (tipo Fabril, o
// proveedor EVER WEAR S.A. INDUSTRIAL cuando el artículo no tiene tipo
// cargado), que vive en /fabrica/faltantes, ni los de tipo Original, que
// quedan fuera de la vista.
// Ver lib/compras/origenArticulo.ts.
type Origen = "importados" | "nacionales" | "otros";

// Fila RETIRADA de la tabla porque el stock cubrió el faltante (backend, punto
// 4c: llegan en `cubiertos`, aparte de `rows`). Sirve para ver QUÉ salió y
// CUÁNDO — no se puede accionar sobre ellas.
interface RowCubierta {
  CodArticulo: string;
  Nombre: string;
  Linea: string | number | null;
  Proveedor: string | null;
  fecha: string;       // día del faltante que quedó cubierto
  faltan: number;
  stock: number;       // stock actual
  stockPico: number;   // mayor stock visto (marca de agua) — lo que lo cubrió
  importe: number;
  renglones: number;
  pedidos: number;
  cubiertoEl: string | null; // día en que se detectó la cobertura
}

interface Row {
  CodArticulo: string;
  Nombre: string;
  Linea: string | number | null;
  Proveedor: string | null;
  clientes: { cod: string; nombre: string | null; cant: number }[];
  fecha: string; // día del faltante (primera aparición)
  vivo: boolean; // false = histórico ya entregado/cubierto
  faltan: number; // acumulado BRUTO hasta este día (nunca se resetea, no se le resta OC/stock)
  nuevoDelDia: number; // lo nuevo que aportó puntualmente este día
  stock: number; // existencia real en depósito 1 (WMS, en vivo — mismo dato que /deposito/stock)
  cubierto: number;
  descubierto: number;
  importe: number;
  renglones: number;
  pedidos: number;
  ocTotal: number;
  fechaEntrega: string | null;
  importacion: boolean;
  tipoArticulo: string | null; // "Nacional"/"Importado"/"Original"/"Fabrica" (Magnus) — fuente del filtro de origen (ver lib/compras/origenArticulo.ts)
  ocs: string[];
  estado: Estado;
  // Cuánto de este bucket ya está separado como extraordinario (por cliente,
  // ver ExtraRow) y esperando que /ventas/faltantes le pregunte al cliente —
  // solo para el badge de la fila; ya está restado de `faltan`.
  extraordinarioEnRevision: number;
  fechaArribo: string | null; // más vieja cargada entre los renglones del bucket
  tieneArribo: boolean; // true = TODOS los renglones del bucket ya la tienen
  // Ingresos por remito del PERÍODO (no del día): total del artículo entre el
  // ancla del cruce y el "hasta" del rango. Entran todos los tipos de remito
  // de ingreso (59/60/61/160/590), no solo los que cuelgan de una OC.
  ingresado: number;
  remitos: { nro: string; fecha: string; cant: number }[];
  ultimoIngreso: string | null;
}

// Porción extraordinaria de un bucket, por CLIENTE (2026-09-16) — ver
// `extraordinarios` en GET /api/compras/faltantes-consumo, y sql/compras_
// faltante_extraordinario.sql. Un pedido extraordinario es de UN cliente
// puntual que pidió mucho más de lo habitual; `cantidad` ya está restada del
// `faltan` del bucket que aparece en `Row` — acá vive aparte, esperando (o
// ya con) la decisión de comprar de /ventas/faltantes.
interface ExtraRow {
  CodArticulo: string;
  Nombre: string;
  Linea: string | number | null;
  Proveedor: string | null;
  tipoArticulo: string | null;
  fecha: string;
  codCliente: string;
  clienteNombre: string | null;
  cantidad: number;
  importe: number;
  stock: number;
  comprar: boolean | null; // null = pendiente (decide ventas/faltantes)
}

const fmtNum = (n: number) =>
  new Intl.NumberFormat("es-AR", { maximumFractionDigits: 2 }).format(n || 0);
const fmtAr = (s: string | null) => {
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(s || "");
  return m ? `${m[3]}/${m[2]}/${m[1]}` : s || "—";
};
// Suma días a una fecha YYYY-MM-DD sin corrimiento de huso horario (parseo manual,
// no new Date(str) directo). Usado para sugerir Arribo = Despacho + 2 días.
const addDaysISO = (iso: string, days: number) => {
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return "";
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
// Fecha local (no UTC) en formato YYYY-MM-DD, para que "hoy" coincida con el
// día calendario del usuario y no se corra por huso horario.
const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
// Mes actual ("YYYY-MM") — default del selector de exportación histórico
// (con/sin existencia), mismo reporte y mismo endpoint que /deposito/faltantes.
function mesActual(): string {
  return new Date().toISOString().slice(0, 7);
}
// Default de "desde": ancla del cruce con OC (OC_DESDE_DEFAULT del backend).
// Con default hoy–hoy la vista quedaba vacía cada mañana: solo miraba la foto
// de ayer y perdía los buckets/acumulado de los días anteriores.
const DESDE_DEFAULT = "2026-06-26";
// Clave de fila: (artículo, día) — misma granularidad que usa el backend para
// marcar extraordinario/comprar (preparado.faltante_extraordinario).
const rowKey = (r: Pick<Row, "CodArticulo" | "fecha">) => `${r.CodArticulo}__${r.fecha}`;
// Clave de marca extraordinaria: (artículo, día, CLIENTE) — misma
// granularidad que preparado.faltante_extraordinario.
const extraKey = (r: Pick<ExtraRow, "CodArticulo" | "fecha" | "codCliente">) =>
  `${r.CodArticulo}__${r.fecha}__${r.codCliente}`;

// Clasificación de origen: única fuente en lib/compras/origenArticulo.ts,
// compartida con /fabrica/faltantes (Nacional acá, Importado del otro lado del
// botón, Fabril solo en fábrica, Original fuera de toda vista, y "Otros" para
// lo que no cae en ninguna). Como pasaOrigen compara contra el filtro activo
// —que nunca vale "fabrica" ni "original"— esas dos quedan excluidas solas.
const origenDe = (r: Row): OrigenArticulo => origenArticulo(r);

const FILTROS: { key: Filtro; label: string }[] = [
  { key: "todos", label: "Todos" },
  { key: "completo", label: "Cubiertos" },
  { key: "incompleto", label: "Parciales" },
  { key: "sin_orden", label: "Sin OC" },
  { key: "entregado", label: "Entregados" },
];

const rowCls: Record<Estado, string> = {
  completo: "bg-green-500/10 hover:bg-green-500/[0.16]",
  entregado: "bg-emerald-500/10 hover:bg-emerald-500/[0.16]",
  incompleto: "bg-red-500/10 hover:bg-red-500/[0.16]",
  // sin_orden = no hay NINGUNA OC pendiente (cub=0) y el stock tampoco cubre
  // el faltante. Reglas 2026-07-27: sin color — el rojo es solo para
  // "incompleto" (hay una OC cargada pero no alcanza). Antes (mismo día,
  // versión intermedia) era rojo igual que "incompleto"; antes de eso había
  // sido neutro — vuelve a serlo, ahora ya explícito y no por accidente.
  sin_orden: "hover:bg-zinc-800/40",
};
// Color del número "cubre OC" dentro de la celda Falta/Stock/OC: verde SOLO si
// stock+OC cubre TODO el faltante (completo/entregado). Si es cobertura
// parcial (incompleto) va en ámbar, no verde — mostrarlo en verde cuando la
// fila sigue con Falta OC en rojo es contradictorio (leía como "ya resuelto").
// Mismo criterio ya usado en /fabrica/faltantes (cubiertoCls).
const cubiertoCls: Record<Estado, string> = {
  completo: "text-green-400 font-medium",
  entregado: "text-emerald-400 font-medium",
  incompleto: "text-amber-400 font-medium",
  sin_orden: "text-zinc-600",
};

// Celda "Cliente": en vez de listar nombres (rompía el ancho de la tabla),
// muestra "n cliente(s)" y abre un modal con el detalle al hacer click.
function ClientesCell({ clientes }: { clientes: Row["clientes"] }) {
  const [open, setOpen] = useState(false);
  if (!clientes.length) return <span className="text-zinc-600">—</span>;
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="text-xs text-zinc-300 hover:text-yellow-400 underline underline-offset-2 decoration-dotted whitespace-nowrap"
      >
        {clientes.length} cliente{clientes.length > 1 ? "s" : ""}
      </button>
      {open &&
        createPortal(
          <div
            className="fixed inset-0 z-[200] bg-black/60 flex items-center justify-center p-4"
            onClick={() => setOpen(false)}
          >
            <div
              className="bg-[#1A1A1A] border border-zinc-700 rounded-xl max-w-md w-full max-h-[70vh] overflow-y-auto p-4"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-medium text-zinc-200">
                  {clientes.length} cliente{clientes.length > 1 ? "s" : ""}
                </h3>
                <button
                  onClick={() => setOpen(false)}
                  className="text-zinc-500 hover:text-zinc-200 p-1"
                >
                  <X size={16} />
                </button>
              </div>
              <ul className="flex flex-col gap-1.5">
                {clientes.map((c) => (
                  <li key={c.cod} className="text-xs text-zinc-300 flex justify-between gap-3">
                    <span className="truncate">
                      {c.cod}
                      {c.nombre ? ` — ${c.nombre}` : ""}
                    </span>
                    {clientes.length > 1 && (
                      <span className="text-zinc-500 shrink-0 tabular-nums">{fmtNum(c.cant)}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

// Modal que abre el botón 🚩: pregunta DE QUÉ CLIENTE es el pedido
// extraordinario (2026-09-16) — un pedido extraordinario es de un cliente
// puntual que pidió mucho más de lo habitual, no del artículo entero. Solo
// se separa la cantidad de ESE cliente (editable, por defecto lo que tiene
// pendiente en este bucket); el resto del faltante sigue la compra normal.
function ModalMarcarExtraordinario({
  row,
  onClose,
  onConfirm,
}: {
  row: Row;
  onClose: () => void;
  onConfirm: (codCliente: string, clienteNombre: string | null, cantidad: number) => void;
}) {
  const unico = row.clientes.length === 1 ? row.clientes[0] : null;
  const [sel, setSel] = useState<string | null>(unico?.cod ?? null);
  const [cant, setCant] = useState<number>(unico?.cant ?? 0);

  const elegir = (c: Row["clientes"][number]) => {
    setSel(c.cod);
    setCant(c.cant);
  };
  const clienteSel = row.clientes.find((c) => c.cod === sel) ?? null;

  return createPortal(
    <div
      className="fixed inset-0 z-[200] bg-black/60 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-[#1A1A1A] border border-red-900/50 rounded-xl max-w-md w-full max-h-[80vh] overflow-y-auto p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-sm font-medium text-zinc-200 flex items-center gap-2">
            <Flag size={14} className="text-red-400" />
            ¿De qué cliente es el pedido extraordinario?
          </h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200 p-1">
            <X size={16} />
          </button>
        </div>
        <p className="text-[11px] text-zinc-500 mb-3">
          {row.CodArticulo} · {row.Nombre} — {fmtAr(row.fecha)}. Se separa solo la cantidad de
          este cliente; el resto del faltante sigue la compra normal del artículo.
        </p>
        {row.clientes.length === 0 ? (
          <p className="text-xs text-zinc-500 mb-3">
            Este faltante no tiene cliente identificado — no se puede marcar como extraordinario.
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5 mb-3">
            {row.clientes.map((c) => (
              <li key={c.cod}>
                <button
                  onClick={() => elegir(c)}
                  className={`w-full text-left px-3 py-2 rounded-lg border text-xs flex items-center justify-between gap-2 transition-colors ${
                    sel === c.cod
                      ? "border-red-400 bg-red-500/10 text-red-200"
                      : "border-zinc-700 text-zinc-300 hover:border-zinc-500"
                  }`}
                >
                  <span className="truncate">
                    {c.cod}
                    {c.nombre ? ` — ${c.nombre}` : ""}
                  </span>
                  <span className="tabular-nums text-zinc-500 shrink-0">{fmtNum(c.cant)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {clienteSel && (
          <div className="flex items-center gap-2 mb-4">
            <label className="text-xs text-zinc-400 whitespace-nowrap">
              Cantidad extraordinaria
            </label>
            <input
              type="number"
              min={0}
              max={clienteSel.cant}
              step="any"
              value={cant}
              onChange={(e) => setCant(Number(e.target.value))}
              className="bg-[#111] border border-zinc-700 rounded-md px-2 py-1 text-xs text-zinc-100 w-28 outline-none focus:border-red-400 [color-scheme:dark]"
            />
            <span className="text-[11px] text-zinc-600">de {fmtNum(clienteSel.cant)} pedidos</span>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-md border border-zinc-700 text-zinc-300 text-xs hover:border-zinc-500"
          >
            Cancelar
          </button>
          <button
            disabled={!clienteSel || cant <= 0}
            onClick={() =>
              clienteSel &&
              onConfirm(clienteSel.cod, clienteSel.nombre, Math.min(cant, clienteSel.cant))
            }
            className="px-3 py-1.5 rounded-md border border-red-400 bg-red-500/15 text-red-300 text-xs font-medium hover:bg-red-500/25 disabled:opacity-40"
          >
            Marcar extraordinario
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// Tabla reutilizable: una sola tabla o el cuerpo de cada acordeón por proveedor.
function Tabla({
  data,
  onMark,
  onArribo,
  onDescartar,
  leaving = {},
  ocultarProveedor = false,
}: {
  data: Row[];
  onMark: (row: Row) => void;
  onArribo: (row: Row, fechaArribo: string | null) => void;
  onDescartar: (row: Row) => void;
  leaving?: Record<string, "left" | "right">;
  ocultarProveedor?: boolean;
}) {
  return (
    <div className="rounded-xl border border-zinc-800 overflow-hidden">
      <div className="overflow-x-auto">
      <table className="w-full min-w-max text-sm">
        <thead className="bg-[#1A1A1A] text-zinc-400">
          <tr className="text-left">
            <th className="px-3 py-2 font-medium"></th>
            <th className="px-3 py-2 font-medium whitespace-nowrap">Cód.</th>
            <th className="px-3 py-2 font-medium whitespace-nowrap">Artículo</th>
            <th className="px-3 py-2 font-medium whitespace-nowrap">Línea</th>
            <th className="px-3 py-2 font-medium whitespace-nowrap">Día</th>
            <th className="px-3 py-2 font-medium text-right whitespace-nowrap">Falta/Stock/En OC</th>
            <th className="px-3 py-2 font-medium text-right whitespace-nowrap">Falta OC</th>
            <th className="px-3 py-2 font-medium whitespace-nowrap">Despacho</th>
            {!ocultarProveedor && (
              <th className="px-3 py-2 font-medium whitespace-nowrap">Proveedor</th>
            )}
            <th className="px-3 py-2 font-medium whitespace-nowrap">Cliente</th>
            <th className="px-3 py-2 font-medium text-right whitespace-nowrap">Importe</th>
            <th className="px-3 py-2 font-medium text-right whitespace-nowrap">Ingresado</th>
            <th className="px-3 py-2 font-medium whitespace-nowrap">Arribo</th>
            <th className="px-3 py-2 font-medium"></th>
          </tr>
        </thead>
        <tbody>
          {data.map((r, i) => {
            const prev = data[i - 1];
            const nuevoArt = !prev || prev.CodArticulo !== r.CodArticulo;
            const dir = leaving[rowKey(r)];
            return (
              <tr
                key={rowKey(r)}
                className={`transition-colors animate-in fade-in duration-300 ${
                  dir === "right" ? "row-out-right" : dir === "left" ? "row-out-left" : ""
                } ${rowCls[r.estado]} ${
                  nuevoArt ? "border-t-2 border-zinc-700/80" : "border-t border-zinc-800/50"
                }`}
              >
                <td className="px-2 py-2">
                  <button
                    onClick={() => onMark(r)}
                    disabled={!!dir}
                    title={
                      r.extraordinarioEnRevision > 0
                        ? `${fmtNum(r.extraordinarioEnRevision)} unid. ya separadas como extraordinarias, esperando a ventas — marcar otro cliente`
                        : "Marcar como pedido extraordinario de un cliente puntual"
                    }
                    className={`btn-anim p-1 disabled:opacity-40 relative ${
                      r.extraordinarioEnRevision > 0 ? "text-red-400" : "text-zinc-600 hover:text-red-400"
                    }`}
                  >
                    <Flag size={14} />
                    {r.extraordinarioEnRevision > 0 && (
                      <span className="absolute -top-1 -right-1 bg-red-500 text-white rounded-full text-[9px] leading-none px-1 py-0.5">
                        !
                      </span>
                    )}
                  </button>
                </td>
                <td className="px-3 py-2 font-mono text-zinc-300 whitespace-nowrap">
                  {r.CodArticulo}
                </td>
                <td className="px-3 py-2 text-zinc-100 whitespace-nowrap">
                  <span>{r.Nombre}</span>
                </td>
                <td className="px-3 py-2 text-zinc-400 whitespace-nowrap">{r.Linea ?? "—"}</td>
                <td className="px-3 py-2 text-zinc-400 whitespace-nowrap tabular-nums">
                  {fmtAr(r.fecha)}
                  {r.pedidos > 1 && (
                    <span className="ml-2 text-[11px] text-zinc-600">{r.pedidos} ped.</span>
                  )}
                </td>
                <td
                  className="px-3 py-2 text-right tabular-nums whitespace-nowrap"
                  title="Faltan (acumulado bruto, sin restar OC/stock) / Stock (existencia real depósito 1 en vivo, mismo dato que /deposito/stock) / En OC (cantidad total pedida en la OC pendiente, tal cual, no neteada contra Faltan)."
                >
                  <span className="text-zinc-100">
                    {fmtNum(r.faltan)}
                    {r.vivo && r.nuevoDelDia > 0 && r.nuevoDelDia !== r.faltan && (
                      <span className="ml-1 text-[11px] text-zinc-600">
                        (+{fmtNum(r.nuevoDelDia)})
                      </span>
                    )}
                  </span>
                  <span className="text-zinc-600">/</span>
                  <span className={r.stock > 0 ? "text-green-400" : "text-zinc-600"}>
                    {r.stock > 0 ? fmtNum(r.stock) : "—"}
                  </span>
                  <span className="text-zinc-600">/</span>
                  <span className={r.ocTotal > 0 ? cubiertoCls[r.estado] : "text-zinc-600"}>
                    {r.ocTotal > 0 ? fmtNum(r.ocTotal) : "—"}
                  </span>
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-red-300/90">
                  {r.descubierto > 0 ? fmtNum(r.descubierto) : "—"}
                </td>
                <td className="px-3 py-2 text-zinc-400 whitespace-nowrap">
                  {r.estado === "entregado"
                    ? <span className="text-emerald-400/80">Entregado</span>
                    : r.cubierto > 0
                      ? r.importacion
                        ? <span className="text-amber-400/80">Importación</span>
                        : fmtAr(r.fechaEntrega)
                      : "—"}
                </td>
                {!ocultarProveedor && (
                  <td className="px-3 py-2 text-zinc-400 whitespace-nowrap">{r.Proveedor || "—"}</td>
                )}
                <td className="px-3 py-2 text-zinc-400 whitespace-nowrap">
                  <ClientesCell clientes={r.clientes} />
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-zinc-300 whitespace-nowrap">
                  ${fmtNum(r.importe)}
                </td>
                {/* Ingresado por remito en el período (total del artículo, ver
                    cabecera). Tooltip = remito por remito. */}
                <td
                  className="px-3 py-2 text-right tabular-nums whitespace-nowrap"
                  title={
                    r.ingresado > 0
                      ? "Ingresado por remito en el período (total del artículo)\n" +
                        r.remitos
                          .map(
                            (m) =>
                              `${m.nro}${m.fecha ? ` · ${fmtAr(m.fecha)}` : ""}${
                                m.cant ? ` · ${fmtNum(m.cant)} u.` : ""
                              }`,
                          )
                          .join("\n")
                      : "Sin remitos de ingreso en el período"
                  }
                >
                  {r.ingresado > 0 ? (
                    <span className="text-sky-300">
                      {fmtNum(r.ingresado)}
                      {r.remitos.length > 0 && (
                        <span className="ml-1 text-[11px] text-zinc-500">
                          {r.remitos.length} rem.
                        </span>
                      )}
                    </span>
                  ) : (
                    <span className="text-zinc-600">—</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  {(() => {
                    // Sugerido = Despacho + 2 días, solo mientras no haya arribo
                    // cargado a mano. No se persiste hasta que se edite/confirme.
                    const sugerido = !r.fechaArribo && r.fechaEntrega ? addDaysISO(r.fechaEntrega, 2) : null;
                    return (
                      <input
                        type="date"
                        value={r.fechaArribo ?? sugerido ?? ""}
                        onChange={(e) => onArribo(r, e.target.value || null)}
                        title={
                          r.tieneArribo
                            ? "Ya cargada — se oculta salvo 'Ver con arribo'"
                            : sugerido
                              ? "Sugerido: Despacho + 2 días. No guardado — editá para confirmar o corregir por retraso."
                              : "Cargar fecha de arribo (aplica a todos los renglones del artículo ese día)"
                        }
                        className={`bg-[#1f1f1f] border rounded-md px-2 py-1 text-xs outline-none [color-scheme:dark] ${
                          r.tieneArribo
                            ? "border-emerald-600 text-emerald-300"
                            : sugerido
                              ? "border-dashed border-zinc-600 text-zinc-400 focus:border-yellow-400"
                              : "border-zinc-700 text-zinc-200 focus:border-yellow-400"
                        }`}
                      />
                    );
                  })()}
                </td>
                <td className="px-2 py-2">
                  <button
                    onClick={() => onDescartar(r)}
                    disabled={!!dir}
                    title="Descartar (no se borra de la base, solo deja de mostrarse acá)"
                    className="btn-anim text-zinc-600 hover:text-red-400 p-1 disabled:opacity-40"
                  >
                    <Trash2 size={14} />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
    </div>
  );
}

// Reverso de la tarjeta: porciones extraordinarias POR CLIENTE (2026-09-16),
// YA decididas (comprar !== null, decisión que toma /ventas/faltantes) — ver
// backRows en el componente de abajo. El toggle "Comprar" de acá permite a
// compras cambiar manualmente esa decisión (true↔false), pero no volver a
// dejarla pendiente (null). Mientras "comprar" siga null (ventas todavía no
// le preguntó al cliente), esa cantidad no aparece acá — ya está restada de
// la tabla principal, y se ve como el "!" del botón 🚩 de esa fila.
//   · Desmarcar "Extraordinario" → borra la marca de ESE cliente: la
//     cantidad vuelve a sumar al faltante normal del artículo.
function TablaExtraordinarios({
  data,
  onToggleComprar,
  onUndo,
  leaving = {},
}: {
  data: ExtraRow[];
  onToggleComprar: (row: ExtraRow, comprar: boolean) => void;
  onUndo: (row: ExtraRow) => void;
  leaving?: Record<string, "left" | "right">;
}) {
  if (data.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-28 gap-3 text-center rounded-xl border border-zinc-800">
        <ShoppingCart size={40} className="text-zinc-700" />
        <p className="text-zinc-400 font-medium">
          No hay pedidos extraordinarios marcados para comprar.
        </p>
      </div>
    );
  }
  return (
    <div className="overflow-x-auto rounded-xl border border-red-900/50">
      <table className="w-full min-w-max text-sm">
        <thead className="bg-[#1A1A1A] text-zinc-400">
          <tr className="text-left">
            <th className="px-3 py-2 font-medium whitespace-nowrap">Cód.</th>
            <th className="px-3 py-2 font-medium whitespace-nowrap">Artículo</th>
            <th className="px-3 py-2 font-medium whitespace-nowrap">Línea</th>
            <th className="px-3 py-2 font-medium whitespace-nowrap">Día</th>
            <th className="px-3 py-2 font-medium whitespace-nowrap">Cliente</th>
            <th className="px-3 py-2 font-medium text-right whitespace-nowrap">Cant. extraordinaria</th>
            <th className="px-3 py-2 font-medium text-right whitespace-nowrap">Stock</th>
            <th className="px-3 py-2 font-medium whitespace-nowrap">Proveedor</th>
            <th className="px-3 py-2 font-medium text-right whitespace-nowrap">Importe</th>
            <th className="px-3 py-2 font-medium text-center whitespace-nowrap">Extraordinario</th>
            <th className="px-3 py-2 font-medium text-center whitespace-nowrap">Comprar</th>
          </tr>
        </thead>
        <tbody>
          {data.map((r) => {
            const dir = leaving[extraKey(r)];
            return (
              <tr
                key={extraKey(r)}
                className={`border-t border-zinc-800/50 bg-red-500/[0.06] hover:bg-red-500/[0.1] transition-colors animate-in fade-in duration-300 ${
                  dir === "right" ? "row-out-right" : dir === "left" ? "row-out-left" : ""
                }`}
              >
                <td className="px-3 py-2 font-mono text-zinc-300 whitespace-nowrap">{r.CodArticulo}</td>
                <td className="px-3 py-2 text-zinc-100 whitespace-nowrap">{r.Nombre}</td>
                <td className="px-3 py-2 text-zinc-400 whitespace-nowrap">{r.Linea ?? "—"}</td>
                <td className="px-3 py-2 text-zinc-400 whitespace-nowrap tabular-nums">{fmtAr(r.fecha)}</td>
                <td className="px-3 py-2 text-zinc-300 whitespace-nowrap">
                  {r.codCliente}
                  {r.clienteNombre ? ` — ${r.clienteNombre}` : ""}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-zinc-100">{fmtNum(r.cantidad)}</td>
                <td
                  className={`px-3 py-2 text-right tabular-nums ${
                    r.stock > 0 ? "text-emerald-400" : "text-zinc-600"
                  }`}
                >
                  {r.stock > 0 ? fmtNum(r.stock) : "—"}
                </td>
                <td className="px-3 py-2 text-zinc-400 whitespace-nowrap">{r.Proveedor || "—"}</td>
                <td className="px-3 py-2 text-right tabular-nums text-zinc-300 whitespace-nowrap">${fmtNum(r.importe)}</td>
                <td className="px-3 py-2 text-center">
                  <button
                    onClick={() => onUndo(r)}
                    disabled={!!dir}
                    title="Desmarcar (la cantidad vuelve a sumar al faltante normal del artículo)"
                    className="btn-anim inline-flex items-center gap-1 text-red-400 hover:text-zinc-400 px-2 py-1 rounded border border-red-400/40 disabled:opacity-40"
                  >
                    <Undo2 size={13} />
                  </button>
                </td>
                <td className="px-3 py-2 text-center">
                  <button
                    onClick={() => onToggleComprar(r, !r.comprar)}
                    title={r.comprar ? "Desmarcar comprar" : "Marcar comprar"}
                    className={`btn-anim inline-flex items-center justify-center w-6 h-6 rounded border ${
                      r.comprar
                        ? "bg-emerald-500/20 border-emerald-400 text-emerald-300"
                        : "border-zinc-600 text-transparent hover:border-zinc-400"
                    }`}
                  >
                    <Check size={13} />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function ComprasFaltantesPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [cubiertos, setCubiertos] = useState<RowCubierta[]>([]); // retiradas por stock (ver RowCubierta)
  const [verRetirados, setVerRetirados] = useState(false);
  const [fecha, setFecha] = useState<string | null>(null);
  const [desdeResp, setDesdeResp] = useState<string | null>(null);
  const [hastaResp, setHastaResp] = useState<string | null>(null);
  const [desde, setDesde] = useState(DESDE_DEFAULT); // rango de búsqueda, default = ancla OC
  const [hasta, setHasta] = useState(todayISO);
  const [conArribo, setConArribo] = useState(false); // ver también los que ya tienen fecha de arribo
  const [filtro, setFiltro] = useState<Filtro>("todos");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ocWarn, setOcWarn] = useState(false);
  const [ingresoWarn, setIngresoWarn] = useState(false); // no se pudo leer /compras/ingresos
  const [comprobanteWarn, setComprobanteWarn] = useState(false); // no se detectó la columna de código de comprobante (ver ingresos.py)
  const [ocDesde, setOcDesde] = useState<string | null>(null);
  const [origen, setOrigen] = useState<Origen>("nacionales"); // filtro por origen del artículo (tipoArticulo) — default Nacionales, cicla con el botón
  const [flipped, setFlipped] = useState(false); // girar la tarjeta → ver extraordinarios
  const [leaving, setLeaving] = useState<Record<string, "left" | "right">>({}); // filas saliendo (animación)
  const [provAbierto, setProvAbierto] = useState<string | null>(null); // acordeón: solo un proveedor abierto a la vez; todos cerrados al entrar
  const [mesExport, setMesExport] = useState(mesActual); // mes del export histórico (existencia)
  const [exportHistLoading, setExportHistLoading] = useState(false);
  const [buscarCod, setBuscarCod] = useState(""); // filtro "buscar por código" (barra de búsqueda)
  const [matches, setMatches] = useState<{ prov: string; rs: Row[] }[]>([]); // proveedores donde aparece el código buscado
  const [matchIdx, setMatchIdx] = useState(0);
  const [buscado, setBuscado] = useState(false); // true tras ejecutar la búsqueda (para distinguir "sin buscar" de "0 resultados")
  const provRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [extraordinarios, setExtraordinarios] = useState<ExtraRow[]>([]); // porciones por cliente (ver punto 3d del backend)
  const [marcando, setMarcando] = useState<Row | null>(null); // bucket para el que se abrió el modal "¿de qué cliente?"
  const [leavingExtra, setLeavingExtra] = useState<Record<string, "left" | "right">>({}); // filas del reverso saliendo (animación)

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setOcWarn(false);
    setIngresoWarn(false);
    setComprobanteWarn(false);
    try {
      const p = new URLSearchParams();
      p.set("desde", desde);
      p.set("hasta", hasta);
      if (conArribo) p.set("conArribo", "1");
      const res = await fetch(`/api/compras/faltantes-consumo?${p}`, { cache: "no-store" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setRows(j.rows ?? []);
      setCubiertos(j.cubiertos ?? []);
      setExtraordinarios(j.extraordinarios ?? []);
      setFecha(j.fecha ?? null);
      setDesdeResp(j.desde ?? null);
      setHastaResp(j.hasta ?? null);
      setOcDesde(j.ocDesde ?? null);
      setOcWarn(!!j.ocWarn);
      setIngresoWarn(!!j.ingresoWarn);
      setComprobanteWarn(!!j.comprobanteWarn);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al cargar");
      setRows([]);
      setCubiertos([]);
      setExtraordinarios([]);
    } finally {
      setLoading(false);
    }
  }, [desde, hasta, conArribo]);

  useEffect(() => {
    load();
  }, [load]);

  // Auto-refresh cada 1 min.
  useEffect(() => {
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  const EXIT_MS = 260;

  // Botón 🚩 de una fila: abre el modal para elegir DE QUÉ CLIENTE es el
  // pedido extraordinario (2026-09-16) — ya no marca el artículo entero.
  const marcarExtraordinario = useCallback((row: Row) => setMarcando(row), []);

  // Confirmación del modal: guarda la marca por (fecha, artículo, cliente) y
  // recarga — el faltante del bucket cambia server-side (se le resta esta
  // cantidad), así que no conviene simularlo optimista acá.
  const confirmarExtraordinario = useCallback(
    async (codCliente: string, clienteNombre: string | null, cantidad: number) => {
      const row = marcando;
      setMarcando(null);
      if (!row) return;
      try {
        const res = await fetch("/api/compras/faltantes-extraordinario", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fecha: row.fecha,
            codArticulo: row.CodArticulo,
            codCliente,
            clienteNombre,
            cantidad,
            comprar: null,
          }),
        });
        if (!res.ok) throw new Error();
        await load();
      } catch {
        setError("No se pudo marcar el pedido extraordinario");
      }
    },
    [marcando, load],
  );

  // Reverso: cambia "comprar" de una marca ya decidida (compras puede
  // overridear lo que decidió ventas). Optimista.
  const toggleComprarExtra = useCallback(async (row: ExtraRow, comprar: boolean) => {
    const prev = row.comprar;
    setExtraordinarios((rs) =>
      rs.map((r) => (extraKey(r) === extraKey(row) ? { ...r, comprar } : r)),
    );
    try {
      const res = await fetch("/api/compras/faltantes-extraordinario", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fecha: row.fecha,
          codArticulo: row.CodArticulo,
          codCliente: row.codCliente,
          clienteNombre: row.clienteNombre,
          cantidad: row.cantidad,
          comprar,
        }),
      });
      if (!res.ok) throw new Error();
    } catch {
      setExtraordinarios((rs) =>
        rs.map((r) => (extraKey(r) === extraKey(row) ? { ...r, comprar: prev } : r)),
      );
      setError("No se pudo guardar la decisión de comprar");
    }
  }, []);

  // Desmarcar (reverso): borra la marca de ese cliente — la cantidad vuelve a
  // sumar al faltante normal del artículo en la próxima lectura.
  const desmarcarExtraordinario = useCallback(
    (row: ExtraRow) => {
      const k = extraKey(row);
      setLeavingExtra((m) => ({ ...m, [k]: "left" }));
      window.setTimeout(async () => {
        setExtraordinarios((rs) => rs.filter((r) => extraKey(r) !== k));
        setLeavingExtra((m) => {
          const n = { ...m };
          delete n[k];
          return n;
        });
        try {
          const res = await fetch(
            `/api/compras/faltantes-extraordinario?fecha=${encodeURIComponent(row.fecha)}` +
              `&codArticulo=${encodeURIComponent(row.CodArticulo)}` +
              `&codCliente=${encodeURIComponent(row.codCliente)}`,
            { method: "DELETE" },
          );
          if (!res.ok) throw new Error();
        } catch {
          setError("No se pudo desmarcar");
        } finally {
          await load();
        }
      }, EXIT_MS);
    },
    [load],
  );

  // Carga/borra la fecha de arribo del bucket (artículo+día). El fan-out por
  // renglón a preparado.faltante_control lo hace el backend (ver
  // /api/compras/faltantes-arribo) — acá solo se actualiza optimista y se
  // revierte si falla. Reemplaza a /deposito/faltantes/control.
  const guardarArribo = useCallback(async (row: Row, fechaArribo: string | null) => {
    const prev = { fechaArribo: row.fechaArribo, tieneArribo: row.tieneArribo };
    setRows((rs) =>
      rs.map((r) =>
        rowKey(r) === rowKey(row) ? { ...r, fechaArribo, tieneArribo: !!fechaArribo } : r,
      ),
    );
    try {
      const res = await fetch("/api/compras/faltantes-arribo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // `snapshot`: foto del bucket al momento del pase — el backend la
        // guarda en preparado.faltante_pase_compras (registro de faltantes que
        // pasan a compras, para comparar a fin de mes contra lo comprado en
        // /compras/pases). No se recalcula después.
        body: JSON.stringify({
          fecha: row.fecha,
          codArticulo: row.CodArticulo,
          fechaArribo,
          snapshot: {
            nombre: row.Nombre,
            proveedor: row.Proveedor,
            linea: row.Linea == null ? null : String(row.Linea),
            faltan: row.faltan,
            descubierto: row.descubierto,
            ocTotal: row.ocTotal,
            stock: row.stock,
            importe: row.importe,
            importacion: row.importacion,
          },
        }),
      });
      if (!res.ok) throw new Error();
    } catch {
      setRows((rs) => rs.map((r) => (rowKey(r) === rowKey(row) ? { ...r, ...prev } : r)));
      setError("No se pudo guardar la fecha de arribo");
    }
  }, []);

  // Descartar: saca la fila de CUALQUIER tabla de la vista (principal, agrupada
  // por proveedor y extraordinarios), pero NO borra nada de la base — solo
  // guarda la marca en preparado.faltante_descartado (/api/compras/faltantes-
  // descartar) y faltantes-consumo la excluye de ahí en adelante. Optimista:
  // se anima y se saca de `rows` ya; si el POST falla, se reinserta + avisa.
  const descartarFaltante = useCallback((row: Row) => {
    const k = rowKey(row);
    setLeaving((m) => ({ ...m, [k]: "right" }));
    window.setTimeout(async () => {
      setRows((rs) => rs.filter((r) => rowKey(r) !== k));
      setLeaving((m) => {
        const n = { ...m };
        delete n[k];
        return n;
      });
      try {
        const res = await fetch("/api/compras/faltantes-descartar", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fecha: row.fecha, codArticulo: row.CodArticulo, descartado: true }),
        });
        if (!res.ok) throw new Error();
      } catch {
        setRows((rs) => [...rs, row]);
        setError("No se pudo descartar el renglón");
      }
    }, EXIT_MS);
  }, []);

  // Cuántas filas caen en "Otros" (ni Nacional ni Importado ni Fábrica ni
  // Original): si no hay ninguna, el botón sigue siendo el toggle de siempre
  // (Nacionales ↔ Importados) y esa tercera solapa ni aparece.
  const hayOtros = useMemo(
    () => rows.some((r) => origenDe(r) === "otros"),
    [rows],
  );
  // Cicla el filtro de origen: Nacionales → Importados → Otros (solo si hay).
  const ciclarOrigen = useCallback(() => {
    setOrigen((o) => {
      if (o === "nacionales") return "importados";
      if (o === "importados") return hayOtros ? "otros" : "nacionales";
      return "nacionales";
    });
  }, [hayOtros]);
  // Si "Otros" queda vacío tras recargar, no dejar la vista clavada ahí.
  useEffect(() => {
    if (origen === "otros" && !hayOtros) setOrigen("nacionales");
  }, [origen, hayOtros]);
  // Ningún lado muestra Fábrica (tipo Fabril, o EVER WEAR S.A. INDUSTRIAL sin
  // tipo cargado — eso se trabaja en /fabrica/faltantes) ni los de tipo
  // Original. Un artículo de tipo Nacional comprado a EVER WEAR sí entra acá.
  const pasaOrigen = useCallback((r: Row) => origenDe(r) === origen, [origen]);
  const pasaOrigenExtra = useCallback(
    (r: ExtraRow) => origenArticulo(r) === origen,
    [origen],
  );

  // Tabla principal: el backend (faltantes-consumo, punto 3d) ya le restó a
  // cada bucket lo marcado extraordinario de cada cliente — acá se muestra
  // tal cual viene, sin filtrar nada más.
  const frontRows = rows;
  // Reverso de la tarjeta: porciones extraordinarias YA DECIDIDAS por
  // /ventas/faltantes (comprar !== null). Mientras sigue null, esa cantidad
  // ya está afuera de la tabla principal pero todavía no aparece acá —
  // compras la ve como el "!" del botón 🚩 de esa fila.
  const backRows = useMemo(
    () =>
      extraordinarios
        .filter((r) => r.comprar !== null)
        .filter(pasaOrigenExtra)
        .sort((a, b) => b.importe - a.importe),
    [extraordinarios, pasaOrigenExtra],
  );

  // 1 fila por artículo: las filas "vivo" son buckets día a día del MISMO
  // acumulado (faltan/cubierto/descubierto ya vienen sumados) — se colapsan a
  // la más reciente por CodArticulo. Las "entregado" (histórico) son hechos
  // aparte, no acumulan entre sí, así que esas se muestran todas.
  const porArticulo = useMemo(() => {
    const ultimaVivaPorArt = new Map<string, Row>();
    const historicas: Row[] = [];
    for (const r of frontRows) {
      if (r.vivo) {
        const prev = ultimaVivaPorArt.get(r.CodArticulo);
        if (!prev || r.fecha > prev.fecha) ultimaVivaPorArt.set(r.CodArticulo, r);
      } else {
        historicas.push(r);
      }
    }
    return [...historicas, ...ultimaVivaPorArt.values()];
  }, [frontRows]);

  // Filtro de origen aplicado ANTES del conteo por estado, así los números de
  // los chips Todos/Cubiertos/Parciales/Sin OC reflejan Importados/Nacionales
  // cuando ese filtro está activo.
  const porArticuloOrigen = useMemo(
    () => porArticulo.filter(pasaOrigen),
    [porArticulo, pasaOrigen],
  );

  const conteo = useMemo(() => {
    const c = { todos: porArticuloOrigen.length, completo: 0, incompleto: 0, sin_orden: 0, entregado: 0 };
    for (const r of porArticuloOrigen) c[r.estado]++;
    return c as Record<Filtro, number>;
  }, [porArticuloOrigen]);

  // Orden jerárquico, SIEMPRE (el agrupado por proveedor ahora es permanente):
  //   1. Proveedor, por su importe TOTAL desc (mismo criterio que el acordeón).
  //   2. Artículo (CodArticulo), por su importe TOTAL desc dentro del proveedor.
  //   3. Día asc dentro del artículo.
  // Ordenar por el importe de cada FILA (como antes) rompe la agrupación: dos
  // días del mismo artículo con $ distinto quedaban separados por otro
  // artículo en el medio. Con el importe TOTAL por proveedor/artículo como
  // clave, los renglones de un mismo artículo (y de un mismo proveedor) quedan
  // siempre contiguos y el orden por $ no se pierde (se agrupa, no se ignora).
  const visibles = useMemo(() => {
    // "Todos" NO muestra los cubiertos (estado "completo", descubierto = 0):
    // apenas la mercadería entra y OC+stock tapan todo el faltante, la fila
    // sale sola de la tabla (2026-08-28). Siguen accesibles con el chip
    // "Cubiertos", que los lista aparte para corroborar.
    const base =
      filtro === "todos"
        ? porArticuloOrigen.filter((r) => r.estado !== "completo")
        : porArticuloOrigen.filter((r) => r.estado === filtro);

    const provImporte = new Map<string, number>();
    const artImporte = new Map<string, number>();
    for (const r of base) {
      const prov = r.Proveedor || "Sin proveedor";
      provImporte.set(prov, (provImporte.get(prov) ?? 0) + r.importe);
      artImporte.set(r.CodArticulo, (artImporte.get(r.CodArticulo) ?? 0) + r.importe);
    }

    return [...base].sort((a, b) => {
      const provA = a.Proveedor || "Sin proveedor";
      const provB = b.Proveedor || "Sin proveedor";
      const dProv = (provImporte.get(provB) ?? 0) - (provImporte.get(provA) ?? 0);
      if (dProv !== 0) return dProv;
      if (provA !== provB) return provA < provB ? -1 : 1;

      const dArt = (artImporte.get(b.CodArticulo) ?? 0) - (artImporte.get(a.CodArticulo) ?? 0);
      if (dArt !== 0) return dArt;
      if (a.CodArticulo !== b.CodArticulo) return a.CodArticulo < b.CodArticulo ? -1 : 1;

      return a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0;
    });
  }, [porArticuloOrigen, filtro]);

  const exportar = useCallback(() => {
    exportarFaltantesCompras(flipped ? backRows : visibles, {
      modo: flipped ? "extraordinarios" : "faltantes",
      desde: desdeResp,
      hasta: hastaResp,
    });
  }, [flipped, backRows, visibles, desdeResp, hastaResp]);

  // Excel histórico "con/sin existencia" (mismo reporte de /deposito/faltantes,
  // mismo endpoint GET /api/deposito/faltantes/historico?mes=YYYY-MM) — acá
  // solo se agrega el botón + selector de mes, la lógica de armado del Excel
  // es la misma (lib/deposito/exportFaltantesExistencia). Excluye comprobantes
  // 70/75 (ver comentario en el endpoint).
  const exportarHistorico = useCallback(async () => {
    setExportHistLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/deposito/faltantes/historico?mes=${mesExport}`,
        { cache: "no-store" },
      );
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      if (!j.rows?.length) {
        setError(`Sin marcas registradas en ${mesExport}`);
        return;
      }
      exportarFaltantesExistencia(j.rows, mesExport);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al exportar");
    } finally {
      setExportHistLoading(false);
    }
  }, [mesExport]);

  // Grupos por proveedor, cada grupo ordenado por importe y los grupos por importe total.
  const grupos = useMemo(() => {
    const m = new Map<string, Row[]>();
    for (const r of visibles) {
      const k = r.Proveedor || "Sin proveedor";
      const arr = m.get(k);
      if (arr) arr.push(r);
      else m.set(k, [r]);
    }
    return [...m.entries()]
      .map(([prov, rs]) => ({ prov, rs, importe: rs.reduce((s, x) => s + x.importe, 0) }))
      .sort((a, b) => b.importe - a.importe);
  }, [visibles]);

  // Buscar por código: encuentra en qué proveedor(es) aparece y abre el primero
  // (cierra cualquier otro — mismo acordeón "1 solo abierto a la vez" de
  // provAbierto). Si aparece en más de un proveedor, el botón "Siguiente"
  // cicla: cierra el actual y abre el que sigue.
  const buscarPorCodigo = useCallback(() => {
    const q = buscarCod.trim().toLowerCase();
    if (!q) {
      setMatches([]);
      setBuscado(false);
      return;
    }
    const found = grupos.filter((g) => g.rs.some((r) => r.CodArticulo.toLowerCase().includes(q)));
    setMatches(found);
    setMatchIdx(0);
    setBuscado(true);
    setProvAbierto(found.length > 0 ? found[0].prov : null);
  }, [buscarCod, grupos]);

  const siguienteMatch = useCallback(() => {
    if (matches.length === 0) return;
    const next = (matchIdx + 1) % matches.length;
    setMatchIdx(next);
    setProvAbierto(matches[next].prov);
  }, [matches, matchIdx]);

  const limpiarBusqueda = useCallback(() => {
    setBuscarCod("");
    setMatches([]);
    setMatchIdx(0);
    setBuscado(false);
  }, []);

  // Al abrir un proveedor (manual o por búsqueda) lo lleva a la vista.
  useEffect(() => {
    if (!provAbierto) return;
    provRefs.current.get(provAbierto)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [provAbierto]);

  // faltan/cubierto/descubierto de las filas "vivo" son ACUMULADOS por artículo
  // (crecen día a día, no se resetean). Sumar todas las filas duplicaría el
  // acumulado: para el total se toma solo la fila más nueva (última fecha) de
  // cada artículo. Las filas "entregado" (histórico) no acumulan, se suman todas.
  const tot = useMemo(() => {
    let importe = 0;
    const arts = new Set<string>();
    const ultimaVivaPorArt = new Map<string, Row>();
    let faltan = 0, cubierto = 0, descubierto = 0;
    for (const r of visibles) {
      importe += r.importe;
      arts.add(r.CodArticulo);
      if (r.vivo) {
        const prev = ultimaVivaPorArt.get(r.CodArticulo);
        if (!prev || r.fecha > prev.fecha) ultimaVivaPorArt.set(r.CodArticulo, r);
      } else {
        faltan += r.faltan;
        cubierto += r.cubierto;
        descubierto += r.descubierto;
      }
    }
    for (const r of ultimaVivaPorArt.values()) {
      faltan += r.faltan;
      cubierto += r.cubierto;
      descubierto += r.descubierto;
    }
    return { art: arts.size, dias: visibles.length, faltan, cubierto, descubierto, importe };
  }, [visibles]);

  const rango =
    desdeResp && hastaResp && desdeResp !== hastaResp
      ? `${fmtAr(desdeResp)} – ${fmtAr(hastaResp)}`
      : fmtAr(fecha);

  const hay = frontRows.length > 0;

  return (
    <div className="min-h-screen bg-[#111111] text-white">
      {(loading || error) && (
        <div className="fixed bottom-6 right-6 z-[110] flex flex-col gap-2">
          {loading && (
            <div className="flex items-center gap-3 bg-[#1A1A1A] border border-yellow-400/40 rounded-xl px-5 py-3 text-sm text-zinc-200">
              <Loader2 size={16} className="animate-spin text-yellow-400" />{" "}
              Consultando la base…
            </div>
          )}
          {error && (
            <div className="flex items-center gap-3 bg-[#1A1A1A] border border-red-400/40 rounded-xl px-5 py-3 text-sm text-red-300">
              <AlertTriangle size={16} className="text-red-400" /> {error}
            </div>
          )}
        </div>
      )}

      <header className="sticky top-0 z-50 bg-[#1A1A1A] border-b-[3px] border-yellow-400 flex items-center justify-between px-4 md:px-8 h-16 gap-4">
        <div className="flex items-center gap-4 min-w-0">
          <InicioButton />
          <span className="font-bold text-yellow-400 text-xl md:text-2xl tracking-wide uppercase whitespace-nowrap">
            EVER WEAR{" "}
            <span className="text-sm tracking-[3px] font-normal">S.A.</span>
          </span>
          <div className="hidden md:block w-px h-7 bg-yellow-400/30" />
          <span className="hidden md:inline text-zinc-500 text-sm">
            Faltantes a encargar · {rango}
          </span>
        </div>
        <div className="flex items-center gap-4 text-sm">
          <span className="hidden sm:inline text-zinc-400">
            <b className="text-yellow-400">{tot.art}</b> art. ·{" "}
            <b className="text-zinc-200">faltan {fmtNum(tot.faltan)}</b> ·{" "}
            <b className="text-green-400">cubren {fmtNum(tot.cubierto)}</b> ·{" "}
            <b className="text-red-400">faltan OC {fmtNum(tot.descubierto)}</b>
          </span>
          <button
            onClick={load}
            title="Refrescar"
            disabled={loading}
            className="btn-anim text-zinc-400 hover:text-yellow-400 p-2 disabled:opacity-40 disabled:hover:scale-100 disabled:hover:translate-y-0"
          >
            <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
          </button>
          <UsuarioActual />
        </div>
      </header>

      <main className="max-w-[1900px] mx-auto px-3 md:px-8 py-6">
        {/* Selector de rango + filtros por estado.
            sticky top-16: queda fijo debajo del header (h-16) al scrollear,
            para no tener que subir toda la vista para cambiar el rango. */}
        <div className="sticky top-16 z-40 -mx-3 md:-mx-8 px-3 md:px-8 py-3 mb-4 bg-[#111111]/95 backdrop-blur border-b border-zinc-800 flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-2 mr-2">
            <CalendarRange size={15} className="text-zinc-500" />
            <DateRangeField
              desde={desde}
              hasta={hasta}
              onChange={(d, h) => {
                setDesde(d);
                setHasta(h);
              }}
              className="text-xs h-7"
            />
            {(desde !== DESDE_DEFAULT || hasta !== todayISO()) && (
              <button
                onClick={() => {
                  setDesde(DESDE_DEFAULT);
                  setHasta(todayISO());
                }}
                className="text-xs text-zinc-500 hover:text-yellow-400 underline underline-offset-2"
              >
                restablecer
              </button>
            )}
          </div>

          <div className="flex items-center gap-1.5">
            <div className="relative">
              <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-zinc-500" />
              <input
                type="text"
                value={buscarCod}
                onChange={(e) => {
                  setBuscarCod(e.target.value);
                  setBuscado(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") buscarPorCodigo();
                  if (e.key === "Escape") limpiarBusqueda();
                }}
                disabled={flipped}
                placeholder="Buscar código…"
                title="Buscar por código de artículo — Enter para buscar; abre el proveedor donde aparece"
                className="bg-zinc-900 border border-zinc-700 rounded-lg pl-7 pr-2 py-1.5 text-xs text-zinc-100 outline-none focus:border-yellow-400 w-36 disabled:opacity-40"
              />
            </div>
            <button
              onClick={buscarPorCodigo}
              disabled={flipped || !buscarCod.trim()}
              title="Buscar"
              className="btn-anim px-2 py-1.5 rounded-lg border border-zinc-700 text-zinc-400 hover:border-yellow-400 hover:text-yellow-400 disabled:opacity-40"
            >
              <Search size={13} />
            </button>
            {matches.length > 0 && (
              <>
                <span className="text-[11px] text-zinc-500 whitespace-nowrap tabular-nums">
                  {matchIdx + 1}/{matches.length}
                </span>
                {matches.length > 1 && (
                  <button
                    onClick={siguienteMatch}
                    title="Siguiente coincidencia (cierra esta tabla y abre la próxima)"
                    className="btn-anim flex items-center gap-1 px-2 py-1.5 rounded-lg border border-zinc-700 text-zinc-300 hover:border-yellow-400 hover:text-yellow-400 text-xs"
                  >
                    Sig. <ArrowRight size={12} />
                  </button>
                )}
                <button
                  onClick={limpiarBusqueda}
                  title="Limpiar búsqueda"
                  className="text-zinc-600 hover:text-red-400 p-1"
                >
                  <X size={13} />
                </button>
              </>
            )}
            {buscado && matches.length === 0 && (
              <span className="text-[11px] text-red-400/80 whitespace-nowrap">sin coincidencias</span>
            )}
          </div>

          <div className="w-px h-5 bg-zinc-800 hidden sm:block" />

          <button
            onClick={() => setConArribo((v) => !v)}
            title="Mostrar también los artículos que ya tienen fecha de arribo cargada (para corroborar los que se pasaron)"
            className={`chip-anim flex items-center gap-2 px-3 py-1.5 rounded-md border text-xs font-medium ${
              conArribo
                ? "bg-emerald-500/15 border-emerald-400 text-emerald-300"
                : "border-zinc-700 text-zinc-400 hover:border-zinc-500"
            }`}
          >
            <CalendarCheck size={14} />
            Ver con arribo
            {conArribo && <Check size={13} />}
          </button>

          <button
            onClick={() => setVerRetirados((v) => !v)}
            disabled={cubiertos.length === 0}
            title="Ver los artículos que salieron de la tabla porque el stock cubrió el faltante"
            className={`chip-anim flex items-center gap-2 px-3 py-1.5 rounded-md border text-xs font-medium disabled:opacity-40 disabled:hover:scale-100 disabled:hover:translate-y-0 ${
              verRetirados
                ? "bg-emerald-500/15 border-emerald-400 text-emerald-300"
                : "border-zinc-700 text-zinc-400 hover:border-zinc-500"
            }`}
          >
            <PackageCheck size={14} />
            Retirados
            {cubiertos.length > 0 && (
              <span className="tabular-nums text-zinc-500">{cubiertos.length}</span>
            )}
          </button>

          <button
            onClick={ciclarOrigen}
            title={
              hayOtros
                ? "Filtra por origen del artículo — click para alternar: Nacionales / Importados / Otros"
                : "Filtra por origen del artículo — click para alternar: Nacionales / Importados"
            }
            className={`chip-anim flex items-center gap-2 px-3 py-1.5 rounded-md border text-xs font-medium ${
              origen === "importados"
                ? "bg-amber-500/15 border-amber-400 text-amber-300"
                : origen === "otros"
                  ? "bg-violet-500/15 border-violet-400 text-violet-300"
                  : "bg-sky-500/15 border-sky-400 text-sky-300"
            }`}
          >
            <Globe size={14} />
            {origen === "importados"
              ? "Importados"
              : origen === "otros"
                ? "Otros"
                : "Nacionales"}
          </button>

          <button
            onClick={() => setFlipped((v) => !v)}
            title="Ver pedidos extraordinarios marcados para comprar (gira la tabla)"
            className={`chip-anim flex items-center gap-2 px-3 py-1.5 rounded-md border text-xs font-medium ${
              backRows.length > 0
                ? "bg-red-500/15 border-red-400 text-red-300"
                : "border-zinc-700 text-zinc-400 hover:border-zinc-500"
            }`}
          >
            <RotateCw
              size={14}
              className={`transition-transform duration-500 ${flipped ? "rotate-180" : ""}`}
            />
            Extraordinario
            {backRows.length > 0 && (
              <span className="bg-red-500 text-white rounded-full px-1.5 text-[10px] leading-4 tabular-nums">
                {backRows.length}
              </span>
            )}
          </button>

          <button
            onClick={exportar}
            disabled={flipped ? backRows.length === 0 : visibles.length === 0}
            title="Exportar a Excel lo que se ve en la tabla"
            className="chip-anim flex items-center gap-2 px-3 py-1.5 rounded-md border border-zinc-700 text-zinc-300 hover:border-yellow-400 hover:text-yellow-400 text-xs font-medium disabled:opacity-40 disabled:hover:scale-100 disabled:hover:translate-y-0"
          >
            <Download size={14} /> Excel
          </button>

          <div className="w-px h-5 bg-zinc-800 hidden sm:block" />

          <input
            type="month"
            onClick={abrirPicker}
            value={mesExport}
            onChange={(e) => setMesExport(e.target.value)}
            title="Mes del histórico con/sin existencia a exportar"
            className="bg-zinc-900 border border-zinc-700 rounded-lg px-2 py-1.5 text-xs text-zinc-100 outline-none focus:border-yellow-400 cursor-pointer"
          />
          <button
            onClick={exportarHistorico}
            disabled={exportHistLoading}
            title="Exportar Excel histórico con/sin existencia del mes (mismo reporte que /deposito/faltantes)"
            className="chip-anim flex items-center gap-2 px-3 py-1.5 rounded-md border border-zinc-700 text-zinc-300 hover:border-yellow-400 hover:text-yellow-400 text-xs font-medium disabled:opacity-40 disabled:hover:scale-100 disabled:hover:translate-y-0"
          >
            {exportHistLoading ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Download size={14} />
            )}
            Excel (existencia)
          </button>

          {ocDesde && (
            <span
              title="El cruce con OC arranca en esta fecha: solo se cuentan las órdenes de compra y los faltantes desde acá."
              className="text-[11px] text-zinc-500 whitespace-nowrap"
            >
              OC desde {fmtAr(ocDesde)}
            </span>
          )}

          <div className="w-px h-5 bg-zinc-800 hidden sm:block" />

          {/* "entregado" ya no existe: todo lo marcado sin existencia es demanda viva.
              "completo" SÍ puede aparecer (cambio 2026-07-27): un artículo
              cubierto de verdad (OC+stock reales) ya no se excluye en el
              backend, se manda con fondo verde (ver faltantes-consumo/
              route.ts, punto 4b) — este chip deja filtrar solo esos. */}
          {FILTROS.filter((f) => f.key !== "entregado").map((f) => (
            <button
              key={f.key}
              onClick={() => setFiltro(f.key)}
              className={`chip-anim flex items-center gap-2 px-3 py-1.5 rounded-md border text-xs font-medium ${
                filtro === f.key
                  ? "bg-yellow-400/15 border-yellow-400 text-yellow-300"
                  : "border-zinc-700 text-zinc-400 hover:border-zinc-500"
              }`}
            >
              {f.label}
              <span
                className={`tabular-nums ${
                  filtro === f.key ? "text-yellow-200/80" : "text-zinc-500"
                }`}
              >
                {conteo[f.key] ?? 0}
              </span>
            </button>
          ))}
          {ocWarn && (
            <span className="flex items-center gap-1.5 text-xs text-amber-400/80 ml-1">
              <AlertTriangle size={13} /> OC no disponible — todo figura sin
              orden
            </span>
          )}
          {ingresoWarn && (
            <span className="flex items-center gap-1.5 text-xs text-amber-400/80 ml-1">
              <AlertTriangle size={13} /> Ingresos no disponibles — la columna
              “Ingresado” queda en cero
            </span>
          )}
          {!ingresoWarn && comprobanteWarn && (
            <span className="flex items-center gap-1.5 text-xs text-amber-400/80 ml-1">
              <AlertTriangle size={13} /> Ingresos sin filtro por tipo de
              comprobante — pueden entrar remitos de más
            </span>
          )}
        </div>

        {/* Retirados por stock: artículos que salieron de la tabla porque el
            stock cubrió el faltante acumulado (backend punto 4c). Solo
            lectura — quedan acá como constancia de qué se fue y cuándo. */}
        {verRetirados && cubiertos.length > 0 && (
          <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/[0.04] overflow-hidden">
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-emerald-500/20">
              <span className="flex items-center gap-2 text-xs font-medium text-emerald-300">
                <PackageCheck size={14} />
                Retirados por stock ({cubiertos.length})
              </span>
              <button
                onClick={() => setVerRetirados(false)}
                className="text-zinc-500 hover:text-zinc-300"
                title="Cerrar"
              >
                <X size={14} />
              </button>
            </div>
            <div className="overflow-x-auto max-h-80">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-zinc-950/95 text-zinc-500">
                  <tr className="text-left">
                    <th className="px-3 py-2 font-medium">Cód.</th>
                    <th className="px-3 py-2 font-medium">Artículo</th>
                    <th className="px-3 py-2 font-medium">Proveedor</th>
                    <th className="px-3 py-2 font-medium">Día faltante</th>
                    <th className="px-3 py-2 font-medium text-right">Faltaban</th>
                    <th className="px-3 py-2 font-medium text-right">Stock que lo cubrió</th>
                    <th className="px-3 py-2 font-medium">Retirado</th>
                  </tr>
                </thead>
                <tbody>
                  {cubiertos.map((c) => (
                    <tr
                      key={`${c.CodArticulo}__${c.fecha}`}
                      className="border-t border-zinc-800/70 text-zinc-300"
                    >
                      <td className="px-3 py-1.5 font-mono text-[11px]">{c.CodArticulo}</td>
                      <td className="px-3 py-1.5">{c.Nombre}</td>
                      <td className="px-3 py-1.5 text-zinc-400">{c.Proveedor || "—"}</td>
                      <td className="px-3 py-1.5 tabular-nums text-zinc-400">{fmtAr(c.fecha)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{fmtNum(c.faltan)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-emerald-400">
                        {fmtNum(c.stockPico)}
                      </td>
                      <td className="px-3 py-1.5 tabular-nums text-zinc-400">
                        {fmtAr(c.cubiertoEl)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Tarjeta que gira: frente = tabla normal, reverso = extraordinarios */}
        <div className="[perspective:2000px]">
          <div
            className={`relative grid min-w-0 transition-transform duration-700 ease-in-out [transform-style:preserve-3d] ${
              flipped ? "[transform:rotateY(180deg)]" : ""
            }`}
          >
            {/* Frente */}
            <div
              className={`col-start-1 row-start-1 min-w-0 [backface-visibility:hidden] ${
                flipped ? "pointer-events-none" : ""
              }`}
            >
              {!hay ? (
                <div className="flex flex-col items-center justify-center py-28 gap-3 text-center">
                  {loading ? (
                    <Loader2
                      size={40}
                      className="text-yellow-400 animate-spin"
                    />
                  ) : (
                    <PackageCheck size={44} className="text-zinc-700" />
                  )}
                  <p className="text-zinc-400 font-medium">
                    {loading
                      ? "Consultando la base…"
                      : "No hay faltantes marcados como “sin existencia”."}
                  </p>
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  {grupos.map(({ prov, rs, importe }) => {
                    const abierto = provAbierto === prov;
                    return (
                    <div
                      key={prov}
                      ref={(el) => {
                        if (el) provRefs.current.set(prov, el);
                        else provRefs.current.delete(prov);
                      }}
                      className="rounded-xl border border-zinc-800 overflow-hidden"
                    >
                      {/* Acordeón: click abre este proveedor y cierra el resto; todos cerrados al entrar. */}
                      <button
                        type="button"
                        onClick={() => setProvAbierto((p) => (p === prov ? null : prov))}
                        className="w-full flex items-center justify-between gap-3 px-4 py-2.5 bg-[#1A1A1A] text-left hover:bg-[#222] transition-colors"
                      >
                        <span className="flex items-center gap-2 min-w-0">
                          {abierto ? (
                            <ChevronDown size={15} className="text-zinc-500 shrink-0" />
                          ) : (
                            <ChevronRight size={15} className="text-zinc-500 shrink-0" />
                          )}
                          <span className="font-medium text-zinc-100 truncate">
                            {prov}
                          </span>
                          <span className="text-[11px] text-zinc-500 shrink-0">
                            {rs.length} reng.
                          </span>
                        </span>
                        <span className="text-sm tabular-nums text-zinc-300 shrink-0">
                          ${fmtNum(importe)}
                        </span>
                      </button>
                      {abierto && (
                        <div className="border-t border-zinc-800">
                          <Tabla
                            data={rs}
                            onMark={marcarExtraordinario}
                            onArribo={guardarArribo}
                            onDescartar={descartarFaltante}
                            leaving={leaving}
                            ocultarProveedor
                          />
                        </div>
                      )}
                    </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Reverso */}
            <div
              className={`col-start-1 row-start-1 min-w-0 [backface-visibility:hidden] [transform:rotateY(180deg)] ${
                !flipped ? "pointer-events-none" : ""
              }`}
            >
              <TablaExtraordinarios
                data={backRows}
                onToggleComprar={toggleComprarExtra}
                onUndo={desmarcarExtraordinario}
                leaving={leavingExtra}
              />
            </div>
          </div>
        </div>
      </main>

      {marcando && (
        <ModalMarcarExtraordinario
          row={marcando}
          onClose={() => setMarcando(null)}
          onConfirm={confirmarExtraordinario}
        />
      )}
    </div>
  );
}
