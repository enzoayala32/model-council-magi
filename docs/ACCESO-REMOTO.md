# Acceso remoto — Consenso IA

Cómo usar la app desde el teléfono, en la LAN y desde afuera. **Leé la
advertencia de HTTP antes de elegir opción.**

---

## Advertencia: HTTP en LAN expone tus credenciales

Si iniciás el modo LAN con HTTP plano (`npm run dev:lan` / `npm run start:lan`),
**cualquiera que esté en la misma red puede escuchar el tráfico** y ver:

- la cookie de sesión del operador (`magi_access_token`);
- el `Authorization: Bearer` de los scripts;
- los tokens de dispositivo emparejados (`magi_device_token`);
- el contenido de las tareas, diffs y respuestas del consejo.

No es un riesgo teórico: en una Wi-Fi compartida, capturar ese tráfico es
trivial. Con la sesión robada, un atacante tiene acceso de operador hasta que la
revokes.

**Regla práctica:**

| Situación | ¿Se puede? |
|---|---|
| Red propia de confianza, pruebas rápidas | Sí, con HTTP, sabiendo el riesgo |
| Wi-Fi pública, red de trabajo compartida | **No** |
| Acceso desde fuera de la casa | **No**, usá HTTPS (Tailscale o Cloudflare) |

---

## Opción recomendada: Tailscale

Tailscale arma una red privada (tailnet) entre tus dispositivos, con cifrado y
HTTPS. No abre puertos en el router.

### 1. Instalar

- **Windows:** descargá el cliente de [tailscale.com](https://tailscale.com) e
  iniciá sesión.
- **Android:** app de Tailscale desde Play Store, misma cuenta.
- Verificá con `tailscale status`: tienen que aparecer los dos dispositivos.

### 2. Publicar el servidor con HTTPS

Con el server corriendo (`npm run dev:lan`), en la PC:

```bash
tailscale serve --bg 3100
```

Eso publica `https://<nombre-de-tu-pc>.<tailnet>.ts.net` apuntando al puerto
local. El puerto queda **cerrado a internet**: solo tu tailnet lo ve.

### 3. Configurar la app

En `.env` de la PC:

```bash
ALLOWED_HOSTS=localhost:3000,mi-pc.tail1234.ts.net
```

> **Importante:** al poner un host que no es loopback, el server **desactiva
> solo** el acceso local implícito. Desde ese momento todo requiere token de
> operador o dispositivo emparejado, incluso desde `localhost`. Es a propósito.

### 4. Conectar el teléfono

1. Abrí `https://mi-pc.tail1234.ts.net/m` en el navegador del teléfono.
2. Entrá con el token de operador, o emparejá el dispositivo desde la PC
   (botón **Emparejar teléfono**, que muestra un QR con el código).
3. Instalá la PWA desde el menú del navegador ("Agregar a pantalla de inicio").

### 5. Probar el cierre

Revocá el dispositivo desde **Ajustes → Dispositivos → Revocar**. En el teléfono,
la siguiente acción debe dar 403.

---

## Alternativa: Cloudflare Tunnel + Access

Si no querés instalar Tailscale:

1. `cloudflared tunnel login` y crear un túnel al puerto local.
2. Delante, **Cloudflare Access** con tu identidad (Google/GitHub) para que
   Cloudflare haga el login antes de llegar a la app.
3. `ALLOWED_HOSTS` con el hostname del túnel.

**No uses Cloudflare Tunnel sin Access**: expone la app a internet sin
autenticación propia.

---

## Antes de exponerte: `npm run doctor:remote`

El doctor lee el entorno y la DB, y te dice si dejaste la puerta abierta. No
toca la red: no manda ningún request. Salvo `--check-tailscale`, no ejecuta
procesos externos.

```bash
npm run doctor:remote
```

Revisa, y clasifica en **FAIL** (dejás la puerta abierta), **WARN** (riesgo que
merece aviso) y **PASS** (quedó razonado):

| Qué mira | Nivel si está mal |
|---|---|
| `APP_ACCESS_TOKEN` no definido con hosts remotos | FAIL |
| Server escuchando en `0.0.0.0` sin ninguna credencial | FAIL |
| Modo LAN sin `APP_ACCESS_TOKEN` | FAIL |
| `tailscale funnel` activo (expone a internet) | FAIL |
| Host público en `ALLOWED_HOSTS` (no tailnet ni IP privada) | WARN |
| Acceso remoto por HTTP plano | WARN |
| Acceso local implícito apagado (fail-closed) | WARN |
| Sin dispositivos emparejados, solo token de operador | WARN |
| Dispositivos con scope `operate` / `approve` | WARN |
| Sesiones de operador vivas con el server expuesto | WARN |

Con `--check-tailscale` además corre `tailscale funnel status` para detectar un
funnel activo. Si Tailscale no está instalado, no falla: vuelve al indicador
por variable de entorno.

El exit code es **1 si hay algún FAIL**, así que serve para dejarlo en un
script de arranque.

> El doctor muestra si `APP_ACCESS_TOKEN` está definida, nunca su valor. Solo
> lee `.env`/`.env.local`; no los escribe.

---

## Desaconsejado: port-forwarding

Abrir un puerto en el router y apuntarlo a la PC expone la app **directamente a
internet**, sin cifrado gestionado y con tu IP pública visible. No lo hagas.

---

## La PC tiene que estar encendida

El server corre en tu máquina, no en la nube:

- **Windows:** Programa la tarea o usá el Administrador de servicios para que
  arranque sola.
- **Energía:** desactivá la suspensión automática (o usá `powercfg` para
  exigir que no se suspenda).
- **Wake-on-LAN:** funciona solo dentro de la misma LAN. Desde afuera de la
  casa no hay forma confiable de despertar la PC; dejala prendida.

---

## Qué protege cada capa

| Capa | Contra qué protege |
|---|---|
| proxy (`proxy.ts`) | Navegadores: CSRF, DNS rebinding |
| Peer real (`server.ts` + `lib/peer.ts`) | Clientes no-navegador que falsifican el header `Host` |
| `lib/auth/*` | Dispositivos remotos: cookie robada, escalado de permisos |

El header `Host` **no autoriza nada**: lo manda el cliente. La decisión de "es
esta PC" sale de `req.socket.remoteAddress`, que fija el kernel.

---

## Checklist manual (5 pasos)

1. Instalá Tailscale en la PC y el teléfono, misma cuenta. `tailscale status`
   muestra los dos.
2. En la PC: `APP_ACCESS_TOKEN=<algo-largo>` en `.env`, luego
   `npm run start:lan`.
3. `tailscale serve --bg 3000`; copiá el `https://<pc>.<tailnet>.ts.net`.
4. Abrí esa URL en el teléfono, entrá con el token y emparejá el dispositivo
   desde la PC con el QR.
5. Revocá el dispositivo y confirmá que el teléfono queda afuera.

---

## No verificado

- Acceso real desde un Android y desde otra máquina: no probado en este
  entorno. Verificá con la checklist de arriba.
- Wake-on-LAN desde fuera de la LAN: no probado, se anota como limitado.
