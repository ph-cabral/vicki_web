import { prisma } from "@/lib/prisma";
import type { LegajoUpdate } from "./legajoSchema";

const relations = {
  familiares: true, beneficiarios: true, estudios: true,
  idiomas: true, equipos: true, antecedentesSrt: true,
} as const;

export async function getLegajoFormValues(id: number) {
  return prisma.legajo.findUnique({ where: { id }, include: relations });
}

export type ConvenioResuelto = {
  convenioId: number | null;
  categoriaId: number | null;
  convenio: string | null;
  categoria: string | null;
};

/**
 * Único punto donde se escriben convenio/categoría del legajo.
 *
 * La UI manda ids del catálogo (everwear.convenio / convenio_categoria) y acá se
 * resuelven los nombres para dejar también las columnas de texto al día: las
 * siguen leyendo exports, el RAG y consultas sueltas, y así FK y texto no pueden
 * divergir.
 *
 * Manda la categoría: si la elegida pertenece a otro convenio, se corrige el
 * convenio en vez de guardar un par inconsistente. Una sola consulta, porque la
 * categoría ya trae su convenio.
 */
export async function resolverConvenio(
  convenioId?: number | null,
  categoriaId?: number | null,
): Promise<ConvenioResuelto> {
  if (categoriaId) {
    const cat = await prisma.convenio_categoria.findUnique({
      where: { id: categoriaId },
      select: {
        id: true,
        nombre: true,
        convenioId: true,
        convenio: { select: { nombre: true } },
      },
    });
    if (cat) {
      return {
        convenioId: cat.convenioId,
        categoriaId: cat.id,
        convenio: cat.convenio.nombre,
        categoria: cat.nombre,
      };
    }
  }

  const con = convenioId
    ? await prisma.convenio.findUnique({
        where: { id: convenioId },
        select: { id: true, nombre: true },
      })
    : null;

  // sin convenio válido no puede quedar categoría colgada
  return {
    convenioId: con?.id ?? null,
    categoriaId: null,
    convenio: con?.nombre ?? null,
    categoria: null,
  };
}

export async function updateLegajo(id: number, data: LegajoUpdate) {
  let payload: LegajoUpdate & Partial<ConvenioResuelto> = data;

  if ("convenioId" in data || "categoriaId" in data) {
    payload = { ...data, ...(await resolverConvenio(data.convenioId, data.categoriaId)) };
  }

  const result = await prisma.$transaction(async (tx) => {
    // Si el N° de legajo (`codigo`) cambia — típico al cambiar de puesto o
    // convenio (ver sql/rrhh_legajo_convenio_carga.sql) — el código anterior
    // se guarda en legajo_codigo_historial en vez de perderse: así, si ese
    // número queda libre y se lo dan a otra persona más adelante, el cruce
    // de nómina (app/api/rrhh/nomina/route.ts) sigue reconociendo a AMBOS
    // dueños del código y desambigua por similitud de nombre contra el
    // Excel (ver elegirCandidato() ahí).
    if ("codigo" in data) {
      const actual = await tx.legajo.findUnique({ where: { id }, select: { codigo: true } });
      if (actual?.codigo && actual.codigo !== data.codigo) {
        await tx.legajo_codigo_historial.create({ data: { legajoId: id, codigo: actual.codigo } });
      }
    }

    return tx.legajo.update({
      where: { id },
      data: payload,
      include: { sectorRel: { select: { nombre: true } } },
    });
  });

  // usuario.sector se hornea en la cookie de sesión al loguear (ver lib/auth/permissions.ts)
  // y sólo se setea una vez en el alta (api/auth/register). Si cambia el sector del legajo,
  // hay que resincronizarlo acá o el usuario queda con permisos viejos/vacíos.
  if ("sector" in data || "sectorId" in data) {
    const sectorEfectivo = result.sectorRel?.nombre ?? result.sector ?? null;
    await prisma.usuario.updateMany({
      where: { legajoId: id },
      data: { sector: sectorEfectivo },
    });
  }

  return result;
}
