// Cliente mínimo de la API clásica de RouterOS (TCP 8728), sin dependencias.
// Protocolo: https://help.mikrotik.com/docs/spaces/ROS/pages/47579160/API
// Se usa solo para dar de alta / baja peers de WireGuard desde vicki (lib/vpn/wireguard.ts).
// Runtime Node (net). Cada llamada abre y cierra su propia conexión: son pocas y esporádicas.
import net from "net";

export type RosRow = Record<string, string>;

function encodeLength(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  if (n < 0x4000) return Buffer.from([(n >> 8) | 0x80, n & 0xff]);
  if (n < 0x200000) return Buffer.from([(n >> 16) | 0xc0, (n >> 8) & 0xff, n & 0xff]);
  if (n < 0x10000000) return Buffer.from([(n >>> 24) | 0xe0, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
  return Buffer.from([0xf0, (n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
}

function encodeSentence(words: string[]): Buffer {
  const parts: Buffer[] = [];
  for (const w of words) {
    const b = Buffer.from(w, "utf8");
    parts.push(encodeLength(b.length), b);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

/** Lee palabras del buffer; devuelve [palabras de sentencias completas, bytes consumidos]. */
function decode(buf: Buffer): { sentences: string[][]; used: number } {
  const sentences: string[][] = [];
  let pos = 0;
  let cur: string[] = [];
  let lastComplete = 0;
  while (pos < buf.length) {
    const c = buf[pos];
    let len: number;
    let hdr: number;
    if ((c & 0x80) === 0) { len = c; hdr = 1; }
    else if ((c & 0xc0) === 0x80) { if (pos + 2 > buf.length) break; len = ((c & 0x3f) << 8) | buf[pos + 1]; hdr = 2; }
    else if ((c & 0xe0) === 0xc0) { if (pos + 3 > buf.length) break; len = ((c & 0x1f) << 16) | (buf[pos + 1] << 8) | buf[pos + 2]; hdr = 3; }
    else if ((c & 0xf0) === 0xe0) { if (pos + 4 > buf.length) break; len = ((c & 0x0f) * 0x1000000) + (buf[pos + 1] << 16) + (buf[pos + 2] << 8) + buf[pos + 3]; hdr = 4; }
    else { if (pos + 5 > buf.length) break; len = buf.readUInt32BE(pos + 1); hdr = 5; }
    if (pos + hdr + len > buf.length) break;
    pos += hdr;
    if (len === 0) {
      sentences.push(cur);
      cur = [];
      lastComplete = pos;
      continue;
    }
    cur.push(buf.subarray(pos, pos + len).toString("utf8"));
    pos += len;
  }
  return { sentences, used: lastComplete };
}

export class RouterOSError extends Error {}

function cfg() {
  const host = process.env.MIKROTIK_HOST;
  const user = process.env.MIKROTIK_API_USER;
  const pass = process.env.MIKROTIK_API_PASS ?? "";
  if (!host || !user) throw new RouterOSError("Falta MIKROTIK_HOST / MIKROTIK_API_USER en el .env");
  return { host, port: Number(process.env.MIKROTIK_API_PORT ?? 8728), user, pass };
}

/**
 * Abre sesión, corre los comandos en orden y cierra. Cada comando es
 * [path, ...palabras] (p.ej. ["/interface/wireguard/peers/print", "?interface=wg-everwear"]).
 * Devuelve las filas (!re) de cada comando. Un !trap corta y tira RouterOSError.
 */
export async function rosRun(commands: string[][], timeoutMs = 8000): Promise<RosRow[][]> {
  const { host, port, user, pass } = cfg();
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    let buf = Buffer.alloc(0);
    const results: RosRow[][] = [];
    let rows: RosRow[] = [];
    let step = -1; // -1 = login
    let trap: string | null = null;
    let done = false;

    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      if (err) reject(err);
      else resolve(results);
    };
    const timer = setTimeout(() => finish(new RouterOSError(`Timeout hablando con el Mikrotik (${host}:${port})`)), timeoutMs);

    const send = (words: string[]) => sock.write(encodeSentence(words));
    const next = () => {
      step++;
      if (step >= commands.length) {
        finish();
        return;
      }
      rows = [];
      send(commands[step]);
    };

    sock.on("connect", () => send(["/login", `=name=${user}`, `=password=${pass}`]));
    sock.on("error", (e) => finish(new RouterOSError(`Mikrotik ${host}:${port}: ${e.message}`)));
    sock.on("close", () => finish(new RouterOSError("El Mikrotik cerró la conexión")));
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const { sentences, used } = decode(buf);
      buf = buf.subarray(used);
      for (const s of sentences) {
        const type = s[0];
        const attrs: RosRow = {};
        for (const w of s.slice(1)) {
          if (!w.startsWith("=")) continue;
          const i = w.indexOf("=", 1);
          attrs[w.slice(1, i)] = w.slice(i + 1);
        }
        if (type === "!re") rows.push(attrs);
        else if (type === "!trap") trap = attrs.message ?? "error";
        else if (type === "!fatal") return finish(new RouterOSError(`Mikrotik: ${s.slice(1).join(" ")}`));
        else if (type === "!done") {
          if (trap) {
            const msg = step < 0 ? `Login rechazado: ${trap}` : `${commands[step][0]}: ${trap}`;
            return finish(new RouterOSError(msg));
          }
          if (step >= 0) results.push(rows);
          next();
        }
      }
    });
  });
}
