"use client";

import {
  useEffect,
  useState,
  useCallback,
  useMemo,
  memo,
  useDeferredValue,
} from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { ChevronLeft, ChevronRight, Pencil, Plus, X } from "lucide-react";
import { InicioButton } from "@/components/ui/InicioButton";
import { Input } from "@/components/ui/input";
import { DateRangeField } from "@/components/ui/date-range-field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import {
  fetchHorarios,
  buildTopeResolver,
  type HorarioTipo,
  type HorarioAsignacion,
} from "@/lib/rrhh/asistenciaIndicadores";
import { RegistroButton, type Opcion } from "./components/RegistroModal";
import { UsuarioActual } from "@/components/auth/UsuarioActual";

type Row = {
  employee_no: string;
  employee_name: string | null;
  departamento: string | null;
  sector: string | null;
  lugar: string | null;
  fecha: string;
  check_in: string | null;
  check_out: string | null;
  minutos: number | null;
  eventos_dia: number | null;
  devices: string | null;
  ajustado?: boolean;
  feriado?: boolean;
  estado: string | null;
  dias: number | null;
  novedad: string | null;
  horas: number | null;
};

const todayLocal = () => {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

// Ingreso/Egreso combinado: 24 hs, sin AM/PM, sin cero a la izquierda en la
// hora (ej. "6:05", "18:02") (2026-07-31).
const fmtTime24 = (iso: string | null) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
};

