# App Android "Vicki"

vicki completo (`BASE_URL/`) en un WebView, con una VPN WireGuard propia adentro.
En el celular no se instala ni configura nada más.

- **En la oficina** (el server responde directo): entra sin túnel. La primera vez
  que el usuario inicia sesión, la app llama `POST /api/vpn/alta` con la cookie
  del WebView → vicki genera las claves y crea el peer en el Mikrotik por la API.
- **Afuera**: levanta el túnel (`TunelService`, VpnService) hacia
  `c5620eca3437.sn.mynetname.net:13231`. Solo enruta `10.10.0.159/32` y solo
  para esta app (`addAllowedApplication`); el resto del celular no pasa por la VPN.
- La primera vez afuera Android pide aceptar "Vicki quiere crear una VPN" (una sola vez).
- Cambio de red (WiFi ↔ datos) → vuelve a decidir. 5 min en segundo plano → baja el túnel.
- Descargas (Excel con `blob:` y links normales) → `Descargas/Vicki`.

WireGuard está implementado en Java puro en `src/.../wg/` (no hay libwg-go:
maven, Go proxy y download.wireguard.com están bloqueados en el entorno de build).
Probado contra boringtun: `test/run.sh` (crypto + handshake + datos + cookie + rekey).

Build: `./build.sh` → `../../public/apk/vicki.apk`. Subir `VERSION_CODE` en cada versión.
Firma: `everwear-vicki.jks` (alias `vicki`, clave `everwear-vicki`). Si se pierde,
hay que desinstalar la app en cada celular para actualizar.

Mikrotik y `.env`: `wireguard-everwear/11-app-vicki-mikrotik.rsc`. Bajas: `/admin/vpn`.
