"use client";

// Botón + modal que reemplaza al viejo Picker de Estado/Novedad en
// /rrhh/asistencia — (2026-08-01).
//
// El botón muestra el nombre arriba y el número (días/horas) abajo, si hay.
// Al hacer click se abre un modal con las opciones en grilla ("ladrillos").
// Si la opción elegida tiene genera_calendario = true (ver
// /api/rrhh/asistencia/opciones), en vez de pedir un número pide un RANGO de
// fechas en un calendario (un solo mes, con navegación) y qué Google
// Calendar usar; al confirmar crea el evento de todo el día y marca esos
// días en la base (/api/rrhh/asistencia/rango). Si no, se comporta como
// antes: pide el número simple y guarda con /api/rrhh/asistencia/novedad.
//
// Un ADMIN puede, desde la propia grilla, togglear qué opciones generan
// evento de Calendar y agregar opciones nuevas.

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CalendarDays, Plus, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export type Opcion = {
  id: number;
  tipo: "estado" | "novedad";
  nombre: string;
  genera_calendario: boolean;
  orden: number;
  activo: boolean;
};

type Calendario = { id: string; nombre: string; primary: boolean };

const CAL_WEEKDAYS = ["Lu", "Ma", "Mi", "Ju", "Vi", "Sá", "Do"];
const CAL_MESES = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

const pad2 = (n: number) => String(n).padStart(2, "0");
const toISO = (y: number, m: number, d: number) => `${y}-${pad2(m + 1)}-${pad2(d)}`;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Step = "bricks" | "numero" | "rango" | "calendario";

type EmailRegistrado = { id: number; email: string; nombre: string | null };

