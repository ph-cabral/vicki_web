import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Imagen Docker mínima: copia solo lo necesario (ver Dockerfile.prod)
  output: "standalone",
  allowedDevOrigins: ["10.10.0.159"],
  // Extracción de texto de los adjuntos de /rrhh/puestos: son CommonJS con
  // binarios/assets propios; si el bundler los empaqueta rompen en runtime.
  serverExternalPackages: ["pdf-parse", "mammoth"],
  // 2026-10-09: picking -> /deposito/picking, manguera -> /fabrica/manguera,
  // sorteo -> /sistema/sorteo. Links viejos (APK del picker instalado, PWA, favoritos).
  async redirects() {
    return [
      { source: "/picking", destination: "/deposito/picking", permanent: false },
      { source: "/picking/:path*", destination: "/deposito/picking/:path*", permanent: false },
      { source: "/manguera", destination: "/fabrica/manguera", permanent: false },
      { source: "/manguera/:path*", destination: "/fabrica/manguera/:path*", permanent: false },
      { source: "/sorteo", destination: "/sistema/sorteo", permanent: false },
      { source: "/sorteo/:path*", destination: "/sistema/sorteo/:path*", permanent: false },
      { source: "/buscador", destination: "/", permanent: false },
    ];
  },
  eslint: {
    // ESLint corre en CI/dev; no bloquear el build de producción
    ignoreDuringBuilds: true,
  },
  typescript: {
    // Errores de tipos se resuelven en dev; no bloquear el build de producción
    ignoreBuildErrors: true,
  },
};

export default nextConfig;
