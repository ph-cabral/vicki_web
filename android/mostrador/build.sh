#!/usr/bin/env bash
# Compila la app Android "EW Mostrador" (control de mostrador) SIN Gradle ni Android Studio.
# Requiere Linux (Ubuntu/Debian) con:
#   sudo apt install openjdk-17-jdk-headless aapt apksigner zipalign dalvik-exchange
# android.jar (API 34) se descarga una vez de github.com/Sable/android-platforms.
#
# Uso:  ./build.sh                     -> ../../public/apk/everwear-mostrador.apk
#       BASE_URL=http://otra:3001 ./build.sh
# Antes de cada versión nueva subir VERSION_CODE (si no, Android no la instala encima).
# Publicar una actualización (las apps la ofrecen solas con el botón "Actualizar"):
#   ../publicar.sh APP "qué cambió" [--obligatoria]   (sube VERSION_CODE, compila y escribe el .json)
# o a mano: subir VERSION_CODE y   NOTAS="..." OBLIGATORIA=1 ./build.sh
# Genera además <apk>.json (versión + sha256) que la app consulta. Commit + deploy de ambos.
set -euo pipefail
cd "$(dirname "$0")"

VERSION_CODE=2
VERSION_NAME="1.1"
BASE_URL="${BASE_URL:-http://10.10.0.159:3001}"
OUT="${OUT:-../../public/apk/everwear-mostrador.apk}"
KS="everwear-mostrador.jks"       # MISMA firma siempre: si se pierde, hay que desinstalar en cada equipo
KS_PASS="${KS_PASS:-everwear-mostrador}"
ANDROID_JAR="${ANDROID_JAR:-.cache/android-34.jar}"

DX=$(command -v dalvik-exchange || command -v dx)
B=build
rm -rf "$B" && mkdir -p "$B/gen" "$B/classes" "$B/src/ar/com/everwear/mostrador"

if [ ! -f "$ANDROID_JAR" ]; then
  mkdir -p "$(dirname "$ANDROID_JAR")"
  curl -fsSL -o "$ANDROID_JAR" https://raw.githubusercontent.com/Sable/android-platforms/master/android-34/android.jar
fi

if [ ! -f "$KS" ]; then
  keytool -genkeypair -keystore "$KS" -storepass "$KS_PASS" -keypass "$KS_PASS" -alias mostrador \
    -keyalg RSA -keysize 2048 -validity 36500 -dname "CN=EverWear Mostrador, O=Ever Wear SA, C=AR"
fi

cat > "$B/src/ar/com/everwear/mostrador/Config.java" <<JAVA
package ar.com.everwear.mostrador;
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
  -d "$B/classes" $(find src ../comun/src "$B/src" "$B/gen" -name '*.java')

echo "==> dex"
"$DX" --dex --min-sdk-version=26 --output="$B/classes.dex" "$B/classes"
(cd "$B" && aapt add -f app.unaligned.apk classes.dex >/dev/null)

echo "==> zipalign + firma"
zipalign -f 4 "$B/app.unaligned.apk" "$B/app.aligned.apk"
mkdir -p "$(dirname "$OUT")"
apksigner sign --v4-signing-enabled false --ks "$KS" --ks-pass "pass:$KS_PASS" --ks-key-alias mostrador \
  --min-sdk-version 26 --out "$OUT" "$B/app.aligned.apk"
apksigner verify "$OUT"

# Manifiesto de actualización que consulta la app (comun/Actualizador.java).
JSON="${OUT%.apk}.json"
SHA=$(sha256sum "$OUT" | cut -d' ' -f1)
PAQ="ar.com.everwear.mostrador" VC="$VERSION_CODE" VN="$VERSION_NAME" APK="/apk/$(basename "$OUT")?v=$VERSION_CODE" \
SHA="$SHA" BYTES="$(stat -c %s "$OUT")" NOTAS="${NOTAS:-}" OBLIG="${OBLIGATORIA:-0}" \
python3 -c 'import json,os,datetime as d; e=os.environ; print(json.dumps({"paquete":e["PAQ"],"versionCode":int(e["VC"]),"versionName":e["VN"],"apk":e["APK"],"sha256":e["SHA"],"bytes":int(e["BYTES"]),"obligatoria":e["OBLIG"] in ("1","true","si"),"notas":e["NOTAS"],"fecha":d.datetime.now().isoformat(timespec="seconds")}, ensure_ascii=False, indent=1))' > "$JSON"
echo "manifiesto -> $JSON"
echo "OK -> $OUT ($(du -h "$OUT" | cut -f1)) v$VERSION_NAME ($VERSION_CODE) BASE_URL=$BASE_URL"
