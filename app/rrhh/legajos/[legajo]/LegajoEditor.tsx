"use client";
// app/rrhh/legajos/[legajo]/page.tsx -> editor de legajo completo
import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useForm, FormProvider, useFormContext, useFieldArray } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import {
  SECTIONS,
  RELATIONS,
  type FieldDef,
  type RelationDef,
} from "@/lib/rrhh/legajoFields";
import { legajoUpdateSchema } from "@/lib/rrhh/legajoSchema";
import { SectorSelect } from "./SectorSelect";
import { LugarSelect } from "./LugarSelect";
import { ConvenioSelect } from "./ConvenioSelect";

const ESTADO_CLASS: Record<string, string> = {
  ACTIVO: "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30",
  INACTIVO: "bg-zinc-700/40 text-zinc-300 border border-zinc-600/50",
  SUSPENDIDO: "bg-amber-500/15 text-amber-300 border border-amber-500/30",
  BAJA: "bg-red-500/15 text-red-300 border border-red-500/30",
};

// ---------- control de campo (reusado por escalares y celdas de relación) ----------
function FieldControl({ def, name }: { def: FieldDef; name: string }) {
  const { register } = useFormContext();
  const cls = "h-9 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 text-sm text-zinc-100 outline-none focus:border-yellow-400 [color-scheme:dark]";

  if (def.type === "bool") return <input type="checkbox" {...register(name)} className="h-4 w-4" />;
  if (def.type === "textarea")
    return <textarea {...register(name)} rows={3} className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-100 outline-none focus:border-yellow-400" />;
  if (def.type === "select")
    return (
      <select {...register(name)} className={cls}>
        <option value="">—</option>
        {def.options!.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );

  const type = def.type === "date" ? "date" : def.type === "number" || def.type === "int" ? "number" : "text";
  return (
    <input
      type={type}
      step={def.type === "number" ? "any" : undefined}
      maxLength={def.type === "text" ? def.max : undefined}
      {...register(name)}
      className={cls}
    />
  );
}

function ScalarField({ def }: { def: FieldDef }) {
  const { formState } = useFormContext();
  const err = (formState.errors as Record<string, { message?: string }>)[def.name]?.message;
  const span = def.col === 3 ? "sm:col-span-3" : def.col === 2 ? "sm:col-span-2" : "";

  if (def.type === "bool")
    return (
      <label className={`flex items-center gap-2 py-1.5 ${span}`}>
        <FieldControl def={def} name={def.name} />
        <span className="text-sm text-zinc-300">{def.label}</span>
      </label>
    );

  return (
    <label className={`block ${span}`}>
      <span className="mb-1 block text-xs font-medium text-zinc-400">
        {def.label}
        {def.required && <b className="text-red-400"> *</b>}
      </span>
      <FieldControl def={def} name={def.name} />
      {err && <span className="mt-0.5 block text-xs text-red-400">{err}</span>}
    </label>
  );
}

// ---------- tabla editable de relación ----------
function RelationTab({ relation }: { relation: RelationDef }) {
  const { control } = useFormContext();
  const { fields, append, remove } = useFieldArray({ control, name: relation.key });

  const empty: Record<string, unknown> = { id: null };
  for (const c of relation.columns) empty[c.name] = c.type === "bool" ? false : "";

  return (
    <div>
      <div className="overflow-x-auto rounded-lg bg-[#171717] border border-zinc-800">
        <table className="w-full text-sm">
          <thead className="bg-[#1f1f1f] text-left text-zinc-500">
            <tr>
              {relation.columns.map((c) => (
                <th key={c.name} className="whitespace-nowrap px-2 py-2 font-medium">
                  {c.label}
                  {c.required && <b className="text-red-400"> *</b>}
                </th>
              ))}
              <th className="px-2 py-2" />
            </tr>
          </thead>
          <tbody>
            {fields.map((f, i) => (
              <tr key={f.id} className="border-t border-zinc-800/60 align-top">
                {relation.columns.map((c) => (
                  <td key={c.name} className="px-2 py-1.5">
                    <FieldControl def={c} name={`${relation.key}.${i}.${c.name}`} />
                  </td>
                ))}
                <td className="px-2 py-1.5 text-center">
                  <button
                    type="button"
                    onClick={() => remove(i)}
                    className="rounded px-2 py-1 text-xs text-red-400 hover:bg-red-500/10"
                  >
                    Quitar
                  </button>
                </td>
              </tr>
            ))}
            {fields.length === 0 && (
              <tr>
                <td colSpan={relation.columns.length + 1} className="px-2 py-6 text-center text-zinc-600">
                  Sin registros
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <button
        type="button"
        onClick={() => append(empty)}
        className="mt-2 rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800 hover:text-yellow-400 transition-colors"
      >
        + Agregar {relation.label.toLowerCase()}
      </button>
    </div>
  );
}

// `initial` llega desde un Server Component (app/rrhh/legajos/[legajo]/page.tsx)
// directo desde Prisma: los campos @db.Date / DateTime cruzan el límite
// server->client como instancias reales de `Date` (React Server Components
// las serializa así), no como strings. Un <input type="date"> sólo acepta
// "YYYY-MM-DD" como value/defaultValue — con un `Date` crudo el campo se ve
// vacío al entrar, aunque el dato SÍ esté guardado en la base (2026-09-11:
// reportado como "no se guarda la fecha de inicio", pero era esto: el GET
// después de guardar mostraba el campo en blanco por este mismo motivo, no
// porque el PUT hubiera fallado). Se normaliza acá, antes de que
// react-hook-form arme los defaultValues, en vez de tocar cada FieldControl.
function normalizeDates<T>(value: T): T {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => normalizeDates(v)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = normalizeDates(v);
    }
    return out as T;
  }
  return value;
}

// ---------- editor ----------
type Tab = { id: string; label: string; kind: "section" | "relation" };

export default function LegajoEditor({ id, initial }: { id: number; initial: Record<string, unknown> }) {
  const router = useRouter();
  const defaultValues = useMemo(() => normalizeDates(initial), [initial]);
  const methods = useForm({
    resolver: zodResolver(legajoUpdateSchema),
    defaultValues: defaultValues as never,
    mode: "onBlur",
  });
  const [saving, setSaving] = useState(false);

  const tabs: Tab[] = useMemo(
    () => [
      ...SECTIONS.map((s) => ({ id: s.id, label: s.label, kind: "section" as const })),
      ...RELATIONS.map((r) => ({ id: r.key, label: r.label, kind: "relation" as const })),
    ],
    []
  );
  const [active, setActive] = useState(tabs[0].id);

  // mapa campo escalar -> sección (para saltar al tab con error)
  const fieldTab = useMemo(() => {
    const m: Record<string, string> = {};
    for (const s of SECTIONS) for (const f of s.fields) m[f.name] = s.id;
    return m;
  }, []);

  const dni = (methods.watch("dni") as string) || (initial._dni as string) || "";
  const nombre = (methods.watch("nombre") as string) || "";
  const estado = (methods.watch("estado") as string) || "";

  async function onValid(values: Record<string, unknown>) {
    setSaving(true);
    try {
      const res = await fetch(`/api/rrhh/legajos/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(j?.error ?? "Error al guardar");
        return;
      }
      toast.success("Legajo guardado");
      methods.reset(values as never);
      router.push("/rrhh/legajos");
    } catch {
      toast.error("Error de red");
    } finally {
      setSaving(false);
    }
  }

  function onInvalid(errors: Record<string, unknown>) {
    const first = Object.keys(errors)[0];
    if (first) setActive(fieldTab[first] ?? first);
    toast.error("Revisá los campos obligatorios");
  }

  const section = SECTIONS.find((s) => s.id === active);
  const relation = RELATIONS.find((r) => r.key === active);
  const dirty = methods.formState.isDirty;

  return (
    <FormProvider {...methods}>
      {/* `dark` + fondo #111111: misma estética que /deposito, /compras y
          /ventas; los selects propios (Sector/Lugar/Convenio) usan las
          variables de shadcn, que acá resuelven al bloque .dark. */}
      <div className="dark min-h-screen bg-[#111111] text-white">
      <form
        onSubmit={methods.handleSubmit(onValid, onInvalid)}
        className="mx-auto max-w-5xl p-4"
      >
        {/* cabecera */}
        <div className="sticky top-0 z-10 -mx-4 mb-4 flex items-center gap-4 border-b border-zinc-800 bg-[#111111]/95 px-4 py-3 backdrop-blur">
          {dni ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`/api/rrhh/legajos/foto/${dni}`}
              alt={nombre}
              className="h-14 w-14 rounded-full object-cover"
              onError={(e) => (e.currentTarget.style.display = "none")}
            />
          ) : (
            <span className="flex h-14 w-14 items-center justify-center rounded-full bg-zinc-800 text-zinc-500">
              —
            </span>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-lg font-semibold">
                {nombre || "Legajo"}
              </h1>
              {estado && (
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-medium ${ESTADO_CLASS[estado] ?? "bg-zinc-700/40 text-zinc-300 border border-zinc-600/50"}`}
                >
                  {estado}
                </span>
              )}
            </div>
            <p className="text-xs text-zinc-500">
              DNI {dni || "—"} · Legajo #{id}
              {dirty && (
                <span className="ml-2 text-amber-400">
                  · cambios sin guardar
                </span>
              )}
            </p>
          </div>
          <Link
            href="/rrhh/legajos"
            className="rounded-md px-3 py-2 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-yellow-400 transition-colors"
            >
            Volver
          </Link>
          <button
            type="submit"
            disabled={saving}
            className="rounded-md bg-yellow-400 px-4 py-2 text-sm font-semibold text-black hover:bg-yellow-300 disabled:opacity-50 transition-colors"
          >
            {saving ? "Guardando…" : "Guardar"}
          </button>
          <SectorSelect
            value={(methods.watch("sectorId") as number | null) ?? null}
            onChange={(sid) =>
              methods.setValue("sectorId", sid, {
                shouldDirty: true,
                shouldValidate: true,
              })
            }
          />
          <LugarSelect
            value={(methods.watch("lugarId") as number | null) ?? null}
            onChange={(lid) =>
              methods.setValue("lugarId", lid, {
                shouldDirty: true,
                shouldValidate: true,
              })
            }
          />
        </div>

        {/* tabs */}
        <div className="mb-4 flex flex-wrap gap-1 border-b border-zinc-800">
          {tabs.map((t) => {
            const count =
              t.kind === "relation"
                ? ((methods.watch(t.id) as unknown[])?.length ?? 0)
                : null;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setActive(t.id)}
                className={`-mb-px border-b-2 px-3 py-2 text-sm ${
                  active === t.id
                    ? "border-yellow-400 font-medium text-yellow-400"
                    : "border-transparent text-zinc-500 hover:text-zinc-300"
                }`}
              >
                {t.label}
                {count !== null && count > 0 && (
                  <span className="ml-1 text-xs text-zinc-600">({count})</span>
                )}
              </button>
            );
          })}
        </div>

        {/* contenido */}
        {section && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {section.id === "laboral" && (
              <div className="sm:col-span-3">
                <ConvenioSelect
                  convenioId={(methods.watch("convenioId") as number | null) ?? null}
                  categoriaId={(methods.watch("categoriaId") as number | null) ?? null}
                  onChange={({ convenioId, categoriaId }) => {
                    const opts = { shouldDirty: true, shouldValidate: true };
                    methods.setValue("convenioId", convenioId, opts);
                    methods.setValue("categoriaId", categoriaId, opts);
                  }}
                />
              </div>
            )}
            {section.fields.map((f) => (
              <ScalarField key={f.name} def={f} />
            ))}
          </div>
        )}
        {relation && <RelationTab relation={relation} />}
      </form>
      </div>
    </FormProvider>
  );
}
