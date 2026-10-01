package ar.com.everwear.vicki.wg;

/**
 * ChaCha20-Poly1305 (RFC 8439) y XChaCha20-Poly1305, en Java puro para no
 * depender del nivel de API de Android (Conscrypt la trae recién en 9).
 * Nonce de WireGuard: 4 bytes en cero + contador de 64 bits little-endian.
 */
final class ChaChaPoly {
    private ChaChaPoly() {}

    static final int TAG = 16;

    private static int le32(byte[] b, int o) {
        return (b[o] & 0xff) | (b[o + 1] & 0xff) << 8 | (b[o + 2] & 0xff) << 16 | (b[o + 3] & 0xff) << 24;
    }

    private static void quarter(int[] x, int a, int b, int c, int d) {
        x[a] += x[b]; x[d] = Integer.rotateLeft(x[d] ^ x[a], 16);
        x[c] += x[d]; x[b] = Integer.rotateLeft(x[b] ^ x[c], 12);
        x[a] += x[b]; x[d] = Integer.rotateLeft(x[d] ^ x[a], 8);
        x[c] += x[d]; x[b] = Integer.rotateLeft(x[b] ^ x[c], 7);
    }

    private static void rounds(int[] x) {
        for (int i = 0; i < 10; i++) {
            quarter(x, 0, 4, 8, 12); quarter(x, 1, 5, 9, 13);
            quarter(x, 2, 6, 10, 14); quarter(x, 3, 7, 11, 15);
            quarter(x, 0, 5, 10, 15); quarter(x, 1, 6, 11, 12);
            quarter(x, 2, 7, 8, 13); quarter(x, 3, 4, 9, 14);
        }
    }

    private static int[] state(byte[] key, int counter, byte[] nonce12) {
        int[] s = new int[16];
        s[0] = 0x61707865; s[1] = 0x3320646e; s[2] = 0x79622d32; s[3] = 0x6b206574;
        for (int i = 0; i < 8; i++) s[4 + i] = le32(key, 4 * i);
        s[12] = counter;
        s[13] = le32(nonce12, 0); s[14] = le32(nonce12, 4); s[15] = le32(nonce12, 8);
        return s;
    }

    private static void block(int[] s, byte[] out) {
        int[] x = s.clone();
        rounds(x);
        for (int i = 0; i < 16; i++) {
            int v = x[i] + s[i];
            out[4 * i] = (byte) v; out[4 * i + 1] = (byte) (v >>> 8);
            out[4 * i + 2] = (byte) (v >>> 16); out[4 * i + 3] = (byte) (v >>> 24);
        }
    }

    /** XOR con el keystream arrancando en el contador indicado. */
    private static void xor(byte[] key, byte[] nonce12, int counter, byte[] in, int inOff, byte[] out, int outOff, int len) {
        int[] s = state(key, counter, nonce12);
        byte[] ks = new byte[64];
        for (int done = 0; done < len; done += 64) {
            block(s, ks);
            s[12]++;
            int n = Math.min(64, len - done);
            for (int i = 0; i < n; i++) out[outOff + done + i] = (byte) (in[inOff + done + i] ^ ks[i]);
        }
    }

