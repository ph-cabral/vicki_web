import { esProveedorFabrica, origenArticulo } from "./origenArticulo";
import type { ArticuloMes, FaltantesMes } from "./faltantesMes";

// ──────────────────────────────────────────────────────────────────────────────
// Universo de faltantes del mes para /compras (cards, funnel, faltantes por
// línea) = lo que la mesa de control marcó "sin existencia" dentro del mes y que
// HOY sigue sin cumplirse en Magnus (pedido Cerrado/Facturado, Cumplida <
// Pedida). 2026-10-07: reemplaza al universo de /compras/faltantes
// (faltantes-consumo), que además restaba extraordinarios por cliente,
// descartados, cubiertos por stock y acumulaba por día: eso hacía que /compras
// diera un número que no cierra con lo que cuenta el sector compras.
//
// Fuente: indicadores-api GET /compras/faltantes-marcados-mes (marcas de
// Postgres preparado.faltante_existencia + estado actual de los renglones en
// Magnus, ver indicadores-api/compras.py fetch_faltantes_marcados_mes).
// Septiembre 2026, nacionales: 312 items / 11.257,53 u.
//
// Por artículo: unidades = Σ(Pedida − Cumplida) actual, importe = Σ unidades ×
// PrecioVenta. Sin tipo cargado se trata como Nacional (mismo criterio que el
// lado OC en compras.py), salvo proveedor de fábrica.
// ──────────────────────────────────────────────────────────────────────────────

const API_URL =
  process.env.INDICADORES_API_URL ?? "http://indicadores-api:8001";

interface FilaMarcada {
  CodArticulo: string;
  Proveedor: string | null;
  tipoArticulo: string | null;
  Linea: string | null;
  unidades: number;
  importe: number;
}

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export async function cargarFaltantesMesCompras(
  desde: string,
  hasta: string,
): Promise<FaltantesMes> {
  const qs = new URLSearchParams({ desde, hasta });
  const res = await fetch(`${API_URL}/compras/faltantes-marcados-mes?${qs}`, {
    cache: "no-store",
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} faltantes-marcados-mes`);
  const j = (await res.json()) as { rows?: FilaMarcada[] };

  const articulos = new Map<string, ArticuloMes>();
  for (const r of j.rows ?? []) {
    const cod = String(r.CodArticulo ?? "").trim();
    if (!cod) continue;
    const proveedor = r.Proveedor ?? null;
    const tipo =
      r.tipoArticulo ?? (esProveedorFabrica(proveedor) ? null : "Nacional");
    articulos.set(cod, {
      cod,
      proveedor,
      tipoArticulo: tipo,
      origen: origenArticulo({ Proveedor: proveedor, tipoArticulo: tipo }),
      habilitado: true,
      unidades: r2(r.unidades || 0),
      importe: r2(r.importe || 0),
      unidadesCanceladas: 0,
      linea: r.Linea ? String(r.Linea).trim() : null,
    });
  }

  return { articulos, estadoDisponible: true, unidadesDescartadas: 0 };
}

export const FALTANTES_MES_VACIO: FaltantesMes = {
  articulos: new Map(),
  estadoDisponible: true,
  unidadesDescartadas: 0,
};
