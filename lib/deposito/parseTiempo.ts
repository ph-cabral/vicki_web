// Parser de "Tiempo de Pedidos" (lead-time entre etapas del pedido).
// Replica tiempo_pedidos.py sobre "SITD_Tiempo de pedidos.xlsx".

export interface EtapaRow {
  clave: string;        // nombre del mes (o "Prioridad N")
  ops: number;
  regAConf: number; confAArm: number; armACierre: number;   // horas (promedio, valores >= 0)
  regASusp: number; suspAConf: number;
  totalPag1: number;    // reg→conf + conf→arm + arm→cierre
  totalPag2: number;    // reg→susp + susp→conf
}
export interface PrioridadResumen { prioridad: number; cantidad: number; tiempoPromedio: number } // Confirm→Cierre

export interface TiempoData {
  fileName: string;
  parsedAt: string;
  filasCrudas: number;
  filasFiltradas: number;
  meses: string[]; // YYYY-MM
  mesReciente: string | null; // nombre del mes
  metricas: EtapaRow[]; // por mes (cronológico)
  metricas3m: EtapaRow[]; // últimos 3 meses cerrados (sin el mes en curso), independiente del filtro de fechas
  porPrioridad: EtapaRow[]; // mes reciente, prioridad 1/2/3
  prioridades: PrioridadResumen[]; // mes reciente, todas las prioridades
  porPrioridadPorMes: Record<string, EtapaRow[]>;
  prioridadesPorMes: Record<string, PrioridadResumen[]>;
}

const MESES = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
const PEDIDOS = new Set(["10 - Pedido MAYORISTA", "100 - PEDIDO MAYORISTA MOSTRADORES", "210 - Pedido MOVIL", "310 - PEDIDO WEB"]);
const FACTURA = new Set(["11 - FACTURA CTA.CTE. MAYORISTA"]);
const ESTADOS = new Set(["Facturado", "Cerrado"]);

const COL = {
  fecha: "FechaRegistracionPedido", estado: "Estado", cod: "CodComprobante", fac: "CodComprobante_Factura",
  prioridad: "Prioridad", mov: "NroMovVenta",
  regSusp: "Tiempo_Entre_Reg_Suspencion", suspConf: "Tiempo_E_Susp_Confirmacion",
  regConf: "Tiempo_Entre_Reg_Confirmacion", confArm: "Tiempo_Entre_Confirm_IniArmado",
  armCierre: "Tiempo_Entre_Armado_Cierre", confCierre: "Tiempo_E_Confirm_Cierre",
};

type Row = Record<string, unknown>;
const s = (v: unknown) => (v == null ? "" : String(v).trim());
function toHoras(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const n = parseFloat(String(v).trim().replace(",", "."));
  return Number.isFinite(n) ? n : null;
}
function parseFecha(v: unknown): Date | null {
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (v == null) return null;
  const tok = String(v).trim().split(/\s+/)[0];
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(tok);
  if (m) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const d = new Date(y, Number(m[2]) - 1, Number(m[1]));
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? null : d;
}
// promedio de los valores >= 0 (excluye negativos y nulos), igual que calcular_etapa()
function avgNoNeg(vals: (number | null)[]): number {
  const ok = vals.filter((x): x is number => x != null && x >= 0);
  if (!ok.length) return 0;
  return ok.reduce((a, b) => a + b, 0) / ok.length;
}

interface Reg {
  mes: string; nombreMes: string; prioridad: number; enRango: boolean;
  regConf: number | null; confArm: number | null; armCierre: number | null;
  regSusp: number | null; suspConf: number | null; confCierre: number | null;
}

function etapa(regs: Reg[], clave: string): EtapaRow {
  const regAConf = avgNoNeg(regs.map((r) => r.regConf));
  const confAArm = avgNoNeg(regs.map((r) => r.confArm));
  const armACierre = avgNoNeg(regs.map((r) => r.armCierre));
  const regASusp = avgNoNeg(regs.map((r) => r.regSusp));
  const suspAConf = avgNoNeg(regs.map((r) => r.suspConf));
  return {
    clave, ops: regs.length, regAConf, confAArm, armACierre, regASusp, suspAConf,
    totalPag1: regAConf + confAArm + armACierre, totalPag2: regASusp + suspAConf,
  };
}

