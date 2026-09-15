"use client";

// Selector de rango de fechas: un solo trigger (botón, no editable a mano) +
// un solo calendario emergente. Click en el 1er día fija el inicio y NO
// cierra; click en un 2do día define el cierre del rango (ordena low/high
// solo, sin importar el orden de click) y ahí sí cierra. También cierra al
// clickear afuera o con Escape. Mientras se está eligiendo el 2do día, el
// hover pinta en vivo los días que va a abarcar el rango.
//
// Reemplaza los pares de <input type="date"> (Desde/Hasta) sueltos y el
// <DateField> (con tipeo manual) donde antes había 2 controles separados.

import * as React from "react";
import { CalendarIcon, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/* ---------------- utils fecha (ISO yyyy-mm-dd) ---------------- */

const pad = (n: number) => String(n).padStart(2, "0");

const isoToDate = (iso?: string | null): Date | null => {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return isNaN(d.getTime()) ? null : d;
};

const dateToIso = (d: Date): string =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const isoToDisplay = (iso?: string | null): string => {
  const d = isoToDate(iso);
  return d ? `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}` : "";
};

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

const WEEKDAYS = ["Lu", "Ma", "Mi", "Ju", "Vi", "Sá", "Do"];
const MONTHS = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

/* ---------------- utils "mes" (yyyy-mm), para MonthRangeField ---------------- */

const monthKeyOf = (iso: string) => iso.slice(0, 7); // "yyyy-mm-dd" → "yyyy-mm"

// Primer/último día ISO de un mes "yyyy-mm".
const monthBounds = (ym: string): [string, string] => {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!m) return ["", ""];
  const y = +m[1];
  const mo = +m[2];
  return [dateToIso(new Date(y, mo - 1, 1)), dateToIso(new Date(y, mo, 0))];
};

