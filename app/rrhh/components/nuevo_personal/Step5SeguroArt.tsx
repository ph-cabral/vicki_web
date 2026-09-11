"use client";

import { useForm, useFieldArray, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Plus, Trash2 } from "lucide-react";

import {
  step5Schema,
  type Step5Data,
  PATOLOGIAS,
} from "@/app/rrhh/legajos/nuevo/schemas/step5";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DateField } from "@/components/ui/date-field";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";

interface Step5Props {
  defaultValues?: Partial<Step5Data>;
  onSubmit: (data: Step5Data) => void;
  onBack: () => void;
  onSaveDraft?: (data: Partial<Step5Data>) => void;
}

export function Step5SeguroArt({
  defaultValues,
  onSubmit,
  onBack,
  onSaveDraft,
}: Step5Props) {
  const {
    register,
    control,
    handleSubmit,
    watch,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm<Step5Data>({
    resolver: zodResolver(step5Schema),
    defaultValues: {
      patologias: PATOLOGIAS.reduce(
        (acc, p) => ({ ...acc, [p.id]: false }),
        {} as Step5Data["patologias"]
      ),
      artCredencialEntregada: false,
      antecedentesSrt: [],
      ...defaultValues,
    },
  });

  const antecedentes = useFieldArray({ control, name: "antecedentesSrt" });
  const patologiasW = watch("patologias");
  const algunaSi = Object.values(patologiasW || {}).some(Boolean);

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-8">
      {/* DDJJ Salud El Norte */}
      <section>
        <h3 className="mb-4 text-lg font-semibold border-b pb-2">
          DDJJ de salud — El Norte Seguros (Vida colectivo)
        </h3>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <Field label="Estatura (m)" error={errors.estatura?.message}>
            <Input
              type="number"
              step="0.01"
              {...register("estatura", { valueAsNumber: true })}
            />
          </Field>
          <Field label="Peso (kg)" error={errors.peso?.message}>
            <Input
              type="number"
              step="0.1"
              {...register("peso", { valueAsNumber: true })}
            />
          </Field>
          <Field label="Presión mínima" error={errors.presionMin?.message}>
            <Input
              type="number"
              {...register("presionMin", { valueAsNumber: true })}
              placeholder="80"
            />
          </Field>
          <Field label="Presión máxima" error={errors.presionMax?.message}>
            <Input
              type="number"
              {...register("presionMax", { valueAsNumber: true })}
              placeholder="120"
            />
          </Field>
        </div>

        <div className="space-y-2">
          <p className="text-sm font-medium">
            ¿Padece o ha padecido alguna de las siguientes condiciones?
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 border rounded-md p-3 bg-muted/20">
            {PATOLOGIAS.map((p) => (
              <Controller
                key={p.id}
                name={`patologias.${p.id}` as const}
                control={control}
                render={({ field }) => (
                  <label className="flex items-center gap-2 text-sm py-1">
                    <Checkbox
                      checked={field.value}
                      onCheckedChange={field.onChange}
                    />
                    <span>{p.label}</span>
                  </label>
                )}
              />
            ))}
          </div>
        </div>

        {algunaSi && (
          <div className="mt-4">
            <Field label="Observaciones (detallar las marcadas)" error={errors.observacionesSalud?.message}>
              <Textarea
                {...register("observacionesSalud")}
                rows={3}
                placeholder="Detalle de patologías, tratamientos, fechas..."
              />
            </Field>
          </div>
        )}
      </section>

      {/* Póliza vida — "Fecha de ingreso al empleo" se sacó (2026-09-11): el
          único dato de fecha de ingreso que usa el sistema es fechaInicio,
          que ahora se fija sola a la fecha de creación del legajo. */}
      <section>
        <h3 className="mb-4 text-lg font-semibold border-b pb-2">
          Datos de póliza — Seguro de vida
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="N° de solicitud" error={errors.numeroSolicitud?.message}>
            <Input {...register("numeroSolicitud")} />
          </Field>
          <Field label="N° de póliza" error={errors.numeroPoliza?.message}>
            <Input {...register("numeroPoliza")} />
          </Field>
          <Field label="Capital asegurado (S.M.V.M.)" error={errors.capitalAsegurado?.message}>
            <Input
              type="number"
              step="0.01"
              {...register("capitalAsegurado", { valueAsNumber: true })}
            />
          </Field>
        </div>
      </section>

      {/* ART */}
      <section>
        <h3 className="mb-4 text-lg font-semibold border-b pb-2">
          ART (Aseguradora de Riesgos del Trabajo)
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
          <Field label="Compañía" error={errors.artCompania?.message}>
            <Input
              {...register("artCompania")}
              placeholder="Prevención ART"
            />
          </Field>
          <Field label="N° de contrato" error={errors.artNumeroContrato?.message}>
            <Input
              {...register("artNumeroContrato")}
              placeholder="221535"
            />
          </Field>
          <div className="flex items-center pb-2">
            <Controller
              name="artCredencialEntregada"
              control={control}
              render={({ field }) => (
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={field.value}
                    onCheckedChange={field.onChange}
                  />
                  <span>Credencial entregada</span>
                </label>
              )}
            />
          </div>
        </div>
      </section>

      {/* SRT 37/2010 */}
      <section>
        <div className="flex items-center justify-between mb-4 border-b pb-2">
          <h3 className="text-lg font-semibold">
            DDJJ de salud — SRT 37/2010 (antecedentes)
          </h3>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              antecedentes.append({
                descripcion: "",
                fecha: "",
                observaciones: "",
              })
            }
          >
            <Plus className="w-4 h-4 mr-1" /> Agregar
          </Button>
        </div>

        {antecedentes.fields.length === 0 ? (
          <p className="text-sm text-muted-foreground italic">
            Sin antecedentes cargados.
          </p>
        ) : (
          <div className="space-y-3">
            {antecedentes.fields.map((field, idx) => (
              <div
                key={field.id}
                className="grid grid-cols-1 md:grid-cols-12 gap-2 items-end p-3 border rounded-md bg-muted/30"
              >
                <div className="md:col-span-5">
                  <Label className="text-xs">Descripción / Patología</Label>
                  <Input {...register(`antecedentesSrt.${idx}.descripcion`)} />
                </div>
                <div className="md:col-span-2">
                  <Label className="text-xs">Fecha</Label>
                  <Controller
                    control={control}
                    name={`antecedentesSrt.${idx}.fecha`}
                    render={({ field }) => (
                      <DateField
                        value={field.value ?? ""}
                        onChange={field.onChange}
                      />
                    )}
                  />
                </div>
                <div className="md:col-span-4">
                  <Label className="text-xs">Observaciones</Label>
                  <Input
                    {...register(`antecedentesSrt.${idx}.observaciones`)}
                  />
                </div>
                <div className="md:col-span-1 flex justify-end">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => antecedentes.remove(idx)}
                  >
                    <Trash2 className="w-4 h-4 text-destructive" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="flex items-center justify-between pt-4 border-t">
        <Button type="button" variant="outline" onClick={onBack}>
          ← Atrás
        </Button>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => onSaveDraft?.(getValues())}
            disabled={isSubmitting}
          >
            Guardar borrador
          </Button>
          <Button type="submit" disabled={isSubmitting}>
            Siguiente: Equipos →
          </Button>
        </div>
      </div>
    </form>
  );
}

function Field({
  label, error, required, children,
}: {
  label: string; error?: string; required?: boolean; children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-sm">
        {label}
        {required && <span className="text-destructive ml-0.5">*</span>}
      </Label>
      {children}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
