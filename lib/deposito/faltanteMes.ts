import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// ─────────────────────────────────────────────────────────────────────────────
// Registro mensual del faltante — 2026-09-22, ajustado el mismo día para
// depender de la MARCA de la mesa, no de toda la diferencia de Magnus.
//
// Fuente: preparado.faltante_pedido (el detalle persistido por
// /api/deposito/faltantes, TODA la diferencia pedida vs cumplida) cruzado
// contra preparado.faltante_existencia (las marcas sí/no/mal facturado que
// carga la mesa). Ya no se vuelve a consultar Magnus para esto: con el
// detalle del renglón ya persistido, es un join en Postgres.
//
// Regla de qué suma dónde:
//   existencia = false (marcado "sin existencia")  → preparado.faltante_mes
//       Es el faltante real: se pidió, no había stock, no se cumplió.
//   existencia = true  (marcado "en existencia")    → faltante_mes_existente
//       Había stock y NO se cumplió igual — falla de picking/proceso, no de
//       stock. Se lleva aparte para no mezclar los dos números.
//   malFacturado = true, o SIN marcar (pendiente)   → no suma en ninguna.
// Como existencia queda NULL tanto en "mal facturado" como en "pendiente", el
// filtro `existencia = false` / `existencia = true` ya los excluye solo (NULL
// no es igual a ni true ni false) — no hace falta un AND aparte.
//
// Por qué se RECALCULA el mes entero en vez de ir sumando de a poco: sumar
// (unidades = unidades + x) no es idempotente — correr el registro dos veces
// duplicaría, y una marca que se corrige después (de "no" a "sí", o se borra)
// seguiría sumando lo viejo para siempre. Recalculando el join completo y
// pisando el total (UPSERT SET =), el resultado es el mismo corra una vez o
// veinte, y los cambios de marca se reflejan solos.
//
// Nunca hay varias filas del mismo artículo en un mes en ninguna de las dos
// tablas: la PK es (mes, codArticulo) y el UPSERT pisa esa única fila.
// ─────────────────────────────────────────────────────────────────────────────

export interface FaltanteMesRow {
  codArticulo: string;
  nombre: string;
  unidades: number;
  importe: number;
  renglones: number;
  pedidos: number;
}

export interface MesResumen {
  articulos: number;
  unidades: number;
  importe: number;
  renglones: number;
}

export interface RegistroMesResultado {
  mes: string;
  desde: string;
  hasta: string; // exclusivo (1er día del mes siguiente)
  sinExistencia: MesResumen; // → faltante_mes (faltante real)
  enExistencia: MesResumen; // → faltante_mes_existente (no cumplido habiendo)
  guardado: boolean; // false = las tablas no existen todavía (falta correr el SQL)
  motivo?: string;
}

type Tabla = "faltante_mes" | "faltante_mes_existente";

interface AggRow {
  codArticulo: string;
  nombre: string;
  unidades: number;
  importe: number;
  renglones: number;
  pedidos: number;
}

export function mesValido(mes: string | null | undefined): mes is string {
  return !!mes && /^\d{4}-\d{2}$/.test(mes);
}

export function mesDeFecha(fecha: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})/.exec(fecha ?? "");
  return m ? `${m[1]}-${m[2]}` : null;
}

function rangoMes(mes: string): { desde: Date; hasta: Date } {
  const [anio, mm] = mes.split("-").map(Number);
  const desde = new Date(Date.UTC(anio, mm - 1, 1));
  const hasta = new Date(Date.UTC(anio, mm, 1)); // exclusivo
  return { desde, hasta };
}

function resumen(rows: AggRow[]): MesResumen {
  return {
    articulos: rows.length,
    unidades: +rows.reduce((a, r) => a + r.unidades, 0).toFixed(3),
    importe: +rows.reduce((a, r) => a + r.importe, 0).toFixed(2),
    renglones: rows.reduce((a, r) => a + r.renglones, 0),
  };
}

/**
 * Agrupa por artículo lo que la mesa marcó como `existencia` (true/false) en
 * el rango de fechas dado, cruzando contra el detalle real del renglón
 * (faltante_pedido). Lo no marcado y lo "mal facturado" quedan afuera solos:
 * ambos dejan existencia NULL, que no matchea ni `= false` ni `= true`.
 */
async function agregarPorMarca(
  existencia: boolean,
  desde: Date,
  hasta: Date,
): Promise<AggRow[]> {
  const rows = await prisma.$queryRaw<
    {
      codArticulo: string;
      nombre: string | null;
      unidades: unknown;
      importe: unknown;
      renglones: bigint;
      pedidos: bigint;
    }[]
  >`
    SELECT fp."codArticulo",
           MAX(fp.nombre)                        AS nombre,
           SUM(fp.diferencia)                    AS unidades,
           SUM(fp.importe)                       AS importe,
           COUNT(*)                              AS renglones,
           COUNT(DISTINCT fp."nroMovVenta")       AS pedidos
    FROM preparado.faltante_existencia fe
    JOIN preparado.faltante_pedido fp
      ON fp."nroMovVenta" = fe.nro_ped_origen
     AND fp."nroRenglon"  = fe.nro_reng_origen
    WHERE fe.existencia = ${existencia}
      AND fp.fecha >= ${desde}::date AND fp.fecha < ${hasta}::date
    GROUP BY fp."codArticulo"
  `;
  return rows.map((r) => ({
    codArticulo: r.codArticulo,
    nombre: r.nombre ?? "",
    unidades: Number(r.unidades ?? 0),
    importe: Number(r.importe ?? 0),
    renglones: Number(r.renglones ?? 0),
    pedidos: Number(r.pedidos ?? 0),
  }));
}

