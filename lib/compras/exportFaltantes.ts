// Exporta /compras/faltantes a .xlsx (descarga en el navegador). Usa `xlsx`
// (SheetJS), mismo patrón que lib/buscador/export.ts.
import * as XLSX from "xlsx";

type Estado = "completo" | "incompleto" | "sin_orden" | "entregado";

interface Row {
  CodArticulo: string;
  Nombre: string;
  Proveedor: string | null;
  fecha: string;
  faltan: number;
  stock: number;
  cubierto: number;
  descubierto: number;
  fechaEntrega: string | null;
  importacion: boolean;
  importe: number;
  fechaArribo: string | null;
  estado: Estado;
  // Ingresos por remito del período (ver /compras/faltantes): total del
  // artículo, no del día. Opcionales por compatibilidad con llamadores viejos.
  ingresado?: number;
  remitos?: { nro: string; fecha: string; cant: number }[];
  ultimoIngreso?: string | null;
}

// Porción extraordinaria de un bucket, por CLIENTE (2026-09-16) — ver
// `extraordinarios` en GET /api/compras/faltantes-consumo.
interface RowExtra {
  CodArticulo: string;
  Nombre: string;
  Proveedor: string | null;
  fecha: string;
  codCliente: string;
  clienteNombre: string | null;
  cantidad: number;
  stock: number;
  importe: number;
  comprar: boolean | null;
}

const ESTADO_LABEL: Record<Estado, string> = {
  completo: "Cubierto",
  incompleto: "Parcial",
  sin_orden: "Sin OC",
  entregado: "Entregado",
};

function ajustarAnchos(ws: XLSX.WorkSheet, filas: Record<string, unknown>[]): void {
  if (filas.length === 0) return;
  const cols = Object.keys(filas[0]);
  ws["!cols"] = cols.map((c) => {
    let max = c.length;
    for (const f of filas) {
      const len = String(f[c] ?? "").length;
      if (len > max) max = len;
    }
    return { wch: Math.min(Math.max(max + 2, 8), 50) };
  });
}

function filaFaltante(r: Row) {
  return {
    "Código": r.CodArticulo,
    "Artículo": r.Nombre,
    Proveedor: r.Proveedor || "",
    "Día": r.fecha,
    Faltan: r.faltan,
    Stock: r.stock,
    "Cubre OC": r.cubierto,
    "Falta OC": r.descubierto,
    Entrega: r.estado === "entregado" ? "Entregado" : r.importacion ? "Importación" : r.fechaEntrega || "",
    Importe: r.importe,
    Ingresado: r.ingresado ?? 0,
    "N° de remitos": (r.remitos ?? []).map((m) => m.nro).join(", "),
    "Último ingreso": r.ultimoIngreso || "",
    Arribo: r.fechaArribo || "",
    Estado: ESTADO_LABEL[r.estado],
  };
}

function filaExtraordinario(r: RowExtra) {
  return {
    "Código": r.CodArticulo,
    "Artículo": r.Nombre,
    "Día": r.fecha,
    Cliente: r.clienteNombre ? `${r.codCliente} — ${r.clienteNombre}` : r.codCliente,
    "Cantidad extraordinaria": r.cantidad,
    Stock: r.stock,
    Proveedor: r.Proveedor || "",
    Importe: r.importe,
    Comprar: r.comprar == null ? "" : r.comprar ? "Sí" : "No",
  };
}

// rows: pasar ya filtradas como estén en pantalla (rango desde/hasta, filtro
// de estado, "ver con arribo" y, si está girada la tarjeta, las
// extraordinarias en vez de las principales — una fila por cliente).
export function exportarFaltantesCompras(
  rows: Row[] | RowExtra[],
  opts: { modo: "faltantes" | "extraordinarios"; desde?: string | null; hasta?: string | null },
): void {
  const wb = XLSX.utils.book_new();
  const filas =
    opts.modo === "extraordinarios"
      ? (rows as RowExtra[]).map(filaExtraordinario)
      : (rows as Row[]).map(filaFaltante);
  const ws = XLSX.utils.json_to_sheet(filas);
  ajustarAnchos(ws, filas);
  XLSX.utils.book_append_sheet(wb, ws, opts.modo === "extraordinarios" ? "Extraordinarios" : "Faltantes");

  const fecha = new Date().toISOString().slice(0, 10);
  const rango = opts.desde && opts.hasta ? `${opts.desde}_a_${opts.hasta}-` : "";
  const sufijo = opts.modo === "extraordinarios" ? "extraordinarios-" : "";
  XLSX.writeFile(wb, `faltantes-compras-${sufijo}${rango}${fecha}.xlsx`);
}
