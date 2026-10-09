import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "Picking EverWear",
  description: "Pedidos al depósito",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Picking",
  },
};

export const viewport: Viewport = {
  themeColor: "#030712",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function PickingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}

