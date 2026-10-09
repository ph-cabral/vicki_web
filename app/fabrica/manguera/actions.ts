"use server";

import { prisma } from "@/lib/prisma";
import { revalidatePath } from "next/cache";

// Los clientes se leen en vivo de Magnus vía indicadores-api (no de Postgres).
const INDICADORES_API_URL =
  process.env.INDICADORES_API_URL ?? "http://indicadores-api:8001";

export async function getPersonalAction() {
  return prisma.personal.findMany({
    orderBy: { nombre: "asc" },
    select: { id: true, nombre: true },
  });
}

export async function getManguerasAction() {
  return prisma.manguera.findMany({ orderBy: { createdAt: "desc" } });
}

export async function addMangueraAction(formData: FormData) {
  const codigo = (formData.get("codigo") as string).toUpperCase().trim();
  const metros = parseFloat(formData.get("metros") as string);
  const ubicacion = (formData.get("ubicacion") as string).toUpperCase().trim();
  if (!codigo || isNaN(metros) || metros <= 0)
    throw new Error("Datos inválidos");
  await prisma.manguera.create({
    data: { codigo, metros, ubicacion: ubicacion || null },
  });
  revalidatePath("/fabrica/manguera");
}

export async function cortarMangueraAction(
  id: number,
  metrosUsados: number,
  personalId: number,
) {
  if (!id || isNaN(metrosUsados) || !personalId)
    throw new Error("Datos inválidos");
  const rollo = await prisma.manguera.findUnique({ where: { id } });
  if (!rollo) throw new Error("Rollo no encontrado");
  const persona = await prisma.personal.findUnique({
    where: { id: personalId },
  });
  if (!persona) throw new Error("Personal no encontrado");
  const cortado = Math.abs(metrosUsados);
  // Descuento atómico y condicional: dos cortes simultáneos ya no pueden
  // pasar los dos el chequeo de stock (antes era read-then-write con carrera).
  await prisma.$transaction(async (tx) => {
    const res = await tx.manguera.updateMany({
      where: { id, metros: { gte: cortado } },
      data: { metros: { decrement: cortado } },
    });
    if (res.count === 0) throw new Error("No hay suficientes metros");
    await tx.corte.create({
      data: { codigo: rollo.codigo, metros: cortado, personalId: persona.id },
    });
    await tx.manguera.deleteMany({ where: { id, metros: { lte: 0 } } });
  });
  revalidatePath("/fabrica/manguera");
}

export async function addPersonalAction(formData: FormData) {
  const nombre = (formData.get("nombre") as string).toUpperCase().trim();
  const dni = (formData.get("dni") as string)?.trim() || null;
  if (!nombre) throw new Error("El nombre es obligatorio");
  await prisma.personal.create({ data: { nombre, dni } });
  revalidatePath("/fabrica/manguera");
}

/* ---------- TRABAJOS ---------- */

export async function getLegajosMangueraAction() {
  return prisma.legajo.findMany({
    where: {
      sectorRel: {
        is: { nombre: { equals: "mangueras", mode: "insensitive" } },
      },
    },
    orderBy: { nombre: "asc" },
    select: { id: true, nombre: true, sectorRel: { select: { nombre: true } } },
  });
}

