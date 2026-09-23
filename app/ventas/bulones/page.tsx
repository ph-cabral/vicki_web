"use client";
import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import {
  Loader2,
  AlertTriangle,
  Search,
  Users,
  Table2,
  ChevronDown,
  ChevronUp,
  Trophy,
  X,
  ListChevronsUpDown,
  UserRound,
  Info,
  Activity,
  Settings2,
} from "lucide-react";
import { InicioButton } from "@/components/ui/InicioButton";
import { UsuarioActual } from "@/components/auth/UsuarioActual";
import PulsoTab from "./PulsoTab";
import ConfigLineas from "./ConfigLineas";

// ──────────────────────────────────────────────────────────────────────────────
// 2026-09-23 — VISTA DE LÍNEAS (en el menú: "Líneas"; la URL sigue siendo
// /ventas/bulones para no romper permisos de sector ni accesos guardados).
// Ya no está clavada a Bulonería: arriba hay un selector con las líneas del
// catálogo (el mismo de /ventas/vendedor) y todo — rankings, modal y Pulso —
// se pide con `?linea=<id>`. Acá cualquier línea se abre entera (no se mira
// "apertura comercial" como en /ventas/vendedor).
//   · Las líneas que ofrece el selector salen de /api/ventas/lineas: ADMIN
//     todas; el resto, las que tenga habilitadas (sin configurar = sólo
//     Bulones). Las rutas proxy vuelven a validar la línea server-side.
//   · ADMIN tiene el botón de engranaje → ConfigLineas.tsx, para elegir qué
//     líneas ve cada usuario (everwear.usuario_linea_venta).
// Lo de abajo es la nota original; donde dice BULONERÍA hoy es "la línea
// elegida".
// ──────────────────────────────────────────────────────────────────────────────
// /ventas/bulones — la MISMA vista que /ventas/vendedor, acotada a la línea
// BULONERÍA (2026-08-26: "una vista igual a la de
// ventas/vendedores pero con agregados"). Tres diferencias, y sólo tres:
//
//   1. Todo sale filtrado por la línea BULONERÍA (lo hace el back, ver
//      bulones.py — acá no se filtra nada).
//   2. Como la línea es UNA sola, el eje "línea" se reemplaza por el PATRÓN
//      (StkFer_Articulos.ArticuloPatron). Se muestra su NOMBRE
//      (DetallePatron, campo `detalle`): el código es sólo un número y no
//      dice nada. El código igual viaja en `patron` porque es la clave con
//      la que se pide el drill-down, y se usa de fallback si un patrón no
//      tiene nombre cargado.
//   3. Hay un TERCER ranking, Vendedor, a la derecha de Clientes | Patrón —
//      el vendedor TAL CUAL figura en el comprobante, sin filtrar por estado
//      ni por "que sea una persona": entran MOSTRADOR, ECOMMERCE y demás
//      canales (a diferencia de /ventas/vendedor). Click en un vendedor →
//      los clientes que ÉL facturó (no su cartera). Ver bulones.py.
//
// 🔑 UN SOLO NIVEL DE MODAL ("acá solo se abrirá un modal, no puede ir otro
// modal más"). Por eso ACÁ NO EXISTE la pila de niveles de /ventas/vendedor
// (ver la nota `ventas_vendedor_drill_2_niveles` en memoria): las filas del
// modal son texto plano, no botones, y el estado del modal es UN solo
// `nivel`. Si algún día se pide drill-down, hay que traerse esa pila
// entera — no alcanza con hacer clickeable la primera columna.
//
// Las tres entradas al modal:
//   · Cliente  → códigos patrón que compró + el VENDEDOR ASIGNADO arriba.
//   · Patrón   → ranking de clientes que lo compraron.
//   · Vendedor → ranking de clientes que ese vendedor facturó.
//
// Fuente: /api/ventas/bulones/* → indicadores-api (bulones.py). Mismo
// criterio de "venta neta" ya verificado contra el pivot Excel real.
//
// 2026-09-09 — CUARTA pestaña, "Pulso" (PulsoTab.tsx): el ranking del período
// que se elija (mes o rango) con el OBJETIVO de cada vendedor al lado. Vino
// del pie de /ventas/presupuestos, donde ya no está. No es un cuarto eje del
// ranking de acá: tiene período y consultas propias, por eso se prende con un
// booleano (`vistaPulso`) y reemplaza el cuerpo de la página en vez de entrar
// en `topVista`.
// ──────────────────────────────────────────────────────────────────────────────

interface Cliente {
  numero: number;
  nombre: string | null;
}

interface MesVal {
  mes: number;
  label: string;
  cantidad: number;
  monto: number;
}

interface AnioVal {
  cantidad: number;
  monto: number;
  meses: MesVal[];
}

interface Totales {
  anioAnterior: AnioVal;
  anioActual: AnioVal;
}

// Parte común de las TRES respuestas del modal: los dos años con desglose
// mensual y las dos métricas. Que sea la misma forma es lo que permite una
// sola tabla para los tres modos (igual que en /ventas/vendedor).
interface RespMatriz {
  anioAnterior: number;
  anioActual: number;
  tieneDatos: boolean;
  totales: Totales;
}

interface ClienteVal {
  numero: number;
  nombre: string | null;
  anioAnterior: AnioVal;
  anioActual: AnioVal;
}

interface PatronVal {
  patron: string;
  // Nombre del patrón (StkFer_Articulos.DetallePatron). null = sin nombre
  // cargado en Magnus → se cae al código.
  detalle: string | null;
  anioAnterior: AnioVal;
  anioActual: AnioVal;
}

interface RespClientesPorPatron extends RespMatriz {
  patron: string;
  detalle: string | null;
  totalClientes: number;
  clientes: ClienteVal[];
}

interface RespClientesPorVendedor extends RespMatriz {
  vendedor: { codigo: number; nombre: string | null };
  totalClientes: number;
  clientes: ClienteVal[];
}

interface RespPatronesPorCliente extends RespMatriz {
  cliente: { codigo: number; nombre: string | null };
  // El agregado propio de esta vista (2026-08-26): quién
  // tiene asignado a ese cliente. Sale del maestro de Magnus (Vendedor por
  // Defecto), no del comprobante. `null` = mostrador / sin vendedor fijo.
  vendedorAsignado: { codigo: number; nombre: string | null } | null;
  totalPatrones: number;
  patrones: PatronVal[];
}

/**
 * Cómo se muestra un patrón en pantalla: el NOMBRE (DetallePatron) y, si no
 * está cargado en Magnus, el código pelado como último recurso. El código
 * nunca es la etiqueta principal — no le dice nada a nadie —, pero se
 * conserva en el `title` de la fila para poder cruzarlo con Magnus.
 */
const etiquetaPatron = (p: { patron: string; detalle: string | null }) =>
  p.detalle?.trim() || p.patron;

// Fila normalizada de la tabla del modal — unifica los tres modos.
interface FilaTabla {
  key: string;
  etiqueta: string;
  anioAnterior: AnioVal;
  anioActual: AnioVal;
}

// Los rankings del pie traen DOS ventanas (2026-09-09, mismo criterio que
// /ventas/vendedor): el campo pelado es el ACUMULADO Enero→mes anterior y el
// sufijo `Mes` es el MES EN CURSO. Van en columnas separadas porque el mes
// está incompleto — ver bulones.py, arriba de fetch_top_clientes.
interface TopCliente {
  numero: number;
  nombre: string | null;
  monto: number;
  montoMes: number;
}

interface TopPatron {
  patron: string;
  detalle: string | null;
  unidades: number;
  unidadesMes: number;
  monto: number;
  montoMes: number;
}

interface TopVendedor {
  codigo: number;
  nombre: string | null;
  unidades: number;
  unidadesMes: number;
  monto: number;
  montoMes: number;
}

// `desde`/`hasta` son NULL en enero: todavía no hay ningún mes cerrado del
// año y la columna del acumulado queda vacía a propósito.
interface RespTopClientes {
  desde: string | null;
  hasta: string | null;
  mesActual: string;
  totalClientes: number;
  porMonto: TopCliente[];
}

interface RespTopPatrones {
  desde: string | null;
  hasta: string | null;
  mesActual: string;
  totalPatrones: number;
  totalPatronesMonto: number;
  porUnidades: TopPatron[];
  porMonto: TopPatron[];
}

interface RespTopVendedores {
  desde: string | null;
  hasta: string | null;
  mesActual: string;
  totalVendedores: number;
  totalVendedoresMonto: number;
  porUnidades: TopVendedor[];
  porMonto: TopVendedor[];
}

// Las tres pestañas del ranking del pie. "vendedores" es la nueva (va a la
// DERECHA de las otras dos).
type TopVista = "clientes" | "patrones" | "vendedores";
type Modo = "unidades" | "pesos";
type Periodo = "ytd" | "meses";

const MESES_CORTOS_ES = [
  "Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic",
];

// Nombre completo, sólo para el encabezado de la columna del mes en curso:
// ahí entra uno solo y el corto queda pobre al lado del rango del acumulado.
const MESES_ES = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

const fmtNum = (n: number | null | undefined) =>
  new Intl.NumberFormat("es-AR", { maximumFractionDigits: 0 }).format(n || 0);
