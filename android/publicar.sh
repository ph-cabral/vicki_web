#!/usr/bin/env bash
# Publica una versión nueva de una app Android EverWear.
#   ./publicar.sh picker|mostrador|vicki "qué cambió" [--obligatoria]
# Sube VERSION_CODE (+1) y VERSION_NAME (1.<code-1>) en APP/build.sh, compila y deja en public/apk/
# el .apk y el .json. Después: git add + commit + push + deploy. Las apps abiertas lo detectan
# solas (al volver al frente o cada 30 min) y muestran "Actualizar"; con --obligatoria tapan la
# pantalla hasta que se actualice.
set -euo pipefail
cd "$(dirname "$0")"
APP="${1:?uso: ./publicar.sh picker|mostrador|vicki \"notas\" [--obligatoria]}"
NOTAS="${2:-}"
OBLIG=0; [ "${3:-}" = "--obligatoria" ] && OBLIG=1
[ -f "$APP/build.sh" ] || { echo "no existe $APP/build.sh"; exit 1; }

VC=$(grep -m1 -oP '^VERSION_CODE=\K[0-9]+' "$APP/build.sh")
NVC=$((VC + 1))
sed -i "s/^VERSION_CODE=$VC\$/VERSION_CODE=$NVC/" "$APP/build.sh"
sed -i "s/^VERSION_NAME=\".*\"\$/VERSION_NAME=\"1.$((NVC - 1))\"/" "$APP/build.sh"
echo "==> $APP: versionCode $VC -> $NVC"

NOTAS="$NOTAS" OBLIGATORIA="$OBLIG" "$APP/build.sh"
echo
echo "Listo. Falta: git add android/$APP/build.sh public/apk/ && git commit && git push + deploy"
