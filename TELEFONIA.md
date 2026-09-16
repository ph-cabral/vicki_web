# Telefonía — softphone web con Issabel

Teléfono dentro de Vicki para puestos sin teléfono IP. El navegador se registra en
Issabel como una extensión (WebRTC sobre WebSocket, librería **JsSIP**) y el audio
va por los auriculares con micrófono de la PC.

- Vista **/sorteo/telefono** (módulo sorteo). Entra quien tenga el módulo sorteo y esa vista habilitada
  en Permisos; sin extensión asignada muestra "No tenés una extensión asignada".
- Llamar (internos y externos, según las rutas salientes de la extensión), atender/rechazar,
  silenciar, espera, transferencia directa, teclado DTMF, recientes (por navegador) y
  notificación de escritorio si la pestaña está en segundo plano.
- La llamada vive mientras esa pestaña esté en /sorteo/telefono: salir de la vista, F5 o cerrar la pestaña la corta.
  El puesto deja esa pestaña abierta.
- Con Vicki abierta en varias pestañas, sólo **una** queda registrada (Web Locks); al cerrarla, toma otra.
- Si la pestaña de Vicki está cerrada, esa extensión **no recibe llamadas** (conviene un "sígueme"
  o buzón en Issabel para esos casos).

## Piezas

| Qué | Dónde |
|---|---|
| Tabla usuario ↔ extensión | `sql/telefonia_usuario_extension.sql`, `model usuario_extension` |
| Cifrado de la clave SIP (AES-256-GCM) | `lib/telefonia/cifrado.ts` |
| Config de la central (env) | `lib/telefonia/config.ts` |
| Credenciales del usuario logueado | `GET /api/telefonia/credenciales` (204 = sin extensión) |
| ABM de extensiones (ADMIN) | `/admin/telefonia` + `app/api/admin/telefonia` |
| Softphone | `components/telefonia/Softphone.tsx` (`modo="pagina"`), vista `app/sorteo/telefono/page.tsx`. El modo `"flotante"` (botón global montado en `app/layout.tsx`) existe pero no está montado |
| Política de navegador (prueba en 1 PC) | `scripts/telefonia_origen_seguro.reg` |

La clave SIP nunca vuelve al admin; sólo viaja al navegador del propio usuario (la necesita
para registrarse).

---

## 1. Issabel (una sola vez) — Issabel 10.10.0.248

Todo se hizo desde la web (**PBX › Tools › Asterisk File Editor** y la pantalla de la extensión),
sin SSH/root. Botón **Reload Asterisk** del editor para aplicar.

### 1.1 WebSocket de Asterisk (puerto 8088)

`http_additional.conf` lo regenera Issabel con `enabled=no`. El encendido queda en
**http_custom.conf**:

```ini
[general](+)
enabled=yes
```

Verificación: `http://10.10.0.248:8088/httpstatus` muestra "Asterisk HTTP Status".

### 1.2 Certificado para DTLS (el audio WebRTC siempre va cifrado)

Autofirmado (DTLS no valida contra CA). Se generó en otra máquina Linux y se pegó (clave + cert en
un solo archivo) con **New File** del editor, que fuerza extensión `.conf` → **`/etc/asterisk/webrtc.conf`**:

```bash
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -keyout /tmp/w.key -out /tmp/w.crt \
  -subj "/CN=issabel-webrtc" && cat /tmp/w.key /tmp/w.crt && rm /tmp/w.key /tmp/w.crt
```

### 1.3 Extensiones WebRTC (hoy: 1140)

Pantalla de la extensión (PBX › Extensions), Device Options:

| Campo | Valor |
|---|---|
| transport | All - WS Primary |
| avpf / icesupport / dtlsenable / encryption | Yes |
| dtlsverify | No |
| dtlssetup | Incoming and Outgoing |
| dtlscertfile / dtlsprivatekey | `/etc/asterisk/webrtc.conf` |
| dtmfmode | RFC 2833 |
| nat | Yes |
| disallow / allow | `all` / `ulaw&alaw` |

Y `rtcp_mux` (no está en la pantalla) en **sip_custom_post.conf**, un bloque por extensión:

```ini
[1140](+)
rtcp_mux=yes
```

> OJO: una extensión así ya **no** sirve para un teléfono IP común.

### 1.4 Firewall

Desde la red de las PCs tiene que llegarse a la central por **8088/tcp** (WebSocket) y
**10000-20000/udp** (audio). Si el módulo Firewall de Issabel está activo, abrir esos puertos
para la LAN.

---

## 2. Navegadores (GPO) — permiso de micrófono en http

