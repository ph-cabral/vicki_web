# Telefonía — softphone web con Issabel

Teléfono dentro de Vicki para puestos sin teléfono IP, en la vista **/sorteo/telefono**. Audio por
auriculares con micrófono de la PC.

## Arquitectura

```
Navegador (JsSIP, WebRTC)  --ws://10.10.0.159:8088/ws + DTLS-SRTP-->  telefonia-gw (Asterisk 20, Docker)
telefonia-gw  --SIP/UDP 5070 <-> 5060, RTP común-->  Issabel 10.10.0.248 (Asterisk 11)
```

**Por qué el puente:** Issabel corre **Asterisk 11.25**, que no soporta `rtcp-mux`; Chrome lo exige
desde 2017 → registrar directo contra Issabel funciona pero la llamada falla con
*"Bad Media Description"*. El puente (`telefonia-gw/`) atiende WebRTC y **se registra en Issabel como
cada extensión** (mismo número y secret), así que para Issabel es un interno SIP común: rutas
salientes, permisos, colas, grupos y caller ID funcionan sin tocar nada.

Probado de punta a punta (Chromium real → puente → Asterisk con chan_sip): llamada saliente y
entrante con audio en los dos sentidos.

- Llamar, atender/rechazar, silenciar, espera, transferencia directa, DTMF (RFC 4733), recientes
  (por navegador), notificación si la pestaña está en segundo plano.
- La llamada vive mientras la pestaña esté en /sorteo/telefono (salir, F5 o cerrar la corta).
- Varias pestañas: sólo una queda registrada (Web Locks).
- Sin la pestaña abierta, el puente contesta "no disponible" y Issabel sigue su curso (buzón, etc.).

## Piezas

| Qué | Dónde |
|---|---|
| Vista | `app/sorteo/telefono/page.tsx` → `components/telefonia/Softphone.tsx` (`modo="pagina"`) |
| Tabla usuario ↔ extensión | `sql/telefonia_usuario_extension.sql`, `model usuario_extension` |
| Clave SIP cifrada (AES-256-GCM) | `lib/telefonia/cifrado.ts` |
| Config (env) | `lib/telefonia/config.ts` |
| Credenciales del logueado | `GET /api/telefonia/credenciales` (204 = sin extensión) |
| ABM (ADMIN) | `/admin/telefonia` + `app/api/admin/telefonia` |
| Puente WebRTC↔SIP | `telefonia-gw/` (Dockerfile, `conf/`, `entrypoint.sh`), servicio `telefonia-gw` en `docker-compose.prod.yml` |
| Política de navegador | `scripts/telefonia_origen_seguro.reg` |

---

## 1. Issabel

La extensión queda como **SIP común** (igual que las de los Fanvil). Nada de WebRTC en Issabel.

Extensión (PBX › Extensions) → Device Options, valores normales:

| Campo | Valor |
|---|---|
| transport | UDP Only |
| avpf / icesupport / dtlsenable / encryption | No |
| dtlscertfile / dtlsprivatekey | vacío |
| nat | Yes |
| dtmfmode | RFC 2833 |

Restos de la prueba directa (sin efecto, se pueden dejar o limpiar): `http_custom.conf`
(`enabled=yes`), `webrtc.conf` (certificado) y el bloque `[1140](+) rtcp_mux=yes` de
`sip_custom_post.conf` — **este último conviene borrarlo** (Asterisk 11 no conoce la opción).

## 2. Server de Vicki (10.10.0.159)

1. **Extensiones del puente** — `telefonia-gw/datos/usuarios.txt` (no está en git; ver
   `telefonia-gw/usuarios.ejemplo.txt`):
   ```
   1140 <secret de la 1140 en Issabel>
   ```
2. **.env**:
   ```bash
   ISSABEL_WS_URL=ws://10.10.0.159:8088/ws
   ISSABEL_SIP_DOMAIN=10.10.0.159
   TELEFONIA_SECRET=<node -e "console.log(require('crypto').randomBytes(32).toString('hex'))">
   # opcionales (default): ISSABEL_HOST=10.10.0.248  ISSABEL_PORT=5060
   ```
3. **Deploy** normal (`./deploy.sh` levanta también `telefonia-gw`).
4. **Tabla** (una vez): `psql "$DATABASE_URL" -f sql/telefonia_usuario_extension.sql`.
5. Puertos libres en el host: **8088/tcp**, **5070/udp**, **20000-20999/udp**.

Verificar el puente:
```bash
docker exec vicki_telefonia asterisk -rx "pjsip show registrations"   # issabel-1140 ... Registered
docker exec vicki_telefonia asterisk -rx "pjsip show contacts"        # 1140 aparece cuando el navegador está conectado
```

Sumar / quitar una extensión: editar `usuarios.txt` y
`docker exec vicki_telefonia /entrypoint.sh recargar` (sin reiniciar).

## 3. Vicki

1. **Administración › Telefonía**: persona → extensión + mismo secret que en `usuarios.txt`.
2. **Administración › Permisos**: habilitar *Sorteo › Teléfono* al sector (toma efecto al re-loguear).

## 4. Navegadores — micrófono en http

Chrome/Edge no dan micrófono a `http://` (salvo localhost). Declarar `http://10.10.0.159:3001` como
origen seguro:

- **Prueba en una PC:** `chrome://flags/#unsafely-treat-insecure-origin-as-secure` → agregar
  `http://10.10.0.159:3001` → Enabled → Relaunch (Edge: `edge://flags/...`).
- **Por PC:** `scripts/telefonia_origen_seguro.reg` (como admin, reiniciar navegador, ver `chrome://policy`).
- **Todas por GPO:** Configuración del equipo › Preferencias › Configuración de Windows › Registro,
  un elemento por cada valor (HKLM, REG_SZ, nombre `1`, valor `http://10.10.0.159:3001`):
  ```
  SOFTWARE\Policies\Google\Chrome\OverrideSecurityRestrictionsOnInsecureOrigin
  SOFTWARE\Policies\Google\Chrome\AudioCaptureAllowedUrls
  SOFTWARE\Policies\Microsoft\Edge\OverrideSecurityRestrictionsOnInsecureOrigin
  SOFTWARE\Policies\Microsoft\Edge\AudioCaptureAllowedUrls
  ```

## Diagnóstico

| Síntoma | Causa probable |
|---|---|
| "No tenés una extensión asignada" | Sin extensión en Administración › Telefonía, o `ISSABEL_WS_URL` vacío |
| "Micrófono bloqueado…" / permisos grises | Falta el flag o la política del punto 4 |
| "Conectando…" fijo | Contenedor `vicki_telefonia` caído o 8088 ocupado/filtrado |
| "Clave de la extensión incorrecta" | Secret de Vicki ≠ `usuarios.txt` |
| Registra pero no llama / "No disponible" | `pjsip show registrations` no está Registered: secret de `usuarios.txt` ≠ Issabel |
| "Bad Media Description" | Se está apuntando directo a Issabel (`ISSABEL_WS_URL` con .248) en vez del puente |
| Conecta pero sin audio | UDP 20000-20999 filtrado en el server |
