import type { Metadata } from "next";
import SorteoClient from "./SorteoClient";

export const metadata: Metadata = { title: "Sorteo EverWear" };

export default function SorteoPage() {
  return <SorteoClient />;
}
