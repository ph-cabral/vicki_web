import { prisma } from "@/lib/prisma";

const API_URL = process.env.INDICADORES_API_URL ?? "http://indicadores-api:8001";

// Mismo ancla que /api/compras/faltantes-consumo (OC_DESDE_DEFAULT) y
// /api/ventas/faltantes (OC_DESDE) — mantener sincronizados. La marca
// existencia=false de un renglón se guarda con la fecha de AQUEL snapshot,
// que puede ser muy anterior al PrimerDia del bucket que muestra
// /compras/faltantes (un renglón sigue "vivo" pero se marcó sin existencia
// hace rato). Si la ventana de lectura arrancara en el PrimerDia del bucket
// en vez de en el ancla, se perdía justo esa marca vieja.
const ANCLA = "2026-06-26";

interface FaltRow {
  NroPedOrigen: number;
  NroRengOrigen: number;
  CodArticulo: string;
  Fecha: string | null; // snapshot más nuevo del renglón (= día "rolling" que usan
  //   /deposito/faltantes, faltante_existencia y faltante_control como clave).
  PrimerDia: string | null; // primera aparición dentro del rango consultado.
}

// Fila cruda de GET /deposito/faltante-pedidos — fuente desde 2026-09-22
// (pedidos Cerrados/Facturados de Magnus, ya no Ven_PedRenPendientes). Cada
// renglón aparece una sola vez con fecha fija (FechaCierre): no hay snapshot
// que "decaiga" al facturarse, así que ya no hace falta pedir histórico ni
// preocuparse porque el renglón haya "salido de la foto viva".
interface FaltantePedidoRow {
  NroMovVenta: number;
  Renglon: number;
  CodArticulo: string;
  Fecha: string | null;
}
function mapFaltantePedido(r: FaltantePedidoRow): FaltRow {
  return {
    NroPedOrigen: r.NroMovVenta,
    NroRengOrigen: r.Renglon,
    CodArticulo: r.CodArticulo,
    Fecha: r.Fecha,
    PrimerDia: r.Fecha,
  };
}

export interface BucketRenglon {
  nroPedOrigen: number;
  nroRengOrigen: number;
  // OJO: NO es el PrimerDia del bucket de /compras/faltantes. Es el "Fecha"
  // (snapshot vigente) del renglón — la misma fecha con la que ya se guarda
  // faltante_existencia / faltante_control desde /deposito/faltantes y que
  // /ventas/faltantes usa para buscar (WHERE fecha = <fecha del día>). Si acá
  // se usara el PrimerDia histórico del bucket, ventas nunca encontraría la
  // fila (ventas siempre consulta con la fecha "de hoy", no con la histórica).
  fecha: string;
}

const keyLine = (p: number, r: number) => `${p}-${r}`;

// Renglones "sin existencia" que componen el bucket (CodArticulo, PrimerDia)
// que muestra /compras/faltantes (agrupado por artículo+día). Se usa para el
// fan-out de fechaArribo: la fecha se carga a nivel artículo+día en esa
// pantalla, pero preparado.faltante_control sigue siendo por renglón (mismo
// esquema que ya usa /ventas/faltantes — no se tocó).
export async function resolveBucketRenglones(
  codArticulo: string,
  primerDia: string,
): Promise<BucketRenglon[]> {
  const hoy = new Date().toISOString().slice(0, 10);
  const hasta = hoy > primerDia ? hoy : primerDia;
  // Fuente 2026-09-22: /deposito/faltante-pedidos (pedidos Cerrados/
  // Facturados de Magnus) — cada renglón tiene FechaCierre fija, ya no "vive"
  // ~1 día como en Ven_PedRenPendientes, así que no hace falta pedir
  // histórico: el renglón sigue apareciendo igual muchos días después de
  // PrimerDia. Mismo patrón que ya usan /api/ventas/faltantes y
  // /api/compras/faltantes-consumo (ver mapFaltantePedido arriba).
  const qs = new URLSearchParams({ desde: primerDia, hasta });

  const res = await fetch(`${API_URL}/deposito/faltante-pedidos?${qs}`, {
    cache: "no-store",
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} /deposito/faltante-pedidos`);
  const json = await res.json();

  const rows: FaltRow[] = ((json.rows ?? []) as FaltantePedidoRow[])
    .map(mapFaltantePedido)
    .filter(
      (r: FaltRow) => r.CodArticulo === codArticulo && (r.PrimerDia ?? r.Fecha) === primerDia,
    );
  if (!rows.length) return [];

  // última marca de existencia por renglón (mismo patrón que faltantes-consumo).
  // Ventana desde el ANCLA (no desde primerDia): ver comentario arriba — la
  // marca puede ser muy anterior al PrimerDia del bucket.
  // Además: si el renglón nunca se tildó en /deposito/faltantes, no hay marca
  // acá (undefined) — y esta pantalla no depende de ese check manual, así que
  // "sin marca" cuenta como sin existencia. Sólo se descarta lo marcado
  // explícitamente existencia=true (ya confirmado con stock).
  const desdeMarks = ANCLA < primerDia ? ANCLA : primerDia;
  const marks = await prisma.faltante_existencia.findMany({
    where: { fecha: { gte: new Date(desdeMarks), lte: new Date(hasta) } },
    select: { nroPedOrigen: true, nroRengOrigen: true, existencia: true, fecha: true },
    orderBy: { fecha: "asc" },
  });
  const latest = new Map<string, boolean>();
  for (const m of marks) latest.set(keyLine(m.nroPedOrigen, m.nroRengOrigen), m.existencia);

  return rows
    .filter((r) => latest.get(keyLine(r.NroPedOrigen, r.NroRengOrigen)) !== true)
    .map((r) => ({
      nroPedOrigen: r.NroPedOrigen,
      nroRengOrigen: r.NroRengOrigen,
      fecha: r.Fecha ?? primerDia,
    }));
}
