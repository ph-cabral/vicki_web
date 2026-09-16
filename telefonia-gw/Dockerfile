# Puente WebRTC <-> SIP para el softphone de Vicki (ver TELEFONIA.md).
# Issabel corre Asterisk 11: no soporta rtcp-mux, que Chrome exige, así que el
# navegador no puede hablar directo con la central. Este Asterisk 20 atiende a
# los navegadores (WebSocket + DTLS-SRTP) y se registra en Issabel como cada
# extensión por SIP/UDP común.
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends asterisk asterisk-modules ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && rm -rf /etc/asterisk && mkdir -p /etc/asterisk /var/lib/asterisk/keys
COPY conf/ /etc/asterisk/
COPY entrypoint.sh /entrypoint.sh
RUN sed -i "s/\r$//" /entrypoint.sh /etc/asterisk/*.conf && chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
