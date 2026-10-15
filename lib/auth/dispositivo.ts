// Un solo celular por usuario en la app Android "Vicki" (sql/usuario_dispositivo.sql).
// La app manda en el User-Agent "VickiApp/<ver> VickiDisp/<ANDROID_ID>/<modelo>"; el navegador
// de escritorio/celular común no trae "VickiApp" y no se restringe.
import { prisma } from "@/lib/prisma";

export type Dispositivo = { deviceId: string; modelo: string | null };

export type ResultadoDispositivo =
  | { ok: true; app: boolean }
  | { ok: false; status: number; error: string };

export function esAppVicki(ua: string | null | undefined): boolean {
  return !!ua && ua.includes("VickiApp/");
}

export function dispositivoDeUA(ua: string | null | undefined): Dispositivo | null {
  const m = ua?.match(/VickiDisp\/([A-Za-z0-9_-]{4,64})(?:\/(\S+))?/);
  if (!m) return null;
  let modelo: string | null = null;
  if (m[2]) {
    try {
      modelo = decodeURIComponent(m[2]).slice(0, 120);
    } catch {
      modelo = m[2].slice(0, 120);
    }
  }
  return { deviceId: m[1], modelo };
}

const REFRESCO_MS = 10 * 60_000; // no escribir ultimoAcceso en cada /me

/**
 * `registrar=true` (login): si el usuario no tiene celular, registra este.
 * `registrar=false` (sesión ya abierta): sólo verifica que este celular siga ACTIVO.
 */
export async function validarDispositivo(
  usuarioId: number,
  ua: string | null | undefined,
  registrar: boolean,
): Promise<ResultadoDispositivo> {
  if (!esAppVicki(ua)) return { ok: true, app: false };
  const disp = dispositivoDeUA(ua);
  if (!disp)
    return {
      ok: false,
      status: 426,
      error: "Actualizá la app Vicki a la última versión para poder ingresar.",
    };

  try {
    const bloqueado = await prisma.usuario_dispositivo.findFirst({
      where: { deviceId: disp.deviceId, estado: "BLOQUEADO" },
      select: { id: true },
    });
    if (bloqueado)
      return {
        ok: false,
        status: 403,
        error: "Este celular está bloqueado. Comunicate con RRHH.",
      };

    const propio = await prisma.usuario_dispositivo.findUnique({
      where: { usuarioId_deviceId: { usuarioId, deviceId: disp.deviceId } },
    });
    if (propio) {
      if (Date.now() - propio.ultimoAcceso.getTime() > REFRESCO_MS) {
        await prisma.usuario_dispositivo
          .update({
            where: { id: propio.id },
            data: { ultimoAcceso: new Date(), ...(disp.modelo ? { modelo: disp.modelo } : {}) },
          })
          .catch(() => {});
      }
      return { ok: true, app: true };
    }

    if (!registrar)
      return {
        ok: false,
        status: 401,
        error: "Este celular ya no está registrado para tu usuario. Volvé a ingresar.",
      };

    const otro = await prisma.usuario_dispositivo.findFirst({
      where: { usuarioId, estado: "ACTIVO" },
      select: { id: true },
    });
    if (otro)
      return {
        ok: false,
        status: 403,
        error:
          "Tu usuario ya está registrado en otro celular. Pedile a RRHH que lo libere para poder usar este.",
      };

    try {
      await prisma.usuario_dispositivo.create({
        data: { usuarioId, deviceId: disp.deviceId, modelo: disp.modelo },
      });
    } catch (e: any) {
      // Índice único parcial: otro login simultáneo registró un celular distinto.
      if (e?.code === "P2002")
        return {
          ok: false,
          status: 403,
          error:
            "Tu usuario ya está registrado en otro celular. Pedile a RRHH que lo libere para poder usar este.",
        };
      throw e;
    }
    return { ok: true, app: true };
  } catch (e) {
    console.error("[dispositivo]", e);
    return { ok: false, status: 503, error: "No se pudo validar el celular. Probá de nuevo." };
  }
}
