import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { esCancelado } from "@/lib/compras/faltantesMes";

const API_URL =
  process.env.INDICADORES_API_URL ?? "http://indicadores-api:8001";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// ──────────────────────────────────────────────────────────────────────────────
// /compras/faltantes — datos por (artículo, día) con consumo de OC por día.
//
//   1. Faltantes (Magnus): sin params = último snapshot; con ?desde&hasta = todos
//      los snapshots del rango, deduplicados por renglón, cada uno con PrimerDia
//      (primera aparición) y solo lo que sigue pendiente en la foto más nueva.
//   2. Se filtra a lo marcado "sin existencia" (preparado.faltante_existencia,
//      última marca por renglón).
//   3. Se agrupa por (artículo, PrimerDia) → "lo nuevo de cada día" sin doble
//      contar (cada renglón cuenta una sola vez, en su día de aparición).
//   4. Por artículo, "faltan" (lo que se MUESTRA) se ACUMULA día a día y NUNCA
//      se resetea ni se le resta la OC/stock: faltan[día] = faltan[día-1] +
//      nuevoDelDia, bruto, siempre (pedido 2026-07-28 — antes se
//      pisaba a 0 el día que la cobertura alcanzaba, y la vista dejaba de
//      mostrar el acumulado real). Aparte, y SOLO para decidir el color de
//      fondo de la fila (estado), se calcula una cobertura interna contra DOS
//      fuentes en VIVO (no estimaciones, no la fecha manual de "Arribo"): la
//      OC "por llegar" (Magnus, ya neta de lo recibido) y el stock físico real
//      del depósito 1 (WMS, ver /deposito/stock-por-articulos). Esa cobertura
//      interna sí se resetea a 0 cuando esas dos fuentes juntas alcanzan a
//      cubrir todo lo acumulado (no arrastra sobrante a favor para el próximo
//      ciclo) — pero ese reset queda en una variable aparte, nunca toca
//      "faltan" ni "ocTotal" (los dos siguen mostrándose tal cual, sin restar
//      uno del otro). Si no alcanzan, el descubierto real sigue acumulando
//      tal cual.
//   4b. Color/visibilidad de cada bucket "vivo" (2026-07-27, 4 casos, en orden):
//      · stock SOLO (sin la OC) ya cubre el acumulado → NO es problema de
//        compras: el bucket se EXCLUYE de la respuesta (desaparece de toda
//        la vista, ver resueltoPorStock). Desde 2026-08-28 alcanza con que
//        lo haya cubierto EN ALGÚN MOMENTO: se compara contra la marca de
//        agua del stock (preparado.faltante_stock_max, punto 3c/5b), no
//        contra el stock de este instante — si la mercadería entró y después
//        se vendió, el artículo ya quedó cubierto y no vuelve a la tabla.
//      · si no, pero OC+stock juntos cubren todo (descubierto=0) → estado
//        "completo", SE MUESTRA en verde (antes también se ocultaba; ahora
//        solo se oculta el caso de arriba, resuelto por stock puro).
//      · si no, y hay algo de OC pendiente (cub>0) → "incompleto", rojo.
//      · si no hay OC en absoluto → "sin_orden", SIN COLOR (antes rojo).
//      El histórico "entregado" no pasa por ninguna de estas reglas (tiene
//      su propio verde, fijo).
//   5. Se persiste el consumo por día en preparado.faltante_oc_consumo
//      (best-effort: si la tabla no está creada aún, la vista igual funciona).
// ──────────────────────────────────────────────────────────────────────────────

interface FaltRow {
  NroPedOrigen: number;
  NroRengOrigen: number;
  CodArticulo: string;
  Nombre: string;
  CantPend: number;
  Importe: number;
  Linea: string | number | null;
  Proveedor: string | null;
  Cliente: string | number | null;
  ClienteNombre: string | null;
  Fecha: string | null; // snapshot más nuevo del renglón en el rango
  PrimerDia: string | null; // primera aparición en el rango
  Vivo?: number; // 1 = sigue pendiente; 0 = histórico ya entregado/cubierto
  EstadoPedido?: string | null; // Pedido_Estados de Magnus (deposito.py); ausente si indicadores-api es viejo
  TipoArticulo?: string | null; // "Nacional"/"Importado"/"Fabrica" (StkFer_Articulos.NacionalImportado, Magnus) o "" si no está cargado
}
// Lote = una OC puntual dentro del artículo (indicadores-api/compras.py,
// fetch_ordenes_pendientes). Se usa para elegir, por cada BUCKET (artículo +
// día del faltante), solo la OC hecha DESPUÉS de que ese faltante apareció —
// ver fechaEntregaParaBucket más abajo. Los campos de arriba (FechaEntrega/
// FechaOC/PorLlegar) siguen siendo el pool agregado de TODAS las OC
// pendientes juntas, sin filtrar por fecha — se usan igual que antes para
// ocTotal/cub/desc (la cantidad neta no distingue de qué OC viene).
interface OcLote {
  FechaOC: string | null;
  FechaEntrega: string | null;
  Importacion?: boolean;
}
interface OcRow {
  CodArticulo: string;
  PorLlegar: number;
  Proveedor: string | null;
  FechaEntrega: string | null;
  FechaOC: string | null; // fecha de la OC (FecMovim), más temprana — fallback para importación (ver fechaOC en Bucket)
  Importacion: boolean;
  NroOCs: string[];
  Lotes?: OcLote[];
}
// Remitos de ingreso de mercadería del período (indicadores-api
// /compras/ingresos), agregados por artículo. Desde 2026-09-03 entran TODOS
// los tipos de comprobante de ingreso (59/60/61/160/590), no solo los ligados
// a una OC — ver indicadores-api/ingresos.py.
interface IngRow {
  CodArticulo: string;
  CantidadIngresada: number;
  FechaUltimoIngreso: string | null;
  NroRemitos?: string[];
  Remitos?: { nro: string; fecha: string; cant: number; cod: string | null; prov: string | null }[];
}
type Estado = "completo" | "incompleto" | "sin_orden" | "entregado";

interface Bucket {
  CodArticulo: string;
  Nombre: string;
  Linea: string | number | null;
  Proveedor: string | null;
  clientes: Map<string, { nombre: string | null; cant: number; importe: number }>;
  fecha: string; // PrimerDia (día del faltante)
  vivo: boolean; // false = histórico ya entregado/cubierto
  faltan: number; // acumulado BRUTO (ver punto 4 más abajo), nunca se resetea ni se le resta OC/stock
  nuevoDelDia: number; // lo que aportó puntualmente este día (sin acumular)
  importe: number;
  renglones: number;
  renglonesConArribo: number; // cuántos de los renglones ya tienen fechaArribo
  fechaArriboMin: string | null; // más vieja cargada entre esos renglones
  pedidos: Set<number>;
  cubierto: number;
  descubierto: number;
  ocTotal: number;
  fechaEntrega: string | null;
  fechaOC: string | null; // fecha de la OC (FecMovim) más temprana — fallback para importación, ver fechaEntrega
  importacion: boolean;
  tipoArticulo: string | null; // "Nacional"/"Importado"/"Fabrica" (Magnus, StkFer_Articulos.NacionalImportado) — ver clasificación Importados/Nacionales en el front
  ocs: string[];
  estado: Estado;
  stock: number; // existencia real en depósito 1 (WMS, en vivo) — ver /deposito/stock
  resueltoPorStock: boolean; // el STOCK SOLO (sin la OC) ya cubre todo el acumulado — se excluye de la respuesta (ver punto 4b), no llega al front
  yaCubierto: boolean; // en alguna corrida anterior el stock ya cubrió este día (preparado.faltante_stock_max) — se excluye para siempre
}

