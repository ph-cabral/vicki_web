import { getLegajosMangueraAction, getManguerasAction } from "../../actions";
import { NuevoTrabajoClient } from "./NuevoTrabajoClient";

export const dynamic = "force-dynamic";

export default async function NuevoTrabajo() {
  const [legajos, mangueras] = await Promise.all([
    getLegajosMangueraAction(),
    getManguerasAction(),
  ]);
  return <NuevoTrabajoClient legajos={legajos} mangueras={mangueras} />;
}
