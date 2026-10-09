import type { Metadata } from "next";
import { WmsTab } from "./WmsTab";

export const metadata: Metadata = { title: "WMS" };

export default function SistemaWmsPage() {
  return <WmsTab />;
}
