// lib/rrhh/legajoFields.ts
// Metadata única de campos del legajo. La consumen el editor (UI) y el schema Zod.
// Mantener sincronizado con prisma/schema.prisma model `legajo` y sus relaciones.

export type FieldType =
  | "text"
  | "textarea"
  | "number" // float
  | "int"
  | "date" // input date -> string 'YYYY-MM-DD'
  | "bool"
  | "select";

export interface FieldDef {
  name: string;
  label: string;
  type: FieldType;
  required?: boolean;
  max?: number; // maxLength para VarChar
  options?: string[]; // para select
  col?: 1 | 2 | 3; // ancho en grilla (default 1)
}

export interface SectionDef {
  id: string;
  label: string;
  fields: FieldDef[];
}

// ---- Opciones de selects (ajustar a tus catálogos reales) ----
export const OPC = {
  estado: ["ACTIVO", "INACTIVO", "SUSPENDIDO", "BAJA"],
  sexo: ["M", "F", "X"],
  estadoCivil: ["Soltero/a", "Casado/a", "Divorciado/a", "Viudo/a", "Conviviente"],
  manoHabil: ["Diestro", "Zurdo", "Ambidiestro"],
  modalidadLiquidacion: ["Mensual", "Quincenal", "Jornal"],
  tipoDocumento: ["DNI", "LC", "LE", "CI", "Pasaporte"],
  nivelEstudio: ["Primario", "Secundario", "Terciario", "Universitario", "Posgrado"],
  nivelIdioma: ["Básico", "Intermedio", "Avanzado", "Nativo"],
  tipoEquipo: ["Notebook", "Celular", "Calzado", "Indumentaria", "Herramienta", "EPP", "Otro"],
  estadoEquipo: ["NUEVO", "USADO", "BUENO", "REGULAR"],
} as const;

