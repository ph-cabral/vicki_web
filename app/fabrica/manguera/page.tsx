import Mangueras from "./Mangueras"; // ✅ Sin llaves, importación por defecto

export const dynamic = "force-dynamic";

export default async function Home() {
  return (
    <div>
      <Mangueras />
    </div>
  );
}
