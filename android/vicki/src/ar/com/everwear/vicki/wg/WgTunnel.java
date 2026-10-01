package ar.com.everwear.vicki.wg;

import java.io.IOException;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.ArrayDeque;

/**
 * Cliente WireGuard mínimo (solo iniciador, un solo peer), en Java puro.
 *
 * Implementa el protocolo de https://www.wireguard.com/protocol/ :
 * handshake Noise_IKpsk2, cookie reply, transporte con contador + ventana
 * anti-replay, rekey a los 120 s y keepalive persistente. No hace de
 * respondedor: el lado del Mikrotik nunca necesita iniciar porque este
 * cliente mantiene la sesión viva con el keepalive.
 *
 * No toca Android: recibe el túnel (Tun) y un DatagramSocket ya creado
 * (en Android, protegido con VpnService.protect).
 */
public final class WgTunnel {

    public interface Tun {
        /** Lee un paquete IP; devuelve 0 si no hubo nada en el tiempo de espera. */
        int read(byte[] buf) throws IOException;

        void write(byte[] buf, int off, int len) throws IOException;
    }

    public interface Listener {
        void onHandshake(long whenMs);

        void onError(String msg);
    }

    public static final class Config {
        public byte[] privateKey;
        public byte[] peerPublicKey;
        public byte[] presharedKey = new byte[32];
        public InetSocketAddress endpoint;
        public int keepaliveSec = 25;
        /** Prefijos IPv4 que el peer puede mandar (cryptokey routing), p.ej. {"10.10.0.159/32"}. */
        public String[] allowedIps = new String[0];
    }

    // Constantes del protocolo
    private static final byte[] CONSTRUCTION = "Noise_IKpsk2_25519_ChaChaPoly_BLAKE2s".getBytes(StandardCharsets.US_ASCII);
    private static final byte[] IDENTIFIER = "WireGuard v1 zx2c4 Jason@zx2c4.com".getBytes(StandardCharsets.US_ASCII);
    private static final byte[] LABEL_MAC1 = "mac1----".getBytes(StandardCharsets.US_ASCII);
    private static final byte[] LABEL_COOKIE = "cookie--".getBytes(StandardCharsets.US_ASCII);
    private static final byte[] EMPTY = new byte[0];

    static final long REKEY_AFTER_TIME = 120_000;
    static final long REJECT_AFTER_TIME = 180_000;
    static final long REKEY_TIMEOUT = 5_000;
    static final long KEEPALIVE_TIMEOUT = 10_000;
    static final long COOKIE_LIFETIME = 120_000;
    static final long REJECT_AFTER_MESSAGES = Long.MAX_VALUE - 8192; // límite práctico (el real es 2^64-2^13-1)

    private final Config cfg;
    private final Tun tun;
    private final DatagramSocket sock;
    private final Listener listener;
    private final SecureRandom rnd = new SecureRandom();

    private final byte[] staticPub;
    private final byte[] mac1Key; // HASH(LABEL_MAC1 || Spub_r)
    private final byte[] mac1KeyOwn; // para verificar las respuestas
    private final byte[] cookieKey; // HASH(LABEL_COOKIE || Spub_r)
    private final byte[] initialH;
    private final byte[] initialC;
    private final int[][] allowed; // {red, máscara}

    private final Object lock = new Object();
    private volatile boolean running;
    private Thread tTun, tUdp, tTimer;

    // Estado (bajo lock)
    private Keypair current, previous;
    private Pending pending;
    private byte[] cookie;
    private long cookieAt;
    private long lastSent, lastDataReceived;
    private volatile long lastHandshake;
    private final ArrayDeque<byte[]> queue = new ArrayDeque<>();

    private static final class Keypair {
        byte[] sendKey, recvKey;
        int localIndex, remoteIndex;
        long created;
        long sendCounter;
        final Replay replay = new Replay();
    }

    private static final class Pending {
        int localIndex;
        byte[] ephPriv, c, h, mac1;
        long sentAt, firstAt;
    }

