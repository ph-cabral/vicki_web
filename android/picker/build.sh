#!/usr/bin/env bash
# Compila la app Android "EverWear Picker" SIN Gradle ni Android Studio.
# Requiere Linux (Ubuntu/Debian) con:
#   sudo apt install openjdk-17-jdk-headless aapt apksigner zipalign dalvik-exchange
# android.jar (API 34) se descarga una vez de github.com/Sable/android-platforms.
#
# Uso:  ./build.sh                     -> ../../public/apk/everwear-picker.apk
#       BASE_URL=http://otra:3001 ./build.sh
# Antes de cada versión nueva subir VERSION_CODE (si no, Android no la instala encima).
set -euo pipefail
cd "$(dirname "$0")"

VERSION_CODE=1
VERSION_NAME="1.0"
BASE_URL="${BASE_URL:-http://10.10.0.159:3001}"
OUT="${OUT:-../../public/apk/everwear-picker.apk}"
KS="everwear-picker.jks"          # MISMA firma siempre: si se pierde, hay que desinstalar en cada PDA
KS_PASS="${KS_PASS:-everwear-picker}"
ANDROID_JAR="${ANDROID_JAR:-.cache/android-34.jar}"

DX=$(command -v dalvik-exchange || command -v dx)
B=build
rm -rf "$B" && mkdir -p "$B/gen" "$B/classes" "$B/src/ar/com/everwear/picker"

if [ ! -f "$ANDROID_JAR" ]; then
  mkdir -p "$(dirname "$ANDROID_JAR")"
  curl -fsSL -o "$ANDROID_JAR" https://raw.githubusercontent.com/Sable/android-platforms/master/android-34/android.jar
fi

if [ ! -f "$KS" ]; then
  keytool -genkeypair -keystore "$KS" -storepass "$KS_PASS" -keypass "$KS_PASS" -alias picker \
    -keyalg RSA -keysize 2048 -validity 36500 -dname "CN=EverWear Picker, O=Ever Wear SA, C=AR"
fi

cat > "$B/src/ar/com/everwear/picker/Config.java" <<JAVA
package ar.com.everwear.picker;
/** Generado por build.sh */
final class Config {
    static final String BASE_URL = "${BASE_URL}";
    static final String VERSION = "${VERSION_NAME}";
    private Config() {}
}
JAVA

echo "==> recursos + R.java"
aapt package -f -m -J "$B/gen" -M AndroidManifest.xml -S res -I "$ANDROID_JAR" \
  --min-sdk-version 26 --target-sdk-version 34 \
  --version-code "$VERSION_CODE" --version-name "$VERSION_NAME" \
  -F "$B/app.unaligned.apk"

echo "==> javac"
javac -nowarn -Xlint:-options -source 8 -target 8 -encoding UTF-8 -bootclasspath "$ANDROID_JAR" \
  -d "$B/classes" $(find src "$B/src" "$B/gen" -name '*.java')

echo "==> dex"
"$DX" --dex --min-sdk-version=26 --output="$B/classes.dex" "$B/classes"
(cd "$B" && aapt add -f app.unaligned.apk classes.dex >/dev/null)

echo "==> zipalign + firma"
zipalign -f 4 "$B/app.unaligned.apk" "$B/app.aligned.apk"
mkdir -p "$(dirname "$OUT")"
apksigner sign --ks "$KS" --ks-pass "pass:$KS_PASS" --ks-key-alias picker \
  --min-sdk-version 26 --out "$OUT" "$B/app.aligned.apk"
apksigner verify "$OUT"
echo "OK -> $OUT ($(du -h "$OUT" | cut -f1)) v$VERSION_NAME ($VERSION_CODE) BASE_URL=$BASE_URL"