// ---- Secciones de campos escalares ----
export const SECTIONS: SectionDef[] = [
  {
    id: "estado",
    label: "Estado / Identificación",
    fields: [
      // N° de legajo (ver everwear.legajo.codigo): es el número que trae la
      // columna "Nro. de Legajo" del Excel de pago de sueldos (2026-09-11,
      // ver lib/rrhh/nomina.ts) — con esto cargado se puede cruzar cada fila
      // del Excel contra su área/sector real. No es lo mismo que
      // `employeeNo` (número de reloj/Hikvision, para fichaje).
      { name: "codigo", label: "N° de legajo", type: "text", max: 20 },
      { name: "estado", label: "Estado", type: "select", options: OPC.estado, required: true, max: 20 },
      { name: "employeeNo", label: "N° empleado (reloj)", type: "text", max: 50 },
      { name: "anvizId", label: "ID Anviz", type: "text", max: 20 },
    ],
  },
  {
    id: "personal",
    label: "Datos personales",
    fields: [
      { name: "nombre", label: "Nombre y apellido", type: "text", required: true, max: 100, col: 2 },
      { name: "dni", label: "DNI", type: "text", max: 20 },
      { name: "cuil", label: "CUIL", type: "text", max: 20 },
      { name: "fechaNacimiento", label: "Fecha de nacimiento", type: "date" },
      { name: "lugarNacimiento", label: "Lugar de nacimiento", type: "text", max: 150 },
      { name: "nacionalidad", label: "Nacionalidad", type: "text", max: 60 },
      { name: "sexo", label: "Sexo", type: "select", options: OPC.sexo, required: true, max: 2 },
      { name: "estadoCivil", label: "Estado civil", type: "select", options: OPC.estadoCivil, max: 20 },
      { name: "altura", label: "Altura (m)", type: "number" },
      { name: "peso", label: "Peso (kg)", type: "number" },
      { name: "manoHabil", label: "Mano hábil", type: "select", options: OPC.manoHabil, max: 20 },
    ],
  },
  {
    id: "contacto",
    label: "Contacto",
    fields: [
      { name: "telefonoFijo", label: "Teléfono fijo", type: "text", max: 40 },
      { name: "telefonoCelular", label: "Celular", type: "text", max: 40 },
      { name: "emailPersonal", label: "Email personal", type: "text", max: 150, col: 2 },
    ],
  },
  {
    id: "domicilio",
    label: "Domicilio",
    fields: [
      { name: "calle", label: "Calle", type: "text", max: 150, col: 2 },
      { name: "numero", label: "Número", type: "text", max: 20 },
      { name: "piso", label: "Piso", type: "text", max: 10 },
      { name: "depto", label: "Depto", type: "text", max: 10 },
      { name: "codigoPostal", label: "Código postal", type: "text", max: 10 },
      { name: "localidad", label: "Localidad", type: "text", max: 100 },
      { name: "provincia", label: "Provincia", type: "text", max: 60 },
    ],
  },
  {
    id: "laboral",
    label: "Laboral / Contrato",
    fields: [
      // "Fecha ingreso empleo" (fechaIngresoEmpleo) se sacó (2026-09-11): la
      // única fecha de ingreso que usa el sistema es fechaInicio, que se fija
      // sola a la fecha de creación del legajo — queda editable acá sólo para
      // corregirla a mano si hace falta.
      { name: "fechaInicio", label: "Fecha de inicio", type: "date" },
      { name: "fechaCese", label: "Fecha de cese", type: "date" },
      { name: "modalidadContrato", label: "Modalidad de contrato", type: "text", max: 100 },
      { name: "situacionRevista", label: "Situación de revista", type: "text", max: 20 },
      { name: "regimen", label: "Régimen", type: "text", max: 40 },
      // convenio y categoría no van acá: salen del catálogo de la base y los
      // renderiza <ConvenioSelect> al principio de esta misma sección.
      { name: "puestoInterno", label: "Puesto interno", type: "text", max: 100 },
      { name: "sector", label: "Sector (texto)", type: "text", max: 60 },
      { name: "retribucionPactada", label: "Retribución pactada", type: "number" },
      { name: "modalidadLiquidacion", label: "Modalidad liquidación", type: "select", options: OPC.modalidadLiquidacion, max: 20 },
      { name: "diaPago", label: "Día de pago", type: "int" },
      { name: "banco", label: "Banco", type: "text", max: 40 },
      { name: "bancoOtro", label: "Banco (otro)", type: "text", max: 60 },
      { name: "percibeSeguroDesempleo", label: "Percibe seguro de desempleo", type: "bool" },
    ],
  },
  {
    id: "fiscal",
    label: "Fiscal / Servicio",
    fields: [
      { name: "tipoServicio", label: "Tipo de servicio", type: "text", max: 100 },
      { name: "actividadEconomica", label: "Actividad económica", type: "text", max: 100 },
      { name: "domicilioExplotacion", label: "Domicilio de explotación", type: "text", max: 200, col: 2 },
      { name: "claveAltaArca", label: "Clave alta ARCA", type: "text", max: 40 },
      { name: "fechaEnvioAlta", label: "Fecha envío alta", type: "date" },
      { name: "obraSocial", label: "Obra social", type: "text", max: 100 },
    ],
  },
  {
    id: "cargas",
    label: "Cargas de familia",
    fields: [
      { name: "tieneCargasFamilia", label: "Tiene cargas de familia", type: "bool" },
      { name: "medioPagoAaff", label: "Medio de pago AAFF", type: "text", max: 40 },
      { name: "medioPagoAaffOtro", label: "Medio de pago AAFF (otro)", type: "text", max: 100 },
    ],
  },
  {
    id: "salud",
    label: "Salud",
    fields: [
      { name: "estatura", label: "Estatura (m)", type: "number" },
      { name: "pesoSalud", label: "Peso (kg)", type: "number" },
      { name: "presionMin", label: "Presión mínima", type: "int" },
      { name: "presionMax", label: "Presión máxima", type: "int" },
      { name: "patologiaNervioso", label: "Nervioso", type: "bool" },
      { name: "patologiaRespiratorio", label: "Respiratorio", type: "bool" },
      { name: "patologiaCirculatorio", label: "Circulatorio", type: "bool" },
      { name: "patologiaDigestivo", label: "Digestivo", type: "bool" },
      { name: "patologiaRenal", label: "Renal", type: "bool" },
      { name: "patologiaOseo", label: "Óseo", type: "bool" },
      { name: "patologiaSangre", label: "Sangre", type: "bool" },
      { name: "patologiaCancer", label: "Cáncer", type: "bool" },
      { name: "patologiaCongenitas", label: "Congénitas", type: "bool" },
      { name: "patologiaEndocrinas", label: "Endocrinas", type: "bool" },
      { name: "patologiaGinecologicas", label: "Ginecológicas", type: "bool" },
      { name: "patologiaEmbarazo", label: "Embarazo", type: "bool" },
      { name: "patologiaChagas", label: "Chagas", type: "bool" },
      { name: "patologiaOtras", label: "Otras", type: "bool" },
      { name: "observacionesSalud", label: "Observaciones de salud", type: "textarea", col: 3 },
    ],
  },
  {
    id: "antecedentes",
    label: "Antecedentes",
    fields: [
      { name: "antecedentesPenales", label: "Antecedentes penales", type: "bool" },
      { name: "antecedentesDetalle", label: "Detalle antecedentes", type: "textarea", col: 2 },
      { name: "aceptaPsicotecnico", label: "Acepta psicotécnico", type: "bool" },
    ],
  },
  {
    id: "seguro",
    label: "Seguro de vida",
    fields: [
      { name: "numeroSolicitud", label: "N° de solicitud", type: "text", max: 60 },
      { name: "numeroPoliza", label: "N° de póliza", type: "text", max: 60 },
      { name: "capitalAsegurado", label: "Capital asegurado", type: "number" },
    ],
  },
  {
    id: "art",
    label: "ART",
    fields: [
      { name: "artCompania", label: "Compañía ART", type: "text", max: 80 },
      { name: "artNumeroContrato", label: "N° contrato ART", type: "text", max: 60 },
      { name: "artCredencialEntregada", label: "Credencial entregada", type: "bool" },
    ],
  },
  {
    id: "ddjj",
    label: "DDJJ / Firma",
    fields: [
      { name: "ddjjConformidad", label: "DDJJ conformidad", type: "bool" },
      { name: "ddjjArt12", label: "DDJJ Art. 12", type: "bool" },
      { name: "aceptaClausulas", label: "Acepta cláusulas", type: "bool" },
      { name: "jurisdiccion", label: "Jurisdicción", type: "text", required: true, max: 100, col: 2 },
      { name: "comprobanteUrl", label: "Comprobante (URL)", type: "text", col: 2 },
      { name: "firmaEmpleado", label: "Firma empleado (URL)", type: "text", col: 2 },
      { name: "fechaFirma", label: "Fecha de firma", type: "date" },
    ],
  },
];

