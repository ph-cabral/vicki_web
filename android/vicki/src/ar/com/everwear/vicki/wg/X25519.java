package ar.com.everwear.vicki.wg;

/**
 * Curve25519 (RFC 7748) en Java puro — port directo de crypto_scalarmult de
 * TweetNaCl (dominio público). Solo se usa en el handshake (una vez cada
 * 2 minutos), así que la velocidad no importa.
 */
final class X25519 {
    private X25519() {}

    private static final long[] C121665 = {0xDB41, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0};

    static final byte[] BASEPOINT = new byte[32];
    static { BASEPOINT[0] = 9; }

    private static void car(long[] o) {
        for (int i = 0; i < 16; i++) {
            o[i] += (1L << 16);
            long c = o[i] >> 16;
            o[(i + 1) * (i < 15 ? 1 : 0)] += c - 1 + 37 * (c - 1) * (i == 15 ? 1 : 0);
            o[i] -= c << 16;
        }
    }

    private static void sel(long[] p, long[] q, int b) {
        long c = ~(b - 1);
        for (int i = 0; i < 16; i++) {
            long t = c & (p[i] ^ q[i]);
            p[i] ^= t;
            q[i] ^= t;
        }
    }

    private static void pack(byte[] o, long[] n) {
        long[] m = new long[16], t = n.clone();
        car(t); car(t); car(t);
        for (int j = 0; j < 2; j++) {
            m[0] = t[0] - 0xffed;
            for (int i = 1; i < 15; i++) {
                m[i] = t[i] - 0xffff - ((m[i - 1] >> 16) & 1);
                m[i - 1] &= 0xffff;
            }
            m[15] = t[15] - 0x7fff - ((m[14] >> 16) & 1);
            int b = (int) ((m[15] >> 16) & 1);
            m[14] &= 0xffff;
            sel(t, m, 1 - b);
        }
        for (int i = 0; i < 16; i++) {
            o[2 * i] = (byte) t[i];
            o[2 * i + 1] = (byte) (t[i] >> 8);
        }
    }

    private static void unpack(long[] o, byte[] n) {
        for (int i = 0; i < 16; i++) o[i] = (n[2 * i] & 0xff) + ((long) (n[2 * i + 1] & 0xff) << 8);
        o[15] &= 0x7fff;
    }

    private static void add(long[] o, long[] a, long[] b) { for (int i = 0; i < 16; i++) o[i] = a[i] + b[i]; }

    private static void sub(long[] o, long[] a, long[] b) { for (int i = 0; i < 16; i++) o[i] = a[i] - b[i]; }

    private static void mul(long[] o, long[] a, long[] b) {
        long[] t = new long[31];
        for (int i = 0; i < 16; i++) for (int j = 0; j < 16; j++) t[i + j] += a[i] * b[j];
        for (int i = 0; i < 15; i++) t[i] += 38 * t[i + 16];
        System.arraycopy(t, 0, o, 0, 16);
        car(o); car(o);
    }

    private static void sq(long[] o, long[] a) { mul(o, a, a); }

    private static void inv(long[] o, long[] i) {
        long[] c = i.clone();
        for (int a = 253; a >= 0; a--) {
            sq(c, c);
            if (a != 2 && a != 4) mul(c, c, i);
        }
        System.arraycopy(c, 0, o, 0, 16);
    }

    /** q = n * p (scalar, u-coordinate). */
    static byte[] scalarMult(byte[] n, byte[] p) {
        byte[] z = new byte[32];
        System.arraycopy(n, 0, z, 0, 32);
        z[31] = (byte) ((n[31] & 127) | 64);
        z[0] &= (byte) 248;
        long[] x = new long[16], a = new long[16], b = new long[16], c = new long[16],
                d = new long[16], e = new long[16], f = new long[16];
        unpack(x, p);
        System.arraycopy(x, 0, b, 0, 16);
        a[0] = d[0] = 1;
        for (int i = 254; i >= 0; --i) {
            int r = ((z[i >>> 3] & 0xff) >>> (i & 7)) & 1;
            sel(a, b, r); sel(c, d, r);
            add(e, a, c); sub(a, a, c); add(c, b, d); sub(b, b, d);
            sq(d, e); sq(f, a); mul(a, c, a); mul(c, b, e);
            add(e, a, c); sub(a, a, c); sq(b, a); sub(c, d, f);
            mul(a, c, C121665); add(a, a, d); mul(c, c, a); mul(a, d, f); mul(d, b, x); sq(b, e);
            sel(a, b, r); sel(c, d, r);
        }
        inv(c, c);
        mul(a, a, c);
        byte[] q = new byte[32];
        pack(q, a);
        return q;
    }

    static byte[] publicKey(byte[] priv) { return scalarMult(priv, BASEPOINT); }

    static byte[] generatePrivate(java.security.SecureRandom rnd) {
        byte[] k = new byte[32];
        rnd.nextBytes(k);
        k[0] &= (byte) 248;
        k[31] = (byte) ((k[31] & 127) | 64);
        return k;
    }
}