const fmtHHMM = (min: number | null) => {
  if (min == null) return "—";
  const h = Math.floor(min / 60),
    m = Math.round(min % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
};

// Columna RRHH: redondea a la hora entera. Sólo sube a la hora siguiente
// cuando el resto llega a 45 minutos (ej. 9:30 -> "9", 8:45 -> "9"). Pedido
// de RRHH 2026-07-29 — sólo cambia cómo se muestra esta columna, el resto de
// los cálculos (topes, indicadores) siguen usando los minutos exactos.
const fmtHorasRRHH = (min: number | null): string => {
  if (min == null) return "—";
  const h = Math.floor(min / 60);
  const rem = min % 60;
  return String(rem >= 45 ? h + 1 : h);
};

// HH:MM en hora local del navegador, para precargar el input type="time".
const toHHMM = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

// Estado calculado por defecto (uno de: Normal | Ausente | Revisar | Presente
// | Feriado). Si el día está marcado como feriado (botón "Feriados") y no hay
// fichaje, no cuenta como falta: todos los empleados faltarían igual ese día.
// Con 1 solo fichaje (sin egreso): si es el día de hoy todavía puede estar
// trabajando, así que se muestra "Presente"; si es de un día anterior, se
// mantiene "Revisar" (2026-07-29).
const calcEstado = (
  r: Row,
): "Normal" | "Ausente" | "Revisar" | "Presente" | "Feriado" => {
  if (!r.check_in) return r.feriado ? "Feriado" : "Ausente";
  if (!r.check_out) return r.fecha === todayLocal() ? "Presente" : "Revisar";
  if ((r.minutos ?? 0) < 60) return "Revisar";
  return "Normal";
};

// Abreviatura del día de semana, para identificar sábados/domingos de un
// vistazo en la columna Fecha (2026-07-29, junto con la
// columna "Extra").
const DOW_SHORT = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
const dowShort = (fecha: string) =>
  DOW_SHORT[new Date(`${fecha}T00:00:00`).getDay()];
const isSaturday = (fecha: string) =>
  new Date(`${fecha}T00:00:00`).getDay() === 6;

// Tintes sobre fondo oscuro (color/15 + texto 300 + borde /30), el mismo
// criterio de chips que usan las vistas de /deposito y /compras.
const AREA_TONES = [
  "bg-sky-500/15 text-sky-300 border-sky-500/30",
  "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  "bg-amber-500/15 text-amber-300 border-amber-500/30",
  "bg-violet-500/15 text-violet-300 border-violet-500/30",
  "bg-rose-500/15 text-rose-300 border-rose-500/30",
  "bg-cyan-500/15 text-cyan-300 border-cyan-500/30",
  "bg-orange-500/15 text-orange-300 border-orange-500/30",
  "bg-lime-500/15 text-lime-300 border-lime-500/30",
];

const estadoTone = (s: string) => {
  if (s === "Normal")
    return "bg-emerald-500/15 text-emerald-300 border-emerald-500/30";
  if (s === "Ausente") return "bg-zinc-100 text-zinc-700 border-zinc-200";
  if (s === "Revisar") return "bg-amber-500/15 text-amber-300 border-amber-500/30";
  if (s === "Presente") return "bg-blue-500/15 text-blue-300 border-blue-500/30";
  if (s === "Feriado") return "bg-indigo-500/15 text-indigo-300 border-indigo-500/30";
  return "bg-sky-500/15 text-sky-300 border-sky-500/30"; // justificaciones
};

// Editor manual de Ingreso/Egreso — para el caso de un fichaje incompleto
// (entró y no marcó salida, o hay una sola marca a la tarde y falta la de
// la mañana). Sólo aparece cuando falta alguno de los dos lados; permite
// cargar ambos porque la única marca que sí existe puede estar mal
// clasificada (ver sql/asistencia_ajuste_manual.sql).
function HorarioEditor({
  employee_no,
  fecha,
  checkIn,
  checkOut,
  onSaved,
}: {
  employee_no: string;
  fecha: string;
  checkIn: string | null;
  checkOut: string | null;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [ci, setCi] = useState(checkIn ? toHHMM(checkIn) : "");
  const [co, setCo] = useState(checkOut ? toHHMM(checkOut) : "");
  const [saving, setSaving] = useState(false);

  const openModal = () => {
    setCi(checkIn ? toHHMM(checkIn) : "");
    setCo(checkOut ? toHHMM(checkOut) : "");
    setOpen(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      await fetch("/api/rrhh/asistencia/ajuste", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          employee_no,
          fecha,
          check_in: ci ? `${fecha}T${ci}:00-03:00` : null,
          check_out: co ? `${fecha}T${co}:00-03:00` : null,
        }),
      });
      setOpen(false);
      onSaved();
    } catch (err) {
      console.error("[ajuste horario]", err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={openModal}
        title="Asignar horario manualmente"
        className="ml-1 inline-flex text-muted-foreground hover:text-foreground"
      >
        <Pencil className="h-3.5 w-3.5" />
      </button>
      {open &&
        createPortal(
          <div
            className="dark fixed inset-0 z-[200] flex items-center justify-center bg-black/60 p-4 text-white"
            onClick={() => setOpen(false)}
          >
            <div
              className="w-full max-w-xs rounded-lg border bg-popover p-4 shadow-lg"
              onClick={(e) => e.stopPropagation()}
            >
              <h2 className="mb-3 text-sm font-medium">
                Editar horario · {fecha}
              </h2>
              <div className="space-y-3">
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">
                    Ingreso
                  </label>
                  <Input
                    type="time"
                    value={ci}
                    onChange={(e) => setCi(e.target.value)}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">
                    Egreso
                  </label>
                  <Input
                    type="time"
                    value={co}
                    onChange={(e) => setCo(e.target.value)}
                  />
                </div>
              </div>
              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="rounded-md border px-3 py-1 text-xs font-medium hover:bg-accent"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={save}
                  disabled={saving}
                  className="rounded-md bg-yellow-400 px-3 py-1 text-xs font-semibold text-black hover:bg-yellow-300 disabled:opacity-50 transition-colors"
                >
                  {saving ? "Guardando…" : "Guardar"}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

const CAL_WEEKDAYS = ["Lu", "Ma", "Mi", "Ju", "Vi", "Sá", "Do"];
const CAL_MESES = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

// Botón "Feriados": abre un calendario donde se pueden marcar/desmarcar varios
// días como no laborables. Esos días quedan en asistencia.feriado
// (sql/asistencia_feriados.sql) y hacen que calcEstado muestre "Feriado" en vez
// de "Ausente" cuando no hay fichaje, para no ensuciar el control de
// inasistencias con un día en el que nadie trabajó (2026-07-29).
//
// El calendario navega mes a mes con ‹ › (2026-09-10): el tope diario de un
// feriado se pone en 0 y de ahí sale la columna FERIADOS de la planilla mensual
// de novedades, así que hay que poder cargar meses ya cerrados hacia atrás
// —antes sólo se veía el mes en curso y no había forma de completarlos desde la
// pantalla. El endpoint ya aceptaba cualquier rango, no hizo falta tocarlo.
function FeriadosButton({ onSaved }: { onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [feriados, setFeriados] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState<string | null>(null);

  const hoy = new Date();
  const [year, setYear] = useState(hoy.getFullYear());
  const [month, setMonth] = useState(hoy.getMonth()); // 0-based
  const enMesActual =
    year === hoy.getFullYear() && month === hoy.getMonth();

  const mm = String(month + 1).padStart(2, "0");
  const ultimoDia = new Date(year, month + 1, 0).getDate();
  const desdeMes = `${year}-${mm}-01`;
  const hastaMes = `${year}-${mm}-${String(ultimoDia).padStart(2, "0")}`;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ desde: desdeMes, hasta: hastaMes });
      const r = await fetch(`/api/rrhh/asistencia/feriados?${qs}`);
      const data: string[] = r.ok ? await r.json() : [];
      setFeriados(new Set(data));
    } finally {
      setLoading(false);
    }
  }, [desdeMes, hastaMes]);

  // Carga al abrir y en cada cambio de mes. Con el modal cerrado no consulta.
  useEffect(() => {
    if (open) load();
  }, [open, load]);

  const moverMes = (delta: number) => {
    const d = new Date(year, month + delta, 1);
    setYear(d.getFullYear());
    setMonth(d.getMonth());
  };

  const volverAlMesActual = () => {
    setYear(hoy.getFullYear());
    setMonth(hoy.getMonth());
  };

  const openModal = () => {
    volverAlMesActual();
    setOpen(true);
  };

  const toggle = async (fecha: string) => {
    const activo = !feriados.has(fecha);
    setSaving(fecha);
    setFeriados((prev) => {
      const next = new Set(prev);
      if (activo) next.add(fecha);
      else next.delete(fecha);
      return next;
    });
    try {
      await fetch("/api/rrhh/asistencia/feriados", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fecha, activo }),
      });
      onSaved();
    } catch (err) {
      console.error("[feriados]", err);
    } finally {
      setSaving(null);
    }
  };

  const firstWeekday = (new Date(year, month, 1).getDay() + 6) % 7;
  const cells: (number | null)[] = [];
  for (let i = 0; i < firstWeekday; i++) cells.push(null);
  for (let d = 1; d <= ultimoDia; d++) cells.push(d);

  return (
    <>
      <button
        type="button"
        onClick={openModal}
        className="mt-2 ml-3 text-xs text-yellow-400 hover:underline"
      >
        Feriados
      </button>
      {open &&
        createPortal(
          <div
            className="dark fixed inset-0 z-[200] flex items-center justify-center bg-black/60 p-4 text-white"
            onClick={() => setOpen(false)}
          >
            <div
              className="w-full max-w-xs rounded-lg border bg-popover p-4 shadow-lg"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="text-sm font-medium">Feriados</span>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="text-muted-foreground hover:text-foreground"
                >
                  ✕
                </button>
              </div>

              <div className="mb-2 flex items-center justify-between gap-1">
                <button
                  type="button"
                  onClick={() => moverMes(-1)}
                  title="Mes anterior"
                  className="rounded-md border p-1 hover:bg-accent"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={volverAlMesActual}
                  disabled={enMesActual}
                  title={enMesActual ? undefined : "Volver al mes actual"}
                  className={cn(
                    "flex-1 rounded-md px-2 py-1 text-sm font-medium",
                    enMesActual
                      ? "cursor-default"
                      : "hover:bg-accent hover:underline",
                  )}
                >
                  {CAL_MESES[month]} {year}
                </button>
                <button
                  type="button"
                  onClick={() => moverMes(1)}
                  title="Mes siguiente"
                  className="rounded-md border p-1 hover:bg-accent"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>

              <p className="mb-3 text-xs text-muted-foreground">
                Marcá los días no laborables. Esos días no cuentan como falta y
                salen como feriado en la planilla mensual de novedades.
              </p>
              <div
                className={cn(
                  "transition-opacity",
                  loading && "pointer-events-none opacity-40",
                )}
              >
                <div className="grid grid-cols-7 gap-0.5 text-center text-[11px] text-muted-foreground mb-1">
                  {CAL_WEEKDAYS.map((w) => (
                    <div key={w} className="py-1">
                      {w}
                    </div>
                  ))}
                </div>
                <div className="grid grid-cols-7 gap-0.5">
                  {cells.map((d, i) => {
                    if (!d) return <div key={i} />;
                    const fecha = `${year}-${mm}-${String(d).padStart(2, "0")}`;
                    const marcado = feriados.has(fecha);
                    const finde = [0, 6].includes(
                      new Date(`${fecha}T00:00:00`).getDay(),
                    );
                    return (
                      <button
                        key={i}
                        type="button"
                        disabled={saving === fecha}
                        onClick={() => toggle(fecha)}
                        title={fecha}
                        className={cn(
                          "h-7 w-7 mx-auto rounded text-xs transition-colors disabled:opacity-50",
                          marcado
                            ? "bg-yellow-400 text-black font-semibold hover:opacity-90"
                            : finde
                              ? "text-muted-foreground hover:bg-accent"
                              : "hover:bg-accent",
                        )}
                      >
                        {d}
                      </button>
                    );
                  })}
                </div>
              </div>
              <p className="mt-2 text-center text-[11px] text-muted-foreground">
                {loading
                  ? "Cargando…"
                  : feriados.size === 0
                    ? "Sin feriados cargados en este mes"
                    : `${feriados.size} día${feriados.size === 1 ? "" : "s"} marcado${feriados.size === 1 ? "" : "s"}`}
              </p>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

type EmailRegistrado = { id: number; email: string; nombre: string | null };

// Botón "Emails": libreta de correos (asistencia.email_registrado, ver
// sql/asistencia_emails_registrados.sql) — (2026-08-03).
// Alimenta el autocompletado de "invitados" del modal de Estado/Novedad
// (RegistroModal.tsx, step "calendario"); acá se administra: agregar,
// ponerle un nombre para reconocerla más fácil, y borrar. Sin gating de
// ADMIN, mismo criterio que el botón "Feriados".
function EmailsButton() {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [emails, setEmails] = useState<EmailRegistrado[]>([]);
  const [saving, setSaving] = useState(false);
  const [nuevoEmail, setNuevoEmail] = useState("");
  const [nuevoNombre, setNuevoNombre] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/rrhh/asistencia/emails");
      const d = await r.json().catch(() => ({}));
      setEmails(r.ok ? (d.emails ?? []) : []);
    } finally {
      setLoading(false);
    }
  }, []);

  const openModal = () => {
    setOpen(true);
    setError(null);
    load();
  };

  const agregar = async () => {
    const email = nuevoEmail.trim();
    if (!email) return;
    setSaving(true);
    setError(null);
    try {
      const r = await fetch("/api/rrhh/asistencia/emails", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, nombre: nuevoNombre.trim() || undefined }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.error ?? "error al agregar");
      setNuevoEmail("");
      setNuevoNombre("");
      await load();
    } catch (e: any) {
      setError(e?.message ?? "error al agregar");
    } finally {
      setSaving(false);
    }
  };

  const eliminar = async (id: number) => {
    setSaving(true);
    try {
      await fetch("/api/rrhh/asistencia/emails", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      await load();
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={openModal}
        className="mt-2 ml-3 text-xs text-yellow-400 hover:underline"
      >
        Emails
      </button>
      {open &&
        createPortal(
          <div
            className="dark fixed inset-0 z-[200] flex items-center justify-center bg-black/60 p-4 text-white"
            onClick={() => setOpen(false)}
          >
            <div
              className="w-full max-w-sm rounded-lg border bg-popover p-4 shadow-lg"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mb-1 flex items-center justify-between">
                <h2 className="text-sm font-medium">Libreta de emails</h2>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="text-muted-foreground hover:text-foreground"
                >
                  ✕
                </button>
              </div>
              <p className="mb-3 text-xs text-muted-foreground">
                Se usan para sugerir invitados al registrar un Estado/Novedad con calendario.
              </p>
              {error && (
                <p className="mb-2 rounded border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-300">
                  {error}
                </p>
              )}
              {loading ? (
                <p className="py-6 text-center text-sm text-muted-foreground">Cargando…</p>
              ) : (
                <div className="max-h-64 overflow-y-auto rounded border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Email</TableHead>
                        <TableHead>Nombre</TableHead>
                        <TableHead className="w-8" />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {emails.map((em) => (
                        <TableRow key={em.id}>
                          <TableCell className="text-xs">{em.email}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {em.nombre ?? "—"}
                          </TableCell>
                          <TableCell>
                            <button
                              type="button"
                              onClick={() => eliminar(em.id)}
                              disabled={saving}
                              title="Eliminar"
                              className="text-muted-foreground hover:text-red-600 disabled:opacity-50"
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </TableCell>
                        </TableRow>
                      ))}
                      {emails.length === 0 && (
                        <TableRow>
                          <TableCell colSpan={3} className="py-4 text-center text-xs text-muted-foreground">
                            Sin emails cargados todavía.
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </div>
              )}
              <div className="mt-3 flex items-center gap-1.5 border-t pt-2">
                <Input
                  placeholder="correo@empresa.com"
                  value={nuevoEmail}
                  onChange={(e) => setNuevoEmail(e.target.value)}
                  className="h-8 text-xs"
                />
                <Input
                  placeholder="Nombre (opcional)"
                  value={nuevoNombre}
                  onChange={(e) => setNuevoNombre(e.target.value)}
                  className="h-8 w-32 text-xs"
                />
                <button
                  type="button"
                  onClick={agregar}
                  disabled={saving || !nuevoEmail.trim()}
                  title="Agregar email"
                  className="rounded-md border p-1.5 hover:bg-accent disabled:opacity-50"
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

// Fila memoizada: editar/tipear una fila no re-renderiza el resto de la tabla.
const AsistenciaRow = memo(function AsistenciaRow({
  row,
  desde,
  hasta,
  resolveTope,
  estadosOp,
  novedadesOp,
  onSaved,
  onOpcionesChanged,
  onHorarioSaved,
  isAdmin,
}: {
  row: Row;
  desde: string;
  hasta: string;
  resolveTope: (r: Row) => number;
  estadosOp: Opcion[];
  novedadesOp: Opcion[];
  onSaved: () => void;
  onOpcionesChanged: () => void;
  onHorarioSaved: () => void;
  isAdmin: boolean;
}) {
  const est = row.estado ?? calcEstado(row);
  const horasNov = row.horas ?? 0;
  const netMin = Math.max(0, (row.minutos ?? 0) - horasNov * 60);
  const tope = resolveTope(row);
  const rrhhMin = Math.min(netMin, tope);
  return (
    <TableRow>
      <TableCell>
        <Link
          href={`/rrhh/asistencia/${row.employee_no}?desde=${desde}&hasta=${hasta}`}
          className="text-zinc-100 hover:text-yellow-400 hover:underline"
        >
          {row.employee_name ?? `#${row.employee_no}`}
        </Link>
      </TableCell>
      <TableCell>
        {row.fecha}{" "}
        <span
          className={cn(
            "text-xs",
            isSaturday(row.fecha)
              ? "font-medium text-orange-600"
              : "text-muted-foreground",
          )}
        >
          ({dowShort(row.fecha)})
        </span>
      </TableCell>
      <TableCell>
        <div className="flex items-center">
          <span className={row.ajustado ? "italic text-amber-700" : undefined}>
            {fmtTime24(row.check_in)}/{fmtTime24(row.check_out)}
          </span>
          {isAdmin && (!row.check_in || !row.check_out) && (
            <HorarioEditor
              employee_no={row.employee_no}
              fecha={row.fecha}
              checkIn={row.check_in}
              checkOut={row.check_out}
              onSaved={onHorarioSaved}
            />
          )}
        </div>
      </TableCell>
      <TableCell
        title={
          horasNov
            ? `Bruto ${fmtHHMM(row.minutos)} − ${horasNov} hs`
            : undefined
        }
      >
        {fmtHHMM(netMin)}
      </TableCell>
      <TableCell title={`Neto ${fmtHHMM(netMin)} · tope ${fmtHHMM(tope)}`}>
        {fmtHorasRRHH(rrhhMin)}
      </TableCell>
      <TableCell>
        <RegistroButton
          tipo="estado"
          opciones={estadosOp}
          value={est}
          numValue={row.dias}
          numLabel="días"
          placeholder="Estado"
          toneOf={estadoTone}
          employee_no={row.employee_no}
          employee_name={row.employee_name}
          fecha={row.fecha}
          isAdmin={isAdmin}
          onSaved={onSaved}
          onOpcionesChanged={onOpcionesChanged}
        />
      </TableCell>
      <TableCell>
        <div className="flex justify-end">
          <RegistroButton
            tipo="novedad"
            opciones={novedadesOp}
            value={row.novedad}
            numValue={row.horas}
            numLabel="horas"
            placeholder="Novedad"
            toneOf={() => "bg-violet-500/15 text-violet-300 border-violet-500/30"}
            employee_no={row.employee_no}
            employee_name={row.employee_name}
            fecha={row.fecha}
            bruto={row.minutos}
            isAdmin={isAdmin}
            onSaved={onSaved}
            onOpcionesChanged={onOpcionesChanged}
          />
        </div>
      </TableCell>
    </TableRow>
  );
});

export default function AsistenciaPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [empleado, setEmpleado] = useState("");
  const [estado, setEstado] = useState<string>("all");
  const [area, setArea] = useState<string>("all");
  const [sector, setSector] = useState<string>("all");

  // Opciones de Estado/Novedad (antes hardcodeadas en ESTADOS/NOVEDADES) —
  // ver /api/rrhh/asistencia/opciones. genera_calendario define si el botón
  // pide un rango de fechas + Google Calendar en vez del número simple.
  const [opciones, setOpciones] = useState<Opcion[]>([]);
  const loadOpciones = useCallback(async () => {
    try {
      const r = await fetch("/api/rrhh/asistencia/opciones");
      const d = await r.json().catch(() => ({}));
      setOpciones(r.ok ? (d.opciones ?? []) : []);
    } catch (err) {
      console.error("[opciones]", err);
    }
  }, []);
  useEffect(() => {
    loadOpciones();
  }, [loadOpciones]);
  const estadosOp = useMemo(
    () => opciones.filter((o) => o.tipo === "estado"),
    [opciones],
  );
  const novedadesOp = useMemo(
    () => opciones.filter((o) => o.tipo === "novedad"),
    [opciones],
  );

  // El ajuste manual de Ingreso/Egreso sólo lo puede cargar un ADMIN (el
  // endpoint también lo exige — esto es sólo para no mostrar el lápiz a
  // quien de todas formas no puede guardarlo).
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setIsAdmin(d?.usuario?.rol === "ADMIN"))
      .catch(() => setIsAdmin(false));
  }, []);

  // Horarios por área (tope diario) — ver /api/rrhh/asistencia/horarios.
  const [tipos, setTipos] = useState<HorarioTipo[]>([]);
  const [asignaciones, setAsignaciones] = useState<HorarioAsignacion[]>([]);
  const [horariosOpen, setHorariosOpen] = useState(false);

  const loadHorarios = useCallback(async () => {
    const h = await fetchHorarios();
    setTipos(h.tipos);
    setAsignaciones(h.asignaciones);
  }, []);

  useEffect(() => {
    loadHorarios();
  }, [loadHorarios]);

  const resolveTope = useMemo(
    () => buildTopeResolver(tipos, asignaciones),
    [tipos, asignaciones],
  );

  const [desde, setDesde] = useState(todayLocal());
  const [hasta, setHasta] = useState(todayLocal());

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ desde, hasta });
      const r = await fetch(`/api/rrhh/asistencia/resumen?${qs}`);
      if (!r.ok) {
        console.error(await r.json().catch(() => ({ error: r.statusText })));
        setRows([]);
        return;
      }
      const data: Row[] = await r.json();
      setRows(data);
    } finally {
      setLoading(false);
    }
  }, [desde, hasta]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Estado/novedad ahora vienen siempre del server (RegistroButton refresca
  // con fetchData después de cada guardado) — ya no hace falta una capa de
  // "edits" local encima de `rows`.
  const effEstado = (r: Row) => r.estado ?? calcEstado(r);

  const empleadoDef = useDeferredValue(empleado);

  const areas = useMemo(
    () =>
      [
        ...new Set(rows.map((r) => r.departamento).filter(Boolean) as string[]),
      ].sort(),
    [rows],
  );

  const sectores = useMemo(
    () =>
      [...new Set(rows.map((r) => r.sector).filter(Boolean) as string[])].sort(),
    [rows],
  );

  // Widget "presentes": agrupa por lugar (Oficina/Depósito/Fábrica/etc.), no por
  // área — 2026-07-30. Mientras no se le asigne lugar a un legajo
  // desde /rrhh/legajos, cae en el balde "Sin lugar".
  const empleadosPorArea = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) {
      if (!r.check_in || r.check_out) continue; // presentes = marcados sin egreso
      if ((r.departamento ?? "").trim().toLowerCase() === "locales") continue; // no cuenta en este widget
      const a = (r.lugar ?? "").trim() || "Sin lugar";
      m.set(a, (m.get(a) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows]);

  const marcados = useMemo(
    () =>
      rows.filter(
        (r) =>
          r.check_in &&
          !r.check_out &&
          (r.departamento ?? "").trim().toLowerCase() !== "locales",
      ).length,
    [rows],
  );

  const filtered = useMemo(() => {
    const q = empleadoDef.trim().toLowerCase();
    return rows.filter((r) => {
      if (q && !(r.employee_name ?? "").toLowerCase().includes(q)) return false;
      if (estado !== "all" && effEstado(r) !== estado) return false;
      if (area !== "all" && (r.departamento ?? "") !== area) return false;
      if (sector !== "all" && (r.sector ?? "") !== sector) return false;
      return true;
    });
  }, [rows, empleadoDef, estado, area, sector]);

  return (
    // `dark` + el mismo fondo #111111 que /deposito, /compras y /ventas: los
    // componentes de shadcn (Table, Input, Select) resuelven sus variables
    // contra el bloque .dark de globals.css, así que alcanza con envolver.
    // OJO: los modales van por createPortal a document.body, o sea FUERA de
    // este div — cada overlay lleva su propia clase `dark` (ídem SelectContent,
    // que también se portalea).
    <div className="dark min-h-screen bg-[#111111] text-white">
    <div className="container mx-auto px-6 py-8">
      <InicioButton label="Inicio" iconSize={16} className="text-sm text-zinc-500 hover:text-yellow-400 transition-colors mb-4" />
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-yellow-400 font-bold text-xl uppercase tracking-wide">Asistencia</h1>
          <p className="text-sm text-zinc-500 mt-1">
            Empleados activos · estado calculado y editable · novedades por día.
          </p>
          <button
            type="button"
            onClick={() => setHorariosOpen((o) => !o)}
            className="mt-2 text-xs text-yellow-400 hover:underline"
          >
            {horariosOpen ? "Ocultar horarios" : "Configurar horarios por área"}
          </button>
          <FeriadosButton onSaved={fetchData} />
          <EmailsButton />
        </div>
        {empleadosPorArea.length > 0 && (
          <div className="flex flex-col items-center gap-2 rounded-[2rem] border border-zinc-800 bg-[#171717] px-6 py-3">
            <span className="text-sm font-medium">
              Total <span className="font-semibold">{marcados}</span>
            </span>
            <div className="flex flex-wrap justify-center gap-2">
              {empleadosPorArea.map(([a, n], i) => (
                <div
                  key={a}
                  className={cn(
                    "flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium",
                    AREA_TONES[i % AREA_TONES.length],
                  )}
                >
                  <span className="text-sm font-semibold">{n}</span>
                  <span>{a}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        <UsuarioActual className="text-muted-foreground" />
      </header>

      {horariosOpen && (
        <HorariosPanel
          tipos={tipos}
          asignaciones={asignaciones}
          areas={areas}
          onReload={loadHorarios}
        />
      )}

      <div className="sticky top-0 z-40 -mx-6 px-6 py-3 mb-4 bg-[#111111]/95 backdrop-blur border-b border-zinc-800 grid grid-cols-1 md:grid-cols-6 gap-3">
        <Input
          placeholder="Empleado…"
          value={empleado}
          onChange={(e) => setEmpleado(e.target.value)}
        />
        <Select value={estado} onValueChange={setEstado}>
          <SelectTrigger>
            <SelectValue placeholder="Estado" />
          </SelectTrigger>
          <SelectContent className="dark">
            <SelectItem value="all">Todos los estados</SelectItem>
            {estadosOp.map((s) => (
              <SelectItem key={s.id} value={s.nombre}>
                {s.nombre}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={sector} onValueChange={setSector}>
          <SelectTrigger>
            <SelectValue placeholder="Sector" />
          </SelectTrigger>
          <SelectContent className="dark">
            <SelectItem value="all">Todos los sectores</SelectItem>
            {sectores.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={area} onValueChange={setArea}>
          <SelectTrigger>
            <SelectValue placeholder="Área" />
          </SelectTrigger>
          <SelectContent className="dark">
            <SelectItem value="all">Todas las áreas</SelectItem>
            {areas.map((a) => (
              <SelectItem key={a} value={a}>
                {a}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="md:col-span-2">
          <DateRangeField
            desde={desde}
            hasta={hasta}
            onChange={(d, h) => {
              setDesde(d);
              setHasta(h);
            }}
            variant="light"
            className="w-full"
          />
        </div>
      </div>

      <div className="rounded-lg bg-[#171717] border border-zinc-800 overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-[#1f1f1f] hover:bg-[#1f1f1f] [&>th]:text-[10px] [&>th]:font-semibold [&>th]:uppercase [&>th]:tracking-wider [&>th]:text-zinc-500 [&>th]:border-b [&>th]:border-zinc-800">
              <TableHead>Empleado</TableHead>
              <TableHead>Fecha</TableHead>
              <TableHead>Ingreso/Egreso</TableHead>
              <TableHead>En empresa</TableHead>
              <TableHead>RRHH</TableHead>
              <TableHead>Estado</TableHead>
              <TableHead className="text-right">Novedad</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && (
              <TableRow>
                <TableCell
                  colSpan={7}
                  className="text-center py-8 text-muted-foreground"
                >
                  Cargando…
                </TableCell>
              </TableRow>
            )}
            {!loading && filtered.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={7}
                  className="text-center py-8 text-muted-foreground"
                >
                  Sin resultados
                </TableCell>
              </TableRow>
            )}
            {filtered.map((r) => (
              <AsistenciaRow
                key={`${r.employee_no}|${r.fecha}-${r.devices}`}
                row={r}
                desde={desde}
                hasta={hasta}
                resolveTope={resolveTope}
                estadosOp={estadosOp}
                novedadesOp={novedadesOp}
                onSaved={fetchData}
                onOpcionesChanged={loadOpciones}
                onHorarioSaved={fetchData}
                isAdmin={isAdmin}
              />
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
    </div>
  );
}

// Panel de administración: editar los topes (minutos esperados por día de
// semana) de cada horario_tipo, y asignar cada área a un tipo. Un área sin
// asignación usa "Estándar (Lun-Vie)" por defecto (ver buildTopeResolver).
function HorariosPanel({
  tipos,
  asignaciones,
  areas,
  onReload,
}: {
  tipos: HorarioTipo[];
  asignaciones: HorarioAsignacion[];
  areas: string[];
  onReload: () => Promise<void>;
}) {
  const [saving, setSaving] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<number, HorarioTipo>>({});
  const [nuevo, setNuevo] = useState({
    nombre: "",
    tope_lun: "540",
    tope_mar: "540",
    tope_mie: "540",
    tope_jue: "540",
    tope_vie: "480",
    tope_sab: "0",
    tope_dom: "0",
  });

  const DIAS: { key: keyof HorarioTipo; label: string }[] = [
    { key: "tope_lun", label: "Lun" },
    { key: "tope_mar", label: "Mar" },
    { key: "tope_mie", label: "Mié" },
    { key: "tope_jue", label: "Jue" },
    { key: "tope_vie", label: "Vie" },
    { key: "tope_sab", label: "Sáb" },
    { key: "tope_dom", label: "Dom" },
  ];

  const valOf = (t: HorarioTipo, key: keyof HorarioTipo) =>
    draft[t.id]?.[key] ?? t[key];

  const setVal = (t: HorarioTipo, key: keyof HorarioTipo, v: string) => {
    const n = parseInt(v, 10) || 0;
    setDraft((prev) => ({
      ...prev,
      [t.id]: { ...(prev[t.id] ?? t), [key]: n },
    }));
  };

  const guardarTipo = async (t: HorarioTipo) => {
    setSaving(`tipo-${t.id}`);
    try {
      const d = draft[t.id] ?? t;
      await fetch("/api/rrhh/asistencia/horarios", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "tipo", id: t.id, ...d }),
      });
      await onReload();
    } finally {
      setSaving(null);
    }
  };

  const crearTipo = async () => {
    if (!nuevo.nombre.trim()) return;
    setSaving("nuevo");
    try {
      await fetch("/api/rrhh/asistencia/horarios", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "tipo",
          nombre: nuevo.nombre,
          tope_lun: parseInt(nuevo.tope_lun, 10) || 0,
          tope_mar: parseInt(nuevo.tope_mar, 10) || 0,
          tope_mie: parseInt(nuevo.tope_mie, 10) || 0,
          tope_jue: parseInt(nuevo.tope_jue, 10) || 0,
          tope_vie: parseInt(nuevo.tope_vie, 10) || 0,
          tope_sab: parseInt(nuevo.tope_sab, 10) || 0,
          tope_dom: parseInt(nuevo.tope_dom, 10) || 0,
        }),
      });
      setNuevo({
        nombre: "",
        tope_lun: "540",
        tope_mar: "540",
        tope_mie: "540",
        tope_jue: "540",
        tope_vie: "480",
        tope_sab: "0",
        tope_dom: "0",
      });
      await onReload();
    } finally {
      setSaving(null);
    }
  };

  const asignarArea = async (departamento: string, horario_tipo_id: string) => {
    setSaving(`area-${departamento}`);
    try {
      await fetch("/api/rrhh/asistencia/horarios", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "asignacion",
          departamento,
          horario_tipo_id: horario_tipo_id ? Number(horario_tipo_id) : null,
        }),
      });
      await onReload();
    } finally {
      setSaving(null);
    }
  };

  const asignacionDe = (a: string) =>
    asignaciones.find((x) => x.departamento === a)?.horario_tipo_id ?? "";

  return (
    <div className="mb-6 rounded-lg bg-[#171717] border border-zinc-800 p-4 space-y-6">
      <div>
        <h2 className="text-sm font-medium mb-2">
          Tipos de horario (minutos esperados por día)
        </h2>
        <div className="space-y-2">
          {tipos.map((t) => (
            <div
              key={t.id}
              className="flex flex-wrap items-center gap-2 rounded border p-2"
            >
              <span className="w-40 text-sm font-medium">{t.nombre}</span>
              {DIAS.map((d) => (
                <div key={d.key} className="flex flex-col items-center">
                  <label className="text-[10px] text-muted-foreground">
                    {d.label}
                  </label>
                  <Input
                    type="number"
                    min={0}
                    value={valOf(t, d.key)}
                    onChange={(e) => setVal(t, d.key, e.target.value)}
                    className="h-8 w-16"
                  />
                </div>
              ))}
              <button
                type="button"
                onClick={() => guardarTipo(t)}
                disabled={saving === `tipo-${t.id}`}
                className="ml-auto rounded-md bg-yellow-400 px-3 py-1 text-xs font-semibold text-black hover:bg-yellow-300 disabled:opacity-50 transition-colors"
              >
                {saving === `tipo-${t.id}` ? "Guardando…" : "Guardar"}
              </button>
            </div>
          ))}
          {tipos.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Sin tipos de horario cargados todavía (falta correr el SQL en la
              base). Mientras tanto se usa el tope fijo de siempre.
            </p>
          )}
        </div>

        <div className="mt-3 flex flex-wrap items-end gap-2 rounded border border-dashed p-2">
          <div className="flex flex-col">
            <label className="text-[10px] text-muted-foreground">
              Nuevo tipo
            </label>
            <Input
              placeholder="Nombre"
              value={nuevo.nombre}
              onChange={(e) => setNuevo((p) => ({ ...p, nombre: e.target.value }))}
              className="h-8 w-40"
            />
          </div>
          {DIAS.map((d) => (
            <div key={d.key} className="flex flex-col items-center">
              <label className="text-[10px] text-muted-foreground">
                {d.label}
              </label>
              <Input
                type="number"
                min={0}
                value={(nuevo as any)[d.key]}
                onChange={(e) =>
                  setNuevo((p) => ({ ...p, [d.key]: e.target.value }))
                }
                className="h-8 w-16"
              />
            </div>
          ))}
          <button
            type="button"
            onClick={crearTipo}
            disabled={saving === "nuevo" || !nuevo.nombre.trim()}
            className="rounded-md border px-3 py-1 text-xs font-medium hover:bg-accent disabled:opacity-50"
          >
            {saving === "nuevo" ? "Creando…" : "+ Agregar tipo"}
          </button>
        </div>
      </div>

      <div>
        <h2 className="text-sm font-medium mb-2">Área → tipo de horario</h2>
        {areas.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No hay áreas para mostrar todavía (cargá datos en el rango de
            fechas de la tabla).
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {areas.map((a) => (
              <div
                key={a}
                className="flex items-center gap-2 rounded border p-2"
              >
                <span className="text-sm">{a}</span>
                <select
                  className="h-8 rounded-md border bg-background px-2 text-sm"
                  value={String(asignacionDe(a))}
                  disabled={saving === `area-${a}`}
                  onChange={(e) => asignarArea(a, e.target.value)}
                >
                  <option value="">Estándar (por defecto)</option>
                  {tipos.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.nombre}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
