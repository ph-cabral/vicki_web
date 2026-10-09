import { getTrabajosAction } from "../actions";
import { TrabajosClient } from "./TrabajosClient";

export const dynamic = "force-dynamic";

export default async function Home() {
  const trabajos = await getTrabajosAction();
  return <TrabajosClient trabajos={trabajos} />;
}