const fmtMoney = (n: number | null | undefined) =>
  new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    maximumFractionDigits: 0,
  }).format(n || 0);

const labelCliente = (c: Cliente) => (c.nombre ? `${c.nombre} (${c.numero})` : String(c.numero));

// ── Agrupado en acordeón (mismo mecanismo que /ventas/vendedor) ───────────
// El back trae TODO lo que entra en el rango; con cientos de filas la tabla
// se vuelve ilegible, así que se agrupan de a GROUP_SIZE en bloques
// colapsables dentro de la MISMA tabla. Acordeón real: un solo grupo
// abierto a la vez.
const GROUP_SIZE = 50;

// "Todas las líneas" (2026-09-23) — mismo id reservado que
// lib/ventas/lineasAcceso.ts (LINEA_TODAS) y bulones.py.
const LINEA_TODAS = 0;
const NOMBRE_TODAS = "Todas las líneas";

function agrupar<T>(items: T[]): T[][] {
  const grupos: T[][] = [];
  for (let i = 0; i < items.length; i += GROUP_SIZE) {
    grupos.push(items.slice(i, i + GROUP_SIZE));
  }
  return grupos;
}

// Ícono de info (2026-09-08) — mismo aviso que en /ventas/vendedor: el año en
// curso incluye el mes a medio facturar, así que el total es estimativo.
// Tooltip propio en hover/focus + `title` nativo como respaldo por si el
// contenedor con overflow lo recorta.
function IconoEstimativo() {
  return (
    <span
      className="group relative inline-flex cursor-help align-middle"
      tabIndex={0}
      title="Estos valores son estimativos"
      aria-label="Estos valores son estimativos"
    >
      <Info size={13} className="text-zinc-500 hover:text-zinc-300 transition-colors" />
      <span className="pointer-events-none absolute left-1/2 top-full z-30 mt-1 hidden -translate-x-1/2 whitespace-nowrap rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] font-normal text-zinc-200 shadow-lg group-hover:block group-focus:block">
        Estos valores son estimativos
      </span>
    </span>
  );
}

function FilaGrupo({
  idx,
  desde,
  hasta,
  total,
  abierto,
  onClick,
  colSpan,
}: {
  idx: number;
  desde: number;
  hasta: number;
  total: number;
  abierto: boolean;
  onClick: () => void;
  colSpan: number;
}) {
  return (
    <tr
      className={`cursor-pointer border-t border-zinc-800 bg-zinc-900/60 hover:bg-zinc-800/60 transition-colors ${
        abierto ? "border-b border-yellow-400/30" : ""
      }`}
      onClick={onClick}
    >
      <td colSpan={colSpan} className="px-3 py-2">
        <span className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-zinc-300">
          {abierto ? (
            <ChevronUp size={14} className="text-yellow-400" />
          ) : (
            <ChevronDown size={14} className="text-zinc-500" />
          )}
          {desde + 1}–{hasta}
          <span className="text-zinc-500 font-normal normal-case">de {total}</span>
        </span>
      </td>
    </tr>
  );
}

