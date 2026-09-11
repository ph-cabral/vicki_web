import { z } from "zod";

// Items DDJJ El Norte (sí/no + observaciones)
export const PATOLOGIAS = [
  { id: "nervioso", label: "Sistema nervioso" },
  { id: "respiratorio", label: "Sistema respiratorio" },
  { id: "circulatorio", label: "Sistema circulatorio" },
  { id: "digestivo", label: "Sistema digestivo" },
  { id: "renal", label: "Sistema renal/urinario" },
  { id: "oseo", label: "Sistema óseo/muscular" },
  { id: "sangre", label: "Enfermedades de la sangre" },
  { id: "cancer", label: "Cáncer" },
  { id: "congenitas", label: "Patologías congénitas" },
  { id: "endocrinas", label: "Enfermedades endocrinas" },
  { id: "ginecologicas", label: "Enfermedades ginecológicas" },
  { id: "embarazo", label: "Embarazo (actual)" },
  { id: "otras", label: "Otras patologías" },
  { id: "chagas", label: "Enfermedad de Chagas" },
] as const;

export type PatologiaId = (typeof PATOLOGIAS)[number]["id"];

const patologiasShape = PATOLOGIAS.reduce<Record<string, z.ZodBoolean>>(
  (acc, p) => {
    acc[p.id] = z.boolean();
    return acc;
  },
  {}
);

export const antecedenteSrtSchema = z.object({
  descripcion: z.string().optional(),
  fecha: z.string().optional(),
  observaciones: z.string().optional(),
});

export const step5Schema = z.object({
  // DDJJ El Norte - datos antropométricos
  estatura: z
    .number({ invalid_type_error: "Numérico" })
    .min(0.5).max(2.5).optional(),
  peso: z
    .number({ invalid_type_error: "Numérico" })
    .min(20).max(250).optional(),
  presionMin: z
    .number({ invalid_type_error: "Numérico" })
    .min(40).max(150).optional(),
  presionMax: z
    .number({ invalid_type_error: "Numérico" })
    .min(60).max(250).optional(),

  // 14 patologías sí/no
  patologias: z.object(patologiasShape),
  observacionesSalud: z.string().optional(),

  // Datos póliza vida
  numeroSolicitud: z.string().optional(),
  numeroPoliza: z.string().optional(),
  capitalAsegurado: z
    .number({ invalid_type_error: "Numérico" })
    .min(0).optional(),
  // fechaIngresoEmpleo se sacó (2026-09-11): la única fecha de ingreso que
  // usa el sistema es legajo.fechaInicio, que ahora se fija sola a la fecha
  // de creación del legajo (ver POST /api/rrhh/legajos).

  // ART
  artCompania: z.string().optional(),
  artNumeroContrato: z.string().optional(),
  artCredencialEntregada: z.boolean().default(false),

  // SRT 37/2010
  antecedentesSrt: z.array(antecedenteSrtSchema).default([]),
});

export type Step5Data = z.infer<typeof step5Schema>;
export type AntecedenteSrt = z.infer<typeof antecedenteSrtSchema>;