    public WgTunnel(Config cfg, Tun tun, DatagramSocket sock, Listener listener) {
        this.cfg = cfg;
        this.tun = tun;
        this.sock = sock;
        this.listener = listener;
        this.staticPub = X25519.publicKey(cfg.privateKey);
        this.mac1Key = Blake2s.hash(LABEL_MAC1, cfg.peerPublicKey);
        this.mac1KeyOwn = Blake2s.hash(LABEL_MAC1, staticPub);
        this.cookieKey = Blake2s.hash(LABEL_COOKIE, cfg.peerPublicKey);
        this.initialC = Blake2s.hash(CONSTRUCTION);
        this.initialH = Blake2s.hash(Blake2s.hash(initialC, IDENTIFIER), cfg.peerPublicKey);
        this.allowed = new int[cfg.allowedIps.length][];
        for (int i = 0; i < cfg.allowedIps.length; i++) allowed[i] = parseCidr(cfg.allowedIps[i]);
    }

    public long lastHandshakeMs() { return lastHandshake; }

    /** Fuerza un handshake nuevo (p.ej. al cambiar de red). */
    public void rekeyNow() {
        synchronized (lock) {
            sendInitiation(System.currentTimeMillis(), true);
        }
    }

    public void start() {
        running = true;
        tTun = new Thread(new Runnable() { @Override public void run() { loopTun(); } }, "wg-tun");
        tUdp = new Thread(new Runnable() { @Override public void run() { loopUdp(); } }, "wg-udp");
        tTimer = new Thread(new Runnable() { @Override public void run() { loopTimer(); } }, "wg-timer");
        for (Thread t : new Thread[] {tTun, tUdp, tTimer}) {
            t.setDaemon(true);
            t.start();
        }
        synchronized (lock) {
            sendInitiation(System.currentTimeMillis(), true);
        }
    }

    public void stop() {
        running = false;
        sock.close();
        for (Thread t : new Thread[] {tTun, tUdp, tTimer}) if (t != null) t.interrupt();
        synchronized (lock) {
            current = previous = null;
            pending = null;
            queue.clear();
        }
    }

    // ------------------------------------------------------------------ loops

    private void loopTun() {
        byte[] buf = new byte[65535];
        while (running) {
            try {
                int n = tun.read(buf);
                if (n <= 0) continue;
                byte[] p = new byte[n];
                System.arraycopy(buf, 0, p, 0, n);
                synchronized (lock) {
                    sendPacket(p, System.currentTimeMillis());
                }
            } catch (IOException e) {
                if (running) listener.onError("tun: " + e.getMessage());
                sleep(200);
            }
        }
    }

    private void loopUdp() {
        byte[] buf = new byte[65535];
        DatagramPacket dp = new DatagramPacket(buf, buf.length);
        while (running) {
            try {
                dp.setLength(buf.length);
                sock.receive(dp);
                synchronized (lock) {
                    handle(buf, dp.getLength(), System.currentTimeMillis());
                }
            } catch (IOException e) {
                if (!running) return;
                listener.onError("udp: " + e.getMessage());
                sleep(500);
            } catch (RuntimeException e) {
                if (running) listener.onError("paquete: " + e);
            }
        }
    }

    private void loopTimer() {
        while (running) {
            sleep(500);
            if (!running) return;
            try {
                synchronized (lock) {
                    tick(System.currentTimeMillis());
                }
            } catch (RuntimeException e) {
                listener.onError("timer: " + e);
            }
        }
    }

