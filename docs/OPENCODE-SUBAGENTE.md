# Usar Consenso IA desde opencode (como subagente)

Consenso IA expone un servidor MCP en `POST /api/mcp`. Desde opencode (o
cualquier cliente MCP) se ve como un servidor más, con herramientas de **solo
lectura** sobre el consejo y el agente.

---

## 1. La config de opencode

opencode lee los servidores MCP de `~/.config/opencode/opencode.json` (o la que
tengas en `OPENCODE_CONFIG`). Se agrega como `mcp` con transporte `remote`:

```json
{
  "mcp": {
    "consenso-ia": {
      "type": "remote",
      "url": "http://127.0.0.1:3000/api/mcp",
      "headers": {
        "X-Magi-Device-Token": "${MAGI_DEVICE_TOKEN}"
      },
      "enabled": true
    }
  }
}
```

- **`headers.X-Magi-Device-Token`**: el token de un **dispositivo emparejado con
  scope `observe`** (ver cómo emparejarlo abajo). El valor sale de una variable
  de entorno: opencode la expande, no se escribe en el archivo.
- **Nunca uses `APP_ACCESS_TOKEN` acá.** El token maestro da acceso total (en
  `/api/mcp` se ve como `approve`), no se puede revocar por separado, y si queda
  en el JSON de configuración de otra herramienta cualquiera con acceso a ese
  archivo se lleva el control de la app. Un dispositivo, en cambio, se revoca
  solo desde Dispositivos y su alcance es acotado.
- Si corrés la app en loopback sin `APP_ACCESS_TOKEN`, no hace falta ninguno: el
  acceso local implícito alcanza.

## Emparejar un dispositivo para opencode

1. En la PC, entrá a la app y andá a **Ajustes → Emparejar teléfono** (o
   `POST /api/pairing` con `{ "scope": "observe" }`). Te da un código de un solo
   uso, válido 5 minutos.
2. Canjealo por un token de dispositivo. El canje se hace **sin ninguna
   credencial** (para eso existe el código), y el token viaja en la cabecera
   `Set-Cookie` de la respuesta:

   ```bash
   # La PC genera el código (operador)
   curl -s -X POST -H 'Authorization: Bearer $APP_ACCESS_TOKEN'      -H 'content-type: application/json' -d '{"scope":"observe"}'      http://127.0.0.1:3000/api/pairing

   # El cliente lo canjea y se queda con el token
   TOKEN=$(curl -s -D - -o /dev/null -X POST -H 'content-type: application/json'      -d '{"code":"XXXX-XXXX-XXXX-XXXX","deviceName":"opencode"}'      http://127.0.0.1:3000/api/pairing/redeem      | grep -i '^set-cookie' | sed 's/.*magi_device_token=//' | tr -d '
' | cut -d';' -f1)
   ```

   El token se devuelve **una sola vez** y no se puede recuperar después: si lo
   perdés, revocá el dispositivo y emparejá otro.
3. Ponelo en la variable de entorno que usa el JSON de opencode
   (`MAGI_DEVICE_TOKEN`) y listo.

Para revocar el acceso: **Ajustes → Dispositivos → Revocar**. El token deja de
funcionar aunque el archivo de opencode lo conserve.

---

## 2. Qué herramientas se ven

| Herramienta | Qué hace | Scope mínimo |
|---|---|---|
| `tasks.list` | Lista las tareas del agente | `observe` |
| `tasks.status` | Estado de una tarea por id | `observe` |
| `tasks.events` | Eventos recientes de una tarea (con su `seq`) | `observe` |
| `council.runs` | Últimas corridas del consejo | `observe` |
| `council.run` | Detalle de una corrida por id | `observe` |

Todas son de **solo lectura**. No hay herramienta que escriba ni que apruebe:
aprobar es un acto humano con segundo factor y se hace desde la app
(`/m/settings`), no por protocolo.

---

## 3. Para qué sirve (patrones de uso)

**Como subagente de consulta.** En opencode, el modelo puede preguntarle a
Consenso IA qué está haciendo el agente sin salir de su propio contexto:

> "Revisá con consenso-ia el estado de la última tarea y contame si terminó"

**Como panel de estado mientras opencode codifica.** Con `tasks.list` y
`tasks.events`, un agente de opencode puede ver si otra tarea quedó a la espera
de aprobación y avisar.

