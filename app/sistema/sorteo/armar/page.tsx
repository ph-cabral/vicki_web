import type { Metadata } from "next";
import ArmarClient from "./ArmarClient";

export const metadata: Metadata = { title: "Armar premios — Sorteo EverWear" };

export default function ArmarPage() {
  return <ArmarClient />;
}
