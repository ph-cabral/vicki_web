// lib/rrhh/asistenciaIndicadores.ts
// Indicadores de Horas y Ausentismo calculados desde la API de fichadas
// (/api/rrhh/asistencia/resumen). Misma lógica de tope/estado que
// app/rrhh/asistencia/page.tsx, centralizada para reusar en las pestañas.

export type ResumenRow = {
  employee_no: string;
  employee_name: string | null;
  departamento: string | null;
  fecha: string; // YYYY-MM-DD
  check_in: string | null;
  check_out: string | null;
  minutos: number | null; // minutos fichados (check_out - check_in)
  eventos_dia: number | null;
  devices: string | null;
  feriado?: boolean; // ver asistencia.feriado / botón "Feriados" en la página
  estado: string | null; // guardado en estado_diario (editable)
  dias: number | null;
  novedad: string | null;
  horas: number | null; // horas de novedad descontadas
};

// Tope diario en minutos (jornada esperada): viernes 480, fin de semana 0, resto 540.
// Usado como fallback cuando no hay horario_tipo asignado (ver buildTopeResolver).
export const topeMin = (fecha: string): number => {
  const dow = new Date(`${fecha}T00:00:00`).getDay(); // 0 Dom .. 6 Sab
  if (dow === 5) return 480;
  if (dow === 0 || dow === 6) return 0;
  return 540;
};

// ── Horarios por área (asistencia.horario_tipo / asistencia.horario_area) ────
// Antes el tope era fijo para todos los empleados. Algunos locales trabajan
// sábado y otros no, así que el tope ahora depende del área/departamento del
// empleado (mismo texto que "departamento" en ResumenRow). Ver
// /api/rrhh/asistencia/horarios y sql/asistencia_horario_tipo.sql.

export type HorarioTipo = {
  id: number;
  nombre: string;
  tope_lun: number;
  tope_mar: number;
  tope_mie: number;
  tope_jue: number;
  tope_vie: number;
  tope_sab: number;
  tope_dom: number;
};

export type HorarioAsignacion = { departamento: string; horario_tipo_id: number };

const DOW_TOPE_FIELDS: (keyof HorarioTipo)[] = [
  "tope_dom",
  "tope_lun",
  "tope_mar",
  "tope_mie",
  "tope_jue",
  "tope_vie",
  "tope_sab",
];

export async function fetchHorarios(): Promise<{
  tipos: HorarioTipo[];
  asignaciones: HorarioAsignacion[];
}> {
  try {
    const r = await fetch("/api/rrhh/asistencia/horarios");
    if (!r.ok) return { tipos: [], asignaciones: [] };
    return r.json();
  } catch {
    return { tipos: [], asignaciones: [] };
  }
}

// Arma (r: ResumenRow) => minutos esperados ese día, según el horario_tipo
// asignado al área del empleado. Un área sin asignación usa "Estándar
// (Lun-Vie)" como fallback. Si todavía no se cargaron tipos (falló el fetch o
// falta correr el SQL en esta base), cae al topeMin(fecha) fijo de siempre.
//
// Feriado (asistencia.feriado / botón "Feriados") siempre pisa el resultado a
// 0, sin importar el horario_tipo asignado: nadie está programado para
// trabajar ese día. Esto hace que cualquier hora trabajada un feriado cuente
// 100% como extra (rrhhMin = min(neto, 0) = 0, extra = neto - 0 = neto) —
// mismo mecanismo que ya existía para un sábado sin horario asignado (tope_sab
// = 0 en "Estándar"). 2026-07-29: marcar quién trabajó un
// sábado o feriado sin tener ese día asignado, y contarlo como hora extra.
export function buildTopeResolver(
  tipos: HorarioTipo[],
  asignaciones: HorarioAsignacion[],
): (r: ResumenRow) => number {
  const base: (r: ResumenRow) => number =
    !tipos || tipos.length === 0
      ? (r) => topeMin(r.fecha)
      : (() => {
          const porId = new Map(tipos.map((t) => [t.id, t]));
          const porArea = new Map(
            asignaciones.map((a) => [a.departamento, a.horario_tipo_id]),
          );
          const estandar =
            tipos.find((t) => t.nombre === "Estándar (Lun-Vie)") ?? tipos[0];
          return (r: ResumenRow) => {
            const dep = (r.departamento ?? "").trim();
            const tipoId = porArea.get(dep);
            const tipo = (tipoId != null ? porId.get(tipoId) : undefined) ?? estandar;
            const dow = new Date(`${r.fecha}T00:00:00`).getDay(); // 0 Dom .. 6 Sab
            return tipo[DOW_TOPE_FIELDS[dow]] as number;
          };
        })();

  return (r) => (r.feriado ? 0 : base(r));
}