// Marca extraordinario/comprar por (fecha, artículo, CLIENTE) — ver
// preparado.faltante_extraordinario (sql/compras_faltante_extraordinario.sql).
// Reemplaza la marca vieja por artículo entero (2026-09-16): un pedido
// extraordinario es de UN cliente puntual, no del artículo.
interface ExtraMark {
  codCliente: string;
  clienteNombre: string | null;
  cantidad: number | null; // null = todo lo pendiente del cliente en el bucket
  comprar: boolean | null;
}
// Fila que se devuelve aparte (`extraordinarios`, no en `rows`): la porción
// de un bucket (artículo+día) que un cliente puntual pidió de más, ya
// restada del faltante "normal" que sigue su compra habitual.
interface ExtraOut {
  CodArticulo: string;
  Nombre: string;
  Linea: string | number | null;
  Proveedor: string | null;
  tipoArticulo: string | null;
  fecha: string;
  codCliente: string;
  clienteNombre: string | null;
  cantidad: number; // cuánto de lo pedido por ese cliente quedó marcado extraordinario
  importe: number; // proporcional a cantidad dentro de lo que pidió ese cliente en el bucket
  stock: number; // existencia real del artículo (contexto, no exclusivo de este cliente)
  comprar: boolean | null;
}

const keyLine = (p: number, r: number) => `${p}-${r}`;
// Clave para cruzar contra faltante_existencia (fuente WMS ot-diferencias):
// NroRengOrigen ahí es OTItemNroRenglon (numeración WMS), distinta del renglón
// real de Ven_PedRenPendientes que trae `faltRows` (fetch_faltantes viejo,
// Magnus) — mismo nombre de campo, otra numeración. NroPedOrigen (=NroMovVenta)
// sí coincide en ambas fuentes, así que se cruza por pedido+artículo (trimeado).
// Bug real encontrado 2026-07-10 (mismo que /api/ventas/faltantes): con
// keyLine (por renglón) los "en existencia" marcados en /deposito/faltantes no
// aparecían del lado de ventas/compras.
const keyArt = (p: number, cod: string) => `${p}-${cod.trim()}`;
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

// Fecha de corte del cruce: el FIFO arranca acá. Solo se consideran las OC hechas
// desde esta fecha y los faltantes que aparecen desde esta fecha, así una OC nueva
// no se "gasta" cubriendo faltantes viejos (de hace años). Override: ?ocDesde=YYYY-MM-DD.
const OC_DESDE_DEFAULT = "2026-06-26";

