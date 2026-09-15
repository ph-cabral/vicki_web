"use client";
import { Fragment, useState, useCallback, useEffect, useMemo, useRef } from "react";
import {
  Loader2,
  AlertTriangle,
  Search,
  Users,
  Table2,
  ChevronDown,
  ChevronUp,
  Trophy,
  ArrowLeft,
  X,
  Info,
} from "lucide-react";
import { InicioButton } from "@/components/ui/InicioButton";
import { UsuarioActual } from "@/components/auth/UsuarioActual";

// ──────────────────────────────────────────────────────────────────────────────
// /ventas/vendedor: vista de ventas por línea de
// artículo de UN cliente, con año actual y año anterior lado a lado.
//
//   · Filtro arriba: búsqueda de cliente por código O por nombre (substring),
//     autocomplete contra /api/ventas/vendedor/clientes. Al elegir un cliente
//     de la lista la tabla se carga sola (se
//     sacó el botón "Filtrar", antes había que elegir y después presionarlo).
//   · Switch "Unidades / Pesos": cambia qué valor muestra la tabla (cantidad
//     neta vendida vs. monto neto vendido) — mismos datos, otra columna.
//   · Tabla: primera columna = línea de artículo (StkFer_ArtParamet.Nivel1),
//     agrupando los artículos. El resto son año anterior y año en curso
//     (total). Botón "Desglosar" separa cada año en sus 12 meses,
//     manteniendo la agrupación por año (encabezado de 2 filas: año arriba,
//     mes abajo) — "Agrupar" vuelve a colapsar a un total por año.
//
//   Fuente: /api/ventas/vendedor → indicadores-api fetch_ventas_por_linea
//   (Ven_CompCabecera + Ven_CompRenglon, venta NETA de nota de crédito, mismo
//   criterio ya verificado contra el pivot Excel real — ver
//   HANDOFF_extracciones_sql.md).
// ──────────────────────────────────────────────────────────────────────────────

interface Cliente {
  numero: number;
  nombre: string | null;
}

// Opción del filtro de vendedor del header (solo admin) — ver
// /api/ventas/vendedor/vendedores.
interface VendedorOpcion {
  codigo: number;
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

interface LineaRow {
  linea: string;
  anioAnterior: AnioVal;
  anioActual: AnioVal;
}

// Fila normalizada de la tabla del modal — ver `filas`/`fuenteTabla` en el
// componente: unifica "una línea de un cliente" con "un cliente de una
// línea" para que ambas usen la misma tabla.
interface FilaTabla {
  key: string;
  etiqueta: string;
  // Qué representa la fila — exactamente uno de los dos está lleno. Es lo
  // que decide a dónde lleva el drill-down (ver `irACliente`/`irALinea`).
  cliente: Cliente | null;
  linea: string | null;
  anioAnterior: AnioVal;
  anioActual: AnioVal;
}

interface RespVentasVendedor {
  cliente: { codigo: number; nombre: string | null };
  anioAnterior: number;
  anioActual: number;
  tieneDatos: boolean;
  lineas: LineaRow[];
  totales: { anioAnterior: AnioVal; anioActual: AnioVal };
  // Bonificaciones y ajustes del cliente (comprobantes 23/24/25/60/62), por
  // año y por mes. YA están sumados adentro de `totales` — viajan aparte
  // sólo para poder decir cuánto del total no está en ninguna fila: no
  // tienen artículo, o sea que no tienen línea. Solo $, sin unidades.
  ajustes?: { anioAnterior: AnioVal; anioActual: AnioVal };
}

// Rankings del pie de la vista — debajo de la tabla principal, con su
// PROPIO rango de meses, independiente del cliente elegido en el buscador y
// del período YTD/meses de la tabla principal.
//
// RANGO (2026-09-04, antes eran los últimos 12 meses móviles): los meses
// TRANSCURRIDOS del AÑO EN CURSO, o sea Enero → mes ANTERIOR. El mes en
// curso NO se mezcla ahí: va en una columna propia a la derecha
// (`montoMes` / `unidadesMes`), que el back trae en la misma consulta. La
// tabla cierra con una fila de totales de las dos columnas.
//
// Son DOS rankings que comparten el rango y se alternan con un switch
// propio:
//   · Clientes → solo $ gastado (ya NO cambia con el switch Unidades/Pesos
//     de la tabla de arriba: acá el monto es lo único que se muestra).
//   · Líneas   → unidades compradas O $ vendidos, con su propio botón
//     dividido $ | Unidades (2026-08-26, mismo patrón que
//     el del modal). Cada vista tiene su PROPIO orden, que resuelve el back
//     (porUnidades / porMonto): togglear no reordena en el front ni pega de
//     nuevo al back, ya vienen las dos listas.
// Cada uno trae además el TOTAL de filas que entran en la filtración
// (`totalClientes` / `totalLineas`), que es mayor que las 10 que se listan.
//
// Todo el recorte por fecha y el orden lo hace el back en SQL (ver
// fetch_top_clientes / fetch_top_lineas en ventas.py) — acá no se filtra ni
// se reordena nada.
interface TopCliente {
  numero: number;
  nombre: string | null;
  // NETO (2026-09-08): venta con artículo + bonificaciones y ajustes del
  // cliente. `bruto`/`ajuste` son la apertura de ese mismo número.
  monto: number;
  // Solo el mes en curso, aparte del acumulado (2026-09-04) — es la
  // columna de la derecha, NO está sumado en `monto`.
  montoMes: number;
  bruto?: number;
  brutoMes?: number;
  ajuste?: number;
  ajusteMes?: number;
}

interface RespTopClientes {
  desde: string | null; // "YYYY-MM" — null en enero (no hay mes cerrado)
  hasta: string | null; // "YYYY-MM"
  mesActual: string; // "YYYY-MM"
  totalClientes: number;
  porMonto: TopCliente[];
  // Netos del ranking completo (no sólo de las filas listadas).
  total?: number;
  totalMes?: number;
  // Bonificaciones y ajustes del mismo rango y la misma cartera. Negativo
  // (es una nota de crédito). Desde 2026-09-08 el back los imputa POR
  // CLIENTE, así que ya están adentro de cada fila: `ajusteIncluido` lo
  // marca y el pie NO los vuelve a restar, sólo los informa.
  ajuste?: number;
  ajusteMes?: number;
  ajusteIncluido?: boolean;
}

// Desde 2026-08-26 cada línea trae las DOS métricas y el back manda las dos
// listas ya ordenadas (`porUnidades` por unidades, `porMonto` por $) — el
// botón $ | Unidades del ranking solo cambia cuál se usa, no refetchea.
//
// Reemplazado 2026-09-15: cada línea ahora es un GRUPO con sus sub_líneas
// (catálogo de Postgres, no Stk_Nivel1 de Magnus — ver fetch_top_lineas).
// `unidades`/`monto` de la línea son la suma de sus `subLineas`; el click
// para ver clientes va en la sub_línea, no en la línea. Ver TopSubLinea.
interface TopSubLinea {
  subLinea: string;
  unidades: number;
  monto: number;
  unidadesMes: number;
  montoMes: number;
}

interface TopLinea {
  linea: string;
  unidades: number;
  monto: number;
  // Mes en curso, en las dos métricas (2026-09-04) — columna aparte.
  unidadesMes: number;
  montoMes: number;
  subLineas: TopSubLinea[];
}

interface RespTopLineas {
  desde: string | null; // "YYYY-MM" — null en enero
  hasta: string | null; // "YYYY-MM"
  mesActual: string; // "YYYY-MM"
  totalLineas: number;
  totalLineasMonto: number;
  porUnidades: TopLinea[];
  porMonto: TopLinea[];
  // Sólo mueve $ — el concepto de una nota de crédito no tiene cantidad, así
  // que en la vista por unidades no hay nada que ajustar.
  ajuste?: number;
  ajusteMes?: number;
}

// Clientes que compraron una línea puntual, de mayor a menor gasto — para
// el modal cuando se hace click en una línea del ranking de abajo (2026-08-18).
//
// Desde 2026-08-20 la forma es el ESPEJO de RespVentasVendedor: mismos dos
// años con desglose mensual y las dos métricas, para que el modal de línea
// use LA MISMA tabla (y por lo tanto los mismos toggles $/Unidades y por
// mes/por año) que el modo "cliente". Lo único que cambia es qué identifica
// la fila: allá `linea: string`, acá `numero`/`nombre` del cliente.
interface ClientePorLinea {
  numero: number;
  nombre: string | null;
  anioAnterior: AnioVal;
  anioActual: AnioVal;
}

interface RespClientesPorLinea {
  linea: string;
  // Presente sólo cuando viene de /clientes-por-sub-linea (ranking del pie,
  // catálogo de Postgres) — ausente en el drill-down Magnus de siempre
  // (línea de un cliente puntual). No se usa para nada acá, es informativo.
  subLinea?: string;
  anioAnterior: number;
  anioActual: number;
  tieneDatos: boolean;
  totalClientes: number;
  clientes: ClientePorLinea[];
  totales: { anioAnterior: AnioVal; anioActual: AnioVal };
}

type TopVista = "clientes" | "lineas";

const MESES_CORTOS_ES = [
  "Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic",
];

// Nombre completo, sólo para el encabezado de la columna del mes en curso: ahí
// el título pasó a ser el TOTAL de la columna, así que el mes queda como
// subtítulo y tiene lugar de sobra para escribirse entero.
const MESES_ES = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

type Modo = "unidades" | "pesos";
type Periodo = "ytd" | "meses";

// Sin decimales en ninguna de las dos métricas
const fmtNum = (n: number | null | undefined) =>
  new Intl.NumberFormat("es-AR", { maximumFractionDigits: 0 }).format(n || 0);
const fmtMoney = (n: number | null | undefined) =>
  new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    maximumFractionDigits: 0,
  }).format(n || 0);

// Texto mostrado en el input una vez elegido un cliente de la lista — se usa
// también para detectar "no volver a buscar" en el efecto de abajo.
const labelCliente = (c: Cliente) => (c.nombre ? `${c.nombre} (${c.numero})` : String(c.numero));