    // ---- Poly1305 (donna, limbs de 26 bits) ----
    private static byte[] poly1305(byte[] key, byte[] aad, byte[] ct, int ctOff, int ctLen) {
        long r0 = le32(key, 0) & 0x3ffffffL;
        long r1 = (le32(key, 3) >>> 2) & 0x3ffff03L;
        long r2 = (le32(key, 6) >>> 4) & 0x3ffc0ffL;
        long r3 = (le32(key, 9) >>> 6) & 0x3f03fffL;
        long r4 = (le32(key, 12) >>> 8) & 0x00fffffL;
        long s1 = r1 * 5, s2 = r2 * 5, s3 = r3 * 5, s4 = r4 * 5;
        long[] h = new long[5];
        long[] rr = {r0, r1, r2, r3, r4, s1, s2, s3, s4};
        polyData(h, rr, aad, 0, aad.length);
        polyData(h, rr, ct, ctOff, ctLen);
        byte[] lens = new byte[16];
        putLe64(lens, 0, aad.length);
        putLe64(lens, 8, ctLen);
        polyBlocks(h, rr, lens, 0, 16, 1L << 24);

        long h0 = h[0], h1 = h[1], h2 = h[2], h3 = h[3], h4 = h[4], c;
        final long M = 0x3ffffffL;
        c = h1 >>> 26; h1 &= M; h2 += c;
        c = h2 >>> 26; h2 &= M; h3 += c;
        c = h3 >>> 26; h3 &= M; h4 += c;
        c = h4 >>> 26; h4 &= M; h0 += c * 5;
        c = h0 >>> 26; h0 &= M; h1 += c;
        long g0 = h0 + 5; c = g0 >>> 26; g0 &= M;
        long g1 = h1 + c; c = g1 >>> 26; g1 &= M;
        long g2 = h2 + c; c = g2 >>> 26; g2 &= M;
        long g3 = h3 + c; c = g3 >>> 26; g3 &= M;
        long g4 = h4 + c - (1L << 26);
        if (g4 >= 0) { h0 = g0; h1 = g1; h2 = g2; h3 = g3; h4 = g4; }
        long f0 = (h0 | (h1 << 26)) & 0xffffffffL;
        long f1 = ((h1 >>> 6) | (h2 << 20)) & 0xffffffffL;
        long f2 = ((h2 >>> 12) | (h3 << 14)) & 0xffffffffL;
        long f3 = ((h3 >>> 18) | (h4 << 8)) & 0xffffffffL;
        long f;
        byte[] tag = new byte[16];
        f = f0 + (le32(key, 16) & 0xffffffffL); putLe32(tag, 0, (int) f);
        f = f1 + (le32(key, 20) & 0xffffffffL) + (f >>> 32); putLe32(tag, 4, (int) f);
        f = f2 + (le32(key, 24) & 0xffffffffL) + (f >>> 32); putLe32(tag, 8, (int) f);
        f = f3 + (le32(key, 28) & 0xffffffffL) + (f >>> 32); putLe32(tag, 12, (int) f);
        return tag;
    }

    /** Datos con padding a 16 (como exige el AEAD). */
    private static void polyData(long[] h, long[] rr, byte[] m, int off, int len) {
        int full = len & ~15;
        polyBlocks(h, rr, m, off, full, 1L << 24);
        if (len > full) {
            byte[] last = new byte[16];
            System.arraycopy(m, off + full, last, 0, len - full);
            polyBlocks(h, rr, last, 0, 16, 1L << 24); // padding con ceros: bloque completo
        }
    }

    private static void polyBlocks(long[] h, long[] rr, byte[] m, int off, int len, long hibit) {
        long r0 = rr[0], r1 = rr[1], r2 = rr[2], r3 = rr[3], r4 = rr[4];
        long s1 = rr[5], s2 = rr[6], s3 = rr[7], s4 = rr[8];
        long h0 = h[0], h1 = h[1], h2 = h[2], h3 = h[3], h4 = h[4];
        final long M = 0x3ffffffL;
        for (int p = off; p < off + len; p += 16) {
            h0 += le32(m, p) & M;
            h1 += (le32(m, p + 3) >>> 2) & M;
            h2 += (le32(m, p + 6) >>> 4) & M;
            h3 += (le32(m, p + 9) >>> 6) & M;
            h4 += ((le32(m, p + 12) >>> 8) & 0xffffffL) | hibit;
            long d0 = h0 * r0 + h1 * s4 + h2 * s3 + h3 * s2 + h4 * s1;
            long d1 = h0 * r1 + h1 * r0 + h2 * s4 + h3 * s3 + h4 * s2;
            long d2 = h0 * r2 + h1 * r1 + h2 * r0 + h3 * s4 + h4 * s3;
            long d3 = h0 * r3 + h1 * r2 + h2 * r1 + h3 * r0 + h4 * s4;
            long d4 = h0 * r4 + h1 * r3 + h2 * r2 + h3 * r1 + h4 * r0;
            long c = d0 >>> 26; h0 = d0 & M;
            d1 += c; c = d1 >>> 26; h1 = d1 & M;
            d2 += c; c = d2 >>> 26; h2 = d2 & M;
            d3 += c; c = d3 >>> 26; h3 = d3 & M;
            d4 += c; c = d4 >>> 26; h4 = d4 & M;
            h0 += c * 5; c = h0 >>> 26; h0 &= M;
            h1 += c;
        }
        h[0] = h0; h[1] = h1; h[2] = h2; h[3] = h3; h[4] = h4;
    }

