#!/usr/bin/env bash
# Pruebas del WireGuard en Java (wg/) en una PC Linux, sin Android:
#  1. CryptoTest: X25519 / ChaCha20-Poly1305 contra el JDK, BLAKE2s contra RFC 7693.
#  2. InteropTest: handshake + datos + cookie reply + rekey contra boringtun
#     (implementación WireGuard de Cloudflare) como servidor en 127.0.0.1:51999.
# Requiere JDK 17 y cargo.
set -euo pipefail
cd "$(dirname "$0")"
OUT=$(mktemp -d)
javac -nowarn -d "$OUT" ../src/ar/com/everwear/vicki/wg/*.java CryptoTest.java InteropTest.java KeyGen.java
java -cp "$OUT" ar.com.everwear.vicki.wg.CryptoTest
(cd harness && cargo build --release -q)
read PRIV PUB < <(java -cp "$OUT" ar.com.everwear.vicki.wg.KeyGen)
for MODE in normal cookie; do
  harness/target/release/harness $MODE "$PUB" > "$OUT/h.out" 2>/dev/null & HP=$!
  sleep 0.5
  java -cp "$OUT" ar.com.everwear.vicki.wg.InteropTest $MODE "$PRIV" "$(awk '/SERVERPUB/{print $2}' "$OUT/h.out")" | tail -1
  kill $HP
done