export function parseTiempo(
  rows: Row[],
  fileName: string,
  opts?: { desde?: string; hasta?: string },
): TiempoData {
  const lo = opts?.desde ? new Date(`${opts.desde}T00:00:00`) : null;
  const hi = opts?.hasta ? new Date(`${opts.hasta}T23:59:59`) : null;
  const todos: Reg[] = [];
  for (const row of rows) {
    if (!PEDIDOS.has(s(row[COL.cod]))) continue;
    if (!FACTURA.has(s(row[COL.fac]))) continue;
    if (!ESTADOS.has(s(row[COL.estado]))) continue;
    const fecha = parseFecha(row[COL.fecha]);
    if (!fecha) continue;
    const enRango = !((lo && fecha < lo) || (hi && fecha > hi));
    const mm = String(fecha.getMonth() + 1).padStart(2, "0");
    todos.push({
      mes: `${fecha.getFullYear()}-${mm}`,
      nombreMes: MESES[fecha.getMonth()],
      prioridad: Number(row[COL.prioridad]), enRango,
      regConf: toHoras(row[COL.regConf]), confArm: toHoras(row[COL.confArm]), armCierre: toHoras(row[COL.armCierre]),
      regSusp: toHoras(row[COL.regSusp]), suspConf: toHoras(row[COL.suspConf]), confCierre: toHoras(row[COL.confCierre]),
    });
  }

  const filtrados = todos.filter((r) => r.enRango);

  // Últimos 3 meses cerrados (sin contar el mes en curso), sin importar el rango elegido.
  const hoy = new Date();
  const ult3: string[] = [];
  for (let i = 3; i >= 1; i--) {
    const d = new Date(hoy.getFullYear(), hoy.getMonth() - i, 1);
    ult3.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  const metricas3m: EtapaRow[] = ult3
    .map((m) => todos.filter((r) => r.mes === m))
    .filter((rs) => rs.length > 0)
    .map((rs) => etapa(rs, rs[0].nombreMes));

  const meses = [...new Set(filtrados.map((r) => r.mes))].sort();
  const metricas: EtapaRow[] = meses.map((m) => {
    const rs = filtrados.filter((r) => r.mes === m);
    return etapa(rs, rs[0]?.nombreMes ?? m);
  });

  const mesRecienteKey = meses.length ? meses[meses.length - 1] : null;
  const mesReciente = mesRecienteKey ? (filtrados.find((r) => r.mes === mesRecienteKey)?.nombreMes ?? null) : null;
  const regsRec = mesRecienteKey ? filtrados.filter((r) => r.mes === mesRecienteKey) : [];

  const porPrioridad: EtapaRow[] = [1, 2, 3]
    .filter((p) => regsRec.some((r) => r.prioridad === p))
    .map((p) => etapa(regsRec.filter((r) => r.prioridad === p), `Prioridad ${p}`));

  const priMap = new Map<number, { cant: number; vals: (number | null)[] }>();
  regsRec.forEach((r) => {
    if (!Number.isFinite(r.prioridad)) return;
    let o = priMap.get(r.prioridad);
    if (!o) { o = { cant: 0, vals: [] }; priMap.set(r.prioridad, o); }
    o.cant += 1; o.vals.push(r.confCierre);
  });
  const prioridades: PrioridadResumen[] = [...priMap.entries()]
    .map(([prioridad, o]) => ({
      prioridad,
      cantidad: o.cant,
      tiempoPromedio: avgNoNeg(o.vals),
    }))
    .sort((a, b) => a.prioridad - b.prioridad);

  const porPrioridadPorMes: Record<string, EtapaRow[]> = {};
  const prioridadesPorMes: Record<string, PrioridadResumen[]> = {};
  for (const mk of meses) {
    const rs = filtrados.filter((r) => r.mes === mk);
    porPrioridadPorMes[mk] = [1, 2, 3]
      .filter((p) => rs.some((r) => r.prioridad === p))
      .map((p) =>
        etapa(
          rs.filter((r) => r.prioridad === p),
          `Prioridad ${p}`,
        ),
      );
    const pm = new Map<number, { cant: number; vals: (number | null)[] }>();
    rs.forEach((r) => {
      if (!Number.isFinite(r.prioridad)) return;
      let o = pm.get(r.prioridad);
      if (!o) {
        o = { cant: 0, vals: [] };
        pm.set(r.prioridad, o);
      }
      o.cant += 1;
      o.vals.push(r.confCierre);
    });
    prioridadesPorMes[mk] = [...pm.entries()]
      .map(([prioridad, o]) => ({
        prioridad,
        cantidad: o.cant,
        tiempoPromedio: avgNoNeg(o.vals),
      }))
      .sort((a, b) => a.prioridad - b.prioridad);
  }

  return {
    fileName,
    parsedAt: new Date().toISOString(),
    filasCrudas: rows.length,
    filasFiltradas: filtrados.length,
    meses,
    mesReciente,
    metricas,
    metricas3m,
    porPrioridad,
    prioridades,
    porPrioridadPorMes,
    prioridadesPorMes,
  };
}