Chrome y Edge **no dan micrófono** a sitios `http://` que no sean localhost. Vicki se sirve en
`http://10.10.0.159:3001`, así que hay que declararlo como origen seguro por política. Sin esto el
softphone muestra *"Micrófono bloqueado por el navegador"* y no se registra.

Políticas (Chrome y Edge usan el mismo nombre):

| Política | Valor |
|---|---|
| `OverrideSecurityRestrictionsOnInsecureOrigin` | `http://10.10.0.159:3001` |
| `AudioCaptureAllowedUrls` (evita el cartel de permiso) | `http://10.10.0.159:3001` |

Rutas de registro (lista: valor `1`, `2`, … tipo REG_SZ):

```
HKLM\SOFTWARE\Policies\Google\Chrome\OverrideSecurityRestrictionsOnInsecureOrigin
HKLM\SOFTWARE\Policies\Google\Chrome\AudioCaptureAllowedUrls
HKLM\SOFTWARE\Policies\Microsoft\Edge\OverrideSecurityRestrictionsOnInsecureOrigin
HKLM\SOFTWARE\Policies\Microsoft\Edge\AudioCaptureAllowedUrls
```

**Prueba en una PC:** doble click en `scripts/telefonia_origen_seguro.reg` (como administrador),
cerrar el navegador por completo y verificar en `chrome://policy` / `edge://policy`.

**Para todas las PCs por GPO** (Administración de directivas de grupo, en el DC):

1. Crear una GPO (p.ej. *Navegador - Vicki telefonía*) y vincularla a la OU de las PCs.
2. Editar › Configuración del equipo › Preferencias › Configuración de Windows › **Registro** ›
   Nuevo › Elemento del Registro. Uno por cada línea de la tabla de arriba:
   Acción *Actualizar*, Subárbol `HKEY_LOCAL_MACHINE`, la ruta, Nombre `1`, Tipo `REG_SZ`,
   Valor `http://10.10.0.159:3001`.
3. En una PC: `gpupdate /force`, reabrir el navegador y revisar `chrome://policy`.

(Alternativa: importar las plantillas ADMX de Chrome/Edge y usar *Configuración del equipo ›
Plantillas administrativas*; el resultado es el mismo.)

Si Vicki pasa a HTTPS con dominio, esto deja de hacer falta, pero la URL del WebSocket tiene que
pasar a `wss://<host>:8089/ws` con certificado válido (el navegador bloquea `ws://` desde una
página https).

---

## 3. Vicki

1. **SQL** en Postgres:
   ```bash
   psql "$DATABASE_URL" -f sql/telefonia_usuario_extension.sql
   ```
2. **.env del server** (no está en git):
   ```bash
   ISSABEL_WS_URL=ws://<ip-issabel>:8088/ws
   ISSABEL_SIP_DOMAIN=<ip-issabel>
   # llave fija para cifrar las claves SIP (si falta usa AUTH_SECRET; cambiarla obliga a recargarlas)
   TELEFONIA_SECRET=<node -e "console.log(require('crypto').randomBytes(32).toString('hex'))">
   ```
   `docker-compose.prod.yml` ya pasa todo el `.env` al contenedor (`env_file`).
3. **Deploy** normal (push a main). Se agregó la dependencia `jssip` (package.json + lock).
4. En **Administración › Telefonía**: a cada persona, número de extensión + su *secret*.
5. Habilitar la vista **Sorteo › Teléfono** al sector de la persona en Administración › Permisos
   (los ADMIN ya la ven; el permiso nuevo toma efecto al volver a iniciar sesión).
6. La persona entra a /sorteo/telefono: punto verde = registrado.

## Diagnóstico

| Síntoma en el teléfono | Causa probable |
|---|---|
| "No tenés una extensión asignada" | Sin extensión en Administración › Telefonía, o `ISSABEL_WS_URL` vacío en el .env |
| Punto rojo "Micrófono bloqueado…" | Falta la política del punto 2 en esa PC |
| Punto amarillo "Conectando…" fijo | No llega a `ws://<ip>:8088/ws` (http.conf / firewall) |
| "Clave de la extensión incorrecta" | *secret* distinto al de Issabel |
| Registra pero no hay audio / corta a los 30 s | Faltan parámetros del 1.3 (avpf, dtls, rtcp_mux, icesupport) o UDP 10000-20000 cerrado |
| "Activo en otra pestaña de Vicki" | Hay otra pestaña con Vicki; esa es la que suena |
| En Asterisk: `asterisk -rx "sip show peers"` | La extensión tiene que figurar con IP de la PC y `OK` |