// ── Agrupado en acordeón ───────────────────────
// El back ya no recorta los rankings/búsquedas — trae TODOS los
// clientes/líneas que entran en el rango (ver indicadores-api/main.py). Con
// cientos de filas la tabla se vuelve ilegible, así que acá se agrupan de a
// GROUP_SIZE en bloques colapsables (1–50, 51–100, …) dentro de la MISMA
// tabla (un <tbody> por grupo, con una fila-header que abre/cierra ese
// grupo) — el <thead>/<tfoot> no se repiten. Se aplica a las 3 tablas que
// pueden crecer mucho: Top clientes/líneas (ranking del pie), clientes por
// línea (modal al clickear una línea) y líneas por cliente (modal al buscar
// un cliente puntual). Acordeón real: solo un grupo abierto a la vez (ver
// los `set*GrupoAbierto` que se usan como componente controlado, un solo
// número de estado en vez de un Set de índices).
const GROUP_SIZE = 50;

function agrupar<T>(items: T[]): T[][] {
  const grupos: T[][] = [];
  for (let i = 0; i < items.length; i += GROUP_SIZE) {
    grupos.push(items.slice(i, i + GROUP_SIZE));
  }
  return grupos;
}

// Fila-header de un grupo — SIEMPRE la primera fila del <tbody> de ese
// grupo. `colSpan` tiene que cubrir todas las columnas de la tabla en la que
// se usa (varía: 3 en las tablas simples, 2 + 2*colSpanAnio en la de
// línea×año con el desglose mensual).
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

