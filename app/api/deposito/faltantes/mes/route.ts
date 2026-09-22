import { NextRequest, NextResponse } from "next/server";
import {
  FaltanteMesRow,
  leerFaltanteMes,
  leerFaltanteMesExistente,
  mesValido,
  registrarFaltanteMes,
} from "@/lib/deposito/faltanteMes";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// ─────────────────────────────────────────────────────────────────────────────
// Acumulado mensual del faltante — DOS series, 1 fila por (mes, artículo) cada
// una, nunca varias del mismo artículo:
//
//   sinExistencia → preparado.faltante_mes           (marcado "sin existencia":
//                                                      faltante real de stock)
//   enExistencia  → preparado.faltante_mes_existente  (marcado "en existencia"
//                                                      pero no se cumplió igual
//                                                      — falla de proceso, no
//                                                      de stock)
// Lo pendiente y lo "mal facturado" no entran en ninguna de las dos.
//
//   GET  ?mes=YYYY-MM              → lo ya registrado (lectura barata: 2
//                                    SELECT a Postgres).
//        ?mes=YYYY-MM&refrescar=1  → recalcula primero (join marca × detalle)
//                                    y devuelve. Si el mes está vacío,
//                                    recalcula igual.
//   POST { mes }                   → registra/recalcula ese mes. Es lo que
//                                    corre el job diario. Sin body, toma el
//                                    mes en curso.
//
// El recálculo es idempotente (ver lib/deposito/faltanteMes.ts).
// ─────────────────────────────────────────────────────────────────────────────

function mesActual(): string {
  return new Date().toISOString().slice(0, 7);
}

function armarResumen(rows: FaltanteMesRow[]) {
  return {
    articulos: rows.length,
    unidades: +rows.reduce((a, r) => a + r.unidades, 0).toFixed(3),
    importe: +rows.reduce((a, r) => a + r.importe, 0).toFixed(2),
    renglones: rows.reduce((a, r) => a + r.renglones, 0),
  };
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const mes = sp.get("mes") ?? mesActual();
  if (!mesValido(mes)) {
    return NextResponse.json(
      { error: "mes requerido, formato YYYY-MM" },
      { status: 400 },
    );
  }
  const refrescar = sp.get("refrescar") === "1";

  try {
    let sinRows: FaltanteMesRow[] = [];
    let conRows: FaltanteMesRow[] = [];
    let desde: string | null = null;
    let hasta: string | null = null;
    let tablaWarn = false;
    let motivo: string | undefined;

    if (!refrescar) {
      [sinRows, conRows] = await Promise.all([
        leerFaltanteMes(mes),
        leerFaltanteMesExistente(mes),
      ]);
    }

    if (refrescar || (!sinRows.length && !conRows.length)) {
      const registro = await registrarFaltanteMes(mes);
      desde = registro.desde;
      hasta = registro.hasta;
      if (registro.guardado) {
        [sinRows, conRows] = await Promise.all([
          leerFaltanteMes(mes),
          leerFaltanteMesExistente(mes),
        ]);
      } else {
        // Sin tablas todavía: se devuelve el total ya calculado en el
        // recálculo (aunque no se haya podido persistir) para que la vista
        // muestre un número, con tablaWarn avisando que no se acumula nada.
        tablaWarn = true;
        motivo = registro.motivo;
        return NextResponse.json({
          mes,
          desde,
          hasta,
          sinExistencia: { total: 0, rows: [], resumen: registro.sinExistencia },
          enExistencia: { total: 0, rows: [], resumen: registro.enExistencia },
          tablaWarn,
          motivo,
        });
      }
    }

    return NextResponse.json({
      mes,
      desde,
      hasta,
      sinExistencia: { total: sinRows.length, rows: sinRows, resumen: armarResumen(sinRows) },
      enExistencia: { total: conRows.length, rows: conRows, resumen: armarResumen(conRows) },
      tablaWarn,
    });
  } catch (error) {
    console.error("GET /api/deposito/faltantes/mes", error);
    return NextResponse.json(
      { error: "Error al leer el acumulado del mes" },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  let mes = mesActual();
  try {
    const b = await req.json().catch(() => ({}));
    if (mesValido(b?.mes)) mes = b.mes;
  } catch {
    /* body vacío → mes en curso */
  }

  try {
    const r = await registrarFaltanteMes(mes);
    return NextResponse.json({ ok: r.guardado, ...r });
  } catch (error) {
    console.error("POST /api/deposito/faltantes/mes", error);
    return NextResponse.json(
      { ok: false, error: "No se pudo registrar el mes" },
      { status: 500 },
    );
  }
}
