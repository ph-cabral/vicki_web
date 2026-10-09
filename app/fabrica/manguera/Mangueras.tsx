import { getManguerasAction, getPersonalAction } from "./actions";
import { ManguerasClient } from "./ManguerasClient";

export default async function Mangueras() {
  const [mangueras, personal] = await Promise.all([
    getManguerasAction(),
    getPersonalAction(),
  ]);

  return <ManguerasClient mangueras={mangueras} personal={personal} />;
}