export default function VentasVendedorPage() {
  // ── Búsqueda / selección de cliente ────────────────────────────────────
  const [qCliente, setQCliente] = useState("");
  const [sugerencias, setSugerencias] = useState<Cliente[]>([]);
  const [buscando, setBuscando] = useState(false);
  const [mostrarSug, setMostrarSug] = useState(false);
  const [clienteSel, setClienteSel] = useState<Cliente | null>(null);
  // true si el back respondió "sin vendedor asignado" (usuario no-admin sin
  // usuario.vendedorCodigo, ver /admin/usuarios) — acceso por vendedor,
  // 2026-08-14: en ese caso el buscador nunca va a
  // devolver nada, mejor explicarlo en vez de que parezca que no encuentra
  // clientes.
  const [sinVendedorAsignado, setSinVendedorAsignado] = useState(false);
  const blurTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Filtro de vendedor (solo ADMIN) ────────────────────────────────────
  // 2026-08-27: un admin puede pararse en un vendedor y ver
  // la vista como la ve él (buscador de clientes, tabla y rankings). La
  // lista son las personas habilitadas en Magnus QUE ADEMÁS tienen usuario
  // activo con legajo ACTIVO en Postgres — ver
  // lib/ventas/vendedoresActivos.ts.
  //
  // /api/ventas/vendedor/vendedores es admin-only: si contesta 403 (o
  // falla) simplemente no hay filtro y la vista queda como siempre — no
  // hace falta un fetch aparte a /api/auth/me para saber el rol.
  // "" = Todos los vendedores (sin restricción, lo de siempre para un admin).
  const [vendedores, setVendedores] = useState<VendedorOpcion[]>([]);
  const [vendedorSel, setVendedorSel] = useState("");
  // Admin = la ruta admin-only contestó 200. Se guarda aparte de la lista
  // porque puede venir VACÍA (ningún viajante activo con vendedor asignado)
  // y en ese caso hay que mostrar el filtro igual, con el aviso, en vez de
  // hacerlo desaparecer sin explicación.
  const [esAdmin, setEsAdmin] = useState(false);

  useEffect(() => {
    let vivo = true;
    fetch("/api/ventas/vendedor/vendedores", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!vivo || !j) return;
        setEsAdmin(true);
        setVendedores(Array.isArray(j.vendedores) ? j.vendedores : []);
      })
      .catch(() => {});
    return () => {
      vivo = false;
    };
  }, []);

  // Se agrega a TODAS las consultas de la vista (buscador, tabla y
  // rankings). Vacío = sin filtro; el back ignora el parámetro si quien
  // pide no es admin (ver vendedorParam en lib/ventas/vendedorAcceso.ts).
  const qsVendedor = useCallback(
    (qs: URLSearchParams) => {
      if (vendedorSel) qs.set("vendedor", vendedorSel);
      return qs;
    },
    [vendedorSel],
  );

  useEffect(() => {
    const texto = qCliente.trim();
    // Recién elegido de la lista (ver elegirCliente) — el input ya muestra
    // "Nombre (código)" y no hace falta volver a buscar nada.
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
        const qs = qsVendedor(new URLSearchParams({ q: texto }));
        const res = await fetch(`/api/ventas/vendedor/clientes?${qs.toString()}`, {
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
  }, [qCliente, vendedorSel]);

  // ── Tabla: se carga automáticamente al elegir un cliente de la lista ───
  const [data, setData] = useState<RespVentasVendedor | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Acordeón de la tabla línea×año (ver agrupar/FilaGrupo arriba) — índice
  // del grupo de 50 abierto (0 = primero). Se resetea a 0 en cada fetch
  // (cliente nuevo, o el mismo cliente de nuevo).
  const [filasGrupoAbierto, setFilasGrupoAbierto] = useState(0);
  // Vista activa del ranking del pie ("Top 10 clientes"/"Top 10 líneas") —
  // la alterna el botón "Mostrar" propio de esa sección. Independiente del modal (ver `vistaModal` más abajo): el
  // modal ahora vive en su propio popup con su propio filtro, no comparte
  // estado con el ranking de la página.
  const [topVista, setTopVista] = useState<TopVista>("clientes");
  // Métrica del ranking del pie cuando la vista es "líneas" (2026-08-26). En vista "clientes" no aplica: ahí siempre es $.
  // Arranca en $ (2026-09-02); "Unidades" queda a un click.
  const [topMetricaLineas, setTopMetricaLineas] = useState<Modo>("pesos");
  const modo: Modo = topVista === "clientes" ? "pesos" : topMetricaLineas;
  const [desglosado, setDesglosado] = useState(false);

  // ── Modal "Ventas por cliente y línea" ──────────────────────────────────
  // Se abre al hacer click en un cliente o en una línea del ranking de abajo
  // El modo del nivel decide qué contenido muestra:
  //   · "cliente" → el buscador + la tabla línea×año de siempre (idéntico
  //     al comportamiento anterior, ahora dentro del modal).
  //   · "linea"   → una tabla nueva con los CLIENTES que compraron esa
  //     línea, de mayor a menor gasto ($) — ver fetchClientesPorLinea.
  // El buscador de cliente sigue disponible en el header del modal en
  // ambos modos: elegir un cliente ahí siempre reinicia en modo "cliente".
  //
  // ── Navegación en 2 niveles ────────────────
  // El drill-down ahora es SIMÉTRICO y con historial:
  //   Cliente (líneas que compró) → click en una línea → Línea (clientes que
  //   la compraron).
  //   Línea (clientes) → click en un cliente → Cliente (líneas que compró).
  // `pila` es el historial: el ÚLTIMO elemento es lo que se está viendo.
  // Máximo DOS niveles ("que sea solo hasta dos modales"): estando en el
  // nivel 2 las filas dejan de ser clickeables, y el botón ← del header
  // vuelve al nivel 1.
  //
  // Truco que hace que volver atrás NO tenga que refetchear: los dos niveles
  // siempre son de modos DISTINTOS (cliente→línea o línea→cliente), así que
  // cada uno vive en su propio estado (`data` para "cliente",
  // `clientesLinea` para "linea") y ninguno pisa al otro. Volver atrás es
  // solo recortar la pila.
  // "sublinea" (2026-09-15): mismo nivel 2 que "linea" (lista de clientes),
  // pero para el click en una sub_línea del ranking del pie (catálogo de
  // Postgres) en vez de una línea de Stk_Nivel1 dentro de la ficha de un
  // cliente — ver fetchClientesPorSubLinea/irASubLinea más abajo. Necesita
  // línea Y sub_línea porque el mismo nombre de sub_línea puede repetirse
  // bajo líneas distintas.
  type NivelModal =
    | { mode: "cliente"; cliente: Cliente }
    | { mode: "linea"; linea: string }
    | { mode: "sublinea"; linea: string; subLinea: string };
  const [modalOpen, setModalOpen] = useState(false);
  const [pila, setPila] = useState<NivelModal[]>([]);
  const nivelActual: NivelModal | null = pila.length ? pila[pila.length - 1] : null;
  const modalMode: "cliente" | "linea" | "sublinea" = nivelActual?.mode ?? "cliente";
  const modalLinea =
    nivelActual?.mode === "linea"
      ? nivelActual.linea
      : nivelActual?.mode === "sublinea"
        ? nivelActual.subLinea
        : null;
  // Texto de cada nivel en las migas de pan del header.
  const etiquetaNivel = (n: NivelModal) =>
    n.mode === "cliente"
      ? n.cliente.nombre ?? String(n.cliente.numero)
      : n.mode === "sublinea"
        ? n.subLinea
        : n.linea;
  // Nivel 1 = todavía se puede bajar un nivel más; nivel 2 = tope.
  const puedeBajar = pila.length < 2;
  const puedeVolver = pila.length > 1;
  const cerrarModal = useCallback(() => setModalOpen(false), []);

  // Filtro del modal colapsable  — arranca visible
  // y se puede plegar con el botón del header para dejarle más lugar a la
  // tabla; se reabre solo cada vez que se abre el modal de nuevo.
  const [filtroVisible, setFiltroVisible] = useState(true);

  // Métrica (pesos/unidades) de la tabla línea×año del modal, en modo
  // "cliente" — mismo switch "Mostrar" de siempre, pero ahora es un estado
  // PROPIO del modal (no el `topVista` de arriba): antes un solo botón
  // controlaba a la vez la tabla principal y el ranking del pie; separados,
  // togglear uno ya no cambia el otro.
  const [vistaModal, setVistaModal] = useState<TopVista>("clientes");
  const modoModal: Modo = vistaModal === "clientes" ? "pesos" : "unidades";

  // Clientes por línea (modal en modo "linea") — ver
  // /api/ventas/vendedor/clientes-por-linea (fetch_clientes_por_linea en
  // ventas.py), mismo rango fijo de 12 meses que los rankings del pie.
  const [clientesLinea, setClientesLinea] = useState<RespClientesPorLinea | null>(null);
  const [clientesLineaLoading, setClientesLineaLoading] = useState(false);
  const [clientesLineaError, setClientesLineaError] = useState<string | null>(null);

  // Trae los 2 años completos con desglose mensual — el filtro YTD/Meses lo hace después el front sobre los
  // meses ya cargados, igual que en modo "cliente". O sea: togglear
  // YTD/Meses NO vuelve a pegarle al back (antes sí, mandando desde/hasta).
  const fetchClientesPorLinea = useCallback(
    async (linea: string) => {
      setClientesLineaLoading(true);
      setClientesLineaError(null);
      // El acordeón de la tabla es compartido con el modo "cliente"
      // (`filasGrupoAbierto`): se resetea al grupo 0 con cada línea nueva,
      // si no queda "colgado" en un grupo que puede no existir.
      setFilasGrupoAbierto(0);
      try {
        const qs = qsVendedor(new URLSearchParams({ linea }));
        const res = await fetch(`/api/ventas/vendedor/clientes-por-linea?${qs.toString()}`, {
          cache: "no-store",
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
        setClientesLinea(j);
      } catch (e) {
        setClientesLineaError(e instanceof Error ? e.message : "Error al cargar");
        setClientesLinea(null);
      } finally {
        setClientesLineaLoading(false);
      }
    },
    [qsVendedor],
  );

  // Hermana de fetchClientesPorLinea (2026-09-15): clientes de una
  // SUB_LÍNEA del catálogo de Postgres — la usa el ranking "Top líneas" del
  // pie (ver abrirModalSubLinea más abajo). Comparte el mismo estado
  // `clientesLinea`/loading/error (la forma de la respuesta es la misma),
  // sólo cambia el endpoint y que manda `linea` además de `subLinea`.
  const fetchClientesPorSubLinea = useCallback(
    async (subLinea: string, linea: string) => {
      setClientesLineaLoading(true);
      setClientesLineaError(null);
      setFilasGrupoAbierto(0);
      try {
        const qs = qsVendedor(new URLSearchParams({ subLinea, linea }));
        const res = await fetch(`/api/ventas/vendedor/clientes-por-sub-linea?${qs.toString()}`, {
          cache: "no-store",
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
        setClientesLinea(j);
      } catch (e) {
        setClientesLineaError(e instanceof Error ? e.message : "Error al cargar");
        setClientesLinea(null);
      } finally {
        setClientesLineaLoading(false);
      }
    },
    [qsVendedor],
  );

  // Recibe el código directamente (en vez de leer clienteSel) porque
  // setClienteSel es asíncrono — si dependiéramos del estado, elegirCliente
  // dispararía la consulta con el valor viejo (null) en el mismo render.
  const fetchVentas = useCallback(async (codigo: number) => {
    setLoading(true);
    setError(null);
    setFilasGrupoAbierto(0);
    try {
      const qs = qsVendedor(new URLSearchParams({ cliente: String(codigo) }));
      const res = await fetch(`/api/ventas/vendedor?${qs.toString()}`, {
        cache: "no-store",
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setData(j);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al cargar");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [qsVendedor]);

  // ── Navegación del modal ────────────────────────────────────────────────
  // `apilar` distingue las dos formas de llegar a un nivel:
  //   · false → ENTRADA: se abre el modal desde afuera (ranking del pie o
  //     buscador). Reinicia la pila: este pasa a ser el nivel 1.
  //   · true  → DRILL-DOWN: se clickeó una fila de la tabla que ya se está
  //     viendo. Apila: pasa a ser el nivel 2. Solo se permite desde el
  //     nivel 1 (ver `puedeBajar`).
  const irACliente = useCallback(
    (c: Cliente, apilar: boolean) => {
      setClienteSel(c);
      setQCliente(labelCliente(c));
      setSugerencias([]);
      setMostrarSug(false);
      setPila((p) =>
        apilar ? [...p, { mode: "cliente", cliente: c }] : [{ mode: "cliente", cliente: c }],
      );
      fetchVentas(c.numero);
    },
    [fetchVentas],
  );

  const irALinea = useCallback(
    (linea: string, apilar: boolean) => {
      // El buscador del header no filtra la lista de clientes de una línea;
      // si queda con el texto de una búsqueda anterior parece que sí (ver
      // 2026-08-20). Al volver atrás se restaura solo, ver
      // `volverAtras`.
      setQCliente("");
      setClienteSel(null);
      setSugerencias([]);
      setMostrarSug(false);
      setPila((p) => (apilar ? [...p, { mode: "linea", linea }] : [{ mode: "linea", linea }]));
      fetchClientesPorLinea(linea);
    },
    [fetchClientesPorLinea],
  );

  // Hermana de irALinea (2026-09-15) — misma mecánica, pero para una
  // sub_línea del catálogo de Postgres (ranking del pie). Necesita línea Y
  // sub_línea: el mismo nombre de sub_línea puede repetirse bajo líneas
  // distintas.
  const irASubLinea = useCallback(
    (subLinea: string, linea: string, apilar: boolean) => {
      setQCliente("");
      setClienteSel(null);
      setSugerencias([]);
      setMostrarSug(false);
      setPila((p) =>
        apilar
          ? [...p, { mode: "sublinea", linea, subLinea }]
          : [{ mode: "sublinea", linea, subLinea }],
      );
      fetchClientesPorSubLinea(subLinea, linea);
    },
    [fetchClientesPorSubLinea],
  );

  // Botón ← del header del modal. No refetchea nada (ver el comentario de
  // `pila` arriba): el nivel al que se vuelve es de otro modo, así que sus
  // datos siguen intactos en su propio estado. Lo único que se restaura a
  // mano es el buscador, que sí se pisa al bajar de nivel.
  const volverAtras = useCallback(() => {
    if (pila.length < 2) return;
    const nueva = pila.slice(0, -1);
    const dest = nueva[nueva.length - 1];
    if (dest.mode === "cliente") {
      setClienteSel(dest.cliente);
      setQCliente(labelCliente(dest.cliente));
    } else {
      setClienteSel(null);
      setQCliente("");
    }
    setSugerencias([]);
    setMostrarSug(false);
    setFilasGrupoAbierto(0);
    setPila(nueva);
  }, [pila]);

  // Elegir un cliente desde el buscador del modal siempre REINICIA en modo
  // "cliente" (nivel 1) — por si se venía de una línea.
  const elegirCliente = useCallback((c: Cliente) => irACliente(c, false), [irACliente]);

  // Entradas desde el ranking del pie.
  const abrirModalCliente = useCallback(
    (c: Cliente) => {
      setModalOpen(true);
      setFiltroVisible(true);
      irACliente(c, false);
    },
    [irACliente],
  );

  // Entrada desde el ranking del pie (Top líneas) — click en una SUB_LÍNEA.
  const abrirModalSubLinea = useCallback(
    (subLinea: string, linea: string) => {
      setModalOpen(true);
      setFiltroVisible(true);
      irASubLinea(subLinea, linea, false);
    },
    [irASubLinea],
  );

  // Abre el modal vacío en modo "cliente", listo para buscar — para no
  // perder la posibilidad de buscar CUALQUIER cliente (no solo los del Top
  // 10) ahora que el buscador vive dentro del modal.
  const abrirModalBusqueda = useCallback(() => {
    setPila([]);
    setClienteSel(null);
    setQCliente("");
    setSugerencias([]);
    setData(null);
    setModalOpen(true);
    setFiltroVisible(true);
  }, []);

  // ── Rankings del pie: top clientes ($) y top líneas (unidades) ─────────
  // Independientes del cliente buscado arriba y del período YTD/meses de la
  // tabla principal. El rango es FIJO y lo resuelve el back (2026-09-04):
  // los meses transcurridos del año en curso (Enero → mes anterior), más el
  // mes en curso aparte en su propia columna. Ya no hay selector de fechas,
  // así que acá no se manda `desde`/`hasta` y el fetch corre UNA sola vez
  // al montar.
  //
  // Se piden los DOS (no solo el de la vista activa): el back cachea 15 min,
  // así que alternar Clientes/Líneas es instantáneo en vez de disparar un
  // fetch nuevo cada vez.
  const [topClientes, setTopClientes] = useState<RespTopClientes | null>(null);
  const [topLineas, setTopLineas] = useState<RespTopLineas | null>(null);
  const [topLoading, setTopLoading] = useState(false);
  const [topError, setTopError] = useState<string | null>(null);
  // Acordeón de este ranking (ver agrupar/FilaGrupo arriba) — se resetea al
  // grupo 0 al alternar Clientes/Líneas (botón "Mostrar" de abajo).
  const [topGrupoAbierto, setTopGrupoAbierto] = useState(0);

  useEffect(() => {
    let cancelado = false;
    setTopLoading(true);
    setTopError(null);
    const pedir = async (ruta: string) => {
      const qs = qsVendedor(new URLSearchParams()).toString();
      const res = await fetch(`/api/ventas/vendedor/${ruta}${qs ? `?${qs}` : ""}`, {
        cache: "no-store",
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      return j;
    };
    Promise.all([pedir("top-clientes"), pedir("top-lineas")])
      .then(([cli, lin]) => {
        if (cancelado) return;
        setTopClientes(cli);
        setTopLineas(lin);
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
    // Cambiar de vendedor recarga los rankings (el back ya cachea por
    // vendedor, así que volver a uno ya visto es instantáneo).
  }, [qsVendedor]);

  // Respuesta y total de la pestaña activa. El rango que se muestra en el
  // encabezado sale del BACK (que es quien resuelve el default), no del
  // estado local, así lo que dice el título siempre coincide con los datos
  // que hay en la tabla.
  const topResp: {
    desde: string | null;
    hasta: string | null;
    mesActual: string;
    ajuste?: number;
    ajusteMes?: number;
  } | null = topVista === "clientes" ? topClientes : topLineas;
  const topTotal: number | null =
    topVista === "clientes"
      ? topClientes?.totalClientes ?? null
      : topLineas?.totalLineas ?? null;

  // ── Período: botón dividido "YTD" / "Meses". Un solo estado para TODO el modal (modo "cliente"
  // y modo "linea" comparten el mismo toggle — 2026-08-20:
  // "cliente por línea y línea por cliente, ambos casos deben tener filtro
  // ytd y mes"). "YTD" es Enero..mes ANTERIOR al actual (el mes en curso
  // queda afuera por estar incompleto). "Meses" es el mes actual completo,
  // sin recortar por día.
  //
  // NINGUNO de los dos modos pega al back al togglear: ambas respuestas
  // traen el desglose mensual completo de los 2 años (ver
  // fetch_ventas_por_linea / fetch_clientes_por_linea) y el período se
  // resuelve sumando los meses correspondientes (ver mesesActivos/
  // sumaPeriodo más abajo). Antes el modo "linea" refetcheaba con
  // desde/hasta; desde 2026-08-20 ya no hace falta.
  const [periodo, setPeriodo] = useState<Periodo>("ytd");
  const mesActualNum = new Date().getMonth() + 1;
  const anioActualNum = new Date().getFullYear();
  // Último mes que entra en el YTD (0 en enero: todavía no hay mes anterior
  // en el año en curso).
  const mesAnteriorNum = mesActualNum - 1;

  const handleFiltrar = useCallback(() => {
    if (!clienteSel) return;
    fetchVentas(clienteSel.numero);
  }, [clienteSel, fetchVentas]);

  // Meses que entran en el "Total" mostrado, según el modo de período.
  const mesesActivos =
    periodo === "ytd"
      ? Array.from({ length: mesAnteriorNum }, (_, i) => i + 1)
      : [mesActualNum];

  const sumaPeriodo = useCallback(
    (a: AnioVal) =>
      a.meses.reduce(
        (acc, m) =>
          mesesActivos.includes(m.mes)
            ? { cantidad: acc.cantidad + m.cantidad, monto: acc.monto + m.monto }
            : acc,
        { cantidad: 0, monto: 0 },
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [periodo, mesActualNum],
  );

  // Nota: usan `modoModal` (estado propio del modal, ver `vistaModal` más
  // arriba), no el `modo` del ranking del pie — la tabla línea×año vive
  // ahora en el modal y tiene su propio switch "Mostrar".
  const valor = useCallback(
    (a: { cantidad: number; monto: number }) => (modoModal === "unidades" ? a.cantidad : a.monto),
    [modoModal],
  );
  const valorMes = useCallback(
    (m: MesVal) => (modoModal === "unidades" ? m.cantidad : m.monto),
    [modoModal],
  );
  const fmt = modoModal === "unidades" ? fmtNum : fmtMoney;
  // Formateador del ranking del pie (Top 10 clientes/líneas) — ese sí sigue
  // atado a `modo`/`topVista`.
  const fmtTop = modo === "unidades" ? fmtNum : fmtMoney;

  // ── Tabla año-anterior vs. año-actual del modal ────────────────────────
  // MISMA tabla para los dos modos. Lo único que cambia es qué identifica a la fila:
  //   · modo "cliente" → una fila por LÍNEA    (data.lineas)
  //   · modo "linea"/"sublinea" → una fila por CLIENTE (clientesLinea.clientes)
  // Ambas respuestas traen la misma forma {anioAnterior, anioActual} con
  // cantidad/monto/meses, así que todo lo de abajo (valor/valorMes,
  // sumaPeriodo, hover, tendencia, acordeón) sirve igual para las dos.
  // "sublinea" (2026-09-15) es el mismo tipo de vista que "linea" — ambas
  // son "lista de clientes de una fila del ranking", sólo cambia de dónde
  // salió esa fila (Magnus/Stk_Nivel1 vs. catálogo de Postgres).
  const esModoLinea = modalMode === "linea" || modalMode === "sublinea";
  const fuenteTabla = esModoLinea ? clientesLinea : data;
  const filas: FilaTabla[] = useMemo(() => {
    const base: FilaTabla[] = esModoLinea
      ? (clientesLinea?.clientes ?? []).map((c) => ({
          key: `cli-${c.numero}`,
          etiqueta: c.nombre ? `${c.nombre} (${c.numero})` : String(c.numero),
          cliente: { numero: c.numero, nombre: c.nombre },
          linea: null,
          anioAnterior: c.anioAnterior,
          anioActual: c.anioActual,
        }))
      : (data?.lineas ?? []).map((l) => ({
          key: `lin-${l.linea}`,
          etiqueta: l.linea,
          cliente: null,
          linea: l.linea,
          anioAnterior: l.anioAnterior,
          anioActual: l.anioActual,
        }));
    // Orden de mayor a menor por el TOTAL DEL AÑO ANTERIOR (
    // 2026-08-25). Se ordena sobre el mismo valor/período que muestra la
    // tabla (sumaPeriodo + valor: respeta YTD/Meses y $/Unidades), así que
    // togglear cualquiera de esos reordena la tabla. Desempate por el año
    // actual y después alfabético, para que el orden sea estable.
    return [...base].sort((a, b) => {
      const ant = valor(sumaPeriodo(b.anioAnterior)) - valor(sumaPeriodo(a.anioAnterior));
      if (ant !== 0) return ant;
      const act = valor(sumaPeriodo(b.anioActual)) - valor(sumaPeriodo(a.anioActual));
      if (act !== 0) return act;
      return a.etiqueta.localeCompare(b.etiqueta, "es");
    });
  }, [esModoLinea, clientesLinea, data, valor, sumaPeriodo]);
  const hayTabla = !!fuenteTabla;
  const sinDatos = !!fuenteTabla && !fuenteTabla.tieneDatos;
  // Encabezado de la primera columna y de la etiqueta de conteo del header.
  const colEtiqueta = esModoLinea ? "Cliente" : "Línea";

  // Aviso del pie de la tabla del cliente (2026-09-08): el TOTAL incluye las
  // bonificaciones y ajustes del cliente (comprobantes 23/24/25/60/62), que
  // no tienen artículo y por lo tanto no están en ninguna fila de línea. Sin
  // esto la suma de las filas no daría el total y parecería un error.
  // Sólo en $ (el concepto no tiene cantidad) y sólo en modo "cliente":
  // el modo "linea" está acotado a UNA línea y ahí el ajuste no aplica.
  const tituloTotalTabla = useMemo(() => {
    if (esModoLinea || modoModal === "unidades") return undefined;
    const aj = data?.ajustes;
    if (!aj) return undefined;
    const act = sumaPeriodo(aj.anioActual).monto;
    const ant = sumaPeriodo(aj.anioAnterior).monto;
    if (!act && !ant) return undefined;
    return (
      "El total incluye bonificaciones y ajustes del cliente (notas de crédito " +
      "por concepto, sin artículo): " +
      `${fmtMoney(ant)} en ${data?.anioAnterior} y ${fmtMoney(act)} en ${data?.anioActual}. ` +
      "No tienen línea, así que no figuran en ninguna fila."
    );
  }, [esModoLinea, modoModal, data, sumaPeriodo]);
  // Único caso sin meses: YTD en enero (todavía no hay mes anterior).
  const sinMesesPeriodo = periodo === "ytd" && mesesActivos.length === 0;

  // Desglosado: en "meses" mostrás solo el mes actual (1 columna); en "ytd"
  // Enero..mes anterior, mismo criterio que ya usa sumaPeriodo/mesesActivos.
  const mesesMostrados = mesesActivos;
  const nMesesMostrados = mesesMostrados.length;
  // Con el desglose mensual en un solo mes (período "Meses") la columna
  // "Total" de cada año repite exactamente el único mes que se muestra —
  // se oculta (2026-08-25). Sin desglose el "total" ES la
  // única columna de datos del año, así que ahí siempre va.
  const mostrarTotalAnio = !desglosado || nMesesMostrados > 1;
  // Separación visual entre bloques (2026-08-25: "una línea
  // gruesa entre años"). El borde grueso amarillo marca dónde ARRANCA cada
  // bloque — año anterior, año actual y Tendencia — y adentro de cada bloque
  // los meses siguen separados con el borde fino de siempre. Con el desglose
  // mensual el bloque arranca en el primer mes; sin desglose arranca en la
  // columna de total (que es la única del año).
  const SEP_BLOQUE = "border-l-2 border-yellow-400/40";
  const SEP_FINO = "border-l border-zinc-800";
  const sepTotalAnio = desglosado ? SEP_FINO : SEP_BLOQUE;
  const colSpanAnio = desglosado ? nMesesMostrados + (mostrarTotalAnio ? 1 : 0) : 1;
  const labelDeMes = (a: AnioVal, mes: number) =>
    a.meses.find((m) => m.mes === mes)?.label ?? "";

  // ── Fila verde si creció + fila/columna iluminada según el mouse (2026-08-14) ──────────────────────────────────────────────────
  // Índices de columna: Línea=0, después las columnas de meses mostrados
  // del año anterior (en el mismo orden que mesesMostrados), Total
  // anterior, columnas de meses mostrados del año actual, Total actual.
  const COL_LINEA = 0;
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
  // Clase de fondo de una celda: verde si la fila creció (año actual >
  // año anterior, sobre el mismo valor/período que ya se muestra), más
  // intenso si además está en la fila u la columna donde está el mouse;
  // si no creció, un tinte amarillo tenue solo cuando está iluminada.
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

  // Triángulo ▲/▼ por línea, columna nueva al final de la tabla (2026-08-18). Compara año actual vs. año anterior sobre el MISMO
  // valor/período que ya muestra la fila (sumaPeriodo + valor: respeta
  // YTD/meses y pesos/unidades, igual que `crece`). "sube" = año actual >
  // año anterior (▲ verde), "baja" = año actual < año anterior (▼ rojo),
  // "igual" = mismo valor — incluye 0 vs 0 (sin ventas) y empates reales:
  // sin triángulo, sin tocar el fondo de esa celda.
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
  // Celda de la columna "Tendencia": el color va en el TEXTO, no en el fondo
  // (2026-08-25: "no pintes toda la fila de rojo cuando la
  // tendencia es baja" — antes la celda del ▼ tenía fondo rojo sólido). El
  // verde de la fila que crece (ver `celda`) se mantiene.
  const celdaTendencia = (t: "sube" | "baja" | "igual") => {
    if (t === "sube") return "text-green-400";
    if (t === "baja") return "text-red-400";
    return "text-zinc-600";
  };
  const iconoTendencia = (t: "sube" | "baja" | "igual") => (t === "sube" ? "▲" : t === "baja" ? "▼" : "—");

  // Variación porcentual año actual vs. año anterior, al lado del triángulo
  // (2026-08-25). Mismo valor/período que `tendencia`.
  // Devuelve null cuando el año anterior es 0: no hay base contra la cual
  // calcular un % (sería infinito), así que en ese caso se muestra solo el
  // triángulo.
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
    p === null ? "" : `${p > 0 ? "+" : ""}${new Intl.NumberFormat("es-AR", { maximumFractionDigits: 0 }).format(p)}%`;

  // ── Agrupado en acordeón (ver agrupar/FilaGrupo/GROUP_SIZE arriba) — un
  // bloque por tabla larga, calculado acá porque las tres dependen de
  // estado que ya está en scope (filas, topVista/topClientes/topLineas,
  // clientesLinea). `*GrupoSeguro` evita quedar apuntando a un grupo que
  // dejó de existir (ej. cambió el listado y ahora hay menos grupos).
  const filasGrupos = agrupar(filas);
  const filasGrupoSeguro = Math.min(filasGrupoAbierto, Math.max(0, filasGrupos.length - 1));
  const totalColsLineaAnio = 2 + 2 * colSpanAnio; // Línea + Año ant. + Año act. + Tend.

  // Cada vista/métrica usa la lista que YA viene ordenada del back.
  const topLineasItems: TopLinea[] =
    (topMetricaLineas === "pesos" ? topLineas?.porMonto : topLineas?.porUnidades) ?? [];
  const topItems: (TopCliente | TopLinea)[] =
    topVista === "clientes" ? topClientes?.porMonto ?? [] : topLineasItems;
  const topGrupos = agrupar(topItems);
  const topGrupoSeguro = Math.min(topGrupoAbierto, Math.max(0, topGrupos.length - 1));

  // ── Las dos columnas de números del ranking (2026-09-04) ───────────────
  // Acumulado del año (Ene→mes anterior) y mes en curso. La misma tabla
  // muestra clientes (siempre $) o líneas ($ o unidades), así que qué campo
  // leer se resuelve una vez acá y no repetido en cada <td>.
  const valorTop = (it: TopCliente | TopLinea) =>
    "linea" in it ? (modo === "unidades" ? it.unidades : it.monto) : it.monto;
  const valorTopMes = (it: TopCliente | TopLinea) =>
    "linea" in it ? (modo === "unidades" ? it.unidadesMes : it.montoMes) : it.montoMes;

  // Totales del pie: suman TODAS las filas del ranking, no solo las del
  // acordeón abierto — son el total del período, no el de lo que se ve.
  const topSumas = useMemo(
    () =>
      topItems.reduce(
        (acc, it) => {
          acc.acum += valorTop(it) || 0;
          acc.mes += valorTopMes(it) || 0;
          return acc;
        },
        { acum: 0, mes: 0 },
      ),
    // valorTop/valorTopMes solo dependen de `modo`, que ya está acá.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [topItems, modo],
  );

  // Ajuste de la venta: bonificaciones y ajustes de saldo del mismo rango y
  // la misma cartera (comprobantes 24/60/25/23/62 — ver bonificaciones.py).
  // Se emiten como notas de crédito por concepto, sin artículo, así que no
  // están en ninguna fila del ranking: entran sólo acá, en el pie.
  //
  // Sólo en $. En la vista por unidades no hay nada que ajustar: el concepto
  // de una nota de crédito no tiene cantidad.
  const topAjuste = useMemo(() => {
    if (modo === "unidades") return null;
    // Ranking de CLIENTES (2026-09-08): el ajuste ya viene imputado adentro
    // de cada fila, así que el pie no lo abre en bruto → ajuste → neto; lo
    // informa aparte (topAjusteIncluido). El de LÍNEAS sigue como estaba:
    // una NC por concepto no tiene artículo y por lo tanto no tiene línea.
    if (topVista === "clientes" && topResp?.ajusteIncluido) return null;
    const acum = topResp?.ajuste ?? 0;
    const mes = topResp?.ajusteMes ?? 0;
    if (!acum && !mes) return null;
    return { acum, mes };
  }, [topResp, modo, topVista]);

  // Cuánto de las filas del ranking de clientes son bonificaciones y ajustes
  // (ya sumados en cada fila). Sólo para mostrarlo debajo del total.
  const topAjusteIncluido = useMemo(() => {
    if (topVista !== "clientes" || !topResp?.ajusteIncluido) return null;
    const acum = topResp?.ajuste ?? 0;
    const mes = topResp?.ajusteMes ?? 0;
    if (!acum && !mes) return null;
    return { acum, mes };
  }, [topResp, topVista]);

  // Etiquetas de encabezado. Salen del BACK (`desde`/`hasta`/`mesActual`)
  // para que el título no pueda contradecir a los datos. En enero
  // desde/hasta vienen en null: todavía no hay ningún mes cerrado del año y
  // la columna del acumulado queda vacía a propósito.
  const nombreMes = (ym: string | null | undefined) =>
    ym ? MESES_CORTOS_ES[Number(ym.slice(5, 7)) - 1] ?? "" : "";
  const rangoAcumLabel = topResp?.desde && topResp?.hasta
    ? `${nombreMes(topResp.desde)}–${nombreMes(topResp.hasta)} ${topResp.hasta.slice(0, 4)}`
    : "Sin meses cerrados";
  // Mes en curso: el nombre entero y sin año — el año ya está en la etiqueta
  // del acumulado de al lado, repetirlo no agrega nada. Si el back todavía no
  // contestó no se inventa un mes: se cae al rótulo genérico.
  const mesActualLabel = topResp?.mesActual
    ? MESES_ES[Number(topResp.mesActual.slice(5, 7)) - 1] ?? "Mes en curso"
    : "Mes en curso";


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

      {/* Header en 3 filas en el teléfono y 1 sola en la computadora (2026-08-25). En mobile es un grid de 2 columnas:
            fila 1 → logo            | "Buscar cliente"
            fila 2 → filtro de vendedor (izq.) + switch Clientes|Líneas (der.)
            fila 3 → el usuario, a la derecha, ocupando el ancho
          (2026-09-03: el filtro ocupaba una fila entera para él solo; ahora va
          angosto al lado del switch. En mobile el orden lo fija `order-*`
          porque en el DOM el switch viene antes que el filtro.)
          En `md` pasa a flex y el `order-*` reacomoda: logo, buscar, switch,
          y el vendedor empujado a la derecha con ml-auto. Por eso el orden
          del DOM no coincide con el de escritorio — al agregar algo nuevo,
          darle su `md:order-N`.
          2026-09-02: se sacó el título "clientes/líneas" con su ícono — el
          botón dividido ya marca en amarillo cuál está activo, el título
          repetía esa misma información. */}
      <header className="sticky top-0 z-50 bg-[#1A1A1A] border-b-[3px] border-yellow-400 px-4 md:px-8 py-3">
        <div className="grid grid-cols-2 items-center gap-x-3 gap-y-2 md:flex md:flex-wrap md:gap-4">
          <div className="order-1 flex items-center gap-3 min-w-0 md:order-1">
            <InicioButton />
            <span className="font-bold text-yellow-400 text-base md:text-2xl tracking-wide uppercase whitespace-nowrap">
              EVER WEAR{" "}
              <span className="text-xs md:text-sm tracking-[3px] font-normal">S.A.</span>
            </span>
          </div>

          <button
            type="button"
            onClick={abrirModalBusqueda}
            className="btn-anim order-2 inline-flex items-center justify-center gap-2 rounded-md border border-zinc-700 px-3 py-2 text-sm text-zinc-100 hover:border-yellow-400 transition-colors md:order-2"
          >
            <Search size={14} className="text-yellow-400" />
            Buscar cliente
          </button>

          {/* Botón dividido Clientes | Líneas (2026-08-25:
              "que sean 2 botones y la marca se mueva de lado a lado según el
              lugar activo") — antes era UN botón que alternaba y mostraba la
              vista actual, confuso porque no se sabía si el texto era el
              estado o la acción. Mismo patrón visual que el YTD/Meses del
              modal: el activo va en amarillo sólido. */}
          <div
            className={`order-4 justify-self-end inline-flex rounded-md border border-zinc-700 overflow-hidden text-sm divide-x divide-zinc-700 md:col-auto md:order-3 ${
              esAdmin ? "" : "col-span-2"
            }`}
          >
            {(["clientes", "lineas"] as TopVista[]).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => {
                  if (topVista === v) return;
                  setTopVista(v);
                  setTopGrupoAbierto(0);
                }}
                title={v === "clientes" ? "Ranking de clientes ($)" : "Ranking de líneas ($ o unidades)"}
                className={`px-2.5 py-2 text-xs font-semibold transition-colors md:px-3 md:text-sm ${
                  topVista === v
                    ? "bg-yellow-400 text-black"
                    : "text-zinc-300 hover:bg-zinc-800"
                }`}
              >
                {v === "clientes" ? "Clientes" : "Líneas"}
              </button>
            ))}
          </div>

          {/* Filtro de vendedor — SOLO ADMIN (2026-08-27).
              No se renderiza si /api/ventas/vendedor/vendedores contestó 403
              (no-admin): ese usuario ya está acotado a su propio vendedor
              server-side. Elegir uno reinicia el cliente/tabla que estaba
              cargado (podía no pertenecer a la cartera del nuevo vendedor) y
              recarga los rankings. */}
          {esAdmin && (
            <div className="order-3 flex min-w-0 items-center gap-2 md:col-auto md:order-4">
              <Users size={14} className="text-yellow-400 shrink-0" />
              <select
                value={vendedorSel}
                onChange={(e) => {
                  setVendedorSel(e.target.value);
                  setClienteSel(null);
                  setQCliente("");
                  setSugerencias([]);
                  setData(null);
                  setTopGrupoAbierto(0);
                }}
                title={
                  vendedores.length === 0
                    ? "Ningún vendedor habilitado en Magnus tiene usuario con legajo activo — revisá Administración → Usuarios"
                    : "Ver la cartera de un vendedor"
                }
                disabled={vendedores.length === 0}
                className="bg-[#1f1f1f] border border-zinc-700 rounded-md px-2 py-1.5 text-xs text-zinc-100 outline-none focus:border-yellow-400 w-full min-w-0 md:text-sm md:w-auto md:max-w-[220px] disabled:opacity-50"
              >
                <option value="">
                  {vendedores.length === 0
                    ? "Sin vendedores activos"
                    : "Todos los vendedores"}
                </option>
                {vendedores.map((v) => (
                  <option key={v.codigo} value={String(v.codigo)}>
                    {v.nombre ?? `Vendedor ${v.codigo}`}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Quién está mirando (2026-08-25). Es el
              componente compartido `<UsuarioActual />` que ya está en el
              header de todas las vistas — NO duplicar el fetch a
              /api/auth/me acá. En esta pantalla el usuario logueado ES el
              vendedor: lo que ve está acotado a SU vendedorCodigo (ver
              lib/ventas/vendedorAcceso.ts). */}
          <UsuarioActual className="order-5 col-span-2 justify-self-end md:col-auto md:order-5 md:ml-auto" />
        </div>
      </header>

      <main className="max-w-[1400px] mx-auto px-4 md:px-8 py-8 space-y-6">
        {/* Modal "Ventas por cliente y línea" (2026-08-18):
            se abre al hacer click en un cliente o una línea del ranking de
            abajo, o en "Buscar cliente" arriba. El filtro queda pegado en
            el header del modal (no scrollea); la tabla scrollea en el
            cuerpo. */}
        {/* `items-start` + `dvh` (2026-08-25: "que el modal
            no se vaya tan arriba"). Centrado y con `vh`, en el teléfono el
            teclado achica el viewport y el modal se corría hacia arriba hasta
            cortar el título y la X. Anclado arriba con un margen fijo, el
            header del modal siempre queda visible; `dvh` es la altura REAL
            disponible (descuenta las barras del navegador y el teclado), a
            diferencia de `vh`. */}
        {modalOpen && (
          <div
            className="fixed inset-0 z-[100] bg-black/70 flex items-start justify-center p-3 md:p-4 overflow-y-auto"
            onClick={cerrarModal}
          >
            <div
              className="w-full max-w-6xl max-h-[calc(100dvh-1.5rem)] md:max-h-[92dvh] rounded-xl border border-zinc-800 bg-[#111111] flex flex-col overflow-hidden shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="shrink-0 bg-[#1A1A1A] border-b border-zinc-800 px-5 py-4 space-y-4 max-h-[45dvh] overflow-y-auto">
                <div className="flex items-start justify-between gap-4">
                  {/* Migas de pan del drill-down (
                      2026-08-25). Muestra los niveles abiertos —
                      "ACME S.A. › POLEAS" — con el actual resaltado, y el ←
                      para volver al anterior. Reemplaza al título suelto de
                      la línea y al nombre del cliente que solo aparecía con
                      el filtro plegado. */}
                  <div className="flex items-center gap-2 min-w-0">
                    {puedeVolver && (
                      <button
                        type="button"
                        onClick={volverAtras}
                        title={`Volver a ${etiquetaNivel(pila[pila.length - 2])}`}
                        aria-label="Volver"
                        className="btn-anim shrink-0 inline-flex items-center rounded-md border border-zinc-700 px-2 py-1.5 text-zinc-300 hover:border-yellow-400 hover:text-yellow-400 transition-colors"
                      >
                        <ArrowLeft size={16} />
                      </button>
                    )}
                    {pila.length > 0 && (
                      <div className="min-w-0">
                        <h3 className="font-bold text-base uppercase tracking-wide flex items-center gap-1.5 min-w-0">
                          {pila.map((n, i) => (
                            <span key={`${n.mode}-${i}`} className="flex items-center gap-1.5 min-w-0">
                              {i > 0 && <span className="text-zinc-600">›</span>}
                              <span
                                className={`truncate ${
                                  i === pila.length - 1
                                    ? "text-yellow-400"
                                    : "text-zinc-500 font-normal"
                                }`}
                              >
                                {etiquetaNivel(n)}
                              </span>
                            </span>
                          ))}
                        </h3>
                        <p className="text-zinc-500 text-xs mt-0.5">
                          {esModoLinea
                            ? "Clientes que compraron esta línea"
                            : "Líneas que compró este cliente"}
                          {!puedeBajar && " — volvé con ← para seguir navegando"}
                        </p>
                      </div>
                    )}
                  </div>
                  {/* La X vive en el header del modal, arriba a la derecha
                      (2026-08-25). Antes estaba adentro del
                      bloque de filtro colapsable — con el filtro plegado
                      desaparecía y solo quedaba cerrar clickeando afuera. */}
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

                {/* Filtro (2026-08-18: colapsable con el botón
                  de arriba — antes ocupaba mucho lugar fijo en el header del
                  modal, que no scrollea, y le dejaba poco espacio a la
                  tabla). */}
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
                          onFocus={() =>
                            sugerencias.length > 0 && setMostrarSug(true)
                          }
                          onBlur={() => {
                            blurTimeout.current = setTimeout(
                              () => setMostrarSug(false),
                              150,
                            );
                          }}
                          onKeyDown={(e) =>
                            e.key === "Enter" && clienteSel && handleFiltrar()
                          }
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
                                  if (blurTimeout.current)
                                    clearTimeout(blurTimeout.current);
                                  elegirCliente(c);
                                }}
                                className="w-full text-left px-3 py-2 text-sm text-zinc-200 hover:bg-yellow-400/10 hover:text-yellow-400 transition-colors flex items-center justify-between gap-2"
                              >
                                <span className="truncate">
                                  {c.nombre ?? "(sin nombre)"}
                                </span>
                                <span className="text-zinc-500 font-mono text-xs shrink-0">
                                  {c.numero}
                                </span>
                              </button>
                            ))}
                          </div>
                        )}
                        {mostrarSug &&
                          sugerencias.length === 0 &&
                          sinVendedorAsignado && (
                            <div className="absolute z-20 mt-1 w-full rounded-md border border-amber-400/40 bg-[#1A1A1A] shadow-xl px-3 py-2.5 text-xs text-amber-300">
                              Tu usuario todavía no tiene un vendedor de Magnus
                              asignado — pedile a un administrador que te lo
                              asigne en Administración → Usuarios.
                            </div>
                          )}
                      </div>
                    </div>

                    {/* Switch $/unidades y desglose por mes de ESTA tabla —
                    estado propio del modal (`vistaModal`/`desglosado`), no el
                    del ranking del pie. Desde 2026-08-20 valen para los DOS
                    modos: la tabla de clientes de una línea
                    tiene el mismo desglose año/mes que la de líneas de un
                    cliente. */}
                    {hayTabla && (
                      <>
                        {/* Botón dividido $ | Unidades — mismo cambio que el
                            Clientes/Líneas del header. "clientes" = pesos, "lineas" =
                            unidades (ver modoModal). */}
                        <div className="flex flex-col gap-1.5">
                          <div className="inline-flex rounded-md border border-zinc-700 overflow-hidden text-sm divide-x divide-zinc-700">
                            {(["clientes", "lineas"] as TopVista[]).map((v) => (
                              <button
                                key={v}
                                type="button"
                                onClick={() => setVistaModal(v)}
                                title={v === "clientes" ? "Ver montos en $" : "Ver unidades"}
                                className={`px-3 py-2 font-semibold transition-colors ${
                                  vistaModal === v
                                    ? "bg-yellow-400 text-black"
                                    : "text-zinc-300 hover:bg-zinc-800"
                                }`}
                              >
                                {v === "clientes" ? "$" : "Unidades"}
                              </button>
                            ))}
                          </div>
                        </div>

                      </>
                    )}

                    {/* Botón dividido: YTD (Ene–mes anterior) vs. Meses (mes
                    actual completo) — 2026-08-20: un solo
                    estado (`periodo`) para los dos modos. En ninguno pega al
                    back: filtra el desglose mensual ya traído (ver
                    mesesActivos/sumaPeriodo). Los títulos usan
                    MESES_CORTOS_ES directo, no `labelDeMes`/`data`. */}
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
                        {filas.length} {esModoLinea ? "cliente(s)" : "línea(s)"}
                      </span>
                      {hayTabla && (
                        <button
                          type="button"
                          onClick={() => setDesglosado((v) => !v)}
                          className="btn-anim flex items-center gap-1.5 border border-zinc-700 text-zinc-200 text-sm rounded-md px-3 py-2 hover:border-yellow-400 transition-colors"
                        >
                          {desglosado
                            ? "por año"
                            : "por mes"}
                        </button>
                    )}
                  </div>
                )}

              </div>

              <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
                <>
                    {modalMode === "cliente" && !hayTabla && (
                      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 px-5 py-16 flex flex-col items-center gap-3 text-center">
                        <Search size={40} className="text-zinc-700" />
                        <p className="text-zinc-500 text-sm">
                          Buscá un cliente por código o nombre y elegilo de la
                          lista.
                        </p>
                      </div>
                    )}

                    {esModoLinea && clientesLineaError && (
                      <div className="rounded-xl border border-red-900/60 bg-red-950/30 px-5 py-4 text-sm text-red-300">
                        {clientesLineaError}
                      </div>
                    )}

                    {esModoLinea && !hayTabla && !clientesLineaError && (
                      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 px-5 py-16 flex flex-col items-center gap-3 text-center">
                        <Table2 size={40} className="text-zinc-700" />
                        <p className="text-zinc-500 text-sm">
                          {clientesLineaLoading
                            ? "Cargando clientes de la línea…"
                            : "Sin datos para esta línea."}
                        </p>
                      </div>
                    )}

                    {hayTabla && sinDatos && (
                      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 px-5 py-16 flex flex-col items-center gap-3 text-center">
                        <Table2 size={40} className="text-zinc-700" />
                        <p className="text-zinc-500 text-sm">
                          {esModoLinea ? (
                            <>
                              Ningún cliente compró {modalLinea} en{" "}
                              {clientesLinea?.anioAnterior}–
                              {clientesLinea?.anioActual}.
                            </>
                          ) : (
                            <>
                              Sin ventas registradas para{" "}
                              {data?.cliente.nombre ?? data?.cliente.codigo} en{" "}
                              {data?.anioAnterior}–{data?.anioActual}.
                            </>
                          )}
                        </p>
                      </div>
                    )}

                    {hayTabla && !sinDatos && sinMesesPeriodo && (
                      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 px-5 py-16 flex flex-col items-center gap-3 text-center">
                        <Table2 size={40} className="text-zinc-700" />
                        <p className="text-zinc-500 text-sm">
                          Todavía no hay mes anterior este año — probá con
                          &quot;Meses&quot; para ver Enero.
                        </p>
                      </div>
                    )}

                    {hayTabla && !sinDatos && !sinMesesPeriodo && (
                      <div
                        className={`rounded-xl border border-zinc-800 overflow-hidden transition-opacity ${
                          loading || clientesLineaLoading
                            ? "opacity-50 pointer-events-none"
                            : ""
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
                                    hoverCol === COL_LINEA
                                      ? "bg-yellow-400/10"
                                      : ""
                                  }`}
                                  onMouseEnter={() => {
                                    setHoverRow(null);
                                    setHoverCol(COL_LINEA);
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
                                      (Ene–
                                      {labelDeMes(fuenteTabla!.totales.anioAnterior, mesAnteriorNum)})
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
                                      (Ene–
                                      {labelDeMes(fuenteTabla!.totales.anioActual, mesAnteriorNum)})
                                    </span>
                                  )}
                                  {periodo === "meses" && (
                                    <span className="text-yellow-400/60 font-normal">
                                      {" "}
                                      ({labelDeMes(fuenteTabla!.totales.anioActual, mesActualNum)})
                                    </span>
                                  )}
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
                                          hoverCol === colAnteriorMes(m.mes)
                                            ? "bg-yellow-400/10"
                                            : ""
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
                                      hoverCol === colAnteriorTotal
                                        ? "bg-yellow-400/10"
                                        : ""
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
                                          hoverCol === colActualMes(m.mes)
                                            ? "bg-yellow-400/10"
                                            : ""
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
                                      hoverCol === colActualTotal
                                        ? "bg-yellow-400/10"
                                        : ""
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
                                    hasta={Math.min(
                                      (gIdx + 1) * GROUP_SIZE,
                                      filas.length,
                                    )}
                                    total={filas.length}
                                    abierto={filasGrupoSeguro === gIdx}
                                    onClick={() =>
                                      setFilasGrupoAbierto(
                                        filasGrupoSeguro === gIdx ? -1 : gIdx,
                                      )
                                    }
                                    colSpan={totalColsLineaAnio}
                                  />
                                )}
                                {(filasGrupos.length <= 1 ||
                                  filasGrupoSeguro === gIdx) &&
                                  grupo.map((r, rowIdx) => {
                                    const rowCrece = crece(r);
                                    const rowTendencia = tendencia(r);
                                    return (
                                      <tr
                                        key={r.key}
                                        className="border-t border-zinc-800/60 transition-colors"
                                      >
                                        {/* Drill-down simétrico (2026-08-25): la fila es un
                                        CLIENTE en modo "linea" y una LÍNEA en
                                        modo "cliente", y en los dos casos se
                                        puede clickear para bajar al otro
                                        modo. Solo desde el nivel 1: en el
                                        nivel 2 (`puedeBajar` false) la
                                        etiqueta es texto plano y hay que
                                        volver con el ← del header. */}
                                        <td
                                          className={`px-3 py-2 text-zinc-100 whitespace-nowrap ${puedeBajar ? "" : "cursor-default"} ${celda(rowIdx, COL_LINEA, rowCrece)}`}
                                          onMouseEnter={() => {
                                            setHoverRow(rowIdx);
                                            setHoverCol(COL_LINEA);
                                          }}
                                        >
                                          {puedeBajar ? (
                                            <button
                                              type="button"
                                              onClick={() =>
                                                r.cliente
                                                  ? irACliente(r.cliente, true)
                                                  : irALinea(r.linea!, true)
                                              }
                                              title={
                                                r.cliente
                                                  ? "Ver las líneas que compró este cliente"
                                                  : "Ver los clientes que compraron esta línea"
                                              }
                                              className="hover:text-yellow-400 hover:underline transition-colors text-left"
                                            >
                                              {r.etiqueta}
                                            </button>
                                          ) : (
                                            r.etiqueta
                                          )}
                                        </td>
                                        {desglosado &&
                                          r.anioAnterior.meses
                                            .filter((m) =>
                                              mesesActivos.includes(m.mes),
                                            )
                                            .map((m, i) => {
                                              const colIdx = colAnteriorMes(
                                                m.mes,
                                              );
                                              return (
                                                <td
                                                  key={`a-${m.mes}`}
                                                  className={`px-2 py-2 text-right tabular-nums text-zinc-400 ${i === 0 ? SEP_BLOQUE : "border-l border-zinc-800/40"} cursor-default ${celda(rowIdx, colIdx, rowCrece)}`}
                                                  onMouseEnter={() => {
                                                    setHoverRow(rowIdx);
                                                    setHoverCol(colIdx);
                                                  }}
                                                >
                                                  {valorMes(m) === 0
                                                    ? "—"
                                                    : fmt(valorMes(m))}
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
                                          {fmt(
                                            valor(sumaPeriodo(r.anioAnterior)),
                                          )}
                                        </td>
                                        )}
                                        {desglosado &&
                                          r.anioActual.meses
                                            .filter((m) =>
                                              mesesActivos.includes(m.mes),
                                            )
                                            .map((m, i) => {
                                              const colIdx = colActualMes(
                                                m.mes,
                                              );
                                              return (
                                                <td
                                                  key={`c-${m.mes}`}
                                                  className={`px-2 py-2 text-right tabular-nums text-zinc-400 ${i === 0 ? SEP_BLOQUE : "border-l border-zinc-800/40"} cursor-default ${celda(rowIdx, colIdx, rowCrece)}`}
                                                  onMouseEnter={() => {
                                                    setHoverRow(rowIdx);
                                                    setHoverCol(colIdx);
                                                  }}
                                                >
                                                  {valorMes(m) === 0
                                                    ? "—"
                                                    : fmt(valorMes(m))}
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
                                          {fmt(
                                            valor(sumaPeriodo(r.anioActual)),
                                          )}
                                        </td>
                                        )}
                                        <td
                                          className={`px-3 py-2 text-center font-bold whitespace-nowrap ${SEP_BLOQUE} cursor-default ${celdaTendencia(rowTendencia)}`}
                                        >
                                          <span className="text-base">
                                            {iconoTendencia(rowTendencia)}
                                          </span>
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
                                    hoverCol === COL_LINEA
                                      ? "bg-yellow-400/10"
                                      : ""
                                  }`}
                                  onMouseEnter={() => {
                                    setHoverRow(null);
                                    setHoverCol(COL_LINEA);
                                  }}
                                  title={tituloTotalTabla}
                                >
                                  Total
                                  {tituloTotalTabla && (
                                    <span className="text-yellow-400/70"> *</span>
                                  )}
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
                                            hoverCol === colIdx
                                              ? "bg-yellow-400/10"
                                              : ""
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
                                    hoverCol === colAnteriorTotal
                                      ? "bg-yellow-400/10"
                                      : ""
                                  }`}
                                  onMouseEnter={() => {
                                    setHoverRow(null);
                                    setHoverCol(colAnteriorTotal);
                                  }}
                                >
                                  {fmt(
                                    valor(
                                      sumaPeriodo(fuenteTabla!.totales.anioAnterior),
                                    ),
                                  )}
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
                                            hoverCol === colIdx
                                              ? "bg-yellow-400/10"
                                              : ""
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
                                    hoverCol === colActualTotal
                                      ? "bg-yellow-400/10"
                                      : ""
                                  }`}
                                  onMouseEnter={() => {
                                    setHoverRow(null);
                                    setHoverCol(colActualTotal);
                                  }}
                                >
                                  {fmt(
                                    valor(
                                      sumaPeriodo(fuenteTabla!.totales.anioActual),
                                    ),
                                  )}
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
                  </>
              </div>
            </div>
          </div>
        )}

        {/* Rankings del pie — top clientes ($) o top líneas (unidades). El
            título, el botón "Mostrar" y el switch Clientes/Líneas se
            mudaron al header. El rango es FIJO y lo resuelve el back: los
            meses transcurridos del año en curso, más el mes en curso en su
            propia columna y una fila de totales al pie.
            Clickeando un cliente o una línea de la tabla de abajo se abre
            el modal con el detalle. */}

        {/* Botón dividido $ | Unidades del ranking de líneas (2026-08-26: "que tenga las 2 vistas, por unidad y por $
            como al verse por cliente"). Mismo patrón visual que el del
            modal y que el Clientes|Líneas del header. Solo aparece en la
            vista "líneas": el ranking de clientes sigue siendo solo $.
            Cambiar de métrica NO refetchea — el back manda las dos listas
            ya ordenadas — pero sí resetea el acordeón al primer grupo,
            porque el orden de las filas es distinto en cada una. */}
        {topVista === "lineas" && !topError && (
          <div className="inline-flex rounded-md border border-zinc-700 overflow-hidden text-sm divide-x divide-zinc-700">
            {(["pesos", "unidades"] as Modo[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => {
                  if (topMetricaLineas === m) return;
                  setTopMetricaLineas(m);
                  setTopGrupoAbierto(0);
                }}
                title={m === "pesos" ? "Ver montos en $" : "Ver unidades"}
                className={`px-3 py-2 font-semibold transition-colors ${
                  topMetricaLineas === m
                    ? "bg-yellow-400 text-black"
                    : "text-zinc-300 hover:bg-zinc-800"
                }`}
              >
                {m === "pesos" ? "$" : "Unidades"}
              </button>
            ))}
          </div>
        )}

        {topError && (
          <div className="rounded-xl border border-red-400/40 bg-zinc-900/40 px-5 py-4 flex items-center gap-3 text-sm text-red-300">
            <AlertTriangle size={16} className="text-red-400" /> {topError}
          </div>
        )}

        {!topError && (
          <div
            className={`rounded-xl border border-zinc-800 overflow-hidden transition-opacity ${topLoading ? "opacity-50" : ""}`}
          >
            {(() => {
              const vacio =
                topVista === "clientes"
                  ? !topClientes?.porMonto?.length
                  : !topLineasItems.length;
              if (!topLoading && vacio) {
                return (
                  <div className="px-5 py-12 flex flex-col items-center gap-3 text-center">
                    <Trophy size={32} className="text-zinc-700" />
                    <p className="text-zinc-500 text-sm">
                      Sin ventas registradas en el rango elegido.
                    </p>
                  </div>
                );
              }
              return (
                <>
                  {/* overflow-x-auto: "que la tabla no se
                exceda de la ventana"). Sin min-w-max y con la columna de
                nombre truncada (max-w-0 w-full truncate —
                2026-08-18: "se sigue escondiendo 3ra columna"): la tabla
                ya no necesita scroll horizontal para mostrar la columna
                de $/unidades, el nombre largo se corta con "…" en vez de
                empujarla fuera de la pantalla. */}
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-[#1A1A1A] text-zinc-400">
                        <tr>
                          <th className="px-3 py-2 font-medium text-left whitespace-nowrap w-10">
                            #
                          </th>
                          <th className="px-3 py-2 font-medium text-left whitespace-nowrap">
                            {topVista === "clientes" ? "Cliente" : "Línea"}
                          </th>
                          <th className="px-3 py-2 font-medium text-right whitespace-nowrap border-l border-zinc-800">
                            {modo === "pesos" ? "Pesos" : "Unidades"}
                            <span className="block text-[11px] font-normal text-zinc-500">
                              {rangoAcumLabel}
                            </span>
                          </th>
                          {/* Mes en curso (2026-09-04) — va aparte
                              del acumulado justamente porque está
                              incompleto: sumarlo adentro haría que el año
                              se compare contra un mes a medio facturar. */}
                          <th className="px-3 py-2 font-medium text-right whitespace-nowrap border-l border-zinc-800 text-yellow-400/80">
                            {/* El título es el TOTAL de la columna — el mismo
                                número que la ÚLTIMA fila del pie, así que no
                                pueden discrepar: neto cuando hay
                                bonificaciones que restar, bruto cuando no —
                                y el mes queda de subtítulo. */}
                            {/* Ícono de info (2026-09-08): el mes en curso
                                sale de datos parciales/ajustados, así que se
                                avisa en el hover que el número es estimativo. */}
                            <span className="inline-flex items-center justify-end gap-1">
                              <span className="tabular-nums">
                                {fmtTop(topSumas.mes + (topAjuste?.mes ?? 0))}
                              </span>
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
                              hasta={Math.min(
                                (gIdx + 1) * GROUP_SIZE,
                                topItems.length,
                              )}
                              total={topItems.length}
                              abierto={topGrupoSeguro === gIdx}
                              onClick={() =>
                                setTopGrupoAbierto(
                                  topGrupoSeguro === gIdx ? -1 : gIdx,
                                )
                              }
                              colSpan={4}
                            />
                          )}
                          {(topGrupos.length <= 1 || topGrupoSeguro === gIdx) &&
                            (topVista === "clientes"
                              ? (grupo as TopCliente[]).map((c, i) => (
                                  <tr
                                    key={c.numero}
                                    className="border-t border-zinc-800/60 hover:bg-zinc-800/30 transition-colors"
                                  >
                                    <td className="px-3 py-2 text-zinc-500 tabular-nums">
                                      {gIdx * GROUP_SIZE + i + 1}
                                    </td>
                                    <td
                                      className="px-3 py-2 text-zinc-100 max-w-0 w-full truncate"
                                      title={c.nombre ?? undefined}
                                    >
                                      <button
                                        type="button"
                                        onClick={() =>
                                          abrirModalCliente({
                                            numero: c.numero,
                                            nombre: c.nombre,
                                          })
                                        }
                                        className="hover:text-yellow-400 hover:underline transition-colors text-left"
                                        title="Ver ventas de este cliente"
                                      >
                                        {c.nombre ?? "(sin nombre)"}
                                      </button>{" "}
                                      {/* <span className="text-zinc-500 font-mono text-xs">
                                        ({c.numero})
                                      </span> */}
                                    </td>
                                    <td className="px-3 py-2 text-right tabular-nums text-yellow-400 font-semibold border-l border-zinc-800 whitespace-nowrap">
                                      {fmtTop(c.monto)}
                                    </td>
                                    <td className="px-3 py-2 text-right tabular-nums text-zinc-300 border-l border-zinc-800 whitespace-nowrap">
                                      {fmtTop(c.montoMes)}
                                    </td>
                                  </tr>
                                ))
                              : // Línea = grupo colapsable (fila en negrita,
                                // no clickeable, con el TOTAL de sus
                                // sub_líneas); Sub_línea = fila clickeable
                                // que abre el modal de clientes (2026-09-15,
                                // catálogo de Postgres — ver fetch_top_lineas).
                                (grupo as TopLinea[]).map((l, i) => (
                                  <Fragment key={l.linea}>
                                    <tr className="border-t border-zinc-800/60 bg-zinc-900/40">
                                      <td className="px-3 py-2 text-zinc-500 tabular-nums">
                                        {gIdx * GROUP_SIZE + i + 1}
                                      </td>
                                      <td
                                        className="px-3 py-2 text-zinc-100 font-semibold max-w-0 w-full truncate"
                                        title={l.linea}
                                      >
                                        {l.linea}
                                      </td>
                                      <td className="px-3 py-2 text-right tabular-nums text-yellow-400 font-semibold border-l border-zinc-800 whitespace-nowrap">
                                        {fmtTop(
                                          topMetricaLineas === "pesos"
                                            ? l.monto
                                            : l.unidades,
                                        )}
                                      </td>
                                      <td className="px-3 py-2 text-right tabular-nums text-zinc-300 border-l border-zinc-800 whitespace-nowrap">
                                        {fmtTop(
                                          topMetricaLineas === "pesos"
                                            ? l.montoMes
                                            : l.unidadesMes,
                                        )}
                                      </td>
                                    </tr>
                                    {l.subLineas.map((sl) => (
                                      <tr
                                        key={`${l.linea}::${sl.subLinea}`}
                                        className="border-t border-zinc-800/30 hover:bg-zinc-800/30 transition-colors"
                                      >
                                        <td className="px-3 py-2" />
                                        <td
                                          className="px-3 py-2 pl-6 text-zinc-300 max-w-0 w-full truncate"
                                          title={sl.subLinea}
                                        >
                                          <button
                                            type="button"
                                            onClick={() => abrirModalSubLinea(sl.subLinea, l.linea)}
                                            className="hover:text-yellow-400 hover:underline transition-colors text-left"
                                            title="Ver clientes que compraron esta sub_línea"
                                          >
                                            {sl.subLinea}
                                          </button>
                                        </td>
                                        <td className="px-3 py-2 text-right tabular-nums text-zinc-200 border-l border-zinc-800 whitespace-nowrap">
                                          {fmtTop(
                                            topMetricaLineas === "pesos"
                                              ? sl.monto
                                              : sl.unidades,
                                          )}
                                        </td>
                                        <td className="px-3 py-2 text-right tabular-nums text-zinc-400 border-l border-zinc-800 whitespace-nowrap">
                                          {fmtTop(
                                            topMetricaLineas === "pesos"
                                              ? sl.montoMes
                                              : sl.unidadesMes,
                                          )}
                                        </td>
                                      </tr>
                                    ))}
                                  </Fragment>
                                )))}
                        </tbody>
                      ))}
                      {/* Totales (2026-09-04). Suman TODAS las
                          filas del ranking, estén o no en el grupo abierto
                          del acordeón — es el total del período, no el de
                          lo que hay a la vista. */}
                      <tfoot className="bg-[#1A1A1A] border-t-2 border-zinc-700">
                        {/* Sin ajuste (vista por unidades, o rango sin notas
                            de crédito) el pie es una sola fila y dice
                            "Total", como siempre. Con ajuste se abre en
                            bruto → ajuste → neto. */}
                        <tr>
                          <td className="px-3 py-2" />
                          <td
                            className={`px-3 py-2 whitespace-nowrap ${
                              topAjuste
                                ? "font-medium text-zinc-400"
                                : "font-semibold text-zinc-300"
                            }`}
                          >
                            {topAjuste ? "Venta bruta" : "Total"}{" "}
                            <span className="text-zinc-500 font-normal">
                              ({topItems.length}{" "}
                              {topVista === "clientes" ? "clientes" : "líneas"})
                            </span>
                          </td>
                          <td
                            className={`px-3 py-2 text-right tabular-nums border-l border-zinc-800 whitespace-nowrap ${
                              topAjuste
                                ? "text-zinc-300"
                                : "text-yellow-400 font-bold"
                            }`}
                          >
                            {fmtTop(topSumas.acum)}
                          </td>
                          <td
                            className={`px-3 py-2 text-right tabular-nums border-l border-zinc-800 whitespace-nowrap ${
                              topAjuste
                                ? "text-zinc-300"
                                : "text-yellow-400 font-bold"
                            }`}
                          >
                            {fmtTop(topSumas.mes)}
                          </td>
                        </tr>
                        {topAjusteIncluido && (
                          <tr className="text-[11px]">
                            <td className="px-3 py-1.5" />
                            <td
                              className="px-3 py-1.5 text-zinc-500 whitespace-nowrap"
                              title="Notas de crédito por concepto (bonificación, bonificación fuera de recibo, crédito interno) y ajustes de saldo. No tienen artículo: se imputan al cliente, no a una línea. Ya están restados en cada fila y en el total."
                            >
                              Incluye bonificaciones y ajustes
                            </td>
                            <td className="px-3 py-1.5 text-right tabular-nums text-red-400/80 border-l border-zinc-800 whitespace-nowrap">
                              {fmtTop(topAjusteIncluido.acum)}
                            </td>
                            <td className="px-3 py-1.5 text-right tabular-nums text-red-400/80 border-l border-zinc-800 whitespace-nowrap">
                              {fmtTop(topAjusteIncluido.mes)}
                            </td>
                          </tr>
                        )}
                        {topAjuste && (
                          <>
                            <tr>
                              <td className="px-3 py-2" />
                              <td
                                className="px-3 py-2 font-medium text-zinc-400 whitespace-nowrap"
                                title="Notas de crédito por concepto (bonificación, bonificación fuera de recibo, crédito interno) y ajustes de saldo. No tienen artículo, así que no figuran en ninguna fila del ranking."
                              >
                                Bonificaciones y ajustes
                              </td>
                              <td className="px-3 py-2 text-right tabular-nums text-red-400 border-l border-zinc-800 whitespace-nowrap">
                                {fmtTop(topAjuste.acum)}
                              </td>
                              <td className="px-3 py-2 text-right tabular-nums text-red-400 border-l border-zinc-800 whitespace-nowrap">
                                {fmtTop(topAjuste.mes)}
                              </td>
                            </tr>
                            <tr className="border-t border-zinc-700">
                              <td className="px-3 py-2" />
                              <td className="px-3 py-2 font-semibold text-zinc-300 whitespace-nowrap">
                                Venta neta
                              </td>
                              <td className="px-3 py-2 text-right tabular-nums text-yellow-400 font-bold border-l border-zinc-800 whitespace-nowrap">
                                {fmtTop(topSumas.acum + topAjuste.acum)}
                              </td>
                              <td className="px-3 py-2 text-right tabular-nums text-yellow-400 font-bold border-l border-zinc-800 whitespace-nowrap">
                                {fmtTop(topSumas.mes + topAjuste.mes)}
                              </td>
                            </tr>
                          </>
                        )}
                      </tfoot>
                    </table>
                  </div>
                </>
              );
            })()}
          </div>
        )}
      </main>
    </div>
  );
}