    private static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException ignored) {
        }
    }

    // ------------------------------------------------------------------ timers

    private void tick(long now) {
        Keypair kp = current;
        if (pending != null) {
            if (now - pending.sentAt >= REKEY_TIMEOUT + pending.localIndex % 334 + 333) sendInitiation(now, false);
        } else if (kp == null || now - kp.created >= REKEY_AFTER_TIME) {
            sendInitiation(now, true);
        }
        kp = current;
        if (kp != null && now - kp.created < REJECT_AFTER_TIME) {
            boolean persistent = cfg.keepaliveSec > 0 && now - lastSent >= cfg.keepaliveSec * 1000L;
            boolean passive = lastDataReceived > lastSent && now - lastDataReceived >= KEEPALIVE_TIMEOUT;
            if (persistent || passive) sendData(kp, EMPTY, 0, now);
        }
        if (previous != null && now - previous.created >= REJECT_AFTER_TIME) previous = null;
        if (current != null && now - current.created >= REJECT_AFTER_TIME * 3) current = null;
    }

    // ------------------------------------------------------------------ envío

    private void sendPacket(byte[] p, long now) {
        Keypair kp = current;
        if (kp == null || now - kp.created >= REJECT_AFTER_TIME || kp.sendCounter >= REJECT_AFTER_MESSAGES) {
            if (queue.size() >= 128) queue.poll();
            queue.add(p);
            if (pending == null) sendInitiation(now, true);
            return;
        }
        sendData(kp, p, p.length, now);
        if (pending == null && now - kp.created >= REKEY_AFTER_TIME) sendInitiation(now, true);
    }

    private void sendData(Keypair kp, byte[] p, int len, long now) {
        int padded = (len + 15) & ~15;
        byte[] pt = p;
        if (padded != len) {
            pt = new byte[padded];
            System.arraycopy(p, 0, pt, 0, len);
        }
        byte[] msg = new byte[16 + padded + ChaChaPoly.TAG];
        msg[0] = 4;
        putLe32(msg, 4, kp.remoteIndex);
        long ctr = kp.sendCounter++;
        ChaChaPoly.putLe64(msg, 8, ctr);
        ChaChaPoly.seal(kp.sendKey, ctr, EMPTY, pt, 0, padded, msg, 16);
        udpSend(msg);
        lastSent = now;
    }

    private void udpSend(byte[] msg) {
        try {
            sock.send(new DatagramPacket(msg, msg.length, cfg.endpoint));
        } catch (IOException e) {
            if (running) listener.onError("send: " + e.getMessage());
        }
    }

    private void sendInitiation(long now, boolean fresh) {
        Pending p = new Pending();
        p.localIndex = rnd.nextInt();
        p.firstAt = (fresh || pending == null) ? now : pending.firstAt;
        p.sentAt = now;
        p.ephPriv = X25519.generatePrivate(rnd);
        byte[] ephPub = X25519.publicKey(p.ephPriv);

        byte[] c = initialC;
        byte[] h = initialH;
        c = Blake2s.kdf(1, c, ephPub)[0];
        h = Blake2s.hash(h, ephPub);
        byte[][] ck = Blake2s.kdf(2, c, X25519.scalarMult(p.ephPriv, cfg.peerPublicKey));
        c = ck[0];
        byte[] encStatic = ChaChaPoly.seal(ck[1], 0, staticPub, h);
        h = Blake2s.hash(h, encStatic);
        ck = Blake2s.kdf(2, c, X25519.scalarMult(cfg.privateKey, cfg.peerPublicKey));
        c = ck[0];
        byte[] encTs = ChaChaPoly.seal(ck[1], 0, tai64n(now), h);
        h = Blake2s.hash(h, encTs);

        byte[] msg = new byte[148];
        msg[0] = 1;
        putLe32(msg, 4, p.localIndex);
        System.arraycopy(ephPub, 0, msg, 8, 32);
        System.arraycopy(encStatic, 0, msg, 40, 48);
        System.arraycopy(encTs, 0, msg, 88, 28);
        p.mac1 = Blake2s.mac(mac1Key, msg, 116);
        System.arraycopy(p.mac1, 0, msg, 116, 16);
        if (cookie != null && now - cookieAt < COOKIE_LIFETIME) {
            System.arraycopy(Blake2s.mac(cookie, msg, 132), 0, msg, 132, 16);
        }
        p.c = c;
        p.h = h;
        pending = p;
        udpSend(msg);
    }

    private static byte[] tai64n(long ms) {
        byte[] t = new byte[12];
        long sec = 0x400000000000000aL + ms / 1000;
        int nano = (int) (ms % 1000) * 1_000_000;
        for (int i = 0; i < 8; i++) t[i] = (byte) (sec >>> (56 - 8 * i));
        for (int i = 0; i < 4; i++) t[8 + i] = (byte) (nano >>> (24 - 8 * i));
        return t;
    }

    // ------------------------------------------------------------------ recepción

    private void handle(byte[] b, int len, long now) {
        if (len < 4 || b[1] != 0 || b[2] != 0 || b[3] != 0) return;
        switch (b[0]) {
            case 2:
                if (len == 92) handleResponse(b, now);
                break;
            case 3:
                if (len == 64) handleCookie(b, now);
                break;
            case 4:
                if (len >= 32) handleData(b, len, now);
                break;
            default:
                // 1 = iniciación desde el server: no hacemos de respondedor.
        }
    }

    private void handleResponse(byte[] b, long now) {
        Pending p = pending;
        if (p == null || le32(b, 8) != p.localIndex) return;
        byte[] mac1 = Blake2s.mac(mac1KeyOwn, b, 60);
        for (int i = 0; i < 16; i++) if (mac1[i] != b[60 + i]) return;
        byte[] ephR = new byte[32];
        System.arraycopy(b, 12, ephR, 0, 32);
        byte[] c = Blake2s.kdf(1, p.c, ephR)[0];
        byte[] h = Blake2s.hash(p.h, ephR);
        c = Blake2s.kdf(1, c, X25519.scalarMult(p.ephPriv, ephR))[0];
        c = Blake2s.kdf(1, c, X25519.scalarMult(cfg.privateKey, ephR))[0];
        byte[][] ctk = Blake2s.kdf(3, c, cfg.presharedKey);
        c = ctk[0];
        h = Blake2s.hash(h, ctk[1]);
        if (ChaChaPoly.open(ctk[2], 0, b, 44, 16, h) == null) return;

        byte[][] keys = Blake2s.kdf(2, c, EMPTY);
        Keypair kp = new Keypair();
        kp.sendKey = keys[0];
        kp.recvKey = keys[1];
        kp.localIndex = p.localIndex;
        kp.remoteIndex = le32(b, 4);
        kp.created = now;
        previous = current;
        current = kp;
        pending = null;
        lastHandshake = now;

        // El respondedor no puede mandar nada hasta recibir el primer paquete nuestro.
        if (queue.isEmpty()) {
            sendData(kp, EMPTY, 0, now);
        } else {
            while (!queue.isEmpty()) {
                byte[] q = queue.poll();
                sendData(kp, q, q.length, now);
            }
        }
        listener.onHandshake(now);
    }

    private void handleCookie(byte[] b, long now) {
        Pending p = pending;
        if (p == null || le32(b, 4) != p.localIndex) return;
        byte[] nonce = new byte[24];
        System.arraycopy(b, 8, nonce, 0, 24);
        byte[] ck = ChaChaPoly.xopen(cookieKey, nonce, b, 32, 32, p.mac1);
        if (ck == null) return;
        cookie = ck;
        cookieAt = now;
        // se reenvía la iniciación (con mac2) cuando vence REKEY_TIMEOUT
    }

    private void handleData(byte[] b, int len, long now) {
        int idx = le32(b, 4);
        Keypair kp = current != null && current.localIndex == idx ? current
                : previous != null && previous.localIndex == idx ? previous : null;
        if (kp == null || now - kp.created >= REJECT_AFTER_TIME) return;
        long ctr = le64(b, 8);
        if (ctr < 0 || ctr >= REJECT_AFTER_MESSAGES || !kp.replay.maybe(ctr)) return;
        byte[] pt = ChaChaPoly.open(kp.recvKey, ctr, b, 16, len - 16, EMPTY);
        if (pt == null || !kp.replay.accept(ctr)) return;

        if (kp == current && pending == null
                && now - kp.created >= REJECT_AFTER_TIME - KEEPALIVE_TIMEOUT - REKEY_TIMEOUT) {
            sendInitiation(now, true);
        }
        if (pt.length == 0) return; // keepalive

        int real;
        int ver = (pt[0] & 0xff) >>> 4;
        if (ver == 4 && pt.length >= 20) {
            real = ((pt[2] & 0xff) << 8) | (pt[3] & 0xff);
            if (!allowedSrc(le32be(pt, 12))) return;
        } else if (ver == 6 && pt.length >= 40) {
            real = 40 + (((pt[4] & 0xff) << 8) | (pt[5] & 0xff));
            if (allowed.length > 0) return; // solo rutas IPv4 configuradas
        } else {
            return;
        }
        if (real > pt.length || real < 20) return;
        lastDataReceived = now;
        try {
            tun.write(pt, 0, real);
        } catch (IOException e) {
            if (running) listener.onError("tun write: " + e.getMessage());
        }
    }

    private boolean allowedSrc(int ip) {
        if (allowed.length == 0) return true;
        for (int[] a : allowed) if ((ip & a[1]) == a[0]) return true;
        return false;
    }

    static int[] parseCidr(String s) {
        String[] parts = s.trim().split("/");
        String[] o = parts[0].split("\\.");
        int ip = 0;
        for (int i = 0; i < 4; i++) ip = (ip << 8) | (Integer.parseInt(o[i]) & 0xff);
        int bits = parts.length > 1 ? Integer.parseInt(parts[1]) : 32;
        int mask = bits == 0 ? 0 : -1 << (32 - bits);
        return new int[] {ip & mask, mask};
    }

    // ------------------------------------------------------------------ bytes

    static int le32(byte[] b, int o) {
        return (b[o] & 0xff) | (b[o + 1] & 0xff) << 8 | (b[o + 2] & 0xff) << 16 | (b[o + 3] & 0xff) << 24;
    }

    private static int le32be(byte[] b, int o) {
        return (b[o] & 0xff) << 24 | (b[o + 1] & 0xff) << 16 | (b[o + 2] & 0xff) << 8 | (b[o + 3] & 0xff);
    }

    static long le64(byte[] b, int o) {
        long v = 0;
        for (int i = 0; i < 8; i++) v |= (long) (b[o + i] & 0xff) << (8 * i);
        return v;
    }

    static void putLe32(byte[] b, int o, int v) {
        b[o] = (byte) v;
        b[o + 1] = (byte) (v >>> 8);
        b[o + 2] = (byte) (v >>> 16);
        b[o + 3] = (byte) (v >>> 24);
    }

    /** Ventana anti-replay de 2048 contadores (como wireguard-go). */
    static final class Replay {
        private static final int WORDS = 32, BITS = WORDS * 64;
        private final long[] map = new long[WORDS];
        private long greatest = -1;

        /** Chequeo previo (sin marcar), para no gastar AEAD en repetidos obvios. */
        boolean maybe(long c) {
            if (c > greatest) return true;
            if (greatest - c >= BITS - 64) return false;
            return (map[(int) ((c >>> 6) & (WORDS - 1))] & (1L << (c & 63))) == 0;
        }

        boolean accept(long c) {
            if (c > greatest) {
                long cur = greatest < 0 ? -1 : greatest >>> 6;
                long nw = c >>> 6;
                long diff = Math.min(nw - cur, WORDS);
                for (long i = 1; i <= diff; i++) map[(int) ((cur + i) & (WORDS - 1))] = 0;
                greatest = c;
            } else if (greatest - c >= BITS - 64) {
                return false;
            }
            int w = (int) ((c >>> 6) & (WORDS - 1));
            long bit = 1L << (c & 63);
            if ((map[w] & bit) != 0) return false;
            map[w] |= bit;
            return true;
        }
    }
}