/** UPSERT en tandas + borrado de lo que quedó viejo (no tocado en esta corrida). */
async function persistirTabla(
  tabla: Tabla,
  mes: Date,
  rows: AggRow[],
  corte: Date,
): Promise<void> {
  const t = Prisma.raw(`preparado.${tabla}`); // nombre fijo, no viene del usuario
  const CH = 500; // tandas: un solo INSERT por tanda, no una query por fila
  for (let i = 0; i < rows.length; i += CH) {
    const chunk = rows.slice(i, i + CH);
    const values = chunk.map(
      (r) =>
        Prisma.sql`(${mes}::date, ${r.codArticulo}, ${r.nombre}, ${r.unidades}, ${r.importe}, ${r.renglones}, ${r.pedidos}, now())`,
    );
    await prisma.$executeRaw`
      INSERT INTO ${t}
        (mes, "codArticulo", nombre, unidades, importe, renglones, pedidos, "updatedAt")
      VALUES ${Prisma.join(values)}
      ON CONFLICT (mes, "codArticulo") DO UPDATE SET
        nombre      = EXCLUDED.nombre,
        unidades    = EXCLUDED.unidades,
        importe     = EXCLUDED.importe,
        renglones   = EXCLUDED.renglones,
        pedidos     = EXCLUDED.pedidos,
        "updatedAt" = now()
    `;
  }
  await prisma.$executeRaw`
    DELETE FROM ${t} WHERE mes = ${mes}::date AND "updatedAt" < ${corte}
  `;
}

/** Recalcula el mes (join marca × detalle) y persiste las dos tablas. */
export async function registrarFaltanteMes(
  mes: string,
): Promise<RegistroMesResultado> {
  const { desde, hasta } = rangoMes(mes);
  const base = {
    mes,
    desde: desde.toISOString().slice(0, 10),
    hasta: hasta.toISOString().slice(0, 10),
  };
  // Marca de corte: las filas del mes que NO se toquen en este recálculo
  // (artículo que dejó de tener marcas de ese tipo) quedan con updatedAt
  // anterior y se borran al final. Evita un NOT IN con cientos de códigos.
  const corte = new Date();

  try {
    const [sinExistenciaRows, enExistenciaRows] = await Promise.all([
      agregarPorMarca(false, desde, hasta),
      agregarPorMarca(true, desde, hasta),
    ]);
    await Promise.all([
      persistirTabla("faltante_mes", desde, sinExistenciaRows, corte),
      persistirTabla("faltante_mes_existente", desde, enExistenciaRows, corte),
    ]);
    return {
      ...base,
      sinExistencia: resumen(sinExistenciaRows),
      enExistencia: resumen(enExistenciaRows),
      guardado: true,
    };
  } catch (e) {
    console.error("registrarFaltanteMes", mes, e);
    return {
      ...base,
      sinExistencia: { articulos: 0, unidades: 0, importe: 0, renglones: 0 },
      enExistencia: { articulos: 0, unidades: 0, importe: 0, renglones: 0 },
      guardado: false,
      motivo:
        "No se pudo escribir preparado.faltante_mes / faltante_mes_existente " +
        "(¿falta correr sql/deposito_faltante_pedido.sql?)",
    };
  }
}

async function leerTabla(tabla: Tabla, mes: string): Promise<FaltanteMesRow[]> {
  const { desde } = rangoMes(mes);
  const t = Prisma.raw(`preparado.${tabla}`);
  const rows = await prisma.$queryRaw<
    {
      codArticulo: string;
      nombre: string | null;
      unidades: number;
      importe: number;
      renglones: number;
      pedidos: number;
    }[]
  >`
    SELECT "codArticulo", nombre, unidades, importe, renglones, pedidos
    FROM ${t}
    WHERE mes = ${desde}::date
    ORDER BY unidades DESC
  `;
  return rows.map((r) => ({
    codArticulo: r.codArticulo,
    nombre: r.nombre ?? "",
    unidades: Number(r.unidades ?? 0),
    importe: Number(r.importe ?? 0),
    renglones: Number(r.renglones ?? 0),
    pedidos: Number(r.pedidos ?? 0),
  }));
}

/** Lee lo ya registrado como SIN existencia (faltante real) de un mes. */
export function leerFaltanteMes(mes: string): Promise<FaltanteMesRow[]> {
  return leerTabla("faltante_mes", mes);
}

/** Lee lo ya registrado como EN existencia (no cumplido habiendo) de un mes. */
export function leerFaltanteMesExistente(mes: string): Promise<FaltanteMesRow[]> {
  return leerTabla("faltante_mes_existente", mes);
}
