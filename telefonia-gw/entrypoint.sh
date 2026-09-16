#!/bin/sh
# Genera /etc/asterisk/pjsip_usuarios.conf desde /etc/vicki-gw/usuarios.txt
# (una línea por extensión: "<extension> <secret de Issabel>") y arranca Asterisk.
# Para sumar/quitar extensiones sin reiniciar:  docker exec vicki_telefonia /entrypoint.sh recargar
set -eu

ISSABEL_HOST="${ISSABEL_HOST:-10.10.0.248}"
ISSABEL_PORT="${ISSABEL_PORT:-5060}"
USUARIOS="/etc/vicki-gw/usuarios.txt"
SALIDA="/etc/asterisk/pjsip_usuarios.conf"

generar() {
  tmp="$(mktemp)"
  echo "; AUTO-GENERADO por entrypoint.sh desde $USUARIOS — no editar" > "$tmp"
  cat >> "$tmp" <<CONF

[issabel-entrante]
type=identify
endpoint=issabel-entrante
match=$ISSABEL_HOST
CONF
  n=0
  if [ -f "$USUARIOS" ]; then
    # tr -d '\r': el archivo puede venir editado en Windows
    tr -d '\r' < "$USUARIOS" | while read -r ext secret _; do
      case "$ext" in ''|\#*) continue ;; esac
      case "$ext" in *[!0-9]*) echo "usuarios.txt: extensión inválida '$ext', se ignora" >&2; continue ;; esac
      [ -n "${secret:-}" ] || { echo "usuarios.txt: falta el secret de $ext, se ignora" >&2; continue; }
      cat >> "$tmp" <<CONF

; ===== $ext =====
; navegador (Vicki) -> este puente
[$ext]
type=auth
auth_type=userpass
username=$ext
password=$secret

[$ext]
type=aor
max_contacts=1
remove_existing=yes
qualify_frequency=30

[$ext](webrtc-usuario)
auth=$ext
aors=$ext

; este puente -> Issabel, registrado como la extensión $ext
[issabel-$ext]
type=auth
auth_type=userpass
username=$ext
password=$secret

[issabel-$ext]
type=aor
contact=sip:$ISSABEL_HOST:$ISSABEL_PORT

[issabel-$ext]
type=registration
transport=transport-udp
outbound_auth=issabel-$ext
server_uri=sip:$ISSABEL_HOST:$ISSABEL_PORT
client_uri=sip:$ext@$ISSABEL_HOST
contact_user=$ext
expiration=300
retry_interval=30
forbidden_retry_interval=300
max_retries=10000

[issabel-$ext](hacia-issabel)
outbound_auth=issabel-$ext
aors=issabel-$ext
from_user=$ext
from_domain=$ISSABEL_HOST
CONF
    done
    n=$(grep -c '^; ===== ' "$tmp" || true)
  fi
  mv "$tmp" "$SALIDA"
  echo "pjsip_usuarios.conf: $n extensión(es)"
}

if [ "${1:-}" = "recargar" ]; then
  generar
  asterisk -rx "module reload res_pjsip.so"
  asterisk -rx "pjsip show registrations"
  exit 0
fi

generar
exec asterisk -f -vvv
