import { z } from "zod";

export const step3Schema = z.object({
  fechaInicio: z.string().optional(),

  modalidadContrato: z.string().optional(), // ej "014 - Nuevo período de prueba"
  situacionRevista: z.string().optional().default("01"),
  regimen: z.string().optional().default("SIPA"),

  // se eligen del catálogo (everwear.convenio / convenio_categoria): viajan los
  // ids y el POST resuelve los nombres. Los campos de texto quedan opcionales
  // sólo para que no rompan los borradores guardados antes del cambio.
  convenioId: z.number().int().positive().optional().nullable(),
  categoriaId: z.number().int().positive().optional().nullable(),
  convenio: z.string().optional(),
  categoria: z.string().optional(),
  puestoInterno: z.string().optional(),
  sector: z.string().optional(),

  retribucionPactada: z
    .number({ invalid_type_error: "Numérico" })
    .min(0, "No puede ser negativa"),
  modalidadLiquidacion: z.enum(["mes", "quincena", "dia"]),

  obraSocial: z.string().optional(), // ej "126205 - OSECAC"
  tipoServicio: z.string().optional(),
  actividadEconomica: z.string().optional(),
  domicilioExplotacion: z.string().optional(),

  claveAltaArca: z.string().regex(/^CA\w+$/i, "Debe iniciar con CA").optional().or(z.literal("")),
  fechaEnvioAlta: z.string().optional(),

  banco: z.enum(["bbva", "nacion", "galicia", "otro"]),
  bancoOtro: z.string().optional(),
  diaPago: z
    .number({ invalid_type_error: "Numérico" })
    .min(1).max(31).optional(),

  percibeSeguroDesempleo: z.boolean().default(false),
  ddjjArt12: z
    .boolean()
    .refine((v) => v === true, { message: "Debe firmar la DDJJ Art. 12" }),
}).refine(
  (d) => d.banco !== "otro" || (d.bancoOtro && d.bancoOtro.length > 0),
  { message: "Indicar nombre del banco", path: ["bancoOtro"] }
);

export type Step3Data = z.infer<typeof step3Schema>;