export function RegistroButton({
  tipo,
  opciones,
  value,
  numValue,
  numLabel,
  placeholder,
  toneOf,
  employee_no,
  employee_name,
  fecha,
  bruto,
  isAdmin,
  onSaved,
  onOpcionesChanged,
}: {
  tipo: "estado" | "novedad";
  opciones: Opcion[];
  value?: string | null;
  numValue?: number | null;
  numLabel: "días" | "horas";
  placeholder: string;
  toneOf: (nombre: string) => string;
  employee_no: string;
  employee_name: string | null;
  fecha: string;
  bruto?: number | null;
  isAdmin: boolean;
  onSaved: () => void;
  onOpcionesChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>("bricks");
  const [selected, setSelected] = useState<Opcion | null>(null);
  const [numVal, setNumVal] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nuevoNombre, setNuevoNombre] = useState("");

  // Rango de fechas.
  const hoy = new Date();
  const [calMonth, setCalMonth] = useState(hoy.getMonth());
  const [calYear, setCalYear] = useState(hoy.getFullYear());
  const [rangeStart, setRangeStart] = useState<string | null>(null);
  const [rangeEnd, setRangeEnd] = useState<string | null>(null);
  // Sólo para tipo "novedad": a diferencia de estado (que es el día entero,
  // sólo importa cuántos días), una novedad son horas puntuales dentro de
  // cada día del rango (ej. "Est. Med." 2 hs/día durante 5 días) — (2026-08-02).
  const [horasDia, setHorasDia] = useState("");

  // Calendarios de Google (paso final del flujo con calendario).
  const [calendarios, setCalendarios] = useState<Calendario[] | null>(null);
  const [calendariosError, setCalendariosError] = useState<string | null>(null);
  const [calendarioId, setCalendarioId] = useState("");
  // Invitados puntuales del evento — (2026-08-03): además del
  // calendario base (que ya tiene agregada a la gente que siempre lo ve), a
  // veces hace falta sumar a alguien puntual a ese registro. Se eligen como
  // pills fijas contra la libreta de asistencia.email_registrado (ver
  // /api/rrhh/asistencia/emails), desmarcadas por default — click las
  // marca/desmarca para ESTE registro. El "+" del input de abajo no suma
  // directo acá: abre un modal chico que guarda el email en la libreta para
  // que quede disponible como pill de ahora en más.
  const [invitados, setInvitados] = useState<string[]>([]);
  const [invitadoInput, setInvitadoInput] = useState("");
  const [emailsRegistrados, setEmailsRegistrados] = useState<EmailRegistrado[] | null>(null);
  // Modal chico para sumar un email nuevo a la libreta (asistencia.email_
  // registrado) sin salir del registro — (2026-08-03): el
  // "+" de abajo antes sumaba directo como invitado puntual de ESTE evento;
  // ahora guarda en la libreta y aparece como pill fijo (desmarcado) para
  // marcar acá o en cualquier registro futuro.
  const [nuevoEmailOpen, setNuevoEmailOpen] = useState(false);
  const [nuevoEmailValor, setNuevoEmailValor] = useState("");
  const [nuevoEmailNombre, setNuevoEmailNombre] = useState("");
  const [nuevoEmailSaving, setNuevoEmailSaving] = useState(false);
  const [nuevoEmailError, setNuevoEmailError] = useState<string | null>(null);

  const resetTransient = () => {
    setStep("bricks");
    setSelected(null);
    setNumVal("");
    setError(null);
    setNuevoNombre("");
    setRangeStart(null);
    setRangeEnd(null);
    setHorasDia("");
    setCalendarios(null);
    setCalendariosError(null);
    setCalendarioId("");
    setInvitados([]);
    setInvitadoInput("");
    setEmailsRegistrados(null);
    setNuevoEmailOpen(false);
    setNuevoEmailValor("");
    setNuevoEmailNombre("");
    setNuevoEmailError(null);
  };

  const close = () => {
    if (saving) return;
    setOpen(false);
    resetTransient();
  };

  const openModal = () => {
    resetTransient();
    setCalMonth(hoy.getMonth());
    setCalYear(hoy.getFullYear());
    setOpen(true);
  };

  const pickOpcion = (op: Opcion) => {
    setSelected(op);
    setError(null);
    if (op.genera_calendario) {
      setStep("rango");
    } else {
      setNumVal(op.nombre === value && numValue != null ? String(numValue) : "");
      setStep("numero");
    }
  };

  // ── Guardado simple (sin calendario) ────────────────────────────────────
  const guardarSimple = async (quitar = false) => {
    if (!selected && !quitar) return;
    setSaving(true);
    setError(null);
    try {
      const body: any = {
        employee_no,
        fecha,
        kind: tipo,
        value: quitar ? null : selected!.nombre,
        num: quitar ? null : numVal || null,
      };
      if (tipo === "novedad") body.bruto = bruto ?? 0;
      const r = await fetch("/api/rrhh/asistencia/novedad", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d?.error ?? "error al guardar");
      }
      onSaved();
      close();
    } catch (e: any) {
      setError(e?.message ?? "error al guardar");
    } finally {
      setSaving(false);
    }
  };

  // ── Paso calendario: carga la lista al entrar ───────────────────────────
  useEffect(() => {
    if (step !== "calendario" || calendarios !== null) return;
    setCalendariosError(null);
    fetch("/api/rrhh/asistencia/calendarios")
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d?.error ?? "no se pudo listar los calendarios");
        return d.calendarios as Calendario[];
      })
      .then((cs) => {
        setCalendarios(cs);
        const def = cs.find((c) => c.primary) ?? cs[0];
        if (def) setCalendarioId(def.id);
      })
      .catch((e) => setCalendariosError(e?.message ?? "error"));
  }, [step, calendarios]);

  // ── Paso calendario: carga la libreta de emails para sugerir invitados ──
  useEffect(() => {
    if (step !== "calendario" || emailsRegistrados !== null) return;
    fetch("/api/rrhh/asistencia/emails")
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        return (r.ok ? d.emails : []) as EmailRegistrado[];
      })
      .then(setEmailsRegistrados)
      .catch(() => setEmailsRegistrados([]));
  }, [step, emailsRegistrados]);

  // Pills fijas: togglear un email de la libreta como invitado de ESTE
  // registro — no persiste nada, sólo entra en el POST a /rango.
  const toggleInvitado = (email: string) => {
    setInvitados((prev) =>
      prev.includes(email) ? prev.filter((e) => e !== email) : [...prev, email],
    );
  };

  // "+" del input de abajo: ya no suma directo como invitado puntual de este
  // evento — abre el modal chico para guardar el email en la libreta
  // (asistencia.email_registrado). Una vez guardado aparece como pill nueva,
  // desmarcada, acá y en cualquier registro futuro.
  const abrirNuevoEmail = () => {
    const limpio = invitadoInput.trim();
    if (!EMAIL_RE.test(limpio)) return;
    setNuevoEmailValor(limpio);
    setNuevoEmailNombre("");
    setNuevoEmailError(null);
    setNuevoEmailOpen(true);
  };

  const guardarNuevoEmail = async () => {
    const email = nuevoEmailValor.trim();
    if (!EMAIL_RE.test(email)) {
      setNuevoEmailError("Email inválido");
      return;
    }
    setNuevoEmailSaving(true);
    setNuevoEmailError(null);
    try {
      const r = await fetch("/api/rrhh/asistencia/emails", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, nombre: nuevoEmailNombre.trim() || undefined }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.error ?? "error al agregar");
      const rl = await fetch("/api/rrhh/asistencia/emails");
      const dl = await rl.json().catch(() => ({}));
      setEmailsRegistrados(rl.ok ? (dl.emails ?? []) : []);
      setInvitadoInput("");
      setNuevoEmailOpen(false);
    } catch (e: any) {
      setNuevoEmailError(e?.message ?? "error al agregar");
    } finally {
      setNuevoEmailSaving(false);
    }
  };

  const horasDiaNum = parseInt(horasDia, 10);
  const horasDiaValida = tipo !== "novedad" || (Number.isFinite(horasDiaNum) && horasDiaNum > 0);

  const confirmarRango = async () => {
    if (!selected || !rangeStart || !rangeEnd || !calendarioId || !horasDiaValida) return;
    setSaving(true);
    setError(null);
    try {
      const r = await fetch("/api/rrhh/asistencia/rango", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          employee_no,
          tipo,
          nombre: selected.nombre,
          desde: rangeStart,
          hasta: rangeEnd,
          calendar_id: calendarioId,
          ...(tipo === "novedad" ? { horas: horasDiaNum } : {}),
          ...(invitados.length > 0 ? { invitados } : {}),
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.error ?? "error al registrar");
      onSaved();
      close();
    } catch (e: any) {
      setError(e?.message ?? "error al registrar");
    } finally {
      setSaving(false);
    }
  };

  // ── Admin: togglear genera_calendario / agregar opción ──────────────────
  const toggleGenera = async (op: Opcion, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await fetch("/api/rrhh/asistencia/opciones", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: op.id, genera_calendario: !op.genera_calendario }),
      });
      onOpcionesChanged();
    } catch (err) {
      console.error("[opciones toggle]", err);
    }
  };

  const agregarOpcion = async () => {
    const nombre = nuevoNombre.trim();
    if (!nombre) return;
    setSaving(true);
    try {
      await fetch("/api/rrhh/asistencia/opciones", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tipo, nombre }),
      });
      setNuevoNombre("");
      onOpcionesChanged();
    } catch (err) {
      console.error("[opciones add]", err);
    } finally {
      setSaving(false);
    }
  };

  // ── Grilla del mes para el paso "rango" ─────────────────────────────────
  const cells = useMemo(() => {
    const firstWeekday = (new Date(calYear, calMonth, 1).getDay() + 6) % 7;
    const ultimoDia = new Date(calYear, calMonth + 1, 0).getDate();
    const out: (number | null)[] = [];
    for (let i = 0; i < firstWeekday; i++) out.push(null);
    for (let d = 1; d <= ultimoDia; d++) out.push(d);
    return out;
  }, [calYear, calMonth]);

  const clickDia = (d: number) => {
    const iso = toISO(calYear, calMonth, d);
    if (!rangeStart || (rangeStart && rangeEnd)) {
      setRangeStart(iso);
      setRangeEnd(null);
      return;
    }
    if (iso < rangeStart) {
      setRangeEnd(rangeStart);
      setRangeStart(iso);
    } else {
      setRangeEnd(iso);
    }
  };

  const cambiarMes = (delta: number) => {
    let m = calMonth + delta;
    let y = calYear;
    if (m < 0) { m = 11; y -= 1; }
    if (m > 11) { m = 0; y += 1; }
    setCalMonth(m);
    setCalYear(y);
  };

  const num = numValue != null ? numValue : null;
  const btnClass = cn(
    "flex min-w-[64px] flex-col items-center justify-center gap-0 rounded-md border px-2.5 py-1 leading-tight hover:opacity-90",
    value ? toneOf(value) : "bg-muted text-muted-foreground border-transparent",
  );

  return (
    <>
      <button type="button" onClick={openModal} className={btnClass}>
        <span className="text-xs font-medium">{value ?? placeholder}</span>
        {num != null && (
          <span className="text-[10px] opacity-75">
            {num}
            {numLabel === "días" ? "d" : "h"}
          </span>
        )}
      </button>

      {open &&
        createPortal(
          <div
            className="dark fixed inset-0 z-[200] flex items-center justify-center bg-black/60 p-4 text-white"
            onClick={close}
          >
            <div
              className={cn(
                "w-full rounded-lg border bg-popover p-4 shadow-lg",
                step === "rango" && tipo === "novedad" ? "max-w-md" : "max-w-sm",
              )}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-medium">
                  {tipo === "estado" ? "Estado" : "Novedad"} · {employee_name ?? employee_no} ·{" "}
                  {fecha}
                </h2>
                <button
                  type="button"
                  onClick={close}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              {error && (
                <p className="mb-3 rounded border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-300">
                  {error}
                </p>
              )}

              {step === "bricks" && (
                <>
                  {value && (
                    <button
                      type="button"
                      onClick={() => guardarSimple(true)}
                      disabled={saving}
                      className="mb-2 text-xs text-muted-foreground hover:text-red-400 hover:underline disabled:opacity-50"
                    >
                      Quitar {tipo === "estado" ? "estado" : "novedad"} actual
                    </button>
                  )}
                  <div className="grid grid-cols-3 gap-1.5">
                    {opciones.map((op) => (
                      <button
                        key={op.id}
                        type="button"
                        onClick={() => pickOpcion(op)}
                        className={cn(
                          "relative rounded-md border px-2 py-2 text-xs font-medium hover:opacity-90",
                          op.nombre === value
                            ? toneOf(op.nombre)
                            : "bg-muted/60 text-foreground border-transparent hover:bg-accent",
                        )}
                      >
                        {op.nombre}
                        {isAdmin && (
                          <span
                            role="button"
                            onClick={(e) => toggleGenera(op, e)}
                            title={
                              op.genera_calendario
                                ? "Genera evento en Calendar (click para desactivar)"
                                : "No genera evento en Calendar (click para activar)"
                            }
                            className={cn(
                              "absolute -right-1 -top-1 rounded-full border bg-background p-0.5",
                              op.genera_calendario
                                ? "text-indigo-300 border-indigo-500/40"
                                : "text-muted-foreground/50 border-transparent",
                            )}
                          >
                            <CalendarDays className="h-3 w-3" />
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                  {isAdmin && (
                    <div className="mt-3 flex items-center gap-1.5 border-t pt-2">
                      <Input
                        placeholder="Nueva opción…"
                        value={nuevoNombre}
                        onChange={(e) => setNuevoNombre(e.target.value)}
                        className="h-7 text-xs"
                      />
                      <button
                        type="button"
                        onClick={agregarOpcion}
                        disabled={saving || !nuevoNombre.trim()}
                        title="Agregar opción"
                        className="rounded-md border p-1.5 hover:bg-accent disabled:opacity-50"
                      >
                        <Plus className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )}
                </>
              )}

              {step === "numero" && selected && (
                <div>
                  <p className="mb-2 text-sm">
                    <span className="font-medium">{selected.nombre}</span> — ¿cuántos {numLabel}?
                  </p>
                  <Input
                    type="number"
                    min={0}
                    inputMode="numeric"
                    autoFocus
                    value={numVal}
                    onChange={(e) => setNumVal(e.target.value)}
                    placeholder={numLabel}
                    className="h-9"
                  />
                  <div className="mt-4 flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setStep("bricks")}
                      className="rounded-md border px-3 py-1 text-xs font-medium hover:bg-accent"
                    >
                      Atrás
                    </button>
                    <button
                      type="button"
                      onClick={() => guardarSimple(false)}
                      disabled={saving}
                      className="rounded-md bg-yellow-400 px-3 py-1 text-xs font-semibold text-black hover:bg-yellow-300 disabled:opacity-50 transition-colors"
                    >
                      {saving ? "Guardando…" : "Guardar"}
                    </button>
                  </div>
                </div>
              )}

              {step === "rango" && selected && (
                <div>
                  <p className="mb-2 text-sm">
                    <span className="font-medium">{selected.nombre}</span> — elegí el rango de
                    fechas
                  </p>
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
                    <div className="shrink-0">
                      <div className="mb-1 flex items-center justify-between">
                        <button
                          type="button"
                          onClick={() => cambiarMes(-1)}
                          className="rounded px-2 py-1 text-sm hover:bg-accent"
                        >
                          ‹
                        </button>
                        <span className="text-xs font-medium">
                          {CAL_MESES[calMonth]} {calYear}
                        </span>
                        <button
                          type="button"
                          onClick={() => cambiarMes(1)}
                          className="rounded px-2 py-1 text-sm hover:bg-accent"
                        >
                          ›
                        </button>
                      </div>
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
                          const iso = toISO(calYear, calMonth, d);
                          const isEdge = iso === rangeStart || iso === rangeEnd;
                          const inRange =
                            rangeStart && rangeEnd && iso >= rangeStart && iso <= rangeEnd;
                          return (
                            <button
                              key={i}
                              type="button"
                              onClick={() => clickDia(d)}
                              title={iso}
                              className={cn(
                                "h-7 w-7 mx-auto rounded text-xs transition-colors",
                                isEdge
                                  ? "bg-yellow-400 text-black font-semibold hover:opacity-90"
                                  : inRange
                                    ? "bg-yellow-400/15 text-yellow-300"
                                    : "hover:bg-accent",
                              )}
                            >
                              {d}
                            </button>
                          );
                        })}
                      </div>
                      <p className="mt-2 text-xs text-muted-foreground">
                        {rangeStart && !rangeEnd && "Ahora elegí el último día."}
                        {rangeStart &&
                          rangeEnd &&
                          `${rangeStart} al ${rangeEnd}`}
                        {!rangeStart && "Elegí el primer día."}
                      </p>
                    </div>
                    {tipo === "novedad" && (
                      <div className="sm:w-28 sm:pt-6">
                        <label className="mb-1 block text-xs text-muted-foreground">
                          ¿Cuántas horas por día?
                        </label>
                        <Input
                          type="number"
                          min={1}
                          inputMode="numeric"
                          value={horasDia}
                          onChange={(e) => setHorasDia(e.target.value)}
                          placeholder="horas"
                          className="h-9 w-24"
                        />
                      </div>
                    )}
                  </div>
                  <div className="mt-4 flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setStep("bricks")}
                      className="rounded-md border px-3 py-1 text-xs font-medium hover:bg-accent"
                    >
                      Atrás
                    </button>
                    <button
                      type="button"
                      disabled={!rangeStart || !rangeEnd || !horasDiaValida}
                      onClick={() => setStep("calendario")}
                      className="rounded-md bg-yellow-400 px-3 py-1 text-xs font-semibold text-black hover:bg-yellow-300 disabled:opacity-50 transition-colors"
                    >
                      Aceptar
                    </button>
                  </div>
                </div>
              )}

              {step === "calendario" && selected && rangeStart && rangeEnd && (
                <div>
                  <p className="mb-2 text-sm">
                    <span className="font-medium">{selected.nombre}</span> del{" "}
                    <span className="font-medium">{rangeStart}</span> al{" "}
                    <span className="font-medium">{rangeEnd}</span>
                    {tipo === "novedad" && horasDiaValida && (
                      <> — {horasDiaNum} hs/día</>
                    )}
                  </p>
                  <p className="mb-2 text-xs text-muted-foreground">
                    Elegí en qué calendario de Google avisar (el que ya tiene agregada a la
                    gente que tiene que verlo).
                  </p>
                  {calendariosError && (
                    <p className="mb-2 rounded border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-300">
                      {calendariosError}
                    </p>
                  )}
                  {!calendariosError && calendarios === null && (
                    <p className="py-4 text-center text-sm text-muted-foreground">Cargando…</p>
                  )}
                  {calendarios && calendarios.length === 0 && (
                    <p className="text-sm text-muted-foreground">
                      No hay calendarios disponibles con permiso de escritura.
                    </p>
                  )}
                  {calendarios && calendarios.length > 0 && (
                    <select
                      className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                      value={calendarioId}
                      onChange={(e) => setCalendarioId(e.target.value)}
                    >
                      {calendarios.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.nombre}
                          {c.primary ? " (principal)" : ""}
                        </option>
                      ))}
                    </select>
                  )}
                  <div className="mt-3">
                    <label className="mb-1 block text-xs text-muted-foreground">
                      Invitados puntuales (opcional) — marcá los que correspondan
                    </label>
                    {emailsRegistrados === null && (
                      <p className="text-xs text-muted-foreground">Cargando…</p>
                    )}
                    {emailsRegistrados && emailsRegistrados.length === 0 && (
                      <p className="text-xs text-muted-foreground">
                        Todavía no hay emails guardados — sumá el primero abajo.
                      </p>
                    )}
                    {emailsRegistrados && emailsRegistrados.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {emailsRegistrados.map((e) => {
                          const marcado = invitados.includes(e.email);
                          return (
                            <button
                              key={e.id}
                              type="button"
                              onClick={() => toggleInvitado(e.email)}
                              title={e.email}
                              className={cn(
                                "rounded-full border px-2.5 py-1 text-[11px] font-medium",
                                marcado
                                  ? "bg-indigo-600 text-white border-indigo-600"
                                  : "bg-muted/50 text-muted-foreground border-transparent hover:bg-accent",
                              )}
                            >
                              {e.nombre || e.email}
                            </button>
                          );
                        })}
                      </div>
                    )}
                    <div className="mt-2 flex items-center gap-1.5">
                      <Input
                        value={invitadoInput}
                        onChange={(e) => setInvitadoInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            abrirNuevoEmail();
                          }
                        }}
                        placeholder="correo@empresa.com"
                        className="h-9 text-xs"
                      />
                      <button
                        type="button"
                        onClick={abrirNuevoEmail}
                        disabled={!EMAIL_RE.test(invitadoInput.trim())}
                        title="Sumar email nuevo a la lista"
                        className="shrink-0 rounded-md border p-1.5 hover:bg-accent disabled:opacity-50"
                      >
                        <Plus className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                  <div className="mt-4 flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setStep("rango")}
                      className="rounded-md border px-3 py-1 text-xs font-medium hover:bg-accent"
                    >
                      Atrás
                    </button>
                    <button
                      type="button"
                      onClick={confirmarRango}
                      disabled={saving || !calendarioId}
                      className="rounded-md bg-yellow-400 px-3 py-1 text-xs font-semibold text-black hover:bg-yellow-300 disabled:opacity-50 transition-colors"
                    >
                      {saving ? "Registrando…" : "Registrar"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>,
          document.body,
        )}

      {nuevoEmailOpen &&
        createPortal(
          <div
            className="dark fixed inset-0 z-[300] flex items-center justify-center bg-black/60 p-4 text-white"
            onClick={() => !nuevoEmailSaving && setNuevoEmailOpen(false)}
          >
            <div
              className="w-full max-w-xs rounded-lg border bg-popover p-4 shadow-lg"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-sm font-medium">Sumar email a la lista</h2>
                <button
                  type="button"
                  onClick={() => !nuevoEmailSaving && setNuevoEmailOpen(false)}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <p className="mb-3 text-xs text-muted-foreground">
                Queda guardado para siempre — va a aparecer como pill para marcar en este y en
                futuros registros.
              </p>
              {nuevoEmailError && (
                <p className="mb-2 rounded border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-300">
                  {nuevoEmailError}
                </p>
              )}
              <div className="space-y-2">
                <Input
                  value={nuevoEmailValor}
                  onChange={(e) => setNuevoEmailValor(e.target.value)}
                  placeholder="correo@empresa.com"
                  className="h-9 text-xs"
                  autoFocus
                />
                <Input
                  value={nuevoEmailNombre}
                  onChange={(e) => setNuevoEmailNombre(e.target.value)}
                  placeholder="Nombre (opcional)"
                  className="h-9 text-xs"
                />
              </div>
              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setNuevoEmailOpen(false)}
                  disabled={nuevoEmailSaving}
                  className="rounded-md border px-3 py-1 text-xs font-medium hover:bg-accent disabled:opacity-50"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={guardarNuevoEmail}
                  disabled={nuevoEmailSaving || !EMAIL_RE.test(nuevoEmailValor.trim())}
                  className="rounded-md bg-yellow-400 px-3 py-1 text-xs font-semibold text-black hover:bg-yellow-300 disabled:opacity-50 transition-colors"
                >
                  {nuevoEmailSaving ? "Guardando…" : "Guardar"}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