    private static void putLe32(byte[] b, int o, int v) {
        b[o] = (byte) v; b[o + 1] = (byte) (v >>> 8); b[o + 2] = (byte) (v >>> 16); b[o + 3] = (byte) (v >>> 24);
    }

    static void putLe64(byte[] b, int o, long v) {
        for (int i = 0; i < 8; i++) b[o + i] = (byte) (v >>> (8 * i));
    }

    static byte[] nonce(long counter) {
        byte[] n = new byte[12];
        putLe64(n, 4, counter);
        return n;
    }

    private static byte[] polyKey(byte[] key, byte[] nonce12) {
        byte[] b = new byte[64];
        block(state(key, 0, nonce12), b);
        byte[] k = new byte[32];
        System.arraycopy(b, 0, k, 0, 32);
        return k;
    }

    /** Cifra pt[off..off+len) y escribe ct||tag en out[outOff..]. */
    static void seal(byte[] key, long counter, byte[] aad, byte[] pt, int off, int len, byte[] out, int outOff) {
        byte[] n = nonce(counter);
        xor(key, n, 1, pt, off, out, outOff, len);
        byte[] tag = poly1305(polyKey(key, n), aad, out, outOff, len);
        System.arraycopy(tag, 0, out, outOff + len, TAG);
    }

    static byte[] seal(byte[] key, long counter, byte[] pt, byte[] aad) {
        byte[] out = new byte[pt.length + TAG];
        seal(key, counter, aad, pt, 0, pt.length, out, 0);
        return out;
    }

    /** Descifra ct||tag; devuelve null si el tag no verifica. */
    static byte[] open(byte[] key, long counter, byte[] in, int off, int len, byte[] aad) {
        if (len < TAG) return null;
        byte[] n = nonce(counter);
        int ctLen = len - TAG;
        byte[] tag = poly1305(polyKey(key, n), aad, in, off, ctLen);
        int diff = 0;
        for (int i = 0; i < TAG; i++) diff |= tag[i] ^ in[off + ctLen + i];
        if (diff != 0) return null;
        byte[] pt = new byte[ctLen];
        xor(key, n, 1, in, off, pt, 0, ctLen);
        return pt;
    }

    // ---- XChaCha20-Poly1305 (solo para el cookie reply) ----
    private static byte[] hchacha(byte[] key, byte[] nonce16) {
        int[] x = new int[16];
        x[0] = 0x61707865; x[1] = 0x3320646e; x[2] = 0x79622d32; x[3] = 0x6b206574;
        for (int i = 0; i < 8; i++) x[4 + i] = le32(key, 4 * i);
        for (int i = 0; i < 4; i++) x[12 + i] = le32(nonce16, 4 * i);
        rounds(x);
        byte[] out = new byte[32];
        for (int i = 0; i < 4; i++) putLe32(out, 4 * i, x[i]);
        for (int i = 0; i < 4; i++) putLe32(out, 16 + 4 * i, x[12 + i]);
        return out;
    }

    static byte[] xopen(byte[] key, byte[] nonce24, byte[] in, int off, int len, byte[] aad) {
        byte[] n16 = new byte[16];
        System.arraycopy(nonce24, 0, n16, 0, 16);
        byte[] sub = hchacha(key, n16);
        long ctr = 0;
        for (int i = 0; i < 8; i++) ctr |= (long) (nonce24[16 + i] & 0xff) << (8 * i);
        return open(sub, ctr, in, off, len, aad);
    }

    static byte[] xseal(byte[] key, byte[] nonce24, byte[] pt, byte[] aad) {
        byte[] n16 = new byte[16];
        System.arraycopy(nonce24, 0, n16, 0, 16);
        byte[] sub = hchacha(key, n16);
        long ctr = 0;
        for (int i = 0; i < 8; i++) ctr |= (long) (nonce24[16 + i] & 0xff) << (8 * i);
        return seal(sub, ctr, pt, aad);
    }
}
