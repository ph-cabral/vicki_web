// lib/rrhh/novedadTramo.ts
//
// Novedades que corren con las marcas del reloj (asistencia.novedad_tramo),
// 2026-10-16. Función pura: dado el día de un empleado (marcas + horario
// asignado) resuelve desde/hasta/minutos de cada novedad y su estado.
//
//   modo "sale"        : desde la marca de SALIDA hasta la marca de VUELTA.
//                        Sin vuelta: hasta la hora de salida del horario.
//   modo "llega_tarde" : desde la hora de ENTRADA del horario hasta la
//                        primera marca del día.
//
// Marcas (mismo criterio que /api/rrhh/asistencia/resumen): posición impar =
// ingreso, par = egreso. Es decir marcas[0] ingresa, marcas[1] egresa,
// marcas[2] vuelve, etc.
//
// El tiempo de una novedad ya NO está dentro de los "minutos" fichados (es
// tiempo fuera de la empresa o previo a la primera marca), así que no se resta
// de nuevo: es información para RRHH (justifica la salida / la tardanza).

export type TramoModo = "sale" | "llega_tarde";

export type TramoEstado =
  | "esperando" // cargada, todavía sin la marca que la dispara  → AVISO
  | "sin_marca" // día pasado y nunca hubo la marca             → AVISO
  | "en_curso" // ya salió, todavía no volvió (corriendo)
  | "cerrada" // con marcas de inicio y fin
  | "asumida" // no volvió: se asume hasta la hora de salida
  | "a_horario" // llegó a horario, no hubo demora
  | "sin_horario"; // falta hora_entrada/hora_salida en el tipo de horario

export type TramoRow = {
  id: number;
  employee_no: string;
  fecha: string; // YYYY-MM-DD
  novedad: string;
  modo: TramoModo;
  creado_at: string; // ISO
};

export type TramoHorario = {
  entrada: string | null; // "HH:MM"
  salida: string | null; // "HH:MM" (ya resuelta para el día: viernes = salida_vie)
};

export type TramoResuelto = TramoRow & {
  estado: TramoEstado;
  inicio: string | null; // ISO
  fin: string | null; // ISO
  minutos: number | null;
  alerta: boolean;
};

const AR_OFFSET = "-03:00"; // Argentina no usa horario de verano
const MARGEN_MS = 5 * 60 * 1000; // 2 marcas a menos de 5 min = 1 sola

const at = (fecha: string, hhmm: string | null): Date | null => {
  if (!hhmm) return null;
  const hm = hhmm.slice(0, 5);
  const d = new Date(`${fecha}T${hm}:00${AR_OFFSET}`);
  return Number.isNaN(d.getTime()) ? null : d;
};

export const hoyAR = (ahora: Date): string =>
  new Date(ahora.getTime() - 3 * 3600_000).toISOString().slice(0, 10);

// Colapsa marcas duplicadas (el reloj a veces tipea dos veces) igual que el
// resumen: una "isla" arranca cuando el hueco con la anterior es >= 5 min y
// se queda con la primera de la isla.
export function dedupeMarcas(times: Date[]): Date[] {
  const s = [...times].sort((a, b) => a.getTime() - b.getTime());
  const out: Date[] = [];
  let prev: Date | null = null;
  for (const t of s) {
    if (!prev || t.getTime() - prev.getTime() >= MARGEN_MS) out.push(t);
    prev = t;
  }
  return out;
}

const minDiff = (a: Date, b: Date) =>
  Math.max(0, Math.floor((b.getTime() - a.getTime()) / 60_000));

export function resolverTramos(
  tramos: TramoRow[],
  marcasRaw: Date[],
  horario: TramoHorario,
  ahora: Date,
): TramoResuelto[] {
  const marcas = dedupeMarcas(marcasRaw);
  const hoy = hoyAR(ahora);
  const ordenados = [...tramos].sort(
    (a, b) => new Date(a.creado_at).getTime() - new Date(b.creado_at).getTime(),
  );
  const usados = new Set<number>(); // índices de egreso ya tomados por otra novedad

  return ordenados.map((t): TramoResuelto => {
    const base = { ...t, inicio: null, fin: null, minutos: null } as TramoResuelto;
    const pasado = t.fecha < hoy;
    const alertaDe = (e: TramoEstado) => e === "esperando" || e === "sin_marca";
    const out = (e: TramoEstado, p: Partial<TramoResuelto> = {}): TramoResuelto => ({
      ...base,
      ...p,
      estado: e,
      alerta: alertaDe(e),
    });

    // ── Llega tarde: horario.entrada → primera marca ────────────────────────
    if (t.modo === "llega_tarde") {
      const ent = at(t.fecha, horario.entrada);
      if (!ent) {
        // Con marca igual mostramos la hora de llegada, pero sin horario no hay demora.
        return out("sin_horario", {
          fin: marcas[0]?.toISOString() ?? null,
        });
      }
      const primera = marcas[0];
      if (primera) {
        if (primera.getTime() <= ent.getTime()) {
          return out("a_horario", {
            inicio: ent.toISOString(),
            fin: primera.toISOString(),
            minutos: 0,
          });
        }
        return out("cerrada", {
          inicio: ent.toISOString(),
          fin: primera.toISOString(),
          minutos: minDiff(ent, primera),
        });
      }
      if (pasado) return out("sin_marca", { inicio: ent.toISOString() });
      // Hoy y sin marca: avisa; si ya pasó la hora de entrada, muestra lo que lleva.
      return out("esperando", {
        inicio: ent.toISOString(),
        minutos: ahora.getTime() > ent.getTime() ? minDiff(ent, ahora) : null,
      });
    }

    // ── Sale: marca de salida → marca de vuelta ─────────────────────────────
    const creado = new Date(t.creado_at).getTime();
    // Egresos = marcas en posición par (índices 1, 3, 5…).
    const egresos: number[] = [];
    for (let i = 1; i < marcas.length; i += 2) egresos.push(i);
    const libres = egresos.filter((i) => !usados.has(i));

    // 1) Si cuando se cargó la novedad el empleado ya estaba afuera (salió
    //    antes y todavía no había vuelto), esa es su salida.
    let elegido: number | null = null;
    const previos = libres.filter((i) => marcas[i].getTime() <= creado);
    const ultimoPrevio = previos[previos.length - 1];
    if (ultimoPrevio !== undefined) {
      const vuelta = marcas[ultimoPrevio + 1];
      if (!vuelta || vuelta.getTime() > creado) elegido = ultimoPrevio;
    }
    // 2) Si no, la primera salida posterior a la carga.
    if (elegido === null) {
      const f = libres.find((i) => marcas[i].getTime() > creado);
      if (f !== undefined) elegido = f;
    }

    if (elegido === null) return out(pasado ? "sin_marca" : "esperando");
    usados.add(elegido);

    const salida = marcas[elegido];
    const vuelta = marcas[elegido + 1] ?? null;
    if (vuelta) {
      return out("cerrada", {
        inicio: salida.toISOString(),
        fin: vuelta.toISOString(),
        minutos: minDiff(salida, vuelta),
      });
    }

    // No hay vuelta: se asume hasta la hora de salida del horario.
    const fin = at(t.fecha, horario.salida);
    if (!pasado && (!fin || ahora.getTime() < fin.getTime())) {
      return out("en_curso", {
        inicio: salida.toISOString(),
        minutos: minDiff(salida, ahora),
      });
    }
    if (!fin) return out("sin_horario", { inicio: salida.toISOString() });
    return out("asumida", {
      inicio: salida.toISOString(),
      fin: fin.toISOString(),
      minutos: minDiff(salida, fin),
    });
  });
}