export default function VentasBulonesPage() {
  // ── Búsqueda de cliente (header del modal) ──────────────────────────────
  // Usa /api/ventas/bulones/clientes (mismo maestro de clientes que
  // /ventas/vendedor, mismo contrato). Ruta propia y NO la de vendedor porque
  // el acceso de esta vista se resuelve con resolverAccesoBulones: los
  // vendedores con acceso total a bulonería (ver lib/ventas/bulonesAcceso.ts)
  // tienen que poder buscar cualquier cliente, no sólo su cartera.
  const [qCliente, setQCliente] = useState("");
  const [sugerencias, setSugerencias] = useState<Cliente[]>([]);
  const [buscando, setBuscando] = useState(false);
  const [mostrarSug, setMostrarSug] = useState(false);
  const [clienteSel, setClienteSel] = useState<Cliente | null>(null);
  const [sinVendedorAsignado, setSinVendedorAsignado] = useState(false);
  const blurTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const texto = qCliente.trim();
    if (!texto || (clienteSel && texto === labelCliente(clienteSel))) {
      setSugerencias([]);
      return;
    }
    if (texto.length < 2) {
      setSugerencias([]);
      return;
    }
    setBuscando(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/ventas/bulones/clientes?q=${encodeURIComponent(texto)}`, {
          cache: "no-store",
        });
        const j = await res.json().catch(() => ({}));
        setSugerencias(Array.isArray(j?.clientes) ? j.clientes : []);
        setSinVendedorAsignado(!!j?.sinVendedorAsignado);
        setMostrarSug(true);
      } catch {
        setSugerencias([]);
      } finally {
        setBuscando(false);
      }
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qCliente]);

  // ── Línea elegida (2026-09-23) ──────────────────────────────────────────
  // Se piden UNA vez las líneas que el usuario puede ver; hasta tenerlas no se
  // dispara ningún ranking (lineaId en null). Si tiene una sola, el selector
  // queda fijo (deshabilitado) mostrando cuál es.
  const [lineas, setLineas] = useState<{ id: number; nombre: string }[]>([]);
  const [lineaId, setLineaId] = useState<number | null>(null);
  const [esAdmin, setEsAdmin] = useState(false);
  // "Todas las líneas" (id 0, 2026-09-23): vista general, sólo si el usuario
  // tiene más de una línea habilitada. ADMIN = toda la venta; el resto = la
  // unión de sus líneas (lo resuelve el proxy, ver lib/ventas/lineasAcceso.ts).
  const [hayTodas, setHayTodas] = useState(false);
  const [lineasError, setLineasError] = useState<string | null>(null);
  const [configOpen, setConfigOpen] = useState(false);

  useEffect(() => {
    let cancelado = false;
    fetch("/api/ventas/lineas", { cache: "no-store" })
      .then(async (res) => {
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
        if (cancelado) return;
        const ls = Array.isArray(j.lineas) ? j.lineas : [];
        setLineas(ls);
        setEsAdmin(!!j.esAdmin);
        setHayTodas(!!j.todas && ls.length > 1);
        if (!ls.length) setLineasError("No tenés ninguna línea habilitada");
        else setLineaId(typeof j.defecto === "number" ? j.defecto : ls[0].id);
      })
      .catch((e) => {
        if (!cancelado) setLineasError(e instanceof Error ? e.message : "Error al cargar las líneas");
      });
    return () => {
      cancelado = true;
    };
  }, []);

  const esTodas = lineaId === LINEA_TODAS;
  const lineaSel =
    esTodas ? { id: LINEA_TODAS, nombre: NOMBRE_TODAS } : lineas.find((l) => l.id === lineaId) ?? null;
  const lineaNombre = lineaSel?.nombre ?? "línea";
  const qLinea = lineaId != null ? `&linea=${lineaId}` : "";

  // ── Ranking del pie ─────────────────────────────────────────────────────
  const [topVista, setTopVista] = useState<TopVista>("clientes");
  // Pestaña "Pulso" (2026-09-09): el ranking del período elegido con objetivo
  // por vendedor, que antes vivía al pie de /ventas/presupuestos. Es un
  // booleano aparte y no un cuarto valor de `TopVista` porque no es otro EJE
  // del mismo ranking: reemplaza el cuerpo de la página (período propio,
  // consultas propias) y `topVista` sigue mandando cuando se vuelve.
  const [vistaPulso, setVistaPulso] = useState(false);
  // Métrica del ranking cuando la vista es "patrones" o "vendedores". En
  // "clientes" no aplica: ahí siempre es $ (igual que en /ventas/vendedor).
  const [topMetrica, setTopMetrica] = useState<Modo>("pesos");
  const modo: Modo = topVista === "clientes" ? "pesos" : topMetrica;

  // ── Modal (UN SOLO NIVEL — ver la nota de arriba) ───────────────────────
  type Nivel =
    | { mode: "cliente"; cliente: Cliente }
    | { mode: "patron"; patron: string }
    | { mode: "vendedor"; vendedor: { codigo: number; nombre: string | null } };
  const [modalOpen, setModalOpen] = useState(false);
  const [nivel, setNivel] = useState<Nivel | null>(null);
  const [filtroVisible, setFiltroVisible] = useState(true);
  const [desglosado, setDesglosado] = useState(false);
  const [periodo, setPeriodo] = useState<Periodo>("ytd");
  // Métrica de la tabla del modal — estado PROPIO, independiente del
  // ranking del pie (togglear uno no toca al otro).
  const [modoModal, setModoModal] = useState<Modo>("pesos");
  const [filasGrupoAbierto, setFilasGrupoAbierto] = useState(0);
  const [topGrupoAbierto, setTopGrupoAbierto] = useState(0);

  // Las TRES respuestas viven en estados separados; `nivel.mode` decide
  // cuál se muestra. Cada fetch limpia las otras dos para que no quede una
  // tabla vieja pintada mientras carga la nueva.
  const [detCliente, setDetCliente] = useState<RespPatronesPorCliente | null>(null);
  const [detPatron, setDetPatron] = useState<RespClientesPorPatron | null>(null);
  const [detVendedor, setDetVendedor] = useState<RespClientesPorVendedor | null>(null);
  const [detLoading, setDetLoading] = useState(false);
  const [detError, setDetError] = useState<string | null>(null);

  const cerrarModal = useCallback(() => setModalOpen(false), []);

  const limpiarDetalle = useCallback(() => {
    setDetCliente(null);
    setDetPatron(null);
    setDetVendedor(null);
    setDetError(null);
    setFilasGrupoAbierto(0);
  }, []);

  const pedirDetalle = useCallback(
    async (url: string, guardar: (j: unknown) => void) => {
      setDetLoading(true);
      try {
        const res = await fetch(url, { cache: "no-store" });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
        guardar(j);
      } catch (e) {
        setDetError(e instanceof Error ? e.message : "Error al cargar");
      } finally {
        setDetLoading(false);
      }
    },
    [],
  );

  // Las tres entradas al modal. Ninguna apila: abrir una reemplaza a la
  // anterior (un solo nivel).
  const abrirCliente = useCallback(
    (c: Cliente) => {
      limpiarDetalle();
      setClienteSel(c);
      setQCliente(labelCliente(c));
      setSugerencias([]);
      setMostrarSug(false);
      setNivel({ mode: "cliente", cliente: c });
      setModalOpen(true);
      setFiltroVisible(true);
      pedirDetalle(
        `/api/ventas/bulones/patrones-por-cliente?cliente=${c.numero}${qLinea}`,
        (j) => setDetCliente(j as RespPatronesPorCliente),
      );
    },
    [limpiarDetalle, pedirDetalle, qLinea],
  );

  const abrirPatron = useCallback(
    (patron: string) => {
      limpiarDetalle();
      setQCliente("");
      setClienteSel(null);
      setSugerencias([]);
      setMostrarSug(false);
      setNivel({ mode: "patron", patron });
      setModalOpen(true);
      setFiltroVisible(true);
      pedirDetalle(
        `/api/ventas/bulones/clientes-por-patron?patron=${encodeURIComponent(patron)}${qLinea}`,
        (j) => setDetPatron(j as RespClientesPorPatron),
      );
    },
    [limpiarDetalle, pedirDetalle, qLinea],
  );

  const abrirVendedor = useCallback(
    (v: { codigo: number; nombre: string | null }) => {
      limpiarDetalle();
      setQCliente("");
      setClienteSel(null);
      setSugerencias([]);
      setMostrarSug(false);
      setNivel({ mode: "vendedor", vendedor: v });
      setModalOpen(true);
      setFiltroVisible(true);
      pedirDetalle(
        `/api/ventas/bulones/clientes-por-vendedor?codigo=${v.codigo}${qLinea}`,
        (j) => setDetVendedor(j as RespClientesPorVendedor),
      );
    },
    [limpiarDetalle, pedirDetalle, qLinea],
  );

  // Abre el modal vacío, listo para buscar cualquier cliente (no sólo los
  // que aparecen en el ranking).
  const abrirModalBusqueda = useCallback(() => {
    limpiarDetalle();
    setNivel(null);
    setClienteSel(null);
    setQCliente("");
    setSugerencias([]);
    setModalOpen(true);
    setFiltroVisible(true);
  }, [limpiarDetalle]);

  // ── Rankings: se piden los TRES al montar ───────────────────────────────
  // El rango lo resuelve el back y son DOS ventanas: acumulado Enero→mes
  // anterior y mes en curso, cada una en su columna. El back cachea 15 min,
  // así que alternar pestañas es instantáneo en vez de disparar un fetch por
  // cambio, y cambiar de métrica tampoco refetchea: las cuatro sumas
  // (unidades/monto × acumulado/mes) vienen en el mismo payload.
  const [topClientes, setTopClientes] = useState<RespTopClientes | null>(null);
  const [topPatrones, setTopPatrones] = useState<RespTopPatrones | null>(null);
  const [topVendedores, setTopVendedores] = useState<RespTopVendedores | null>(null);
  const [topLoading, setTopLoading] = useState(false);
  const [topError, setTopError] = useState<string | null>(null);

  useEffect(() => {
    if (lineaId == null) return;
    let cancelado = false;
    setTopLoading(true);
    setTopError(null);
    setTopGrupoAbierto(0);
    const pedir = async (ruta: string) => {
      const res = await fetch(`/api/ventas/bulones/${ruta}?linea=${lineaId}`, { cache: "no-store" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      return j;
    };
    Promise.all([pedir("top-clientes"), pedir("top-patrones"), pedir("top-vendedores")])
      .then(([cli, pat, ven]) => {
        if (cancelado) return;
        setTopClientes(cli);
        setTopPatrones(pat);
        setTopVendedores(ven);
      })
      .catch((e) => {
        if (!cancelado) setTopError(e instanceof Error ? e.message : "Error al cargar los rankings");
      })
      .finally(() => {
        if (!cancelado) setTopLoading(false);
      });
    return () => {
      cancelado = true;
    };
  }, [lineaId]);

  // La tarjeta de bonificación prorrateada se sacó de la vista. El cálculo
  // sigue vivo en /api/ventas/bulones/bonificacion + bonificaciones.py por si
  // se lo quiere volver a mostrar; acá ya no se pide (una query menos).

  // ── Período YTD / Meses ─────────────────────────────────────────────────
  // "YTD" = Enero..mes ANTERIOR (el mes en curso queda afuera por estar
  // incompleto). "Meses" = el mes actual completo. No refetchea: filtra el
  // desglose mensual ya traído.
  const mesActualNum = new Date().getMonth() + 1;
  const mesAnteriorNum = mesActualNum - 1;
  const mesesActivos = useMemo(
    () =>
      periodo === "ytd"
        ? Array.from({ length: mesAnteriorNum }, (_, i) => i + 1)
        : [mesActualNum],
    [periodo, mesAnteriorNum, mesActualNum],
  );

  const sumaPeriodo = useCallback(
    (a: AnioVal) =>
      a.meses.reduce(
        (acc, m) =>
          mesesActivos.includes(m.mes)
            ? { cantidad: acc.cantidad + m.cantidad, monto: acc.monto + m.monto }
            : acc,
        { cantidad: 0, monto: 0 },
      ),
    [mesesActivos],
  );

  const valor = useCallback(
    (a: { cantidad: number; monto: number }) => (modoModal === "unidades" ? a.cantidad : a.monto),
    [modoModal],
  );
  const valorMes = useCallback(
    (m: MesVal) => (modoModal === "unidades" ? m.cantidad : m.monto),
    [modoModal],
  );
  const fmt = modoModal === "unidades" ? fmtNum : fmtMoney;
  const fmtTop = modo === "unidades" ? fmtNum : fmtMoney;

  // ── Tabla del modal: MISMA tabla para los tres modos ────────────────────
  // Lo único que cambia es qué identifica la fila:
  //   · modo "cliente"  → una fila por CÓDIGO PATRÓN
  //   · modo "patron"   → una fila por CLIENTE
  //   · modo "vendedor" → una fila por CLIENTE
  const modalMode = nivel?.mode ?? null;
  const fuenteTabla: RespMatriz | null =
    modalMode === "cliente" ? detCliente : modalMode === "patron" ? detPatron : modalMode === "vendedor" ? detVendedor : null;

  const filas: FilaTabla[] = useMemo(() => {
    const deClientes = (cs: ClienteVal[]): FilaTabla[] =>
      cs.map((c) => ({
        key: `cli-${c.numero}`,
        etiqueta: c.nombre ? `${c.nombre} (${c.numero})` : String(c.numero),
        anioAnterior: c.anioAnterior,
        anioActual: c.anioActual,
      }));
    const base: FilaTabla[] =
      modalMode === "cliente"
        ? (detCliente?.patrones ?? []).map((p) => ({
            key: `pat-${p.patron}`,
            etiqueta: etiquetaPatron(p),
            anioAnterior: p.anioAnterior,
            anioActual: p.anioActual,
          }))
        : modalMode === "patron"
          ? deClientes(detPatron?.clientes ?? [])
          : modalMode === "vendedor"
            ? deClientes(detVendedor?.clientes ?? [])
            : [];
    // Orden por el TOTAL DEL AÑO ANTERIOR sobre el mismo valor/período que
    // muestra la tabla (respeta YTD/Meses y $/Unidades), desempate por el
    // año actual y después alfabético para que sea estable.
    return [...base].sort((a, b) => {
      const ant = valor(sumaPeriodo(b.anioAnterior)) - valor(sumaPeriodo(a.anioAnterior));
      if (ant !== 0) return ant;
      const act = valor(sumaPeriodo(b.anioActual)) - valor(sumaPeriodo(a.anioActual));
      if (act !== 0) return act;
      return a.etiqueta.localeCompare(b.etiqueta, "es");
    });
  }, [modalMode, detCliente, detPatron, detVendedor, valor, sumaPeriodo]);

  const hayTabla = !!fuenteTabla;
  const sinDatos = !!fuenteTabla && !fuenteTabla.tieneDatos;
  // Encabezado de la primera columna del modal.
  const colEtiqueta = modalMode === "cliente" ? "Patrón" : "Cliente";
  const sinMesesPeriodo = periodo === "ytd" && mesesActivos.length === 0;

  const tituloNivel =
    nivel?.mode === "cliente"
      ? nivel.cliente.nombre ?? String(nivel.cliente.numero)
      : nivel?.mode === "patron"
        ? detPatron?.detalle?.trim() || nivel.patron
        : nivel?.mode === "vendedor"
          ? nivel.vendedor.nombre ?? String(nivel.vendedor.codigo)
          : "";
  const subtituloNivel =
    modalMode === "cliente"
      ? `Patrones de ${lineaNombre} que compró este cliente`
      : modalMode === "patron"
        ? "Clientes que compraron este patrón"
        : "Clientes de este vendedor";

  const mesesMostrados = mesesActivos;
  const nMesesMostrados = mesesMostrados.length;
  const mostrarTotalAnio = !desglosado || nMesesMostrados > 1;
  const SEP_BLOQUE = "border-l-2 border-yellow-400/40";
  const SEP_FINO = "border-l border-zinc-800";
  const sepTotalAnio = desglosado ? SEP_FINO : SEP_BLOQUE;
  const colSpanAnio = desglosado ? nMesesMostrados + (mostrarTotalAnio ? 1 : 0) : 1;
  const labelDeMes = (a: AnioVal, mes: number) => a.meses.find((m) => m.mes === mes)?.label ?? "";

  // Índices de columna para el iluminado por fila/columna.
  const COL_ETIQ = 0;
  const colAnteriorMes = (mes: number) => 1 + mesesMostrados.indexOf(mes);
  const colAnteriorTotal = desglosado ? 1 + nMesesMostrados : 1;
  const colActualMes = (mes: number) => 1 + colSpanAnio + mesesMostrados.indexOf(mes);
  const colActualTotal = desglosado ? 1 + colSpanAnio + nMesesMostrados : 2;

  const [hoverRow, setHoverRow] = useState<number | null>(null);
  const [hoverCol, setHoverCol] = useState<number | null>(null);
  const limpiarHover = useCallback(() => {
    setHoverRow(null);
    setHoverCol(null);
  }, []);
  const celda = useCallback(
    (rowIdx: number, colIdx: number, crece: boolean) => {
      const iluminada = hoverRow === rowIdx || hoverCol === colIdx;
      if (crece) return iluminada ? "bg-green-500/25" : "bg-green-500/10";
      return iluminada ? "bg-yellow-400/10" : "";
    },
    [hoverRow, hoverCol],
  );
  const crece = useCallback(
    (r: { anioAnterior: AnioVal; anioActual: AnioVal }) =>
      valor(sumaPeriodo(r.anioActual)) > valor(sumaPeriodo(r.anioAnterior)),
    [valor, sumaPeriodo],
  );
  const tendencia = useCallback(
    (r: { anioAnterior: AnioVal; anioActual: AnioVal }): "sube" | "baja" | "igual" => {
      const ant = valor(sumaPeriodo(r.anioAnterior));
      const act = valor(sumaPeriodo(r.anioActual));
      if (act > ant) return "sube";
      if (act < ant) return "baja";
      return "igual";
    },
    [valor, sumaPeriodo],
  );
  // El color de la tendencia va en el TEXTO, no en el fondo (así una fila
  // que bajó no queda pintada entera de rojo).
  const celdaTendencia = (t: "sube" | "baja" | "igual") =>
    t === "sube" ? "text-green-400" : t === "baja" ? "text-red-400" : "text-zinc-600";
  const iconoTendencia = (t: "sube" | "baja" | "igual") =>
    t === "sube" ? "▲" : t === "baja" ? "▼" : "—";
  const pctTendencia = useCallback(
    (r: { anioAnterior: AnioVal; anioActual: AnioVal }): number | null => {
      const ant = valor(sumaPeriodo(r.anioAnterior));
      const act = valor(sumaPeriodo(r.anioActual));
      if (!ant) return null;
      return ((act - ant) / Math.abs(ant)) * 100;
    },
    [valor, sumaPeriodo],
  );
  const fmtPct = (p: number | null) =>
    p === null
      ? ""
      : `${p > 0 ? "+" : ""}${new Intl.NumberFormat("es-AR", { maximumFractionDigits: 0 }).format(p)}%`;

  const filasGrupos = agrupar(filas);
  const filasGrupoSeguro = Math.min(filasGrupoAbierto, Math.max(0, filasGrupos.length - 1));
  const totalColsTabla = 2 + 2 * colSpanAnio;

  // Cada vista/métrica usa la lista que YA viene ordenada del back.
  const topItems: (TopCliente | TopPatron | TopVendedor)[] =
    topVista === "clientes"
      ? topClientes?.porMonto ?? []
      : topVista === "patrones"
        ? (topMetrica === "pesos" ? topPatrones?.porMonto : topPatrones?.porUnidades) ?? []
        : (topMetrica === "pesos" ? topVendedores?.porMonto : topVendedores?.porUnidades) ?? [];
  const topGrupos = agrupar(topItems);
  const topGrupoSeguro = Math.min(topGrupoAbierto, Math.max(0, topGrupos.length - 1));
  const colTop =
    topVista === "clientes" ? "Cliente" : topVista === "patrones" ? "Patrón" : "Vendedor";

  // Totales del pie (2026-09-23, igual que /ventas/vendedor): suman TODAS las
  // filas del ranking, estén o no en el grupo abierto del acordeón — es el
  // total del período, no el de lo que hay a la vista. Misma métrica que las
  // filas ($ o unidades, acumulado y mes en curso).
  const topSumas = useMemo(() => {
    let acum = 0;
    let mes = 0;
    for (const it of topItems) {
      if (topVista === "clientes") {
        const c = it as TopCliente;
        acum += c.monto;
        mes += c.montoMes;
      } else {
        const x = it as TopPatron | TopVendedor;
        acum += topMetrica === "pesos" ? x.monto : x.unidades;
        mes += topMetrica === "pesos" ? x.montoMes : x.unidadesMes;
      }
    }
    return { acum, mes };
  }, [topItems, topVista, topMetrica]);
  const nombreFilasTop =
    topVista === "clientes" ? "clientes" : topVista === "patrones" ? "patrones" : "vendedores";

  // Etiquetas de los dos encabezados. Salen del BACK (`desde`/`hasta`/
  // `mesActual`) para que el título no pueda contradecir a los datos: las
  // tres respuestas traen el mismo rango, así que alcanza con la de la vista
  // activa. En enero desde/hasta vienen en null y el acumulado queda vacío.
  const topResp: { desde: string | null; hasta: string | null; mesActual: string } | null =
    topVista === "clientes"
      ? topClientes
      : topVista === "patrones"
        ? topPatrones
        : topVendedores;
  const nombreMesCorto = (ym: string | null | undefined) =>
    ym ? MESES_CORTOS_ES[Number(ym.slice(5, 7)) - 1] ?? "" : "";
  const rangoAcumLabel =
    topResp?.desde && topResp?.hasta
      ? `${nombreMesCorto(topResp.desde)}–${nombreMesCorto(topResp.hasta)} ${topResp.hasta.slice(0, 4)}`
      : "Sin meses cerrados";
  // El mes en curso va con el nombre entero y SIN año: el año ya está en la
  // etiqueta del acumulado de al lado. Si el back todavía no contestó no se
  // inventa un mes, se cae al rótulo genérico.
  const mesActualLabel = topResp?.mesActual
    ? MESES_ES[Number(topResp.mesActual.slice(5, 7)) - 1] ?? "Mes en curso"
    : "Mes en curso";

  return (
    <div className="min-h-screen bg-[#111111] text-white">
      {(detLoading || detError) && (
        <div className="fixed bottom-6 right-6 z-[110] flex flex-col gap-2">
          {detLoading && (
            <div className="flex items-center gap-3 bg-[#1A1A1A] border border-yellow-400/40 rounded-xl px-5 py-3 text-sm text-zinc-200">
              <Loader2 size={16} className="animate-spin text-yellow-400" /> Consultando la base…
            </div>
          )}
          {detError && (
            <div className="flex items-center gap-3 bg-[#1A1A1A] border border-red-400/40 rounded-xl px-5 py-3 text-sm text-red-300">
              <AlertTriangle size={16} className="text-red-400" /> {detError}
            </div>
          )}
        </div>
      )}

      {/* Header: 3 filas en el teléfono / 1 en la computadora, con `md:order-*`
          reacomodando. Mismo patrón que /ventas/vendedor — al agregar algo
          nuevo, darle su `md:order-N` o se rompe la alineación. El switch
          tiene CUATRO botones (Clientes | Patrón | Vendedor | Pulso): los
          tres primeros son ejes del mismo ranking, el último cambia toda la
          vista (2026-09-09). */}
      <header className="sticky top-0 z-50 bg-[#1A1A1A] border-b-[3px] border-yellow-400 px-4 md:px-8 py-3">
        <div className="grid grid-cols-2 items-center gap-x-3 gap-y-2 md:flex md:flex-wrap md:gap-4">
          <div className="flex items-center gap-3 min-w-0 md:order-1">
            <InicioButton />
            <span className="font-bold text-yellow-400 text-base md:text-2xl tracking-wide uppercase whitespace-nowrap">
              EVER WEAR{" "}
              <span className="text-xs md:text-sm tracking-[3px] font-normal">S.A.</span>
            </span>
          </div>

          <h2 className="justify-self-end text-yellow-400 font-bold text-sm md:text-lg uppercase tracking-wide flex items-center gap-2 whitespace-nowrap md:order-3">
            {vistaPulso ? (
              <Activity size={18} />
            ) : topVista === "clientes" ? (
              <Users size={18} />
            ) : topVista === "patrones" ? (
              <ListChevronsUpDown size={18} />
            ) : (
              <UserRound size={18} />
            )}
            {lineaNombre} ·{" "}
            {vistaPulso
              ? "pulso"
              : topVista === "clientes"
                ? "clientes"
                : topVista === "patrones"
                  ? "patrones"
                  : "vendedores"}
          </h2>

          <button
            type="button"
            onClick={abrirModalBusqueda}
            className="btn-anim inline-flex items-center justify-center gap-2 rounded-md border border-zinc-700 px-3 py-2 text-sm text-zinc-100 hover:border-yellow-400 transition-colors md:order-2"
          >
            <Search size={14} className="text-yellow-400" />
            Buscar cliente
          </button>

          {/* Selector de línea (2026-09-23). Con una sola línea habilitada
              queda fijo: se ve cuál es pero no se puede cambiar. El engranaje
              (sólo ADMIN) abre la configuración de líneas por usuario. */}
          <div className="flex items-center gap-2 min-w-0 md:order-2">
            <select
              value={lineaId ?? ""}
              onChange={(e) => {
                const id = Number(e.target.value);
                if (!Number.isInteger(id) || id === lineaId) return;
                setModalOpen(false);
                // Pulso no aplica a "Todas": los objetivos son por línea.
                if (id === LINEA_TODAS) setVistaPulso(false);
                setLineaId(id);
              }}
              disabled={lineas.length <= 1}
              title={lineas.length <= 1 ? "Línea habilitada para tu usuario" : "Elegí la línea a ver"}
              className="min-w-0 flex-1 md:flex-none md:w-56 rounded-md border border-zinc-700 bg-[#111111] px-3 py-2 text-sm text-zinc-100 focus:border-yellow-400 focus:outline-none disabled:opacity-80 disabled:cursor-not-allowed"
            >
              {lineaId == null && <option value="">Cargando líneas…</option>}
              {hayTodas && <option value={LINEA_TODAS}>{NOMBRE_TODAS}</option>}
              {lineas.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.nombre}
                </option>
              ))}
            </select>
            {esAdmin && (
              <button
                type="button"
                onClick={() => setConfigOpen(true)}
                title="Configurar qué líneas ve cada usuario"
                aria-label="Configurar líneas por usuario"
                className="btn-anim inline-flex items-center justify-center rounded-md border border-zinc-700 p-2 text-zinc-300 hover:border-yellow-400 hover:text-yellow-400 transition-colors"
              >
                <Settings2 size={16} />
              </button>
            )}
          </div>

          <div className="col-span-2 justify-self-end inline-flex rounded-md border border-zinc-700 overflow-hidden text-sm divide-x divide-zinc-700 md:col-auto md:order-4">
            {(["clientes", "patrones", "vendedores"] as TopVista[]).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => {
                  setVistaPulso(false);
                  if (topVista === v) return;
                  setTopVista(v);
                  setTopGrupoAbierto(0);
                }}
                title={
                  v === "clientes"
                    ? "Ranking de clientes ($)"
                    : v === "patrones"
                      ? "Ranking de códigos patrón ($ o unidades)"
                      : "Ranking de vendedores ($ o unidades)"
                }
                className={`px-3 py-2 font-semibold transition-colors ${
                  !vistaPulso && topVista === v
                    ? "bg-yellow-400 text-black"
                    : "text-zinc-300 hover:bg-zinc-800"
                }`}
              >
                {v === "clientes" ? "Clientes" : v === "patrones" ? "Patrón" : "Vendedor"}
              </button>
            ))}
            {/* Cuarto botón: no es otro eje del mismo ranking, cambia toda la
                vista por la del período elegido + objetivos (ver PulsoTab). */}
            {!esTodas && (
            <button
              type="button"
              onClick={() => setVistaPulso(true)}
              title="Ranking del período que elijas, con el objetivo de cada vendedor"
              className={`px-3 py-2 font-semibold transition-colors inline-flex items-center gap-1.5 ${
                vistaPulso ? "bg-yellow-400 text-black" : "text-zinc-300 hover:bg-zinc-800"
              }`}
            >
              <Activity size={14} />
              Pulso
            </button>
            )}
          </div>

          <UsuarioActual className="col-span-2 justify-self-end md:col-auto md:order-5 md:ml-auto" />
        </div>
      </header>

      {configOpen && <ConfigLineas onCerrar={() => setConfigOpen(false)} />}

      <main className="max-w-[1400px] mx-auto px-4 md:px-8 py-8 space-y-6">
        {/* Modal de UN SOLO NIVEL. Anclado arriba con `dvh` (en el teléfono
            el teclado achica el viewport y centrado se corta el header). */}
        {modalOpen && (
          <div
            className="fixed inset-0 z-[100] bg-black/70 flex items-start justify-center p-3 md:p-4 overflow-y-auto"
            onClick={cerrarModal}
          >
            <div
              className="w-full max-w-6xl max-h-[calc(100dvh-1.5rem)] md:max-h-[92dvh] rounded-xl border border-zinc-800 bg-[#111111] flex flex-col overflow-hidden shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              {/* El header scrollea (max-h + overflow-y-auto), pero eso recorta el
                  dropdown de sugerencias, que es absolute. Mientras la lista está
                  abierta se libera el overflow para que se vea completa. */}
              <div
                className={`shrink-0 bg-[#1A1A1A] border-b border-zinc-800 px-5 py-4 space-y-4 ${
                  mostrarSug ? "overflow-visible" : "max-h-[45dvh] overflow-y-auto"
                }`}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    {nivel && (
                      <>
                        <h3 className="font-bold text-base uppercase tracking-wide text-yellow-400 truncate">
                          {tituloNivel}
                        </h3>
                        <p className="text-zinc-500 text-xs mt-0.5">{subtituloNivel}</p>
                        {/* Vendedor asignado al cliente (
                            2026-08-26). Sale del maestro de Magnus, no del
                            comprobante — es el "Vendedor por Defecto".
                            Clientes de mostrador no tienen ninguno. */}
                        {modalMode === "cliente" && detCliente && (
                          <p className="text-xs mt-1 flex items-center gap-1.5 text-zinc-400">
                            <UserRound size={13} className="text-yellow-400" />
                            Vendedor asignado:{" "}
                            <span className="text-zinc-100 font-semibold">
                              {detCliente.vendedorAsignado?.nombre ??
                                (detCliente.vendedorAsignado
                                  ? String(detCliente.vendedorAsignado.codigo)
                                  : "sin vendedor asignado")}
                            </span>
                          </p>
                        )}
                      </>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={cerrarModal}
                      className="text-zinc-500 hover:text-zinc-200 transition-colors"
                      aria-label="Cerrar"
                    >
                      <X size={20} />
                    </button>
                  </div>
                </div>

                {filtroVisible && (
                  <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 px-5 py-4 flex flex-wrap items-end gap-4">
                    <div className="flex flex-col gap-1.5 relative">
                      <div className="relative">
                        <Search
                          size={13}
                          className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500"
                        />
                        <input
                          id="filtro-cliente"
                          type="text"
                          value={qCliente}
                          onChange={(e) => {
                            setQCliente(e.target.value);
                            setClienteSel(null);
                          }}
                          onFocus={() => sugerencias.length > 0 && setMostrarSug(true)}
                          onBlur={() => {
                            blurTimeout.current = setTimeout(() => setMostrarSug(false), 150);
                          }}
                          placeholder="Ej: 1234 o ACME S.A."
                          className="bg-[#1f1f1f] border border-zinc-700 rounded-md pl-7 pr-3 py-2 text-sm text-zinc-100 outline-none w-72 focus:border-yellow-400 placeholder:text-zinc-600"
                        />
                        {buscando && (
                          <Loader2
                            size={13}
                            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-500 animate-spin"
                          />
                        )}
                        {mostrarSug && sugerencias.length > 0 && (
                          <div className="absolute z-20 mt-1 w-full max-h-64 overflow-y-auto rounded-md border border-zinc-700 bg-[#1A1A1A] shadow-xl">
                            {sugerencias.map((c) => (
                              <button
                                key={c.numero}
                                type="button"
                                onMouseDown={(e) => {
                                  e.preventDefault();
                                  if (blurTimeout.current) clearTimeout(blurTimeout.current);
                                  abrirCliente(c);
                                }}
                                className="w-full text-left px-3 py-2 text-sm text-zinc-200 hover:bg-yellow-400/10 hover:text-yellow-400 transition-colors flex items-center justify-between gap-2"
                              >
                                <span className="truncate">{c.nombre ?? "(sin nombre)"}</span>
                                <span className="text-zinc-500 font-mono text-xs shrink-0">
                                  {c.numero}
                                </span>
                              </button>
                            ))}
                          </div>
                        )}
                        {mostrarSug && sugerencias.length === 0 && sinVendedorAsignado && (
                          <div className="absolute z-20 mt-1 w-full rounded-md border border-amber-400/40 bg-[#1A1A1A] shadow-xl px-3 py-2.5 text-xs text-amber-300">
                            Tu usuario todavía no tiene un vendedor de Magnus asignado — pedile a
                            un administrador que te lo asigne en Administración → Usuarios.
                          </div>
                        )}
                      </div>
                    </div>

                    {hayTabla && (
                      <>
                        <div className="flex flex-col gap-1.5">
                          <div className="inline-flex rounded-md border border-zinc-700 overflow-hidden text-sm divide-x divide-zinc-700">
                            {(["pesos", "unidades"] as Modo[]).map((m) => (
                              <button
                                key={m}
                                type="button"
                                onClick={() => setModoModal(m)}
                                title={m === "pesos" ? "Ver montos en $" : "Ver unidades"}
                                className={`px-3 py-2 font-semibold transition-colors ${
                                  modoModal === m
                                    ? "bg-yellow-400 text-black"
                                    : "text-zinc-300 hover:bg-zinc-800"
                                }`}
                              >
                                {m === "pesos" ? "$" : "Unidades"}
                              </button>
                            ))}
                          </div>
                        </div>

                      </>
                    )}

                    {hayTabla && !sinDatos && (
                      <div className="flex flex-col gap-1.5">
                        <div className="inline-flex rounded-md border border-zinc-700 overflow-hidden text-sm divide-x divide-zinc-700">
                          <button
                            type="button"
                            onClick={() => setPeriodo("ytd")}
                            title={
                              mesAnteriorNum >= 1
                                ? `Acumulado Enero–${MESES_CORTOS_ES[mesAnteriorNum - 1]}`
                                : "Todavía no hay mes anterior este año"
                            }
                            className={`px-3 py-2 transition-colors ${
                              periodo === "ytd"
                                ? "bg-yellow-400 text-black font-semibold"
                                : "text-zinc-300 hover:bg-zinc-800"
                            }`}
                          >
                            YTD
                          </button>
                          <button
                            type="button"
                            onClick={() => setPeriodo("meses")}
                            title={`${MESES_CORTOS_ES[mesActualNum - 1]} completo`}
                            className={`px-3 py-2 transition-colors ${
                              periodo === "meses"
                                ? "bg-yellow-400 text-black font-semibold"
                                : "text-zinc-300 hover:bg-zinc-800"
                            }`}
                          >
                            Meses
                          </button>
                        </div>
                      </div>
                    )}
                      <span className="text-sm text-zinc-500 pb-2">
                        {filas.length} {modalMode === "cliente" ? "cód. patrón" : "cliente(s)"}
                      </span>

                    {hayTabla && (
                        <button
                          type="button"
                          onClick={() => setDesglosado((v) => !v)}
                          className="btn-anim flex items-center gap-1.5 border border-zinc-700 text-zinc-200 text-sm rounded-md px-3 py-2 hover:border-yellow-400 transition-colors"
                        >
                          {desglosado ? "por año" : "por mes"}
                        </button>
                    )}
                  </div>
                )}
              </div>

              <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
                {!nivel && (
                  <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 px-5 py-16 flex flex-col items-center gap-3 text-center">
                    <Search size={40} className="text-zinc-700" />
                    <p className="text-zinc-500 text-sm">
                      Buscá un cliente por código o nombre y elegilo de la lista.
                    </p>
                  </div>
                )}

                {nivel && detError && (
                  <div className="rounded-xl border border-red-900/60 bg-red-950/30 px-5 py-4 text-sm text-red-300">
                    {detError}
                  </div>
                )}

                {nivel && !hayTabla && !detError && (
                  <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 px-5 py-16 flex flex-col items-center gap-3 text-center">
                    <Table2 size={40} className="text-zinc-700" />
                    <p className="text-zinc-500 text-sm">
                      {detLoading ? "Cargando…" : "Sin datos."}
                    </p>
                  </div>
                )}

                {hayTabla && sinDatos && (
                  <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 px-5 py-16 flex flex-col items-center gap-3 text-center">
                    <Table2 size={40} className="text-zinc-700" />
                    <p className="text-zinc-500 text-sm">
                      Sin ventas de {lineaNombre} para {tituloNivel} en {fuenteTabla!.anioAnterior}–
                      {fuenteTabla!.anioActual}.
                    </p>
                  </div>
                )}

                {hayTabla && !sinDatos && sinMesesPeriodo && (
                  <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 px-5 py-16 flex flex-col items-center gap-3 text-center">
                    <Table2 size={40} className="text-zinc-700" />
                    <p className="text-zinc-500 text-sm">
                      Todavía no hay mes anterior este año — probá con &quot;Meses&quot; para ver
                      Enero.
                    </p>
                  </div>
                )}

                {hayTabla && !sinDatos && !sinMesesPeriodo && (
                  <div
                    className={`rounded-xl border border-zinc-800 overflow-hidden transition-opacity ${
                      detLoading ? "opacity-50 pointer-events-none" : ""
                    }`}
                    onMouseLeave={limpiarHover}
                  >
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-max text-sm">
                        <thead className="bg-[#1A1A1A] text-zinc-400">
                          <tr>
                            <th
                              rowSpan={desglosado ? 2 : 1}
                              className={`px-3 py-2 font-medium text-left whitespace-nowrap align-bottom cursor-default ${
                                hoverCol === COL_ETIQ ? "bg-yellow-400/10" : ""
                              }`}
                              onMouseEnter={() => {
                                setHoverRow(null);
                                setHoverCol(COL_ETIQ);
                              }}
                            >
                              {colEtiqueta}
                            </th>
                            <th
                              colSpan={colSpanAnio}
                              className={`px-3 py-2 font-medium text-center whitespace-nowrap ${SEP_BLOQUE} text-zinc-300 ${
                                !desglosado && hoverCol === colAnteriorTotal
                                  ? "bg-yellow-400/10 cursor-default"
                                  : ""
                              }`}
                              onMouseEnter={
                                desglosado
                                  ? undefined
                                  : () => {
                                      setHoverRow(null);
                                      setHoverCol(colAnteriorTotal);
                                    }
                              }
                            >
                              Año {fuenteTabla!.anioAnterior}
                              {periodo === "ytd" && mesAnteriorNum >= 1 && (
                                <span className="text-zinc-500 font-normal">
                                  {" "}
                                  (Ene–{labelDeMes(fuenteTabla!.totales.anioAnterior, mesAnteriorNum)})
                                </span>
                              )}
                              {periodo === "meses" && (
                                <span className="text-zinc-500 font-normal">
                                  {" "}
                                  ({labelDeMes(fuenteTabla!.totales.anioAnterior, mesActualNum)})
                                </span>
                              )}
                            </th>
                            <th
                              colSpan={colSpanAnio}
                              className={`px-3 py-2 font-medium text-center whitespace-nowrap ${SEP_BLOQUE} text-yellow-400 ${
                                !desglosado && hoverCol === colActualTotal
                                  ? "bg-yellow-400/10 cursor-default"
                                  : ""
                              }`}
                              onMouseEnter={
                                desglosado
                                  ? undefined
                                  : () => {
                                      setHoverRow(null);
                                      setHoverCol(colActualTotal);
                                    }
                              }
                            >
                              Año {fuenteTabla!.anioActual}
                              {periodo === "ytd" && mesAnteriorNum >= 1 && (
                                <span className="text-yellow-400/60 font-normal">
                                  {" "}
                                  (Ene–{labelDeMes(fuenteTabla!.totales.anioActual, mesAnteriorNum)})
                                </span>
                              )}
                              {periodo === "meses" && (
                                <span className="text-yellow-400/60 font-normal">
                                  {" "}
                                  ({labelDeMes(fuenteTabla!.totales.anioActual, mesActualNum)})
                                </span>
                              )}{" "}
                              <IconoEstimativo />
                            </th>
                            <th
                              rowSpan={desglosado ? 2 : 1}
                              className={`px-3 py-2 font-medium text-center whitespace-nowrap align-bottom ${SEP_BLOQUE} cursor-default`}
                              title="Año actual vs. año anterior"
                            >
                              Tend.
                            </th>
                          </tr>
                          {desglosado && (
                            <tr className="text-[11px] text-zinc-500">
                              {fuenteTabla!.totales.anioAnterior.meses
                                .filter((m) => mesesActivos.includes(m.mes))
                                .map((m, i) => (
                                  <th
                                    key={`pa-${m.mes}`}
                                    className={`px-2 py-1.5 font-normal text-right whitespace-nowrap ${i === 0 ? SEP_BLOQUE : "border-l border-zinc-800/60"} cursor-default ${
                                      hoverCol === colAnteriorMes(m.mes) ? "bg-yellow-400/10" : ""
                                    }`}
                                    onMouseEnter={() => {
                                      setHoverRow(null);
                                      setHoverCol(colAnteriorMes(m.mes));
                                    }}
                                  >
                                    {m.label}
                                  </th>
                                ))}
                              {mostrarTotalAnio && (
                                <th
                                  className={`px-2 py-1.5 font-semibold text-right whitespace-nowrap border-l border-zinc-800 text-zinc-300 cursor-default ${
                                    hoverCol === colAnteriorTotal ? "bg-yellow-400/10" : ""
                                  }`}
                                  onMouseEnter={() => {
                                    setHoverRow(null);
                                    setHoverCol(colAnteriorTotal);
                                  }}
                                >
                                  Total
                                </th>
                              )}
                              {fuenteTabla!.totales.anioActual.meses
                                .filter((m) => mesesActivos.includes(m.mes))
                                .map((m, i) => (
                                  <th
                                    key={`pc-${m.mes}`}
                                    className={`px-2 py-1.5 font-normal text-right whitespace-nowrap ${i === 0 ? SEP_BLOQUE : "border-l border-zinc-800/60"} cursor-default ${
                                      hoverCol === colActualMes(m.mes) ? "bg-yellow-400/10" : ""
                                    }`}
                                    onMouseEnter={() => {
                                      setHoverRow(null);
                                      setHoverCol(colActualMes(m.mes));
                                    }}
                                  >
                                    {m.label}
                                  </th>
                                ))}
                              {mostrarTotalAnio && (
                                <th
                                  className={`px-2 py-1.5 font-semibold text-right whitespace-nowrap border-l border-zinc-800 text-yellow-400 cursor-default ${
                                    hoverCol === colActualTotal ? "bg-yellow-400/10" : ""
                                  }`}
                                  onMouseEnter={() => {
                                    setHoverRow(null);
                                    setHoverCol(colActualTotal);
                                  }}
                                >
                                  Total
                                </th>
                              )}
                            </tr>
                          )}
                        </thead>
                        {filasGrupos.map((grupo, gIdx) => (
                          <tbody key={`fg-${gIdx}`}>
                            {filasGrupos.length > 1 && (
                              <FilaGrupo
                                idx={gIdx}
                                desde={gIdx * GROUP_SIZE}
                                hasta={Math.min((gIdx + 1) * GROUP_SIZE, filas.length)}
                                total={filas.length}
                                abierto={filasGrupoSeguro === gIdx}
                                onClick={() =>
                                  setFilasGrupoAbierto(filasGrupoSeguro === gIdx ? -1 : gIdx)
                                }
                                colSpan={totalColsTabla}
                              />
                            )}
                            {(filasGrupos.length <= 1 || filasGrupoSeguro === gIdx) &&
                              grupo.map((r, rowIdx) => {
                                const rowCrece = crece(r);
                                const rowTendencia = tendencia(r);
                                return (
                                  <tr key={r.key} className="border-t border-zinc-800/60 transition-colors">
                                    {/* Texto plano, NO botón: en esta vista
                                        el modal es de un solo nivel, no hay
                                        drill-down (
                                        2026-08-26). */}
                                    <td
                                      className={`px-3 py-2 text-zinc-100 whitespace-nowrap cursor-default ${celda(rowIdx, COL_ETIQ, rowCrece)}`}
                                      onMouseEnter={() => {
                                        setHoverRow(rowIdx);
                                        setHoverCol(COL_ETIQ);
                                      }}
                                    >
                                      {r.etiqueta}
                                    </td>
                                    {desglosado &&
                                      r.anioAnterior.meses
                                        .filter((m) => mesesActivos.includes(m.mes))
                                        .map((m, i) => {
                                          const colIdx = colAnteriorMes(m.mes);
                                          return (
                                            <td
                                              key={`a-${m.mes}`}
                                              className={`px-2 py-2 text-right tabular-nums text-zinc-400 ${i === 0 ? SEP_BLOQUE : "border-l border-zinc-800/40"} cursor-default ${celda(rowIdx, colIdx, rowCrece)}`}
                                              onMouseEnter={() => {
                                                setHoverRow(rowIdx);
                                                setHoverCol(colIdx);
                                              }}
                                            >
                                              {valorMes(m) === 0 ? "—" : fmt(valorMes(m))}
                                            </td>
                                          );
                                        })}
                                    {mostrarTotalAnio && (
                                      <td
                                        className={`px-3 py-2 text-right tabular-nums text-zinc-200 font-medium ${sepTotalAnio} cursor-default ${celda(rowIdx, colAnteriorTotal, rowCrece)}`}
                                        onMouseEnter={() => {
                                          setHoverRow(rowIdx);
                                          setHoverCol(colAnteriorTotal);
                                        }}
                                      >
                                        {fmt(valor(sumaPeriodo(r.anioAnterior)))}
                                      </td>
                                    )}
                                    {desglosado &&
                                      r.anioActual.meses
                                        .filter((m) => mesesActivos.includes(m.mes))
                                        .map((m, i) => {
                                          const colIdx = colActualMes(m.mes);
                                          return (
                                            <td
                                              key={`c-${m.mes}`}
                                              className={`px-2 py-2 text-right tabular-nums text-zinc-400 ${i === 0 ? SEP_BLOQUE : "border-l border-zinc-800/40"} cursor-default ${celda(rowIdx, colIdx, rowCrece)}`}
                                              onMouseEnter={() => {
                                                setHoverRow(rowIdx);
                                                setHoverCol(colIdx);
                                              }}
                                            >
                                              {valorMes(m) === 0 ? "—" : fmt(valorMes(m))}
                                            </td>
                                          );
                                        })}
                                    {mostrarTotalAnio && (
                                      <td
                                        className={`px-3 py-2 text-right tabular-nums text-yellow-400 font-semibold ${sepTotalAnio} cursor-default ${celda(rowIdx, colActualTotal, rowCrece)}`}
                                        onMouseEnter={() => {
                                          setHoverRow(rowIdx);
                                          setHoverCol(colActualTotal);
                                        }}
                                      >
                                        {fmt(valor(sumaPeriodo(r.anioActual)))}
                                      </td>
                                    )}
                                    <td
                                      className={`px-3 py-2 text-center font-bold whitespace-nowrap ${SEP_BLOQUE} cursor-default ${celdaTendencia(rowTendencia)}`}
                                    >
                                      <span className="text-base">{iconoTendencia(rowTendencia)}</span>
                                      <span className="ml-1 text-xs tabular-nums">
                                        {fmtPct(pctTendencia(r))}
                                      </span>
                                    </td>
                                  </tr>
                                );
                              })}
                          </tbody>
                        ))}
                        <tfoot>
                          <tr className="border-t-2 border-zinc-700 bg-zinc-900/60">
                            <td
                              className={`px-3 py-2 text-zinc-300 font-semibold uppercase text-xs tracking-wide cursor-default ${
                                hoverCol === COL_ETIQ ? "bg-yellow-400/10" : ""
                              }`}
                              onMouseEnter={() => {
                                setHoverRow(null);
                                setHoverCol(COL_ETIQ);
                              }}
                            >
                              Total
                            </td>
                            {desglosado &&
                              fuenteTabla!.totales.anioAnterior.meses
                                .filter((m) => mesesActivos.includes(m.mes))
                                .map((m, i) => {
                                  const colIdx = colAnteriorMes(m.mes);
                                  return (
                                    <td
                                      key={`ta-${m.mes}`}
                                      className={`px-2 py-2 text-right tabular-nums text-zinc-300 font-medium ${i === 0 ? SEP_BLOQUE : "border-l border-zinc-800/40"} cursor-default ${
                                        hoverCol === colIdx ? "bg-yellow-400/10" : ""
                                      }`}
                                      onMouseEnter={() => {
                                        setHoverRow(null);
                                        setHoverCol(colIdx);
                                      }}
                                    >
                                      {fmt(valorMes(m))}
                                    </td>
                                  );
                                })}
                            {mostrarTotalAnio && (
                              <td
                                className={`px-3 py-2 text-right tabular-nums text-zinc-100 font-bold ${sepTotalAnio} cursor-default ${
                                  hoverCol === colAnteriorTotal ? "bg-yellow-400/10" : ""
                                }`}
                                onMouseEnter={() => {
                                  setHoverRow(null);
                                  setHoverCol(colAnteriorTotal);
                                }}
                              >
                                {fmt(valor(sumaPeriodo(fuenteTabla!.totales.anioAnterior)))}
                              </td>
                            )}
                            {desglosado &&
                              fuenteTabla!.totales.anioActual.meses
                                .filter((m) => mesesActivos.includes(m.mes))
                                .map((m, i) => {
                                  const colIdx = colActualMes(m.mes);
                                  return (
                                    <td
                                      key={`tc-${m.mes}`}
                                      className={`px-2 py-2 text-right tabular-nums text-zinc-300 font-medium ${i === 0 ? SEP_BLOQUE : "border-l border-zinc-800/40"} cursor-default ${
                                        hoverCol === colIdx ? "bg-yellow-400/10" : ""
                                      }`}
                                      onMouseEnter={() => {
                                        setHoverRow(null);
                                        setHoverCol(colIdx);
                                      }}
                                    >
                                      {fmt(valorMes(m))}
                                    </td>
                                  );
                                })}
                            {mostrarTotalAnio && (
                              <td
                                className={`px-3 py-2 text-right tabular-nums text-yellow-400 font-bold ${sepTotalAnio} cursor-default ${
                                  hoverCol === colActualTotal ? "bg-yellow-400/10" : ""
                                }`}
                                onMouseEnter={() => {
                                  setHoverRow(null);
                                  setHoverCol(colActualTotal);
                                }}
                              >
                                {fmt(valor(sumaPeriodo(fuenteTabla!.totales.anioActual)))}
                              </td>
                            )}
                            <td
                              className={`px-3 py-2 text-center font-bold whitespace-nowrap ${SEP_BLOQUE} cursor-default ${celdaTendencia(tendencia(fuenteTabla!.totales))}`}
                            >
                              <span className="text-base">
                                {iconoTendencia(tendencia(fuenteTabla!.totales))}
                              </span>
                              <span className="ml-1 text-xs tabular-nums">
                                {fmtPct(pctTendencia(fuenteTabla!.totales))}
                              </span>
                            </td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Ranking del pie — clientes ($), códigos patrón o vendedores ($ o
            unidades), en DOS columnas: acumulado Enero→mes anterior y mes en
            curso. El rango lo resuelve el back. Click en una fila abre el
            modal. Cambiar de métrica NO refetchea (el back manda las dos
            listas ya ordenadas, con las dos ventanas adentro), pero sí
            resetea el acordeón: el orden es distinto. */}
        {vistaPulso && lineaSel && !esTodas && <PulsoTab key={lineaSel.id} linea={lineaSel} />}

        {!vistaPulso && topVista !== "clientes" && !topError && (
          <div className="inline-flex rounded-md border border-zinc-700 overflow-hidden text-sm divide-x divide-zinc-700">
            {(["pesos", "unidades"] as Modo[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => {
                  if (topMetrica === m) return;
                  setTopMetrica(m);
                  setTopGrupoAbierto(0);
                }}
                title={m === "pesos" ? "Ver montos en $" : "Ver unidades"}
                className={`px-3 py-2 font-semibold transition-colors ${
                  topMetrica === m ? "bg-yellow-400 text-black" : "text-zinc-300 hover:bg-zinc-800"
                }`}
              >
                {m === "pesos" ? "$" : "Unidades"}
              </button>
            ))}
          </div>
        )}

        {lineasError && (
          <div className="rounded-xl border border-red-400/40 bg-zinc-900/40 px-5 py-4 flex items-center gap-3 text-sm text-red-300">
            <AlertTriangle size={16} className="text-red-400" /> {lineasError}
          </div>
        )}

        {!vistaPulso && topError && (
          <div className="rounded-xl border border-red-400/40 bg-zinc-900/40 px-5 py-4 flex items-center gap-3 text-sm text-red-300">
            <AlertTriangle size={16} className="text-red-400" /> {topError}
          </div>
        )}

        {!vistaPulso && !topError && (
          <div
            className={`rounded-xl border border-zinc-800 overflow-hidden transition-opacity ${topLoading ? "opacity-50" : ""}`}
          >
            {!topLoading && topItems.length === 0 ? (
              <div className="px-5 py-12 flex flex-col items-center gap-3 text-center">
                <Trophy size={32} className="text-zinc-700" />
                <p className="text-zinc-500 text-sm">
                  Sin ventas de {lineaNombre} registradas en el rango.
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-[#1A1A1A] text-zinc-400">
                    <tr>
                      {/* Columna del índice angosta y con el número chico
                          (2026-08-26: "que sea más chica y
                          reducir el tamaño del número, para tener más
                          espacio para los nombres"). `w-8` + padding
                          mínimo: el ancho sobrante se lo lleva la columna
                          del nombre, que es la que se truncaba. */}
                      <th className="px-1.5 py-2 font-medium text-left whitespace-nowrap w-8 text-[11px]">
                        #
                      </th>
                      <th className="px-3 py-2 font-medium text-left whitespace-nowrap">
                        {colTop}
                      </th>
                      <th className="px-3 py-2 font-medium text-right whitespace-nowrap border-l border-zinc-800">
                        {modo === "pesos" ? "Pesos" : "Unidades"}
                        <span className="block text-[11px] font-normal text-zinc-500">
                          {rangoAcumLabel}
                        </span>
                      </th>
                      {/* Mes en curso: va aparte del acumulado justamente
                          porque está incompleto — sumarlo adentro haría que
                          el año se compare contra un mes a medio facturar.
                          El ícono avisa en el hover que el número todavía
                          se mueve. */}
                      <th className="px-3 py-2 font-medium text-right whitespace-nowrap border-l border-zinc-800 text-yellow-400/80">
                        <span className="inline-flex items-center justify-end gap-1">
                          <span>{modo === "pesos" ? "Pesos" : "Unidades"}</span>
                          <span
                            className="group relative inline-flex cursor-help align-middle"
                            tabIndex={0}
                            title="Estos valores son estimativos"
                            aria-label="Estos valores son estimativos"
                          >
                            <Info
                              size={13}
                              className="text-zinc-500 hover:text-zinc-300 transition-colors"
                            />
                            <span className="pointer-events-none absolute right-0 top-full z-30 mt-1 hidden whitespace-nowrap rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] font-normal text-zinc-200 shadow-lg group-hover:block group-focus:block">
                              Estos valores son estimativos
                            </span>
                          </span>
                        </span>
                        <span className="block text-[11px] font-normal text-zinc-500">
                          {mesActualLabel}
                        </span>
                      </th>
                    </tr>
                  </thead>
                  {topGrupos.map((grupo, gIdx) => (
                    <tbody key={`top-${gIdx}`}>
                      {topGrupos.length > 1 && (
                        <FilaGrupo
                          idx={gIdx}
                          desde={gIdx * GROUP_SIZE}
                          hasta={Math.min((gIdx + 1) * GROUP_SIZE, topItems.length)}
                          total={topItems.length}
                          abierto={topGrupoSeguro === gIdx}
                          onClick={() => setTopGrupoAbierto(topGrupoSeguro === gIdx ? -1 : gIdx)}
                          colSpan={4}
                        />
                      )}
                      {(topGrupos.length <= 1 || topGrupoSeguro === gIdx) &&
                        grupo.map((item, i) => {
                          const pos = gIdx * GROUP_SIZE + i + 1;
                          // Una sola fila para las tres vistas: cambia la
                          // clave, la etiqueta, el valor y a qué modal lleva.
                          const cli = topVista === "clientes" ? (item as TopCliente) : null;
                          const pat = topVista === "patrones" ? (item as TopPatron) : null;
                          const ven = topVista === "vendedores" ? (item as TopVendedor) : null;
                          const key = cli ? `c${cli.numero}` : pat ? `p${pat.patron}` : `v${ven!.codigo}`;
                          const etiqueta = cli
                            ? cli.nombre ?? "(sin nombre)"
                            : pat
                              ? etiquetaPatron(pat)
                              : ven!.nombre ?? String(ven!.codigo);
                          // El código patrón no se muestra, pero queda en el
                          // tooltip para poder buscarlo en Magnus.
                          const tituloEtiqueta =
                            pat && pat.detalle ? `${etiqueta} · cód. ${pat.patron}` : etiqueta;
                          const valorTop = cli
                            ? cli.monto
                            : topMetrica === "pesos"
                              ? (pat ?? ven!).monto
                              : (pat ?? ven!).unidades;
                          // La columna del mes sigue el mismo botón $ |
                          // Unidades que la del acumulado: las dos siempre
                          // en la misma métrica, si no la fila mezcla peras
                          // con manzanas.
                          const valorTopMes = cli
                            ? cli.montoMes
                            : topMetrica === "pesos"
                              ? (pat ?? ven!).montoMes
                              : (pat ?? ven!).unidadesMes;
                          const abrir = () =>
                            cli
                              ? abrirCliente({ numero: cli.numero, nombre: cli.nombre })
                              : pat
                                ? abrirPatron(pat.patron)
                                : abrirVendedor({ codigo: ven!.codigo, nombre: ven!.nombre });
                          const titulo = cli
                            ? "Ver los patrones que compró este cliente"
                            : pat
                              ? "Ver los clientes que compraron este patrón"
                              : "Ver los clientes de este vendedor";
                          return (
                            <tr
                              key={key}
                              className="border-t border-zinc-800/60 hover:bg-zinc-800/30 transition-colors"
                            >
                              <td className="px-1.5 py-2 text-zinc-600 tabular-nums text-[11px] w-8">
                                {pos}
                              </td>
                              <td
                                className="px-3 py-2 text-zinc-100 max-w-0 w-full truncate"
                                title={tituloEtiqueta}
                              >
                                <button
                                  type="button"
                                  onClick={abrir}
                                  title={titulo}
                                  className="hover:text-yellow-400 hover:underline transition-colors text-left"
                                >
                                  {etiqueta}
                                </button>
                              </td>
                              <td className="px-3 py-2 text-right tabular-nums text-yellow-400 font-semibold border-l border-zinc-800 whitespace-nowrap">
                                {fmtTop(valorTop)}
                              </td>
                              <td className="px-3 py-2 text-right tabular-nums text-zinc-300 border-l border-zinc-800 whitespace-nowrap">
                                {fmtTop(valorTopMes)}
                              </td>
                            </tr>
                          );
                        })}
                    </tbody>
                  ))}
                  <tfoot className="bg-[#1A1A1A] border-t-2 border-zinc-700">
                    <tr>
                      <td className="px-1.5 py-2 w-8" />
                      <td className="px-3 py-2 font-semibold text-zinc-300 whitespace-nowrap">
                        Total{" "}
                        <span className="text-zinc-500 font-normal">
                          ({fmtNum(topItems.length)} {nombreFilasTop})
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-yellow-400 font-bold border-l border-zinc-800 whitespace-nowrap">
                        {fmtTop(topSumas.acum)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-yellow-400 font-bold border-l border-zinc-800 whitespace-nowrap">
                        {fmtTop(topSumas.mes)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