// Últimos N meses "yyyy-mm" (más reciente primero, incluye el actual).
const lastMonths = (n: number): string[] => {
  const hoy = new Date();
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(hoy.getFullYear(), hoy.getMonth() - i, 1);
    out.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}`);
  }
  return out;
};

const monthLabel = (ym: string): string => {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!m) return ym;
  return `${MONTHS[+m[2] - 1]} ${m[1]}`;
};

/**
 * Primer y último día ISO del último mes calendario completo (el anterior al
 * actual) — pensado como default inicial para MonthRangeField (2026-08-20: el filtro de Depósito arranca en el mes pasado, no en
 * "hoy").
 */
export function lastFullMonthRange(): [string, string] {
  const hoy = new Date();
  const anterior = new Date(hoy.getFullYear(), hoy.getMonth() - 1, 1);
  return monthBounds(`${anterior.getFullYear()}-${pad(anterior.getMonth() + 1)}`);
}

/* ---------------- estilos por variante visual ---------------- */

type Variant = "dark" | "light";

const STYLES: Record<
  Variant,
  {
    trigger: string;
    triggerOpen: string;
    icon: string;
    popup: string;
    weekday: string;
    day: string;
    dayToday: string;
    dayInRange: string;
    dayEndpoint: string;
    dayDisabled: string;
    navBtn: string;
    monthLabel: string;
    /** Select nativo de mes de MonthRangeField. */
    select: string;
  }
> = {
  // Tema oscuro hex usado en deposito/*, compras/faltantes (bg #1f1f1f, acento amarillo).
  dark: {
    trigger:
      "flex items-center gap-2 h-8 px-2.5 rounded-lg border border-zinc-700 bg-[#1f1f1f] text-zinc-100 text-sm cursor-pointer select-none hover:border-zinc-500 transition-colors",
    triggerOpen: "border-yellow-400",
    icon: "text-zinc-500",
    popup: "rounded-lg border border-zinc-700 bg-[#1A1A1A] shadow-xl",
    weekday: "text-zinc-500",
    day: "text-zinc-200 hover:bg-zinc-700/60",
    dayToday: "border border-zinc-600",
    dayInRange: "bg-yellow-400/15 text-yellow-100",
    dayEndpoint: "bg-yellow-400 text-black hover:bg-yellow-400 font-medium",
    dayDisabled: "opacity-30 cursor-not-allowed hover:bg-transparent",
    navBtn: "text-zinc-400 hover:bg-zinc-700/60 hover:text-zinc-100",
    monthLabel: "text-zinc-200",
    select:
      "h-8 px-2.5 rounded-lg border border-zinc-700 bg-[#1f1f1f] text-zinc-100 text-sm cursor-pointer select-none outline-none focus:border-yellow-400 hover:border-zinc-500 transition-colors",
  },
  // Tema shadcn (tokens de tema) usado en rrhh/asistencia.
  light: {
    trigger:
      "flex h-8 items-center gap-2 rounded-lg border border-input bg-transparent px-2.5 text-sm text-foreground cursor-pointer select-none transition-colors dark:bg-input/30 hover:border-ring/60",
    triggerOpen: "border-ring ring-3 ring-ring/50",
    icon: "text-muted-foreground",
    popup: "rounded-lg border border-border bg-popover text-popover-foreground shadow-md",
    weekday: "text-muted-foreground",
    day: "text-foreground hover:bg-accent hover:text-accent-foreground",
    dayToday: "border border-border",
    dayInRange: "bg-accent text-accent-foreground",
    dayEndpoint: "bg-primary text-primary-foreground hover:bg-primary font-medium",
    dayDisabled: "opacity-30 cursor-not-allowed hover:bg-transparent",
    navBtn: "hover:bg-accent",
    monthLabel: "",
    select:
      "h-8 px-2.5 rounded-lg border border-input bg-transparent text-sm text-foreground cursor-pointer select-none outline-none focus:border-ring dark:bg-input/30 hover:border-ring/60 transition-colors",
  },
};

export interface DateRangeFieldProps {
  /** Fecha desde, ISO yyyy-mm-dd. */
  desde: string;
  /** Fecha hasta, ISO yyyy-mm-dd. */
  hasta: string;
  /** Se llama una sola vez por selección, siempre con desde <= hasta. */
  onChange: (desde: string, hasta: string) => void;
  /** Día mínimo seleccionable (ISO), opcional. */
  min?: string;
  /** Día máximo seleccionable (ISO), opcional — ej. "hoy" para no elegir futuro. */
  max?: string;
  variant?: Variant;
  /** Lado por el que se alinea el desplegable respecto del trigger. */
  align?: "start" | "end";
  placeholder?: string;
  className?: string;
}

export function DateRangeField({
  desde,
  hasta,
  onChange,
  min,
  max,
  variant = "dark",
  align = "start",
  placeholder = "Elegir fechas",
  className,
}: DateRangeFieldProps) {
  const s = STYLES[variant];
  const [open, setOpen] = React.useState(false);
  // Día ya clickeado en esta sesión de selección; null = todavía no eligió el
  // 1er día (o ya cerró el rango y espera un click para arrancar de nuevo).
  const [pendingStart, setPendingStart] = React.useState<Date | null>(null);
  const [hoverDay, setHoverDay] = React.useState<Date | null>(null);
  const wrapRef = React.useRef<HTMLDivElement>(null);

  const desdeDate = isoToDate(desde);
  const hastaDate = isoToDate(hasta);
  const minDate = isoToDate(min);
  const maxDate = isoToDate(max);

  const [cursor, setCursor] = React.useState<Date>(() => desdeDate ?? new Date());

  const openPicker = () => {
    setPendingStart(null);
    setHoverDay(null);
    setCursor(desdeDate ?? new Date());
    setOpen(true);
  };

  const closePicker = () => {
    setOpen(false);
    setPendingStart(null);
    setHoverDay(null);
  };

  // Cierra al clickear afuera del trigger/popover, o con Escape.
  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        closePicker();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closePicker();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const handleDayClick = (d: Date) => {
    if (!pendingStart) {
      // 1er click: fija el inicio ya mismo (desde = hasta = ese día) y sigue abierto.
      setPendingStart(d);
      onChange(dateToIso(d), dateToIso(d));
    } else {
      // 2do click: cierra el rango (ordenado) y el desplegable.
      const lo = d < pendingStart ? d : pendingStart;
      const hi = d < pendingStart ? pendingStart : d;
      onChange(dateToIso(lo), dateToIso(hi));
      closePicker();
    }
  };

  // Límites a pintar: si hay una selección en curso, preview en vivo contra el
  // hover; si no, el rango ya confirmado (desde/hasta).
  let rangeLo: Date | null;
  let rangeHi: Date | null;
  if (pendingStart) {
    const other = hoverDay ?? pendingStart;
    if (other < pendingStart) {
      rangeLo = other;
      rangeHi = pendingStart;
    } else {
      rangeLo = pendingStart;
      rangeHi = other;
    }
  } else {
    rangeLo = desdeDate;
    rangeHi = hastaDate;
  }

  const label =
    desdeDate && hastaDate
      ? sameDay(desdeDate, hastaDate)
        ? isoToDisplay(desde)
        : `${isoToDisplay(desde)} – ${isoToDisplay(hasta)}`
      : placeholder;

  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const firstOfMonth = new Date(year, month, 1);
  const firstWeekday = (firstOfMonth.getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = startOfDay(new Date());

  const cells: (Date | null)[] = [];
  for (let i = 0; i < firstWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(year, month, d));
  while (cells.length % 7 !== 0) cells.push(null);

  const isDisabled = (d: Date) => {
    if (minDate && d < minDate) return true;
    if (maxDate && d > maxDate) return true;
    return false;
  };

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => (open ? closePicker() : openPicker())}
        className={cn(s.trigger, open && s.triggerOpen, className)}
      >
        <CalendarIcon className={cn("h-3.5 w-3.5 shrink-0", s.icon)} />
        <span className="whitespace-nowrap tabular-nums">{label}</span>
      </button>

      {open && (
        <div
          className={cn(
            "absolute top-full mt-1.5 p-3 w-[260px] select-none z-50",
            align === "end" ? "right-0" : "left-0",
            s.popup,
          )}
          onMouseLeave={() => setHoverDay(null)}
        >
          <div className="flex items-center justify-between mb-2">
            <button
              type="button"
              onClick={() => setCursor(new Date(year, month - 1, 1))}
              className={cn("p-1 rounded", s.navBtn)}
              aria-label="Mes anterior"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <div className={cn("text-sm font-medium", s.monthLabel)}>
              {MONTHS[month]} {year}
            </div>
            <button
              type="button"
              onClick={() => setCursor(new Date(year, month + 1, 1))}
              className={cn("p-1 rounded", s.navBtn)}
              aria-label="Mes siguiente"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>

          <div className={cn("grid grid-cols-7 gap-0.5 text-center text-[11px] mb-1", s.weekday)}>
            {WEEKDAYS.map((w) => (
              <div key={w} className="py-1">
                {w}
              </div>
            ))}
          </div>

          <div className="grid grid-cols-7 gap-0.5">
            {cells.map((d, i) => {
              if (!d) return <div key={i} />;
              const disabled = isDisabled(d);
              const isToday = sameDay(d, today);
              const isStart = !!rangeLo && sameDay(d, rangeLo);
              const isEnd = !!rangeHi && sameDay(d, rangeHi);
              const inRange = !!rangeLo && !!rangeHi && d >= rangeLo && d <= rangeHi;
              return (
                <button
                  key={i}
                  type="button"
                  disabled={disabled}
                  // Evita que el mousedown le saque foco al trigger antes del click.
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => pendingStart && setHoverDay(d)}
                  onClick={() => handleDayClick(d)}
                  className={cn(
                    "h-7 w-7 mx-auto rounded text-xs transition-colors",
                    s.day,
                    isToday && !isStart && !isEnd && s.dayToday,
                    inRange && !disabled && s.dayInRange,
                    (isStart || isEnd) && !disabled && s.dayEndpoint,
                    disabled && s.dayDisabled,
                  )}
                >
                  {d.getDate()}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------- MonthRangeField (2 meses: Desde / Hasta) ---------------- */

// Filtro de Depósito: 2 selects de mes calendario, uno al lado del otro
// ("Desde" / "Hasta"), sin calendario de días ni toggle de modo. 2026-08-20 — primero se probó con toggle "Mes"/"Rango" (día a día),
// pero se pidió sacar la opción de días: acá SOLO se elige mes, nunca un día
// suelto dentro del mes. Cada select ofrece los últimos `monthsBack` meses
// (incluye el actual, más reciente al final para leer de izquierda a
// derecha). Si se elige un "Desde" posterior al "Hasta" actual (o viceversa),
// el otro extremo se ajusta solo para que el rango nunca quede invertido.
export interface MonthRangeFieldProps {
  /** Primer día ISO del mes "desde". */
  desde: string;
  /** Último día ISO del mes "hasta". */
  hasta: string;
  /** Se llama con el primer día del mes "desde" y el último día del mes "hasta". */
  onChange: (desde: string, hasta: string) => void;
  variant?: Variant;
  className?: string;
  /** Cuántos meses atrás ofrecer en cada select (incluye el actual). Default 24. */
  monthsBack?: number;
}

export function MonthRangeField({
  desde,
  hasta,
  onChange,
  variant = "dark",
  className,
  monthsBack = 24,
}: MonthRangeFieldProps) {
  const s = STYLES[variant];
  // lastMonths() da más reciente primero; para leer "Desde → Hasta" de
  // izquierda a derecha en los <select>, se muestran en orden cronológico.
  const meses = React.useMemo(() => [...lastMonths(monthsBack)].reverse(), [monthsBack]);

  const desdeYm = desde ? monthKeyOf(desde) : "";
  const hastaYm = hasta ? monthKeyOf(hasta) : "";

  const elegirDesde = (ym: string) => {
    if (!ym) return;
    const hastaFinal = hastaYm && hastaYm >= ym ? hastaYm : ym;
    const [d] = monthBounds(ym);
    const [, h] = monthBounds(hastaFinal);
    onChange(d, h);
  };
  const elegirHasta = (ym: string) => {
    if (!ym) return;
    const desdeFinal = desdeYm && desdeYm <= ym ? desdeYm : ym;
    const [d] = monthBounds(desdeFinal);
    const [, h] = monthBounds(ym);
    onChange(d, h);
  };

  return (
    <div className={cn("flex items-center gap-1.5", className)}>
      <select
        value={meses.includes(desdeYm) ? desdeYm : ""}
        onChange={(e) => elegirDesde(e.target.value)}
        className={s.select}
        aria-label="Mes desde"
      >
        {!meses.includes(desdeYm) && <option value="">Desde</option>}
        {meses.map((ym) => (
          <option key={ym} value={ym}>
            {monthLabel(ym)}
          </option>
        ))}
      </select>
      <span className="text-zinc-600 text-xs shrink-0">–</span>
      <select
        value={meses.includes(hastaYm) ? hastaYm : ""}
        onChange={(e) => elegirHasta(e.target.value)}
        className={s.select}
        aria-label="Mes hasta"
      >
        {!meses.includes(hastaYm) && <option value="">Hasta</option>}
        {meses.map((ym) => (
          <option key={ym} value={ym}>
            {monthLabel(ym)}
          </option>
        ))}
      </select>
    </div>
  );
}

/* ---------------- MonthRangePickerField (1 input, popup con grilla de meses) ---------------- */

// Mismo patrón de interacción que DateRangeField (1 solo trigger + 1 solo
// popup; 1er click fija el mes de inicio y NO cierra; 2do click define el
// cierre del rango —ordenado solo— y ahí sí cierra; hover previsualiza el
// rango mientras se elige el 2do mes; cierra con click afuera o Escape) pero
// la grilla del popup son los 12 meses del año (con nav ◀ año ▶) en vez de
// los días de un mes. Para vistas que agrupan todo por mes calendario
// (ej. /deposito/pedidos) donde no tiene sentido elegir un día suelto.
export interface MonthRangePickerFieldProps {
  /** Primer día ISO del mes "desde". */
  desde: string;
  /** Último día ISO del mes "hasta". */
  hasta: string;
  /** Se llama una sola vez por selección, con el primer día del mes "desde" y el último día del mes "hasta". */
  onChange: (desde: string, hasta: string) => void;
  /** Mes mínimo seleccionable (ISO "yyyy-mm" o "yyyy-mm-dd"), opcional. */
  min?: string;
  /** Mes máximo seleccionable (ISO "yyyy-mm" o "yyyy-mm-dd"), opcional — ej. el mes actual para no elegir futuro. */
  max?: string;
  variant?: Variant;
  /** Lado por el que se alinea el desplegable respecto del trigger. */
  align?: "start" | "end";
  placeholder?: string;
  className?: string;
}

export function MonthRangePickerField({
  desde,
  hasta,
  onChange,
  min,
  max,
  variant = "dark",
  align = "start",
  placeholder = "Elegir meses",
  className,
}: MonthRangePickerFieldProps) {
  const s = STYLES[variant];
  const [open, setOpen] = React.useState(false);
  // "yyyy-mm" ya clickeado en esta sesión de selección; null = todavía no
  // eligió el 1er mes (o ya cerró el rango y espera un click para arrancar de nuevo).
  const [pendingStart, setPendingStart] = React.useState<string | null>(null);
  const [hoverYm, setHoverYm] = React.useState<string | null>(null);
  const wrapRef = React.useRef<HTMLDivElement>(null);

  const desdeYm = desde ? monthKeyOf(desde) : "";
  const hastaYm = hasta ? monthKeyOf(hasta) : "";
  const minYm = min ? monthKeyOf(min) : "";
  const maxYm = max ? monthKeyOf(max) : "";

  const [cursorYear, setCursorYear] = React.useState<number>(() =>
    desdeYm ? +desdeYm.slice(0, 4) : new Date().getFullYear(),
  );

  const openPicker = () => {
    setPendingStart(null);
    setHoverYm(null);
    setCursorYear(desdeYm ? +desdeYm.slice(0, 4) : new Date().getFullYear());
    setOpen(true);
  };
  const closePicker = () => {
    setOpen(false);
    setPendingStart(null);
    setHoverYm(null);
  };

  // Cierra al clickear afuera del trigger/popover, o con Escape.
  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) closePicker();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closePicker();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const ymOf = (year: number, monthIdx: number) => `${year}-${pad(monthIdx + 1)}`;

  const isDisabled = (ym: string) => {
    if (minYm && ym < minYm) return true;
    if (maxYm && ym > maxYm) return true;
    return false;
  };

  const handleMonthClick = (ym: string) => {
    if (isDisabled(ym)) return;
    if (!pendingStart) {
      // 1er click: fija el inicio ya mismo (desde = hasta = ese mes) y sigue abierto.
      setPendingStart(ym);
      const [d, h] = monthBounds(ym);
      onChange(d, h);
    } else {
      // 2do click: cierra el rango (ordenado) y el desplegable.
      const lo = ym < pendingStart ? ym : pendingStart;
      const hi = ym < pendingStart ? pendingStart : ym;
      const [d] = monthBounds(lo);
      const [, h] = monthBounds(hi);
      onChange(d, h);
      closePicker();
    }
  };

  // Límites a pintar: si hay una selección en curso, preview en vivo contra el
  // hover; si no, el rango ya confirmado (desde/hasta).
  let rangeLo: string | null;
  let rangeHi: string | null;
  if (pendingStart) {
    const other = hoverYm ?? pendingStart;
    if (other < pendingStart) {
      rangeLo = other;
      rangeHi = pendingStart;
    } else {
      rangeLo = pendingStart;
      rangeHi = other;
    }
  } else {
    rangeLo = desdeYm || null;
    rangeHi = hastaYm || null;
  }

  const label =
    desdeYm && hastaYm
      ? desdeYm === hastaYm
        ? monthLabel(desdeYm)
        : `${monthLabel(desdeYm)} – ${monthLabel(hastaYm)}`
      : placeholder;

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => (open ? closePicker() : openPicker())}
        className={cn(s.trigger, open && s.triggerOpen, className)}
      >
        <CalendarIcon className={cn("h-3.5 w-3.5 shrink-0", s.icon)} />
        <span className="whitespace-nowrap tabular-nums">{label}</span>
      </button>

      {open && (
        <div
          className={cn(
            "absolute top-full mt-1.5 p-3 w-[220px] select-none z-50",
            align === "end" ? "right-0" : "left-0",
            s.popup,
          )}
          onMouseLeave={() => setHoverYm(null)}
        >
          <div className="flex items-center justify-between mb-2">
            <button
              type="button"
              onClick={() => setCursorYear((y) => y - 1)}
              className={cn("p-1 rounded", s.navBtn)}
              aria-label="Año anterior"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <div className={cn("text-sm font-medium", s.monthLabel)}>{cursorYear}</div>
            <button
              type="button"
              onClick={() => setCursorYear((y) => y + 1)}
              className={cn("p-1 rounded", s.navBtn)}
              aria-label="Año siguiente"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>

          <div className="grid grid-cols-3 gap-1">
            {MONTHS.map((mName, i) => {
              const ym = ymOf(cursorYear, i);
              const disabled = isDisabled(ym);
              const isStart = !!rangeLo && ym === rangeLo;
              const isEnd = !!rangeHi && ym === rangeHi;
              const inRange = !!rangeLo && !!rangeHi && ym >= rangeLo && ym <= rangeHi;
              return (
                <button
                  key={ym}
                  type="button"
                  disabled={disabled}
                  // Evita que el mousedown le saque foco al trigger antes del click.
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => pendingStart && setHoverYm(ym)}
                  onClick={() => handleMonthClick(ym)}
                  className={cn(
                    "h-8 rounded text-xs transition-colors",
                    s.day,
                    inRange && !disabled && s.dayInRange,
                    (isStart || isEnd) && !disabled && s.dayEndpoint,
                    disabled && s.dayDisabled,
                  )}
                >
                  {mName.slice(0, 3)}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
