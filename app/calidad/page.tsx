import type { Metadata } from "next";
import CalidadClient from "./CalidadClient";

export const metadata: Metadata = { title: "Calidad" };

export default function CalidadPage() {
  return <CalidadClient />;
}
