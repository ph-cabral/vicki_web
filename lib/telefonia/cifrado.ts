// Cifrado de la clave SIP de cada extensión (AES-256-GCM, módulo crypto de
// Node, sin dependencias). Formato guardado: base64(iv[12] | tag[16] | datos).
//
// La llave sale de TELEFONIA_SECRET (recomendado, fijo) o, si no está, de
// AUTH_SECRET. OJO: si se cambia la variable que se esté usando, las claves
// guardadas dejan de poder leerse y hay que volver a cargarlas en
// /admin/telefonia.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

function llave(): Buffer {
  const base = process.env.TELEFONIA_SECRET || process.env.AUTH_SECRET;
  if (!base || base.length < 16) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("TELEFONIA_SECRET/AUTH_SECRET no configurado");
    }
    return createHash("sha256").update("dev-insecure-telefonia").digest();
  }
  return createHash("sha256").update(`telefonia:${base}`).digest();
}

export function cifrarClave(plano: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", llave(), iv);
  const datos = Buffer.concat([c.update(plano, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), datos]).toString("base64");
}

/** null si no se puede descifrar (llave cambiada o dato corrupto). */
export function descifrarClave(cifrado: string): string | null {
  try {
    const buf = Buffer.from(cifrado, "base64");
    const d = createDecipheriv("aes-256-gcm", llave(), buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}
