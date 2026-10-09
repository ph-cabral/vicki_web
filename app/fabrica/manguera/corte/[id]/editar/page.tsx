import { notFound } from "next/navigation";
import {
  getLegajosMangueraAction,
  getManguerasAction,
  getTrabajoAction,
} from "../../../actions";
import { NuevoTrabajoClient } from "../../nuevo/NuevoTrabajoClient";

export const dynamic = "force-dynamic";

export default async function EditarTrabajo({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [trabajo, legajos, mangueras] = await Promise.all([
    getTrabajoAction(Number(id)),
    getLegajosMangueraAction(),
    getManguerasAction(),
  ]);
  if (!trabajo) notFound();

  return (
    <NuevoTrabajoClient
      legajos={legajos}
      mangueras={mangueras}
      trabajo={{
        id: trabajo.id,
        legajoId: trabajo.legajoId,
        clienteNumero: trabajo.clienteNumero,
        clienteNombre: trabajo.clienteNombre ?? null,
        ordenTrabajo: trabajo.ordenTrabajo,
        prioridad: trabajo.prioridad,
        producto: trabajo.producto,
        cantidadAProducir: trabajo.cantidadAProducir,
        observaciones: trabajo.observaciones,
        fechaPedido: trabajo.fechaPedido,
        cortes: trabajo.cortes.map((c) => ({
          codigo: c.codigo,
          metros: c.metros,
          observacion: c.observacion,
        })),
      }}
    />
  );
}
