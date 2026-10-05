import { NextRequest } from "next/server";
import { GET as faltantesConsumoGET } from "@/app/api/compras/faltantes-consumo/route";
import { origenArticulo } from "./origenArticulo";
import type { ArticuloMes, FaltantesMes } from "./faltantesMes";

// ──────────────────────────────────────────────────────────────────────────────
// Universo de faltantes del mes para /compras = EL MISMO de /compras/faltantes.
//
// Antes /compras contaba todo renglón pendiente del mes sin mirar las marcas de
// la mesa (faltante_existencia) y /compras/faltantes sólo lo marcado "sin
// existencia" menos extraordinarios, descartados y cubiertos por stock: dos
// números distintos para "los faltantes". Ahora /compras (metricas y
// faltantes-linea) se arma con la respuesta de faltantes-consumo, así que las
// dos vistas parten exactamente del mismo conjunto de artículos.
//
// Se llama al handler de la ruta directamente (sin HTTP) con el rango del mes y
// conArribo=1: se cuentan también los artículos que ya tienen fecha de arribo
// cargada (la vista los oculta por defecto con el toggle "ver con arribo", pero
// siguen siendo faltante del mes y casi todos son justamente los "Con OC").
//
// Por artículo, igual que la tabla de /compras/faltantes (última fila viva):
//   · unidades = `faltan` del último día (acumulado bruto, ya sin lo marcado
//     extraordinario).
//   · importe  = precio de venta unitario × unidades, con el precio sacado de
//     las filas del artículo (Σ importe / Σ nuevoDelDia).
// El estado del artículo no se vuelve a filtrar: las marcas de la mesa son las
// que deciden (habilitado = true).
// ──────────────────────────────────────────────────────────────────────────────

interface FilaConsumo {
  CodArticulo: string;
  Proveedor: string | null;
  tipoArticulo: string | null;
  Linea: string | number | null;
  fecha: string;
  faltan: number;
  nuevoDelDia: number;
  importe: number;
}

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export async function cargarFaltantesMesCompras(
  desde: string,
  hasta: string,
): Promise<FaltantesMes> {
  const qs = new URLSearchParams({ desde, hasta, conArribo: "1" });
  const res = await faltantesConsumoGET(
    new NextRequest(`http://localhost/api/compras/faltantes-consumo?${qs}`),
  );
  if (!res.ok) throw new Error(`HTTP ${res.status} faltantes-consumo`);
  const j = (await res.json()) as { rows?: FilaConsumo[] };

  const porArt = new Map<string, FilaConsumo[]>();
  for (const r of j.rows ?? []) {
    const cod = String(r.CodArticulo ?? "").trim();
    if (!cod) continue;
    const arr = porArt.get(cod) ?? [];
    arr.push(r);
    porArt.set(cod, arr);
  }

  const articulos = new Map<string, ArticuloMes>();
  for (const [cod, arr] of porArt) {
    arr.sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0));
    const ultima = arr[arr.length - 1];
    let sumNuevo = 0;
    let sumImporte = 0;
    let proveedor: string | null = null;
    let tipo: string | null = null;
    let linea: string | null = null;
    for (const r of arr) {
      sumNuevo += r.nuevoDelDia || 0;
      sumImporte += r.importe || 0;
      if (!proveedor && r.Proveedor) proveedor = r.Proveedor;
      if (!tipo && r.tipoArticulo) tipo = r.tipoArticulo;
      if (!linea && r.Linea != null && String(r.Linea).trim()) linea = String(r.Linea).trim();
    }
    const unidades = r2(ultima.faltan || 0);
    const precio = sumNuevo > 0 ? sumImporte / sumNuevo : 0;
    articulos.set(cod, {
      cod,
      proveedor,
      tipoArticulo: tipo,
      origen: origenArticulo({ Proveedor: proveedor, tipoArticulo: tipo }),
      habilitado: true,
      unidades,
      importe: r2(unidades * precio),
      unidadesCanceladas: 0,
      linea,
    });
  }

  return { articulos, estadoDisponible: true, unidadesDescartadas: 0 };
}

export const FALTANTES_MES_VACIO: FaltantesMes = {
  articulos: new Map(),
  estadoDisponible: true,
  unidadesDescartadas: 0,
};