export async function getClienteAction(numero: number) {
  if (numero == null || isNaN(numero)) return null;
  try {
    const res = await fetch(`${INDICADORES_API_URL}/clientes/${numero}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null; // 404 (no existe) o 503 (Magnus caído)
    const cli = await res.json();
    return {
      numero: Number(cli.numero),
      nombre: cli.nombre != null ? String(cli.nombre) : "",
    };
  } catch {
    return null;
  }
}

export async function getTrabajosAction() {
  return prisma.trabajo.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      ordenTrabajo: true,
      fechaPedido: true,
      estado: true,
      legajo: { select: { nombre: true } },
      sector: { select: { nombre: true } },
      clienteNombre: true,
      _count: { select: { cortes: true } },
      cortes: {
        orderBy: { fecha: "desc" },
        select: {
          id: true,
          codigo: true,
          metros: true,
          fecha: true,
          observacion: true,
          personal: { select: { nombre: true } },
        },
      },
    },
  });
}

type NuevoCorte = {
  mangueraId: number;
  codigo: string;
  metros: number;
  observacion?: string | null;
};
type NuevoTrabajoInput = {
  legajoId: number;
  clienteNumero: number | null;
  clienteNombre?: string | null;
  ordenTrabajo?: string | null;
  prioridad?: string | null;
  producto?: string | null;
  cantidadAProducir?: number | null;
  observaciones?: string | null;
  inicio: string;
  cortes: NuevoCorte[];
  finalizar?: boolean;
};

// function calcEstado(cantidad: number | null | undefined, nCortes: number) {
//   if (!cantidad || cantidad <= 0)
//     return nCortes > 0 ? "TERMINADO" : "PENDIENTE";
//   if (nCortes === cantidad) return "CUMPLIDO";
//   return nCortes < cantidad ? "INCOMPLETO" : "EXCEDIDO";
// }
function calcEstado(
  finalizar: boolean,
  cortes: { observacion?: string | null }[],
) {
  if (
    cortes.some(
      (c) => (c.observacion || "").toUpperCase() === "ESPERA DE RECEPCION",
    )
  )
    return "ESPERA_RECEPCION";
  return finalizar ? "CUMPLIDO" : "EN_PROCESO";
}

// Resuelve número + nombre del cliente para denormalizar en el trabajo.
// El nombre suele venir del form (ya resuelto contra Magnus); si falta, se
// intenta completar best-effort desde Magnus. No hay FK: nunca bloquea el guardado.
async function resolveCliente(input: {
  clienteNumero: number | null;
  clienteNombre?: string | null;
}): Promise<{ clienteNumero: number | null; clienteNombre: string | null }> {
  if (input.clienteNumero == null || isNaN(input.clienteNumero)) {
    return { clienteNumero: null, clienteNombre: null };
  }
  let clienteNombre = input.clienteNombre?.trim() || null;
  if (!clienteNombre) {
    const cli = await getClienteAction(input.clienteNumero);
    clienteNombre = cli?.nombre || null;
  }
  return { clienteNumero: input.clienteNumero, clienteNombre };
}

export async function createTrabajoAction(input: NuevoTrabajoInput) {
  if (!input.legajoId) throw new Error("Elegí un operario");
  if (!input.cortes?.length) throw new Error("Agregá al menos un corte");

  const legajo = await prisma.legajo.findUnique({
    where: { id: input.legajoId },
    select: { id: true, sectorId: true },
  });
  if (!legajo) throw new Error("Operario no encontrado");

  const { clienteNumero, clienteNombre } = await resolveCliente(input);

  // const estado = calcEstado(input.cantidadAProducir, input.cortes.length);
  const estado = calcEstado(!!input.finalizar, input.cortes);

  await prisma.$transaction(async (tx) => {
    const trabajo = await tx.trabajo.create({
      data: {
        legajoId: legajo.id,
        sectorId: legajo.sectorId,
        clienteNumero,
        clienteNombre,
        ordenTrabajo: input.ordenTrabajo?.trim() || null,
        prioridad: input.prioridad || null,
        producto: input.producto?.trim() || null,
        cantidadAProducir: input.cantidadAProducir ?? null,
        observaciones: input.observaciones?.trim() || null,
        estado,
        inicio: new Date(input.inicio),
        fin: new Date(),
      },
    });

    for (const c of input.cortes) {
      const rollo = await tx.manguera.findUnique({
        where: { id: c.mangueraId },
        select: { id: true },
      });
      if (!rollo) throw new Error(`Manguera ${c.codigo} no encontrada`);
      const usar = Math.max(0, c.metros || 0);
      await tx.corte.create({
        data: {
          codigo: c.codigo,
          metros: usar,
          observacion: c.observacion?.trim() || null,
          trabajoId: trabajo.id,
        },
      });
      // decremento atómico (sin carrera read-then-write); si queda en 0 o menos, se borra el rollo
      await tx.manguera.update({
        where: { id: rollo.id },
        data: { metros: { decrement: usar } },
      });
      await tx.manguera.deleteMany({ where: { id: rollo.id, metros: { lte: 0 } } });
    }
  });

  revalidatePath("/fabrica/manguera");
}

export async function updateCorteAction(input: {
  corteId: number;
  metros: number;
  observacion?: string | null;
}) {
  const corte = await prisma.corte.findUnique({
    where: { id: input.corteId },
  });
  if (!corte) throw new Error("Corte no encontrado");

  const nuevo = Math.max(0, Math.round((input.metros || 0) * 100) / 100);
  const diff = nuevo - corte.metros; // >0 consume más, <0 devuelve
  const obs = input.observacion?.trim() || null;

  await prisma.$transaction(async (tx) => {
    await tx.corte.update({
      where: { id: corte.id },
      data: { metros: nuevo, observacion: obs },
    });

    if (diff !== 0) {
      const rollo = await tx.manguera.findFirst({
        where: { codigo: corte.codigo },
        orderBy: { createdAt: "asc" },
        select: { id: true },
      });
      if (rollo) {
        // decremento/incremento atómico; si queda en 0 o menos, se borra
        await tx.manguera.update({
          where: { id: rollo.id },
          data: { metros: { decrement: diff } },
        });
        await tx.manguera.deleteMany({ where: { id: rollo.id, metros: { lte: 0 } } });
      } else if (diff < 0) {
        // rollo se borró al llegar a 0 → recrear con lo devuelto
        await tx.manguera.create({
          data: { codigo: corte.codigo, metros: -diff },
        });
      }
      // diff>0 sin rollo: se registra igual, no hay stock que descontar
    }

    if (corte.trabajoId) {
      const trabajo = await tx.trabajo.findUnique({
        where: { id: corte.trabajoId },
        select: { estado: true },
      });
      const cortes = await tx.corte.findMany({
        where: { trabajoId: corte.trabajoId },
        select: { observacion: true },
      });
      const hayEspera = cortes.some(
        (c) => (c.observacion || "").toUpperCase() === "ESPERA DE RECEPCION",
      );
      let estado = trabajo?.estado ?? "EN_PROCESO";
      if (hayEspera) estado = "ESPERA_RECEPCION";
      else if (estado === "ESPERA_RECEPCION") estado = "EN_PROCESO";
      await tx.trabajo.update({
        where: { id: corte.trabajoId },
        data: { estado },
      });
    }
  });

  revalidatePath("/fabrica/manguera/corte");
  revalidatePath("/fabrica/manguera");
}
export async function getTrabajoAction(id: number) {
  return prisma.trabajo.findUnique({
    where: { id },
    select: {
      id: true,
      legajoId: true,
      clienteNumero: true,
      ordenTrabajo: true,
      prioridad: true,
      producto: true,
      cantidadAProducir: true,
      observaciones: true,
      fechaPedido: true,
      estado: true,
      clienteNombre: true,
      cortes: {
        orderBy: { fecha: "asc" },
        select: { id: true, codigo: true, metros: true, observacion: true },
      },
    },
  });
}

export async function updateTrabajoAction(
  input: NuevoTrabajoInput & { trabajoId: number },
) {
  if (!input.trabajoId) throw new Error("Falta trabajoId");
  if (!input.legajoId) throw new Error("Elegí un operario");
  if (!input.cortes?.length) throw new Error("Agregá al menos un corte");

  const legajo = await prisma.legajo.findUnique({
    where: { id: input.legajoId },
    select: { id: true, sectorId: true },
  });
  if (!legajo) throw new Error("Operario no encontrado");

  const { clienteNumero, clienteNombre } = await resolveCliente(input);

  const estado = calcEstado(!!input.finalizar, input.cortes);

  await prisma.$transaction(async (tx) => {
    const previos = await tx.corte.findMany({
      where: { trabajoId: input.trabajoId },
      select: { metros: true, codigo: true },
    });

    const sumar = (arr: { codigo: string; metros: number }[]) => {
      const m: Record<string, number> = {};
      for (const c of arr) m[c.codigo] = (m[c.codigo] || 0) + (c.metros || 0);
      return m;
    };
    const oldByCod = sumar(previos);
    const newByCod = sumar(
      input.cortes.map((c) => ({
        codigo: c.codigo,
        metros: Math.max(0, c.metros || 0),
      })),
    );

    // reconciliar stock por código: delta = nuevo - viejo
    const cods = new Set([...Object.keys(oldByCod), ...Object.keys(newByCod)]);
    for (const cod of cods) {
      const delta = (newByCod[cod] || 0) - (oldByCod[cod] || 0);
      if (delta === 0) continue;
      const rollo = await tx.manguera.findFirst({
        where: { codigo: cod },
        orderBy: { createdAt: "asc" },
        select: { id: true },
      });
      if (rollo) {
        // ajuste atómico de stock; si queda en 0 o menos, se borra
        await tx.manguera.update({
          where: { id: rollo.id },
          data: { metros: { decrement: delta } },
        });
        await tx.manguera.deleteMany({ where: { id: rollo.id, metros: { lte: 0 } } });
      } else if (delta < 0) {
        await tx.manguera.create({ data: { codigo: cod, metros: -delta } });
      }
      // delta>0 sin rollo: se registra igual
    }

    await tx.corte.deleteMany({ where: { trabajoId: input.trabajoId } });
    for (const c of input.cortes) {
      await tx.corte.create({
        data: {
          codigo: c.codigo,
          metros: Math.max(0, c.metros || 0),
          observacion: c.observacion?.trim() || null,
          trabajoId: input.trabajoId,
        },
      });
    }

    await tx.trabajo.update({
      where: { id: input.trabajoId },
      data: {
        legajoId: legajo.id,
        sectorId: legajo.sectorId,
        clienteNumero,
        clienteNombre,
        ordenTrabajo: input.ordenTrabajo?.trim() || null,
        prioridad: input.prioridad || null,
        producto: input.producto?.trim() || null,
        cantidadAProducir: input.cantidadAProducir ?? null,
        observaciones: input.observaciones?.trim() || null,
        estado,
        fin: input.finalizar ? new Date() : null,
      },
    });
  });

  revalidatePath("/fabrica/manguera/corte");
  revalidatePath("/fabrica/manguera");
}