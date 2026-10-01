// Alta / baja de dispositivos de la app Android "Vicki" en la VPN WireGuard
// del Mikrotik (MK-EW-PPAL, interfaz wg-everwear). La fuente de verdad son los
// peers del router: no hay tabla en Postgres. Cada peer de la app lleva en el
// comentario "vicki-app uid=<id> dev=<android_id> | <nombre> | <modelo>".
import { generateKeyPairSync } from "crypto";
import { rosRun, RouterOSError, type RosRow } from "./routeros";

export const WG_IFACE = process.env.VPN_WG_INTERFACE ?? "wg-everwear";
const ENDPOINT = process.env.VPN_ENDPOINT ?? "c5620eca3437.sn.mynetname.net";
const PORT = Number(process.env.VPN_PORT ?? 13231);
// Rango reservado para la app (celulares WireGuard a mano: .11-.30, PCs: .31-.60).
const POOL = process.env.VPN_APP_POOL ?? "10.20.30.100-10.20.30.250";
// Lo único que la app enruta por el túnel. El firewall del Mikrotik igual limita.
const ALLOWED = (process.env.VPN_APP_ALLOWED_IPS ?? "10.10.0.159/32").split(",").map((s) => s.trim());
const PREFIJO = "vicki-app ";

export type DispositivoVpn = {
  id: string; // .id del peer en RouterOS (*1A)
  uid: number | null;
  dev: string;
  nombre: string;
  modelo: string;
  ip: string;
  ultimoHandshake: string | null; // tal cual lo da RouterOS ("1m20s") o null
  deshabilitado: boolean;
};

export type ConfigVpn = {
  privateKey: string;
  address: string;
  serverPublicKey: string;
  endpoint: string;
  port: number;
  allowedIps: string[];
  keepalive: number;
};

function b64urlToB64(s: string): string {
  const b = s.replace(/-/g, "+").replace(/_/g, "/");
  return b + "=".repeat((4 - (b.length % 4)) % 4);
}

function nuevoParDeClaves(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  const d = privateKey.export({ format: "jwk" }).d!;
  const x = publicKey.export({ format: "jwk" }).x!;
  return { privateKey: b64urlToB64(d), publicKey: b64urlToB64(x) };
}

function ipToInt(ip: string): number {
  return ip.split(".").reduce((a, o) => a * 256 + Number(o), 0);
}
function intToIp(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

function parseComentario(c: string | undefined) {
  if (!c || !c.startsWith(PREFIJO)) return null;
  const [cab, nombre = "", modelo = ""] = c.split(" | ");
  const uid = /uid=(\d+)/.exec(cab)?.[1];
  const dev = /dev=([^\s]+)/.exec(cab)?.[1] ?? "";
  return { uid: uid ? Number(uid) : null, dev, nombre, modelo };
}

function limpiar(s: string, max: number) {
  return s.replace(/[|\r\n"\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function aDispositivo(r: RosRow): DispositivoVpn | null {
  const c = parseComentario(r.comment);
  if (!c) return null;
  return {
    id: r[".id"],
    ...c,
    ip: (r["allowed-address"] ?? "").split(",")[0].replace(/\/32$/, ""),
    ultimoHandshake: r["last-handshake"] ?? null,
    deshabilitado: r.disabled === "true",
  };
}

export async function listarDispositivos(): Promise<DispositivoVpn[]> {
  const [peers] = await rosRun([["/interface/wireguard/peers/print", `?interface=${WG_IFACE}`]]);
  return peers.map(aDispositivo).filter((d): d is DispositivoVpn => d !== null);
}

/**
 * Da de alta (o re-emite) el peer de un dispositivo. Idempotente por
 * android_id: si ya existía, se reemplaza la clave y se conserva la IP.
 * La clave privada se genera acá y solo viaja en la respuesta a la app.
 */
export async function altaDispositivo(p: {
  uid: number;
  nombreUsuario: string;
  dev: string;
  modelo: string;
}): Promise<ConfigVpn> {
  const dev = p.dev.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  if (!dev) throw new RouterOSError("dispositivo inválido");

  const [ifaces, peers] = await rosRun([
    ["/interface/wireguard/print", `?name=${WG_IFACE}`],
    ["/interface/wireguard/peers/print"],
  ]);
  const iface = ifaces[0];
  if (!iface?.["public-key"]) {
    throw new RouterOSError(`No existe la interfaz ${WG_IFACE} en el Mikrotik (correr vpn-app-mikrotik.rsc)`);
  }

  // IPs ocupadas por CUALQUIER peer (no solo los de la app).
  const usadas = new Set<number>();
  let previo: RosRow | null = null;
  for (const r of peers) {
    for (const a of (r["allowed-address"] ?? "").split(",")) {
      if (a.endsWith("/32")) usadas.add(ipToInt(a.slice(0, -3)));
    }
    const c = parseComentario(r.comment);
    if (c && c.dev === dev && r.interface === WG_IFACE) previo = r;
  }

  let ip: number;
  if (previo) {
    ip = ipToInt((previo["allowed-address"] ?? "").split(",")[0].replace(/\/32$/, ""));
  } else {
    const [desde, hasta] = POOL.split("-").map(ipToInt);
    ip = -1;
    for (let n = desde; n <= hasta; n++) {
      if (!usadas.has(n)) {
        ip = n;
        break;
      }
    }
    if (ip < 0) throw new RouterOSError(`No quedan IPs libres en ${POOL}`);
  }

  const claves = nuevoParDeClaves();
  const comentario =
    `${PREFIJO}uid=${p.uid} dev=${dev} | ${limpiar(p.nombreUsuario, 40)} | ${limpiar(p.modelo, 40)}`;
  const cmds: string[][] = [];
  if (previo) cmds.push(["/interface/wireguard/peers/remove", `=.id=${previo[".id"]}`]);
  cmds.push([
    "/interface/wireguard/peers/add",
    `=interface=${WG_IFACE}`,
    `=public-key=${claves.publicKey}`,
    `=allowed-address=${intToIp(ip)}/32`,
    `=comment=${comentario}`,
  ]);
  await rosRun(cmds);

  return {
    privateKey: claves.privateKey,
    address: intToIp(ip),
    serverPublicKey: iface["public-key"],
    endpoint: ENDPOINT,
    port: PORT,
    allowedIps: ALLOWED,
    keepalive: 25,
  };
}

export async function bajaDispositivo(id: string): Promise<void> {
  if (!/^\*[0-9A-F]+$/i.test(id)) throw new RouterOSError("id inválido");
  // Solo peers de la app: no se deja borrar un peer cargado a mano.
  const [peers] = await rosRun([["/interface/wireguard/peers/print", `?.id=${id}`]]);
  if (!peers[0] || !parseComentario(peers[0].comment)) throw new RouterOSError("No es un dispositivo de la app");
  await rosRun([["/interface/wireguard/peers/remove", `=.id=${id}`]]);
}