async function getJson(url: string) {
  const res = await fetch(url, {
    cache: "no-store",
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const desdeParam = sp.get("desde");
  const hastaParam = sp.get("hasta");
  // (?historico= ya no se usa: siempre se pide histórico, ver qs más abajo)
  // conArribo: por defecto oculta los buckets que ya tienen fecha de arribo
  // cargada (preparado.faltante_control) en TODOS sus renglones; con
  // conArribo=1 los vuelve a mostrar (para corroborar los que ya se pasaron).
  const conArribo = sp.get("conArribo") === "1" || sp.get("conArribo") === "true";
  // corte del cruce (faltantes y OC se anclan acá). Override opcional ?ocDesde=
  const ocDesde = sp.get("ocDesde") || OC_DESDE_DEFAULT;
  // La OC del 26 cubre faltantes del 25 en adelante → corte de faltantes = 1 día antes.
  const addDays = (iso: string, n: number) => {
    const d = new Date(iso + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const faltDesde = sp.get("faltDesde") || addDays(ocDesde, -1);

  const qs = new URLSearchParams();
  if (desdeParam) qs.set("desde", desdeParam);
  if (hastaParam) qs.set("hasta", hastaParam);
  // SIEMPRE histórico: los renglones faltantes salen de Ven_PedRenPendientes
  // apenas se factura el pedido (viven ~1 snapshot). Sin histórico, la variante
  // "viva" exige estar en la última foto y se pierden los faltantes de días
  // anteriores. Lo marcado "sin existencia" es demanda vigente siempre (ver
  // agrupado, punto 3) — el param ?historico= del front quedó sin efecto.
  qs.set("historico", "1");
  const faltUrl = `${API_URL}/deposito/faltantes${qs.toString() ? `?${qs}` : ""}`;
  // fabril=1: incluye las OC de producción interna (PRODUCCION HIDRAULICA /
  // FUNDICION). Lo manda solo /fabrica/faltantes (ver app/api/fabrica/
  // faltantes/route.ts); en compras/ventas esas OC no son compra y quedan
  // afuera, igual que los presupuestos genéricos (P.INDUSTRIA / P.MKT), que
  // no entran nunca (indicadores-api/compras.py, _cond_tipo).
  const fabril = sp.get("fabril") === "1";
  const ocUrl =
    `${API_URL}/compras/ordenes-pendientes?desde=${encodeURIComponent(ocDesde)}` +
    (fabril ? "&fabril=1" : "");

  // Ingresos (remitos) del período: desde el ancla del cruce (faltDesde) hasta
  // el fin del rango consultado — con el rango puesto en un mes cerrado, el
  // total por artículo cierra con el reporte de remitos de ese mes. Sin
  // `hasta`, llega hasta hoy.
  const ingUrl =
    `${API_URL}/compras/ingresos?desde=${encodeURIComponent(faltDesde)}` +
    (hastaParam ? `&hasta=${encodeURIComponent(hastaParam)}` : "");

  // 1) faltantes (obligatorio) + OC e ingresos (best-effort) en paralelo
  const [faltRes, ocRes, ingRes] = await Promise.allSettled([
    getJson(faltUrl),
    getJson(ocUrl),
    getJson(ingUrl),
  ]);

  if (faltRes.status !== "fulfilled") {
    return NextResponse.json(
      { error: "No se pudo leer faltantes", detail: String(faltRes.reason) },
      { status: 503 },
    );
  }
  const faltJson = faltRes.value;
  const fecha: string | null = faltJson.fecha ?? null;
  // Universo del cruce: solo faltantes que aparecen (PrimerDia) desde el corte.
  // Así el FIFO no arrastra faltantes viejos que la OC nueva no debería cubrir.
  // Fuera los renglones de pedidos CANCELADOS (o sin estado = pedido que ya no
  // está en Magnus): no son demanda, y dejaban al cliente de ese pedido en la
  // columna "Cliente" y su cantidad sumada al bucket. Mismo criterio que el
  // recorte del mes (lib/compras/faltantesMes.ts, esCancelado). Solo se aplica
  // si indicadores-api manda la columna EstadoPedido; sin ella no se filtra.
  const rawRows: FaltRow[] = faltJson.rows ?? [];
  const hayEstadoPedido = rawRows.some((it) => it && "EstadoPedido" in it);
  const faltRows: FaltRow[] = rawRows.filter((it: FaltRow) => {
    if (hayEstadoPedido && esCancelado(it.EstadoPedido)) return false;
    const dia = it.PrimerDia ?? it.Fecha ?? fecha;
    return !dia || dia >= faltDesde;
  });

  let ocWarn = false;
  const ocMap = new Map<string, OcRow>();
  if (ocRes.status === "fulfilled") {
    for (const r of (ocRes.value.rows ?? []) as OcRow[]) {
      const cod = String(r.CodArticulo ?? "").trim();
      if (cod) ocMap.set(cod, r);
    }
  } else {
    ocWarn = true;
  }

  // Ingresos por artículo (cantidad + remitos). Es un total del PERÍODO, por
  // artículo: se repite igual en todos los días (buckets) de ese artículo, no
  // se imputa día por día.
  let ingresoWarn = false;
  let comprobanteWarn = false;
  const ingMap = new Map<
    string,
    { cant: number; ultimo: string | null; remitos: { nro: string; fecha: string; cant: number }[] }
  >();
  if (ingRes.status === "fulfilled") {
    comprobanteWarn = ingRes.value?.comprobanteWarn === true;
    for (const r of (ingRes.value.rows ?? []) as IngRow[]) {
      const cod = String(r.CodArticulo ?? "").trim();
      if (!cod) continue;
      const det = (r.Remitos ?? []).map((d) => ({
        nro: String(d.nro ?? ""),
        fecha: String(d.fecha ?? ""),
        cant: Number(d.cant) || 0,
      }));
      ingMap.set(cod, {
        cant: Number(r.CantidadIngresada) || 0,
        ultimo: r.FechaUltimoIngreso ?? null,
        remitos: det.length
          ? det
          : (r.NroRemitos ?? []).map((n) => ({ nro: String(n), fecha: "", cant: 0 })),
      });
    }
  } else {
    ingresoWarn = true;
    console.error("GET /api/compras/faltantes-consumo — ingresos", ingRes.reason);
  }

  // rango efectivo (de las filas) para acotar la lectura de marcas
  let minPrimer: string | null = null;
  let maxFecha: string | null = null;
  for (const r of faltRows) {
    if (r.PrimerDia && (!minPrimer || r.PrimerDia < minPrimer)) minPrimer = r.PrimerDia;
    if (r.Fecha && (!maxFecha || r.Fecha > maxFecha)) maxFecha = r.Fecha;
  }

  // 2) marcas existencia=false (última marca por renglón).
  // OJO: la ventana arranca en el ANCLA (faltDesde), NO en minPrimer del rango
  // visible: un renglón que sigue pendiente hoy pudo marcarse "sin existencia"
  // días atrás (la marca se guarda con la fecha de aquel snapshot). Con rango
  // default hoy–hoy, minPrimer = ayer y esas marcas viejas quedaban afuera →
  // la vista aparecía vacía aunque los faltantes siguieran vivos.
  const sinExistencia = new Set<string>();
  const desdeMarks = faltDesde < (minPrimer ?? faltDesde) ? faltDesde : (minPrimer ?? faltDesde);
  const hastaMarks = maxFecha ?? fecha;
  if (faltRows.length && desdeMarks && hastaMarks) {
    // new Date('YYYY-MM-DD') = medianoche UTC, igual que se guardan las marcas (@db.Date)
    const marks = await prisma.faltante_existencia.findMany({
      where: { fecha: { gte: new Date(desdeMarks), lte: new Date(hastaMarks) } },
      select: { nroPedOrigen: true, codArticulo: true, existencia: true, fecha: true },
      orderBy: { fecha: "asc" },
    });
    const latest = new Map<string, boolean>();
    for (const m of marks)
      latest.set(keyArt(m.nroPedOrigen, m.codArticulo ?? ""), m.existencia);
    for (const [k, ex] of latest) if (ex === false) sinExistencia.add(k);
  }

  // 2c) fechaArribo por renglón (preparado.faltante_control), para poder
  // ocultar de esta vista lo que ya está cargado (ver conArribo). Igual que
  // sinExistencia: NO se filtra por la columna "fecha" de faltante_control —
  // ver nota en lib/faltantesArribo.ts sobre por qué esa columna es otra
  // fecha (el snapshot vigente AL MOMENTO de cargar el Arribo, no el
  // PrimerDia del bucket). Antes acotaba con WHERE fecha BETWEEN
  // desdeMarks/hastaMarks: un bucket viejo (PrimerDia de hace semanas, caso
  // típico acá porque "faltan" es acumulado) puede haber guardado su Arribo
  // con una "fecha" fuera de esa ventana y quedaba afuera — mismo bug que
  // /api/ventas/faltantes (ver ctrlPorArt ahí).
  //
  // Match primario por renglón (nroPedOrigen+nroRengOrigen) y fallback por
  // (nroPedOrigen+CodArticulo) — arriboPorRenglonArt — para el caso en que
  // Ven_PedRenPendientes renumeró el renglón pendiente entre la carga en
  // /compras/faltantes y esta lectura (pedidos con varias líneas). Mismo
  // patrón que keyArt ya usa acá para sinExistencia.
  const arriboPorRenglon = new Map<string, string | null>();
  const arriboPorRenglonArt = new Map<string, string | null>();
  if (faltRows.length) {
    try {
      const ctrlRows = await prisma.$queryRaw<
        {
          nroPedOrigen: number;
          nroRengOrigen: number;
          codArticulo: string | null;
          fechaArribo: string | null;
        }[]
      >`
        SELECT "nroPedOrigen", "nroRengOrigen", "codArticulo",
               to_char("fechaArribo", 'YYYY-MM-DD') AS "fechaArribo"
        FROM preparado.faltante_control
        ORDER BY "updatedAt" ASC
      `;
      for (const r of ctrlRows) {
        if (!r.fechaArribo) continue;
        arriboPorRenglon.set(keyLine(r.nroPedOrigen, r.nroRengOrigen), r.fechaArribo);
        const cod = (r.codArticulo ?? "").trim();
        if (cod) arriboPorRenglonArt.set(keyArt(r.nroPedOrigen, cod), r.fechaArribo);
      }
    } catch (e) {
      console.error("read faltante_control (arribo)", e);
    }
  }

  // 2b) marcas extraordinario/comprar por (fecha, artículo, CLIENTE) —
  // best-effort: si la tabla no está creada aún (sql/compras_faltante_
  // extraordinario.sql sin aplicar), la vista sigue funcionando sin marcas.
  const keyArtDia = (cod: string, dia: string) => `${cod}__${dia}`;
  const keyArtCliente = (cod: string, cliente: string) => `${cod}__${cliente}`;
  // exact-match por (artículo, día, cliente): varios clientes pueden tener
  // marca en el MISMO bucket, por eso el valor es un array.
  const extraMap = new Map<string, ExtraMark[]>();
  // marca más nueva por (artículo, cliente) — fallback cuando el día del
  // bucket "rodó" y ya no coincide con la fecha guardada (mismo criterio que
  // ya usaba la versión por artículo entero).
  const extraUltPorArtCliente = new Map<string, ExtraMark>();
  let extraWarn = false;
  if (faltRows.length && desdeMarks && hastaMarks) {
    try {
      const extraRows = await prisma.$queryRaw<
        {
          fecha: Date;
          codArticulo: string;
          codCliente: string;
          clienteNombre: string | null;
          cantidad: number | null;
          extraordinario: boolean;
          comprar: boolean | null;
        }[]
      >`
        SELECT fecha, "codArticulo", "codCliente", "clienteNombre", cantidad, extraordinario, comprar
        FROM preparado.faltante_extraordinario
        WHERE fecha BETWEEN ${new Date(desdeMarks)} AND ${new Date(hastaMarks)}
        ORDER BY "updatedAt" ASC
      `;
      for (const e of extraRows) {
        if (!e.extraordinario) continue;
        const dia = e.fecha.toISOString().slice(0, 10);
        const cliente = (e.codCliente ?? "").trim();
        if (!cliente) continue; // fila legado (marca vieja por artículo entero) — sin cliente no hay con qué cruzar
        const val: ExtraMark = {
          codCliente: cliente,
          clienteNombre: e.clienteNombre,
          cantidad: e.cantidad === null ? null : Number(e.cantidad),
          comprar: e.comprar === null ? null : !!e.comprar,
        };
        const kDia = keyArtDia(e.codArticulo, dia);
        const arr = extraMap.get(kDia) ?? [];
        arr.push(val);
        extraMap.set(kDia, arr);
        extraUltPorArtCliente.set(keyArtCliente(e.codArticulo, cliente), val); // asc → queda la más nueva
      }
    } catch (e) {
      extraWarn = true;
      console.error("read faltante_extraordinario", e);
    }
  }

  // 2d) marcas "descartar" por (fecha, artículo) — igual criterio que extraMap
  // (match exacto + fallback a la más nueva del artículo, porque el día del
  // bucket "rueda" según el rango consultado). Best-effort: si la tabla no
  // está creada aún (prisma/sql/faltante_descartado.sql sin aplicar), la vista
  // sigue funcionando sin descartar nada. NO borra ninguna fila de ninguna
  // tabla: solo se usa para excluir el bucket de la respuesta (ver filtro más
  // abajo), por eso no aparece en ninguna tabla de la vista (principal,
  // agrupada por proveedor ni extraordinarios).
  const descartMap = new Map<string, boolean>();
  const descartUltPorArt = new Map<string, boolean>();
  let descartWarn = false;
  if (faltRows.length && desdeMarks && hastaMarks) {
    try {
      const descartRows = await prisma.$queryRaw<
        { fecha: Date; codArticulo: string; descartado: boolean }[]
      >`
        SELECT fecha, "codArticulo", descartado
        FROM preparado.faltante_descartado
        WHERE fecha BETWEEN ${new Date(desdeMarks)} AND ${new Date(hastaMarks)}
        ORDER BY "updatedAt" ASC
      `;
      for (const d of descartRows) {
        const dia = d.fecha.toISOString().slice(0, 10);
        const val = !!d.descartado;
        descartMap.set(keyArtDia(d.codArticulo, dia), val);
        descartUltPorArt.set(d.codArticulo, val); // asc → queda la más nueva
      }
    } catch (e) {
      descartWarn = true;
      console.error("read faltante_descartado", e);
    }
  }

  // 3) agrupar lo "sin existencia" por (artículo, primer día)
  const buckets = new Map<string, Bucket>();
  for (const it of faltRows) {
    const cod = String(it.CodArticulo ?? "").trim();
    if (!sinExistencia.has(keyArt(it.NroPedOrigen, cod))) continue;
    const dia = it.PrimerDia ?? it.Fecha ?? fecha ?? "";
    if (!cod || !dia) continue;
    // Todo renglón MARCADO "sin existencia" es demanda vigente aunque Vivo=0:
    // que haya salido de Ven_PedRenPendientes solo significa que el pedido se
    // facturó (sin el artículo), no que el faltante se haya resuelto. Sale del
    // circuito por OC que cubre / fechaArribo / extraordinario, no por Magnus.
    const vivo = true;
    const k = `${cod}__${dia}__v`;
    let b = buckets.get(k);
    if (!b) {
      b = {
        CodArticulo: cod,
        Nombre: it.Nombre,
        Linea: it.Linea ?? null,
        Proveedor: it.Proveedor,
        clientes: new Map(),
        fecha: dia,
        vivo,
        faltan: 0,
        nuevoDelDia: 0,
        importe: 0,
        renglones: 0,
        renglonesConArribo: 0,
        fechaArriboMin: null,
        pedidos: new Set<number>(),
        cubierto: 0,
        descubierto: 0,
        ocTotal: 0,
        fechaEntrega: null,
        fechaOC: null,
        importacion: false,
        tipoArticulo: (it.TipoArticulo || "").trim() || null,
        ocs: [],
        estado: "sin_orden",
        stock: 0,
        resueltoPorStock: false,
        yaCubierto: false,
      };
      buckets.set(k, b);
    }
    b.faltan += it.CantPend || 0;
    b.nuevoDelDia += it.CantPend || 0;
    b.importe += it.Importe || 0;
    b.renglones += 1;
    b.pedidos.add(it.NroPedOrigen);
    const codCli = it.Cliente != null && it.Cliente !== "" ? String(it.Cliente) : null;
    if (codCli) {
      const prevCli = b.clientes.get(codCli);
      if (prevCli) {
        prevCli.cant += it.CantPend || 0;
        prevCli.importe += it.Importe || 0;
      } else {
        b.clientes.set(codCli, {
          nombre: it.ClienteNombre ?? null,
          cant: it.CantPend || 0,
          importe: it.Importe || 0,
        });
      }
    }
    const arribo =
      arriboPorRenglon.get(keyLine(it.NroPedOrigen, it.NroRengOrigen)) ??
      arriboPorRenglonArt.get(keyArt(it.NroPedOrigen, cod));
    if (arribo) {
      b.renglonesConArribo += 1;
      if (!b.fechaArriboMin || arribo < b.fechaArriboMin) b.fechaArriboMin = arribo;
    }
    if (!b.Proveedor && it.Proveedor) b.Proveedor = it.Proveedor;
    if (!b.tipoArticulo && it.TipoArticulo) b.tipoArticulo = it.TipoArticulo.trim() || null;
    if ((b.Linea === null || b.Linea === "") && it.Linea != null && it.Linea !== "")
      b.Linea = it.Linea;
  }

  // 3d) Separar del bucket la cantidad marcada "extraordinaria" de cada
  // cliente (preparado.faltante_extraordinario, ver punto 2b). Un pedido
  // extraordinario es de UN cliente puntual que pidió mucho más de lo
  // habitual — la compra normal del artículo debe seguir cubriendo al RESTO
  // de los clientes, así que acá se resta esa cantidad del bucket ANTES de
  // acumular (punto 4): "faltan"/"nuevoDelDia" del bucket quedan con la
  // demanda normal solamente, y la porción extraordinaria sale aparte en
  // `extraordinariosOut` (no vuelve a `rows`). Se aplica sin importar si
  // "comprar" ya se decidió o sigue pendiente: mientras la marca exista, esa
  // cantidad no cuenta para la reposición normal del artículo.
  const extraordinariosOut: ExtraOut[] = [];
  for (const b of buckets.values()) {
    if (!b.clientes.size) continue;
    const marks = extraMap.get(keyArtDia(b.CodArticulo, b.fecha)) ?? [];
    // Un cliente puede tener marca exacta (mismo día) o, si el día del bucket
    // "rodó", la más nueva que se le conoce en ese artículo.
    const vistos = new Set(marks.map((m) => m.codCliente));
    const candidatos: ExtraMark[] = [...marks];
    for (const codCli of b.clientes.keys()) {
      if (vistos.has(codCli)) continue;
      const ult = extraUltPorArtCliente.get(keyArtCliente(b.CodArticulo, codCli));
      if (ult) candidatos.push(ult);
    }
    for (const mark of candidatos) {
      const cliEntry = b.clientes.get(mark.codCliente);
      if (!cliEntry || cliEntry.cant <= 0) continue;
      const qty = r2(Math.min(mark.cantidad ?? cliEntry.cant, cliEntry.cant));
      if (qty <= 0) continue;
      const importeProp = cliEntry.cant > 0 ? r2((cliEntry.importe * qty) / cliEntry.cant) : 0;
      extraordinariosOut.push({
        CodArticulo: b.CodArticulo,
        Nombre: b.Nombre,
        Linea: b.Linea,
        Proveedor: b.Proveedor,
        tipoArticulo: b.tipoArticulo,
        fecha: b.fecha,
        codCliente: mark.codCliente,
        clienteNombre: mark.clienteNombre ?? cliEntry.nombre,
        cantidad: qty,
        importe: importeProp,
        stock: 0, // se completa más abajo, una vez que se lee el stock real (punto 3b)
        comprar: mark.comprar,
      });
      b.faltan = r2(b.faltan - qty);
      b.nuevoDelDia = r2(b.nuevoDelDia - qty);
      b.importe = r2(b.importe - importeProp);
      cliEntry.cant = r2(cliEntry.cant - qty);
      cliEntry.importe = r2(cliEntry.importe - importeProp);
      if (cliEntry.cant <= 0) b.clientes.delete(mark.codCliente);
    }
  }

  // 4) por artículo: acumular el faltante día a día y NUNCA resetearlo ni
  //    restarle la OC/stock en lo que se muestra (b.faltan) — eso se compara
  //    aparte, en una cobertura interna, solo para decidir estado/color.
  //
  //    · faltan (por día, MOSTRADO) = acumulado bruto de todo lo que sigue sin
  //      existencia hasta ESE día (faltanAcum[día] = faltanAcum[día-1] +
  //      nuevoDelDia), SIEMPRE, sin excepción — nunca se pisa a 0 aunque la OC
  //      o el stock ya lo cubran (pedido 2026-07-28).
  //    · Para el ESTADO (color de fondo) se calcula, aparte, una cobertura
  //      interna: la OC cubre el acumulado primero (cubierto = min(acumulado,
  //      ocTotal)); lo que la OC no llega a cubrir, se neta contra el stock
  //      físico actual.
  //    · Cualquier día que esa cobertura interna (OC + stock) llegue a cubrir
  //      TODO el acumulado, esa cobertura (no "faltan") se descarta: no se
  //      arrastra sobrante a favor del próximo ciclo, vuelve a foja cero para
  //      el cálculo de estado (antes esto solo pasaba el día EXACTO de
  //      "fechaEntrega"; ahora aplica cualquier día, sea por OC, por stock, o
  //      la suma de ambos). Si no alcanza, el descubierto real NO se resetea:
  //      sigue acumulando hasta que se cubra de verdad.
  //    · Un artículo que quedó en 0 (cubierto de verdad): si necesitó la OC
  //      para llegar a 0 (el stock solo no alcanzaba), NO se excluye — se
  //      manda con estado "completo" (fondo verde) para que quede a la vista
  //      que se resolvió. Si en cambio el STOCK SOLO ya alcanzaba (la OC no
  //      hizo falta), SÍ se excluye (ver resueltoPorStock/punto 4b): no es un
  //      problema de compras, desaparece de la vista. La fecha manual de
  //      "Arribo" NO interviene en ninguno de los dos casos, solo la
  //      cobertura real (OC/stock en vivo).
  //    · ocTotal (para cub/desc/estado) sigue siendo el pool agregado de
  //      TODAS las OC pendientes del artículo, sin filtrar por fecha — la
  //      cantidad neta no distingue de qué OC viene. La fecha MOSTRADA
  //      (fechaEntrega/fechaOC del bucket) es otra historia: hasta
  //      2026-09-16 tomaba la más temprana de CUALQUIER OC pendiente del
  //      artículo, así que una OC vieja con saldo suelto (de antes de este
  //      faltante puntual) podía prestarle una fecha ya vencida a un
  //      faltante que apareció después. Ahora, por bucket, se filtra a las
  //      OC (`oc.Lotes`, indicadores-api/compras.py) hechas DESPUÉS del
  //      PrimerDia de ese bucket y se toma la más temprana de esas — ver
  //      mejorLoteParaFecha más abajo.
  const porArt = new Map<string, Bucket[]>();
  for (const b of buckets.values()) {
    const arr = porArt.get(b.CodArticulo) ?? [];
    arr.push(b);
    porArt.set(b.CodArticulo, arr);
  }

  // 3b) stock real del depósito 1 (WMS, en vivo) para los artículos en pantalla
  // (mismo dato que /deposito/stock). Si ya está físicamente en depósito, el
  // faltante se puede dar por cubierto sin esperar una OC — ver más abajo.
  // Best-effort: si el servicio no responde, sigue funcionando con stock=0
  // (se comporta igual que antes de este cambio).
  let stockWarn = false;
  const stockMap = new Map<string, number>();
  const codigosUnicos = [...porArt.keys()];
  if (codigosUnicos.length) {
    try {
      const stockUrl = `${API_URL}/deposito/stock-por-articulos?codigos=${encodeURIComponent(codigosUnicos.join(","))}`;
      const stockJson = await getJson(stockUrl);
      for (const r of (stockJson.rows ?? []) as { CodArticulo: string; Stock: number }[]) {
        const cod = String(r.CodArticulo ?? "").trim();
        if (cod) stockMap.set(cod, r.Stock || 0);
      }
    } catch (e) {
      stockWarn = true;
      console.error("read stock-por-articulos", e);
    }
  }
  // Completa el stock (contexto, no exclusivo de ningún cliente) de las
  // porciones extraordinarias separadas en el punto 3d, ahora que ya se leyó.
  for (const ex of extraordinariosOut) ex.stock = stockMap.get(ex.CodArticulo) ?? 0;

  // 3c) Memoria de cobertura por stock (preparado.faltante_stock_max): marca de
  // agua del stock por artículo + hasta qué día de faltante ya quedó cubierto.
  // El stock se lee EN VIVO, así que si la mercadería entró y después se
  // vendió, el momento en que cubría el faltante ya no se puede observar y el
  // artículo quedaba clavado en la vista. Con esta tabla, una vez que el stock
  // superó al acumulado el bucket sale y NO vuelve (ver sql/compras_faltante_stock_max.sql).
  // Best-effort: si la tabla no está aplicada, la vista funciona sin memoria.
  const stockMaxPrev = new Map<string, number>();
  const cubiertoHasta = new Map<string, string>();
  // Día en que se detectó la cobertura (updatedAt de la marca) — solo para
  // mostrarlo en la solapa "Retirados" de la vista.
  const cubiertoEl = new Map<string, string>();
  let stockMaxWarn = false;
  if (codigosUnicos.length) {
    try {
      const prevRows = await prisma.$queryRaw<
        {
          codArticulo: string;
          stockMax: number | null;
          cubiertoHasta: string | null;
          cubiertoEl: string | null;
        }[]
      >`
        SELECT "codArticulo", "stockMax",
               to_char("cubiertoHasta", 'YYYY-MM-DD') AS "cubiertoHasta",
               to_char("updatedAt", 'YYYY-MM-DD')     AS "cubiertoEl"
        FROM preparado.faltante_stock_max
      `;
      for (const r of prevRows) {
        const cod = String(r.codArticulo ?? "").trim();
        if (!cod) continue;
        stockMaxPrev.set(cod, Number(r.stockMax) || 0);
        if (r.cubiertoHasta) {
          cubiertoHasta.set(cod, r.cubiertoHasta);
          if (r.cubiertoEl) cubiertoEl.set(cod, r.cubiertoEl);
        }
      }
    } catch (e) {
      stockMaxWarn = true;
      console.error("read faltante_stock_max", e);
    }
  }
  // Se persisten al final: marca de agua nueva y último día cubierto.
  const cubiertosNuevos: { cod: string; fecha: string; stock: number; faltan: number }[] = [];

  // Elige, para un bucket puntual (artículo + PrimerDia del faltante), la OC
  // pendiente de ese artículo hecha DESPUÉS de esa fecha con la entrega más
  // temprana (Despacho, salvo importación sin fecha confiable → FecMovim) —
  // mismo criterio que arriboParaFaltante en app/api/ventas/faltantes/
  // route.ts. Devuelve null si no hay ninguna OC elegible (el bucket cae al
  // último fallback: fechaArribo cargada a mano, ver page.tsx).
  const mejorLoteParaFecha = (lotes: OcLote[] | undefined, fechaBucket: string): OcLote | null => {
    if (!lotes?.length) return null;
    // 2026-09-16: se prefiere la entrega más temprana NO vencida (base + 2
    // días >= hoy); si todas están vencidas, la más temprana igual. Mismo
    // criterio que arriboParaFaltante en app/api/ventas/faltantes/route.ts.
    const hoyISO = new Date().toLocaleDateString("sv-SE", {
      timeZone: "America/Argentina/Buenos_Aires",
    });
    const mas2 = (iso: string) => {
      const d = new Date(`${iso}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + 2);
      return d.toISOString().slice(0, 10);
    };
    let mejor: OcLote | null = null;
    let mejorBase: string | null = null;
    let futuro: OcLote | null = null;
    let futuroBase: string | null = null;
    for (const l of lotes) {
      if (!l.FechaOC || l.FechaOC < fechaBucket) continue;
      const base = l.FechaEntrega && !l.Importacion ? l.FechaEntrega : l.FechaOC;
      if (!base) continue;
      if (mejorBase === null || base < mejorBase) {
        mejorBase = base;
        mejor = l;
      }
      if (mas2(base) >= hoyISO && (futuroBase === null || base < futuroBase)) {
        futuroBase = base;
        futuro = l;
      }
    }
    return futuro ?? mejor;
  };

  const artImporte = new Map<string, number>();
  for (const [cod, arr] of porArt) {
    arr.sort((a, c) => (a.fecha < c.fecha ? -1 : a.fecha > c.fecha ? 1 : 0));
    const oc = ocMap.get(cod);
    const ocTotal = oc?.PorLlegar ?? 0;
    const stock = stockMap.get(cod) ?? 0;
    // acumuladoBruto: lo que se MUESTRA en "faltan" — suma nuevoDelDia día a
    // día y NUNCA se resetea, ni aunque la OC/stock cubran todo (pedido
    // 2026-07-28). acumulado: cobertura INTERNA (solo para estado/color
    // de fila), esa sí se resetea cuando OC+stock alcanzan a cubrir todo.
    let acumuladoBruto = 0;
    let acumulado = 0;
    let imp = 0;
    // Día hasta el cual este artículo ya quedó cubierto por stock en alguna
    // corrida anterior: esos buckets no se muestran NI acumulan (el acumulado
    // arranca de cero después de esa fecha).
    const cubHasta = cubiertoHasta.get(cod) ?? null;
    // Mayor stock visto alguna vez (marca de agua). Si en algún momento superó
    // al acumulado, el faltante está cubierto aunque hoy ya se haya vendido.
    const stockPico = Math.max(stock, stockMaxPrev.get(cod) ?? 0);
    for (const b of arr) {
      b.stock = stock;
      if (cubHasta && b.fecha <= cubHasta) {
        b.yaCubierto = true; // cubierto en su momento: no acumula ni se muestra
        continue;
      }
      imp += b.importe;
      if (!b.vivo) {
        // Histórico ya entregado: cubierto con stock, no consume la OC por llegar.
        b.cubierto = b.faltan;
        b.descubierto = 0;
        b.ocTotal = ocTotal;
        b.estado = "entregado";
        continue;
      }
      acumuladoBruto += b.nuevoDelDia;
      acumulado += b.nuevoDelDia;
      // Acumulado de HOY antes de cualquier reset — se usa para decidir si el
      // STOCK SOLO (sin la OC) ya alcanza a cubrirlo (ver resueltoPorStock).
      const acumuladoDelDia = acumulado;
      let cub = Math.min(Math.max(ocTotal, 0), acumulado);
      let desc = Math.max(acumulado - ocTotal, 0);
      // El stock físico del depósito 1 (en vivo, WMS) tapa lo que la OC no
      // cubrió: si ya está en depósito no hace falta esperar una orden de compra.
      let descNetoStock = Math.max(desc - stock, 0);

      // El STOCK SOLO (sin contar ninguna OC) ya cubre todo el acumulado de
      // hoy: no es un problema de compras (no hace falta encargar nada), así
      // que este bucket se excluye más abajo en vez de pintarse — desaparece
      // de la tabla en lugar de quedar verde o neutro.
      // Cubierto por stock: alcanza con que el stock haya superado al acumulado
      // EN ALGÚN MOMENTO (stockPico = marca de agua persistida), no solo ahora.
      const resueltoPorStock = stockPico >= acumuladoDelDia;

      // Cobertura INTERNA de hoy (OC pendiente actual + stock físico actual,
      // las dos en vivo — no la fecha manual de "Arribo" ni ninguna
      // estimación): si ya alcanza para cubrir TODO el acumulado, se descarta
      // el crédito de ESTA cobertura interna (no se arrastra sobrante a favor
      // del próximo ciclo, para el cálculo de estado). Antes esto pisaba
      // también "faltan" (lo mostrado); ahora "faltan" queda aparte, en
      // acumuladoBruto, que nunca se resetea. Si no alcanza, el descubierto
      // real NO se resetea: sigue acumulando tal cual.
      if (descNetoStock <= 0) {
        acumulado = 0;
        cub = 0;
        desc = 0;
        descNetoStock = 0;
      }

      b.faltan = r2(acumuladoBruto); // bruto: nunca se resetea ni se le resta OC/stock
      b.cubierto = cub;
      b.descubierto = r2(descNetoStock);
      b.ocTotal = ocTotal;
      b.resueltoPorStock = resueltoPorStock;
      if (oc) {
        // Fecha mostrada: solo la OC hecha después de b.fecha (PrimerDia de
        // este bucket). Si ninguna OC pendiente califica (todas son de antes
        // de este faltante), no se muestra fecha en vivo — cae al fallback
        // manual (fechaArribo cargada), igual que cuando no hay OC alguna.
        // oc.Lotes === undefined (indicadores-api todavía sin este campo,
        // desfasaje de deploy): se sigue con el agregado viejo, sin filtrar.
        if (oc.Lotes === undefined) {
          b.fechaEntrega = oc.FechaEntrega ?? null;
          b.fechaOC = oc.FechaOC ?? null;
          b.importacion = !!oc.Importacion;
        } else {
          const lote = mejorLoteParaFecha(oc.Lotes, b.fecha);
          b.fechaEntrega = lote?.FechaEntrega ?? null;
          b.fechaOC = lote?.FechaOC ?? null;
          b.importacion = !!lote?.Importacion;
        }
        b.ocs = oc.NroOCs ?? [];
        if (!b.Proveedor && oc.Proveedor) b.Proveedor = oc.Proveedor;
      }
      // 4 estados (2026-07-27, pedido explícito):
      //   · descNetoStock<=0 (OC+stock cubren TODO)     → "completo" (verde).
      //     Si además resueltoPorStock (el STOCK SOLO ya alcanzaba, sin
      //     necesitar la OC), el filtro de más abajo lo saca de la
      //     respuesta — desaparece en vez de quedar verde.
      //   · si no, cub>0 (hay algo de OC pero no alcanza ni con el stock)
      //     → "incompleto" (rojo).
      //   · si no (no hay OC y el stock tampoco alcanza)  → "sin_orden"
      //     (sin color — antes rojo, ver rowCls en page.tsx).
      b.estado = descNetoStock <= 0 ? "completo" : cub > 0 ? "incompleto" : "sin_orden";
      if (resueltoPorStock) {
        // Queda registrado: de acá en más este día no vuelve a mostrarse y el
        // acumulado arranca de cero (lo posterior es faltante nuevo).
        cubiertosNuevos.push({ cod, fecha: b.fecha, stock: stockPico, faltan: acumuladoDelDia });
        acumuladoBruto = 0;
        acumulado = 0;
      }
    }
    artImporte.set(cod, imp);
  }

  // 4c) Filas RETIRADAS por cobertura de stock (las que ya no se muestran en la
  //     tabla): se devuelven aparte, en `cubiertos`, para poder ver QUÉ salió y
  //     CUÁNDO — no vuelven a `rows`. Incluye las que salieron en corridas
  //     anteriores (yaCubierto) y las que salen en ésta (resueltoPorStock).
  const hoyISO = new Date().toISOString().slice(0, 10);
  const cubiertosOut = [...buckets.values()]
    .filter((b) => b.yaCubierto || (b.estado === "completo" && b.resueltoPorStock))
    .map((b) => ({
      CodArticulo: b.CodArticulo,
      Nombre: b.Nombre,
      Linea: b.Linea,
      Proveedor: b.Proveedor,
      fecha: b.fecha, // día del faltante que quedó cubierto
      faltan: r2(b.faltan),
      stock: r2(b.stock),
      stockPico: r2(Math.max(b.stock, stockMaxPrev.get(b.CodArticulo) ?? 0)),
      importe: r2(b.importe),
      renglones: b.renglones,
      pedidos: b.pedidos.size,
      cubiertoEl: b.yaCubierto ? (cubiertoEl.get(b.CodArticulo) ?? null) : hoyISO,
    }))
    .sort((a, c) =>
      (c.cubiertoEl ?? "") !== (a.cubiertoEl ?? "")
        ? (c.cubiertoEl ?? "") < (a.cubiertoEl ?? "") ? -1 : 1
        : c.importe - a.importe,
    );

  // Cuánto de cada bucket quedó separado como extraordinario y TODAVÍA sin
  // decidir (comprar === null, ventas/faltantes no le preguntó al cliente
  // todavía) — solo para el badge de la fila principal (ver punto 3d).
  const extraPendientePorBucket = new Map<string, number>();
  for (const ex of extraordinariosOut) {
    if (ex.comprar !== null) continue;
    const k = keyArtDia(ex.CodArticulo, ex.fecha);
    extraPendientePorBucket.set(k, r2((extraPendientePorBucket.get(k) ?? 0) + ex.cantidad));
  }

  // 5) ordenar: artículos por importe total desc, días asc dentro del artículo.
  //    conArribo=0 (default): oculta buckets con TODOS sus renglones ya con
  //    fecha de arribo cargada (preparado.faltante_control) — ya están
  //    resueltos para compras. conArribo=1 los vuelve a mostrar, para
  //    corroborar los que ya se pasaron.
  const rowsOut = [...buckets.values()]
    .filter((b) => conArribo || b.renglones === 0 || b.renglonesConArribo < b.renglones)
    .filter((b) => {
      const descartado =
        descartMap.get(keyArtDia(b.CodArticulo, b.fecha)) ?? descartUltPorArt.get(b.CodArticulo);
      return !descartado;
    })
    // Resuelto por STOCK SOLO (sin la OC, ver resueltoPorStock más arriba):
    // no es un problema de compras, no hace falta encargar nada — esta fila
    // SÍ se excluye (desaparece de toda la vista). Distinto de "completo" a
    // secas (OC+stock cubren todo pero el stock por sí solo NO alcanzaba):
    // ese caso NO se excluye más abajo, se manda con estado "completo" y se
    // pinta verde (cambio 2026-07-27, antes también se ocultaba).
    .filter((b) => !b.yaCubierto)
    .filter((b) => !(b.estado === "completo" && b.resueltoPorStock))
    .sort((a, c) => {
      const ia = artImporte.get(a.CodArticulo) ?? 0;
      const ic = artImporte.get(c.CodArticulo) ?? 0;
      if (ic !== ia) return ic - ia;
      if (a.CodArticulo !== c.CodArticulo) return a.CodArticulo < c.CodArticulo ? -1 : 1;
      return a.fecha < c.fecha ? -1 : a.fecha > c.fecha ? 1 : 0;
    })
    .map((b) => {
      return {
        CodArticulo: b.CodArticulo,
        Nombre: b.Nombre,
        Linea: b.Linea,
        Proveedor: b.Proveedor,
        clientes: Array.from(b.clientes, ([cod, v]) => ({ cod, nombre: v.nombre, cant: r2(v.cant) })),
        fecha: b.fecha,
        vivo: b.vivo,
        faltan: r2(b.faltan), // acumulado BRUTO hasta este día, YA SIN lo marcado extraordinario (punto 3d), sin restar OC/stock (ver punto 4)
        nuevoDelDia: r2(b.nuevoDelDia),
        cubierto: r2(b.cubierto),
        descubierto: r2(b.descubierto),
        importe: r2(b.importe),
        renglones: b.renglones,
        pedidos: b.pedidos.size,
        stock: r2(b.stock),
        ocTotal: r2(b.ocTotal),
        fechaEntrega: b.fechaEntrega,
        fechaOC: b.fechaOC,
        importacion: b.importacion,
        tipoArticulo: b.tipoArticulo,
        ocs: b.ocs,
        estado: b.estado,
        // Cuánto de este bucket ya está separado como extraordinario y
        // esperando que /ventas/faltantes le pregunte al cliente (ver
        // `extraordinarios` en la respuesta, aparte de `rows`).
        extraordinarioEnRevision: extraPendientePorBucket.get(keyArtDia(b.CodArticulo, b.fecha)) ?? 0,
        // fechaArribo = lo cargado a mano en preparado.faltante_control (sin
        // cambios de nombre/semántica acá, para no romper otros consumidores
        // de este endpoint). 2026-09-16 — "siempre en vivo": el FRONT
        // (app/compras/faltantes/page.tsx) dejó de usar este valor como LA
        // fecha mostrada — ahora prioriza el sugerido recalculado de
        // fechaEntrega/fechaOC (ver esos campos acá arriba) en cada carga, y
        // usa este `fechaArribo` solo de último fallback cuando ya no hay OC
        // vigente. Antes, una fecha ya cargada quedaba clavada en pantalla
        // aunque Magnus reprogramara la OC (caso real: arribo confirmado en
        // julio, OC movida a septiembre, la vista seguía en julio).
        fechaArribo: b.fechaArriboMin,
        tieneArribo: b.renglones > 0 && b.renglonesConArribo === b.renglones,
        // Ingresos del período por artículo (mismo valor en todos los días de
        // ese artículo, ver ingMap): unidades recibidas por remito + detalle.
        ingresado: r2(ingMap.get(b.CodArticulo)?.cant ?? 0),
        remitos: ingMap.get(b.CodArticulo)?.remitos ?? [],
        ultimoIngreso: ingMap.get(b.CodArticulo)?.ultimo ?? null,
      };
    });

  // 5b) persistir la marca de agua del stock + hasta qué día quedó cubierto
  //     (preparado.faltante_stock_max, ver sql/compras_faltante_stock_max.sql).
  //     Un solo INSERT ... ON CONFLICT con GREATEST: la marca nunca baja, así
  //     que el artículo no vuelve a la vista cuando el stock se vende.
  //     Se escribe para TODOS los artículos en pantalla (marca de agua), y con
  //     cubiertoHasta solo para los que quedaron cubiertos en esta corrida.
  if (codigosUnicos.length) {
    try {
      const cubMap = new Map<string, { fecha: string; stock: number; faltan: number }>();
      for (const c of cubiertosNuevos) {
        const prev = cubMap.get(c.cod);
        if (!prev || c.fecha > prev.fecha) cubMap.set(c.cod, c);
      }
      const values = codigosUnicos.map((cod) => {
        const cub = cubMap.get(cod) ?? null;
        const stk = Math.max(stockMap.get(cod) ?? 0, stockMaxPrev.get(cod) ?? 0);
        return Prisma.sql`(${cod}, ${stk}, ${cub ? cub.fecha : null}::date, ${cub ? cub.faltan : null}, now())`;
      });
      await prisma.$executeRaw`
        INSERT INTO preparado.faltante_stock_max
          ("codArticulo", "stockMax", "cubiertoHasta", "faltanCubierto", "updatedAt")
        VALUES ${Prisma.join(values)}
        ON CONFLICT ("codArticulo") DO UPDATE SET
          "stockMax"       = GREATEST(preparado.faltante_stock_max."stockMax", EXCLUDED."stockMax"),
          "cubiertoHasta"  = GREATEST(preparado.faltante_stock_max."cubiertoHasta", EXCLUDED."cubiertoHasta"),
          "faltanCubierto" = COALESCE(EXCLUDED."faltanCubierto", preparado.faltante_stock_max."faltanCubierto"),
          "updatedAt"      = now()
      `;
    } catch (e) {
      stockMaxWarn = true;
      console.error("persist faltante_stock_max", e);
    }
  }

  // 6) persistir el consumo por día (best-effort; tabla aplicada a mano por SQL)
  //    Solo demanda viva: los entregados históricos no imputan OC.
  let consumoWarn = false;
  const consumoRows = rowsOut.filter((r) => r.vivo);
  if (consumoRows.length) {
    try {
      const values = consumoRows.map(
        (r) =>
          Prisma.sql`(${r.fecha}::date, ${r.CodArticulo}, ${r.faltan}, ${r.cubierto}, ${r.descubierto}, ${r.ocTotal}, now())`,
      );
      await prisma.$executeRaw`
        INSERT INTO preparado.faltante_oc_consumo
          (fecha, "codArticulo", faltan, "ocImputada", descubierto, "ocTotal", "updatedAt")
        VALUES ${Prisma.join(values)}
        ON CONFLICT (fecha, "codArticulo") DO UPDATE SET
          faltan       = EXCLUDED.faltan,
          "ocImputada" = EXCLUDED."ocImputada",
          descubierto  = EXCLUDED.descubierto,
          "ocTotal"    = EXCLUDED."ocTotal",
          "updatedAt"  = now()
      `;
    } catch (e) {
      consumoWarn = true;
      console.error("persist faltante_oc_consumo", e);
    }
  }

  return NextResponse.json({
    fecha,
    desde: minPrimer ?? fecha,
    hasta: maxFecha ?? fecha,
    ocDesde,
    faltDesde,
    historico: true, // siempre histórico (ver qs arriba)
    conArribo,
    total: rowsOut.length,
    rows: rowsOut,
    // Filas retiradas por cobertura de stock (ver 4c) — no están en `rows`.
    cubiertos: cubiertosOut,
    // Porciones extraordinarias por cliente, ya restadas de `rows` (ver punto
    // 3d) — pendientes (comprar=null) o decididas (comprar=true/false).
    extraordinarios: extraordinariosOut,
    ocWarn,
    ingresoWarn,
    comprobanteWarn,
    ingresosDesde: faltDesde,
    ingresosHasta: hastaParam ?? null,
    consumoWarn,
    extraWarn,
    stockWarn,
    stockMaxWarn,
    descartWarn,
  });
}
