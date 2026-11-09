# Usar Consenso IA desde opencode (como subagente)

Consenso IA expone un servidor MCP en `POST /api/mcp`. Desde opencode (o
cualquier cliente MCP) se ve como un servidor más, con herramientas de **solo
lectura** sobre el consejo y el agente.

---

## 1. La config de opencode

opencode lee los servidores MCP de `~/.config/opencode/opencode.json` (o la que
tengas en `OPENCODE_CONFIG`). Se agrega como `mcp` con transporte `local` (un
comando que habla JSON-RPC por stdio) o `remote` (HTTP):

```json
{
  "mcp": {
    "consenso-ia": {
      "type": "remote",
      "url": "http://127.0.0.1:3000/api/mcp",
      "headers": {
        "Authorization": "Bearer ${CONSENSO_TOKEN}"
      },
      "enabled": true
    }
  }
}
```

- **`url`**: la app corriendo. Para usarla desde otra máquina, HTTPS (ver
  `docs/ACCESO-REMOTO.md`); el túnel ve todo como loopback, así que conviene un
  token de operador o un dispositivo emparejado.
- **`headers.Authorization`**: `Bearer` con tu `APP_ACCESS_TOKEN`, o el token de
  un dispositivo emparejado. El valor sale de una variable de entorno:
  opencode la expande, no se escribe en el archivo.
- Si corrés la app en loopback sin `APP_ACCESS_TOKEN`, no hace falta header: el
  acceso local implícito alcanza.

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