**Como segunda opinión.** `council.runs` y `council.run` devuelven el resultado
del consenso de modelos: útil para contrastar una decisión de diseño.

---

## 4. Autorización (resumen)

| Cómo te conectás | Qué podés hacer |
|---|---|
| Loopback, sin `APP_ACCESS_TOKEN` | todo lo de `observe` |
| `Bearer` con el token de operador | todo lo de `observe` (y enrutas como `approve` para `tools/list`) |
| Dispositivo emparejado `observe` | las 5 herramientas |
| Dispositivo emparejado `operate`/`approve` | las 5 herramientas (el catálogo no cambia: todo es `observe`) |
| Sin credencial, desde afuera de la PC | **403** |

---

## 5. Verificación

```
npm run security:test-mcp-server      # 53 casos, incluye /api/mcp
```

Cubre `initialize`, `ping`, `tools/list`, `tools/call`, herramienta
desconocida, argumentos inválidos, y que **no exista** método de aprobación
(`-32601`).

**Verificado contra el server real** (modo LAN, 2026-11-09), desde la IP de LAN
como lo haría un cliente remoto:

| Pedido | Resultado |
|---|---|
| `initialize` sin credencial | **403** |
| `initialize` con `Bearer <APP_ACCESS_TOKEN>` | handshake + instrucciones |
| `tools/list` con token | las 5 herramientas, todas `readOnly: true` |
| `tools/call tasks.list` con token | `{"content":[{"type":"text","text":"[]"}]}` |
| `approvals/approve` con token | `-32601` (no existe el método) |
| `POST /api/pairing` (operador) | código de un solo uso |
| `POST /api/pairing/redeem` **sin credencial** | **200** + token en `Set-Cookie` |
| handshake MCP con `x-magi-device-token: <token>` | handshake + instrucciones |
| `tools/list` con el dispositivo emparejado | las 5 herramientas |

Para probar a mano contra tu server corriendo:

```bash
# handshake
curl -s -X POST -H 'content-type: application/json' \
  -H "Authorization: Bearer $APP_ACCESS_TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize"}' \
  http://127.0.0.1:3000/api/mcp

# catálogo
curl -s -X POST -H 'content-type: application/json' \
  -H "Authorization: Bearer $APP_ACCESS_TOKEN" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  http://127.0.0.1:3000/api/mcp

# una herramienta
curl -s -X POST -H 'content-type: application/json' \
  -H "Authorization: Bearer $APP_ACCESS_TOKEN" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"tasks.list","arguments":{"limit":5}}}' \
  http://127.0.0.1:3000/api/mcp
```

---

## 5bis. Un bug que apareció al verificar esto (Etapa 0.4)

Al probar el flujo de emparejado contra el server real, el canje daba **403
"Token de acceso ausente o inválido" desde cualquier peer, incluso loopback**:
el proxy exigía `APP_ACCESS_TOKEN` antes de que el cliente tuviera ninguna
credencial — justo lo que viene a buscar. El emparejamiento era imposible con
token configurado.

Arreglado en la Etapa 0.4: `/api/pairing` y `/api/pairing/redeem` quedaron
exentos de esa exigencia (se protegen solas: código de un solo uso, TTL de 5
minutos y rate limiting estricto). También se agregó el header
`x-magi-device-token`, porque el token de dispositivo solo se leía de la cookie
y un cliente sin cookies (CLI, SDK, opencode) no tenía forma de mandarlo.

Verificado de punta a punta: generar código → canjear sin credencial → handshake
MCP con el header. Tests: `security:test-proxy` (85/85) y
`security:test-devices` (88/88).

---

## 6. NO VERIFICADO

- **opencode real conectado**: no se pudo probar contra una instalación de
  opencode en este entorno (no hay una disponible acá). Lo que sí está
  verificado: el endpoint JSON-RPC con el server levantado de verdad
  (handshake, catálogo, llamada, rechazo del método de aprobación, y 403 desde
  la LAN sin credencial), más los 53 casos de `security:test-mcp-server`.
- Si opencode espera `notifications/initialized` o descubrimiento por
  `tools/list` con paginado, se responde lo que el protocolo pide; falta la
  prueba con el cliente real.
- El formato exacto del bloque `mcp` de `opencode.json` puede variar entre
  versiones de opencode: si el nombre del campo cambia, la URL y los headers son
  los mismos.