const todayLocal = (): string => {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

// Los viajantes trabajan en otras provincias y NO fichan en el reloj: sin
// fichada no se los marca "Ausente" (inflaba horas inactivas y faltas). Si
// fichan igual, o tienen un estado cargado (Vacaciones, Enfermedad, Gira...),
// todo sigue como siempre.
// Directorio tampoco marca.
export const AREAS_NO_FICHAN = ["viajante", "directorio"];
export const noFichaPorArea = (departamento: string | null | undefined): boolean =>
  AREAS_NO_FICHAN.includes((departamento ?? "").trim().toLowerCase());

// Estado auto cuando no hay uno guardado en BD. Si el día es feriado (botón
// "Feriados" en /rrhh/asistencia) y no hay fichaje, no cuenta como falta.
// Con 1 solo fichaje (sin egreso): "Presente" si es hoy (puede seguir
// trabajando), "Revisar" si es un día anterior (2026-07-29).
export const calcEstado = (
  r: ResumenRow,
): "Normal" | "Ausente" | "Revisar" | "Presente" | "Feriado" => {
  if (!r.check_in) {
    if (r.feriado) return "Feriado";
    return noFichaPorArea(r.departamento) ? "Normal" : "Ausente";
  }
  if (!r.check_out) return r.fecha === todayLocal() ? "Presente" : "Revisar";
  if ((r.minutos ?? 0) < 60) return "Revisar";
  return "Normal";
};

// Estado efectivo = el guardado, o el calculado por defecto.
export const effEstado = (r: ResumenRow): string => r.estado ?? calcEstado(r);

// Minutos netos ("En empresa") = fichados − horas de novedad.
export const netMin = (r: ResumenRow): number =>
  Math.max(0, (r.minutos ?? 0) - (r.horas ?? 0) * 60);

// Minutos RRHH = netos con tope diario aplicado. `tope` opcional por si se
// resolvió por área (buildTopeResolver); si no se pasa, cae al topeMin(fecha) fijo.
export const rrhhMin = (r: ResumenRow, tope?: number): number =>
  Math.min(netMin(r), tope ?? topeMin(r.fecha));

// Redondeo RRHH a hora entera: sólo sube a la siguiente hora cuando el resto
// llega a 45 min (9:30 -> 9 hs, 8:45 -> 9 hs). Devuelve minutos.
export const redondeoHoraMin = (min: number): number => {
  const h = Math.floor(min / 60);
  return (min % 60 >= 45 ? h + 1 : h) * 60;
};

// Minutos extra = lo trabajado por encima del tope del día. En un día sin
// tope asignado (sábado sin horario asignado, o feriado — ver
// buildTopeResolver) el tope es 0, así que todo lo trabajado ese día cae acá
// entero. Mismo criterio que `ex` en computeIndicadores, expuesto para poder
// mostrarlo por fila (ej. columna "Extra" en /rrhh/asistencia).
export const extraMin = (r: ResumenRow, tope?: number): number =>
  redondeoHoraMin(Math.max(0, netMin(r) - (tope ?? topeMin(r.fecha))));

// Estados que NO cuentan como ausencia (ajustá esta lista si querés incluir
// "Ausente" como injustificada en el % de ausentismo).
export const ESTADOS_NO_AUSENCIA = [
  "Normal",
  "Ausente",
  "Revisar",
  "Presente",
  "Feriado",
  "Gira comercial",
  "Dia Expo",
];

export type ParArea = { name: string; value: number };

export type Indicadores = {
  totalHoras: number; // Total de horas mensual EW (RRHH, con tope)
  horasExtras: number; // netas por encima del tope
  horasInactivas: number; // tope perdido en días Ausente / Revisar
  ratioExtras: number; // % = extras / total
  ratioInactivas: number; // % = inactivas / total
  ratioAusencia: number; // % de ausencia por jornada hábil
  jornadasEsperadas: number; // jornadas hábiles (tope > 0)
  diasAusencia: number; // días-empleado con ausencia (justificada)
  personasAusentes: number;
  extrasPorArea: ParArea[]; // horas extra por sector
  ausenciaPorMotivo: ParArea[]; // días por estado (excluye Normal/Ausente/Revisar)
  ausenciaPorArea: ParArea[]; // días de ausencia por sector
};

const round1 = (n: number) => Math.round(n * 10) / 10;
const dep = (r: ResumenRow) => (r.departamento ?? "").trim() || "Sin área";

export function computeIndicadores(
  rows: ResumenRow[],
  resolveTope?: (r: ResumenRow) => number,
): Indicadores {
  let totalMin = 0;
  let extrasMin = 0;
  let inactMin = 0;
  let jornadas = 0;
  let diasAus = 0;

  const extrasArea = new Map<string, number>(); // minutos
  const motivo = new Map<string, number>(); // días
  const ausArea = new Map<string, number>(); // días
  const personas = new Set<string>();

  for (const r of rows) {
    const tope = resolveTope ? resolveTope(r) : topeMin(r.fecha);
    const net = netMin(r);
    const rrhh = Math.min(net, tope);
    const est = effEstado(r);

    totalMin += rrhh;
    if (tope > 0) jornadas++;

    // Horas extra: trabajado por encima del tope diario.
    // Redondeado a hora entera (≥45 min sube a la hora siguiente).
    const ex = redondeoHoraMin(Math.max(0, net - tope));
    if (ex > 0) extrasArea.set(dep(r), (extrasArea.get(dep(r)) ?? 0) + ex);
    extrasMin += ex;

    // Horas inactivas: tope perdido en días Ausente / Revisar (Feriado no
    // cuenta: ese día nadie tenía que trabajar).
    if (est === "Ausente" || est === "Revisar") {
      inactMin += Math.max(0, tope - rrhh);
    }

    // Ausentismo (por estado, excluye Normal/Ausente/Revisar) en jornada hábil.
    if (tope > 0 && !ESTADOS_NO_AUSENCIA.includes(est)) {
      diasAus++;
      personas.add(r.employee_no);
      motivo.set(est, (motivo.get(est) ?? 0) + 1);
      ausArea.set(dep(r), (ausArea.get(dep(r)) ?? 0) + 1);
    }
  }

  const totalHoras = totalMin / 60;
  const horasExtras = extrasMin / 60;
  const horasInactivas = inactMin / 60;

  const toHours = (m: Map<string, number>): ParArea[] =>
    [...m.entries()]
      .map(([name, v]) => ({ name, value: round1(v / 60) }))
      .filter((d) => d.value > 0)
      .sort((a, b) => b.value - a.value);
  const toCount = (m: Map<string, number>): ParArea[] =>
    [...m.entries()]
      .map(([name, v]) => ({ name, value: v }))
      .sort((a, b) => b.value - a.value);

  return {
    totalHoras: round1(totalHoras),
    horasExtras: round1(horasExtras),
    horasInactivas: round1(horasInactivas),
    ratioExtras: totalHoras > 0 ? round1((horasExtras / totalHoras) * 100) : 0,
    ratioInactivas: totalHoras > 0 ? round1((horasInactivas / totalHoras) * 100) : 0,
    ratioAusencia: jornadas > 0 ? round1((diasAus / jornadas) * 100) : 0,
    jornadasEsperadas: jornadas,
    diasAusencia: diasAus,
    personasAusentes: personas.size,
    extrasPorArea: toHours(extrasArea),
    ausenciaPorMotivo: toCount(motivo),
    ausenciaPorArea: toCount(ausArea),
  };
}

// Total de horas RRHH (con tope diario aplicado) acumuladas por empleado en
// el período — para comparar contra el objetivo mensual de horas
// (asistencia.horas_objetivo, pestaña Ausentismo) (2026-07-31).
export type HorasEmpleado = {
  employee_no: string;
  employee_name: string | null;
  departamento: string | null;
  minutos: number;
};

export function horasPorEmpleado(
  rows: ResumenRow[],
  resolveTope?: (r: ResumenRow) => number,
): HorasEmpleado[] {
  const m = new Map<string, HorasEmpleado>();
  for (const r of rows) {
    // Quien no ficha por su tarea (viajantes) no se mide contra horas objetivo.
    if (noFichaPorArea(r.departamento)) continue;
    const tope = resolveTope ? resolveTope(r) : topeMin(r.fecha);
    const min = rrhhMin(r, tope);
    const cur = m.get(r.employee_no);
    if (cur) cur.minutos += min;
    else
      m.set(r.employee_no, {
        employee_no: r.employee_no,
        employee_name: r.employee_name,
        departamento: r.departamento,
        minutos: min,
      });
  }
  return [...m.values()].sort((a, b) => a.minutos - b.minutos);
}

// ── Fetch + rango de mes ──────────────────────────────────────────────────────

export async function fetchResumen(desde: string, hasta: string): Promise<ResumenRow[]> {
  const qs = new URLSearchParams({ desde, hasta });
  const r = await fetch(`/api/rrhh/asistencia/resumen?${qs}`);
  if (!r.ok) {
    const e = await r.json().catch(() => ({ error: r.statusText }));
    throw new Error(e?.error ?? "Error al cargar fichadas");
  }
  return r.json();
}

const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export const currentYm = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

// Convierte "YYYY-MM" en rango desde/hasta (hasta acotado al día de hoy).
export function mesRange(ym: string): { desde: string; hasta: string } {
  const [y, m] = ym.split("-").map(Number);
  const last = new Date(y, m, 0).getDate();
  const desde = `${ym}-01`;
  let hasta = `${ym}-${String(last).padStart(2, "0")}`;
  const hoy = ymd(new Date());
  if (hasta > hoy && desde <= hoy) hasta = hoy;
  return { desde, hasta };
}
