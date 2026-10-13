// /rrhh/busqueda — constantes compartidas (API + UI). Tablas: sql/rrhh_busqueda.sql.

export const ESTADOS_POSTULANTE = [
  "EN_PROCESO",
  "RECHAZADO",
  "DESISTIO",
  "MALAS_REFERENCIAS",
  "DESCARTADO",
] as const;
export type EstadoPostulante = (typeof ESTADOS_POSTULANTE)[number];

export const ESTADO_LABEL: Record<EstadoPostulante, string> = {
  EN_PROCESO: "En proceso",
  RECHAZADO: "Rechazado",
  DESISTIO: "Desistió",
  MALAS_REFERENCIAS: "Malas referencias",
  DESCARTADO: "Descartado",
};

// Estados que sacan al candidato de las recomendaciones del chat de selección.
// Si se cambia esta lista hay que cambiar también el índice parcial de
// sql/rrhh_busqueda.sql y vicki_chat/app/main.py::_SQL_EXCLUIDOS_RRHH.
export const ESTADOS_EXCLUYENTES: EstadoPostulante[] = [
  "RECHAZADO",
  "DESISTIO",
  "MALAS_REFERENCIAS",
  "DESCARTADO",
];

export const TIPOS_EVENTO = [
  "ENTREVISTA",
  "PREOCUPACIONAL",
  "PSICOTECNICO",
  "INGRESO_PROGRAMADO",
] as const;
export type TipoEvento = (typeof TIPOS_EVENTO)[number];

export const TIPO_EVENTO_LABEL: Record<TipoEvento, string> = {
  ENTREVISTA: "Entrevista",
  PREOCUPACIONAL: "Preocupacional",
  PSICOTECNICO: "Psicotécnico",
  INGRESO_PROGRAMADO: "Ingreso programado",
};

export const esEstado = (v: unknown): v is EstadoPostulante =>
  typeof v === "string" && (ESTADOS_POSTULANTE as readonly string[]).includes(v);
export const esTipoEvento = (v: unknown): v is TipoEvento =>
  typeof v === "string" && (TIPOS_EVENTO as readonly string[]).includes(v);

// Tabla faltante (SQL sin correr): se avisa en la UI en vez de tirar 500 mudo.
export function esTablaFaltante(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return /rrhh_busqueda/.test(m) && /(does not exist|no existe|P2021)/i.test(m);
}
export const TABLA_FALTA_MSG =
  "Faltan las tablas de búsquedas: correr sql/rrhh_busqueda.sql en Postgres y luego prisma generate.";