// ---- Relaciones (1:N). columns = campos editables por fila ----
export interface RelationDef {
  key: string; // nombre de la relación en el GET / payload
  label: string;
  columns: FieldDef[];
}

export const RELATIONS: RelationDef[] = [
  {
    key: "familiares",
    label: "Familiares",
    columns: [
      { name: "parentesco", label: "Parentesco", type: "text", required: true, max: 20 },
      { name: "apellido", label: "Apellido", type: "text", required: true, max: 100 },
      { name: "nombre", label: "Nombre", type: "text", required: true, max: 100 },
      { name: "tipoDocumento", label: "Tipo doc.", type: "select", options: OPC.tipoDocumento, required: true, max: 10 },
      { name: "numeroDocumento", label: "N° doc.", type: "text", required: true, max: 20 },
      { name: "fechaNacimiento", label: "F. nac.", type: "date", required: true },
      { name: "nacionalidad", label: "Nacionalidad", type: "text", required: true, max: 60 },
      { name: "telefono", label: "Teléfono", type: "text", max: 40 },
      { name: "ocupacion", label: "Ocupación", type: "text", max: 100 },
      { name: "convive", label: "Convive", type: "bool" },
    ],
  },
  {
    key: "beneficiarios",
    label: "Beneficiarios",
    columns: [
      { name: "apellidoNombre", label: "Apellido y nombre", type: "text", required: true, max: 200 },
      { name: "tipoDocumento", label: "Tipo doc.", type: "select", options: OPC.tipoDocumento, required: true, max: 10 },
      { name: "numeroDocumento", label: "N° doc.", type: "text", required: true, max: 20 },
      { name: "parentesco", label: "Parentesco", type: "text", required: true, max: 40 },
      { name: "domicilio", label: "Domicilio", type: "text", required: true, max: 200 },
      { name: "porcentaje", label: "%", type: "number", required: true },
    ],
  },
  {
    key: "estudios",
    label: "Estudios",
    columns: [
      { name: "nivel", label: "Nivel", type: "select", options: OPC.nivelEstudio, required: true, max: 20 },
      { name: "institucion", label: "Institución", type: "text", required: true, max: 200 },
      { name: "desde", label: "Desde", type: "text", required: true, max: 10 },
      { name: "hasta", label: "Hasta", type: "text", max: 10 },
      { name: "titulo", label: "Título", type: "text", max: 200 },
      { name: "enCurso", label: "En curso", type: "bool" },
    ],
  },
  {
    key: "idiomas",
    label: "Idiomas",
    columns: [
      { name: "idioma", label: "Idioma", type: "text", required: true, max: 60 },
      { name: "habla", label: "Habla", type: "select", options: OPC.nivelIdioma, required: true, max: 20 },
      { name: "escritura", label: "Escritura", type: "select", options: OPC.nivelIdioma, required: true, max: 20 },
    ],
  },
  {
    key: "equipos",
    label: "Equipos",
    columns: [
      { name: "tipo", label: "Tipo", type: "select", options: OPC.tipoEquipo, required: true, max: 30 },
      { name: "marca", label: "Marca", type: "text", required: true, max: 60 },
      { name: "modelo", label: "Modelo", type: "text", required: true, max: 100 },
      { name: "numeroSerie", label: "N° serie", type: "text", required: true, max: 80 },
      { name: "fechaEntrega", label: "F. entrega", type: "date", required: true },
      { name: "estado", label: "Estado", type: "select", options: OPC.estadoEquipo, required: true, max: 10 },
      { name: "detalle", label: "Detalle", type: "text" },
      { name: "observaciones", label: "Observaciones", type: "text" },
    ],
  },
  {
    key: "antecedentesSrt",
    label: "Antecedentes SRT",
    columns: [
      { name: "descripcion", label: "Descripción", type: "text", required: true, max: 300 },
      { name: "fecha", label: "Fecha", type: "date" },
      { name: "observaciones", label: "Observaciones", type: "text" },
    ],
  },
];

// Todos los campos escalares aplanados (útil para el schema y normalización)
export const ALL_FIELDS: FieldDef[] = SECTIONS.flatMap((s) => s.fields);
