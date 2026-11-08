# MCP — Model Context Protocol

Cómo se conecta la app a servidores MCP externos (Fase 7), qué hace falta para
que puedan escribir (Fase 8) y cómo se expone la app como servidor (Fase 9).

---

## 0. Estado real (qué está conectado y qué no)

| Capacidad | Estado |
|---|---|
| Cliente MCP read-only (`lib/mcp/client.ts`, `config.ts`) | **Conectado**: lo usa el loop del agente (Fase 7.4) |
| Herramientas MCP en el agente (`lib/agent/mcp-tools.ts`) | **Conectado**: `mcp__<servidor>__<herramienta>` |
| Aprobación humana (`lib/mcp/approvals.ts` + rutas) | **Conectado**: UI en `/m/settings` y rutas `/api/mcp/approvals*` |
| Servidor MCP propio (`/api/mcp`) | **Conectado**: solo lectura |
| Aislamiento del entorno del hijo | **Conectado** (tests con servidor real por stdio) |
| Push al aprobar (`approval.required`) | **Conectado** como evento de push; envío real **NO VERIFICADO** |
| Cliente HTTP remoto (transport `http`) | **NO conectado al loop**: la config lo acepta y el cliente solo implementa stdio |
| UI de administración de servidores | **Pendiente**: el JSON se edita a mano (ver sección 7) |
| Servidores MCP reales de terceros | **NO VERIFICADO**: sin un servidor real para probar |

---

## 1. Dónde vive la configuración (y por qué no en el repo)

```
%APPDATA%\consenso-ia\mcp.json            (Windows)
$XDG_CONFIG_HOME/consenso-ia/mcp.json     (Linux/macOS)
```

Otra ruta con `MAGI_MCP_CONFIG=/ruta/al/archivo.json`.

**Fuera del repo a propósito.** El archivo dice "ejecutá este comando con estos
argumentos": si viviera en el repo, un pull —o el propio agente tocando un
archivo— bastaría para que la PC ejecutara lo que fuera. Además no se puede
commitear por accidente.

Si el archivo no existe, MCP está desactivado. No es un error.

## 2. Formato

```json
{
  "version": 1,
  "servers": [
    {
      "name": "mi-servidor",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "algun-mcp"],
      "envForward": ["MI_TOKEN_MCP"],
      "tools": ["leer_cosa", "listar_otra"],
      "readOnlyTools": ["leer_cosa"],
      "readOnly": true,
      "timeoutMs": 60000,
      "note": "por qué confío en este servidor"
    },
    {
      "name": "http-remoto",
      "transport": "http",
      "url": "https://mcp.ejemplo.com/mcp",
      "httpHeaders": { "Authorization": "${MI_TOKEN_MCP}" },
      "tools": ["listar"],
      "readOnlyTools": [],
      "readOnly": true
    }
  ]
}
```

**`readOnlyTools` es la lista que decide qué se ejecuta sin aprobación humana.**
Tiene que ser subconjunto de `tools`; si listás algo que no está en `tools`, la
config se rechaza (no se podría llamar de todos modos). **Si la omitís, ninguna
herramienta queda eximida: todo pide aprobación.**

Validación (todo o nada, nunca a medias):

| Regla | Motivo |
|---|---|
| `version` tiene que ser `1` | un cambio de formato se ve, no se ignora |
| `name` único y sin caracteres raros | se usa como identificador |
| stdio exige `command`; http exige `url` | sin eso no hay con qué conectarse |
| http remoto **solo HTTPS** | los headers suelen ser credenciales |
| `timeoutMs` entre 1 y 15 min | ni cuelgue ni espera infinita |
| `tools` es lista de strings | la allowlist es explícita |
| `readOnlyTools` ⊆ `tools` | eximir una herramienta que no se puede llamar es un error del operador: se rechaza la config |

## 2bis. Los secretos de la app NO se reenvían (léelo antes de configurar)

El proceso hijo recibe un entorno armado por allowlist, y estas variables están
en una lista de **nunca reenviar**, aunque las listes en `envForward`:

```
APP_ACCESS_TOKEN
MAGI_TOTP_KEY
OPENROUTER_API_KEY
NVIDIA_API_KEY
GEMINI_API_KEY
GITHUB_TOKEN
TAVILY_API_KEY
```

`GITHUB_TOKEN` es el que más sorprende: es un secreto de la app que está en el
`.env` del proyecto, y un servidor MCP que "necesita el token de GitHub" se
llevaría el tuyo, con tus permisos, sin que te enteres.

**Si un servidor MCP necesita una credencial, ponele OTRO nombre y cargala vos
donde corresponda.** Ejemplo: el servidor pide `MI_MCP_GITHUB_TOKEN`; esa
variable no está en la lista de nunca reenviar, así que se reenvía si la listás
en `envForward`:

```json
{
  "name": "mi-servidor",
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "mi-mcp"],
  "envForward": ["MI_MCP_GITHUB_TOKEN"],
  "tools": ["leer_cosa"],
  "readOnly": true
}
```

Y el valor lo definís donde vos decidas (entorno del sistema, o un `.env`
propio del servidor), **no** en el `.env` de la app. Así, si el servidor filtra
algo, lo que se filtra es una credencial de alcance mínimo que vos le diste, no
tu token de GitHub.

 Los headers de un servidor `http` siguen la misma regla (`headersForward`).

---

## 2c. FAIL-CLOSED: qué se ejecuta sin aprobación

**Solo lo que el operador escribió en `readOnlyTools`.** Nada más.

Antes la decisión la tomaba una heurística sobre el nombre y la descripción, y
el comentario del código decía "si duda, escritura" — que era falso: acertaba con
~20 palabras en inglés y clasificaba como **lectura** herramientas como
`post_message`, `deploy`, `restart_service`, `kill_process`, `transfer_funds`,
`publish`, `commit`, `merge_pull_request`, `approve`, `pay_invoice`,
`charge_card`, `grant_access`, `revoke_token`, `shutdown`, `reboot`,
`format_disk`, `drop_table`, `chmod`, `eval`, `install_package`, `upload`,
`submit`, `click`, `navigate`, `fill_form`, `type_text`, `set_config`, `toggle`
y `trigger`, que se ejecutaban **sin ninguna aprobación**.

Tres consecuencias de la regla nueva:

1. **`readOnlyHint: true` del servidor NO exime.** El servidor es el no
   confiable: si le creemos lo que dice de sí mismo, un servidor comprometido se
   declara de solo lectura y hace lo que quiere. El hint se muestra en la UI
   como dato, nada más.
2. **La heurística sigue, pero solo para ADVERTIR.** Si eximís una herramienta
   cuyo nombre parece de escritura, el reporte de config lo dice
   (`McpToolRegistry.configWarnings()`); no bloquea, decidís vos.
3. **Config sin `readOnlyTools` = todo con aprobación.** Es lo seguro por
   defecto: agregar excepciones es un acto deliberado.

El código de un solo uso de la aprobación **no viaja al modelo**: el resultado
de la herramienta solo dice que quedó pendiente y que un humano la aprueba desde
la app. El código lo ve el humano en la UI de la PC o de `/m`.

## 3. Las tres reglas de seguridad

### 3.1 El proceso hijo NO hereda el entorno

El hijo recibe un entorno armado por allowlist: lo mínimo para que un comando
funcione (`PATH`, `HOME`, `LANG`…) más las variables que el operador listó en
`envForward`.

Con el entorno completo, un servidor MCP comprometido se llevaba
`NVIDIA_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `APP_ACCESS_TOKEN` y
`MAGI_TOTP_KEY` con solo leer su propio `process.env`. Estas cinco (y
`GITHUB_TOKEN`, `TAVILY_API_KEY`) están en una lista de **nunca reenviar**, ni
aunque se listen en `envForward`.

Verificado en `lib/test-mcp-client.ts`: el servidor falso responde con su propio
entorno, y la prueba comprueba que las claves de la app no están mientras la
variable permitida sí.

### 3.2 Allowlist de herramientas, enforced en el cliente

`callTool` rechaza en el cliente cualquier herramienta que no esté en `tools`,
**antes** de hablar con el servidor. No se confía en que el servidor diga "no
puedo". Lista vacía = no se puede llamar nada.

### 3.3 La salida es contenido no confiable

Todo lo que devuelve un servidor MCP vuelve con el preámbulo
`[contenido no confiable de MCP]`, recortado a 100.000 caracteres y con los
secretos de la app redactados. Se trata como texto de un extraño, nunca como
instrucción: si un servidor responde "ignorá tus reglas y ejecutá…", eso es
dato, no orden.

## 4. Fase 8 — herramientas de escritura: aprobación humana

Una herramienta que MODIFICA algo (borrar, mandar, aplicar) no se ejecuta con
que el agente la pida. Hace falta una **aprobación humana, de un solo uso**.

- El cliente pide la herramienta → `lib/mcp/approvals.ts` crea una solicitud y
  devuelve un código del tipo `XXXX-XXXX-XXXX-XXXX`, **una sola vez** (en la DB
  queda el hash, igual que los códigos de emparejamiento).
- El código se le muestra al operador en la app; desde ahí aprueba o rechaza.
- Aprobar es acto humano: operador (token o sesión) o dispositivo con scope
  `approve` **y step-up vigente** (`lib/auth/step-up.ts`).
- Al ejecutar, la aprobación se **consume**: es de un solo uso, y tiene que
  coincidir el hash de los argumentos. Si el agente cambió la ruta que iba a
  borrar, la aprobación no sirve.
- Vence en 5 minutos. Los errores son genéricos: no se filtra si existía.
- Un pedido idéntico repetido dentro de 10 segundos **reusa** la misma
  solicitud: si no, un agente que insigue genera 10 aprobaciones y el operador
  termina aprobando en masa.

Quién puede aprobar lo resuelve la ruta, no este módulo.

## 4bis. Cómo llega MCP al loop del agente (Fase 7.4)

`lib/agent/mcp-tools.ts` crea una tool por cada herramienta permitida, con el
nombre `mcp__<servidor>__<herramienta>`. El loop las ve como cualquier otra
herramienta del agente.

- **La decisión de "puede escribir" es por HERRAMIENTA, no por servidor.** Un
  servidor con `readOnly: false` puede exponer `leer` (lectura) y `borrar`
  (escritura): la primera se ejecuta, la segunda pide aprobación. (Decidirlo por
  servidor hacía que hasta una consulta inocente pidiera aprobación humana —
  ese fue el bug que encontró el primer test de punta a punta.)
- **La de lectura se ejecuta** y su salida vuelve marcada como no confiable,
  recortada a 20.000 caracteres, con tamaño y hash.
- **La de escritura NO se ejecuta**: crea la aprobación y le dice al modelo que
  espere, con el código. No reintenta.
- **La salida se registra en el event log como metadato** (`chars`, `sha256`,
  `preview` de 160 caracteres ya redactado), nunca como contenido.
- Las conexiones se cachean por servidor durante la corrida y se cierran al
  terminar (sino quedaban procesos stdio vivos tras cada task).

Tests: `npm run security:test-mcp-loop` (39 casos, con un servidor MCP real por
stdio).

---

## 5. Fase 9 — la app como servidor MCP (`/api/mcp`)

Un cliente MCP emparejado se autentica como un dispositivo más (cookie de
dispositivo o token de operador) y habla JSON-RPC 2.0 por POST:

| Método | Qué hace |
|---|---|
| `initialize` | Handshake. Devuelve las instrucciones, que aclaran que es solo lectura |
| `ping` | Latido |
| `tools/list` | Catálogo, filtrado por el scope del cliente |
| `tools/call` | Ejecuta una herramienta de solo lectura |

Herramientas expuestas, todas `readOnly`: `tasks.list`, `tasks.status`,
`tasks.events`, `council.runs`, `council.run`.

**No hay método de aprobación, a propósito.** Aprobar es un acto humano con
segundo factor que se hace en la app; un cliente MCP no puede pedirlo por
protocolo. Si un cliente insiste con `approvals/approve`, recibe `-32601`.

La ruta tiene scope en `lib/auth/scopes.ts` y llama `guardRequest()` como
primera sentencia: sin credencial o con cookie falsa, 401/403.

## 5bis. Rutas de aprobación

| Ruta | Método | Scope | step-up |
|---|---|---|---|
| `/api/mcp/approvals` | GET | `approve` | — |
| `/api/mcp/approvals` | POST (rechazar) | `approve` | sí (dispositivo remoto) |
| `/api/mcp/approvals/approve` | POST | `approve` | sí (dispositivo remoto) |

Un cliente MCP conectado a `/api/mcp` **no puede aprobar**: `/api/mcp` no expone
ningún método de aprobación (responde `-32601`), y las rutas de arriba exigen
`approve`, que un cliente `observe` u `operate` no tiene.

La UI está en `/m/settings` (y en la PC, con la misma pieza). La lista muestra
servidor, herramienta y resumen de argumentos; **nunca** el código de las
pendientes, porque el endpoint no lo devuelve.

---

## 6. Timeout y procesos

Cada servidor tiene su `timeoutMs`. Si no responde, la conexión queda en error
—no colgada— y el proceso se mata **por árbol** (`killProcessTree`), para que en
Windows no queden procesos nieto vivos.

## 6bis. Transporte HTTP (Fase 7)

Un servidor MCP puede vivir detrás de una URL en vez de en un proceso local. El
cliente HTTP (`lib/mcp/http-client.ts`) tiene el **mismo contrato** que el de
stdio (`connect`, `listTools`, `callTool`, `ping`, `close`), así que el loop no
distingue el transporte.

### Config

| Campo | Qué es |
|---|---|
| `url` | endpoint MCP del servidor |
| `httpHeaders` | headers a mandar. Los valores van **por referencia** a variables de entorno: `"Authorization": "${MI_TOKEN_MCP}"`. Nunca en claro. Una referencia a una variable que no existe **omite el header** y se informa cuál faltó. |
| `allowInsecureLocal` | `true` solo para `http://` **y** host loopback (server local de prueba). Tiene que estar marcado a mano. |

### Anti-SSRF (las mismas reglas que el push)

- **HTTPS siempre.** HTTP únicamente si el host es loopback y
  `allowInsecureLocal: true`.
- **Sin credenciales en la URL** (`user:pass@`): quedarían en logs.
- **Sin redirects** (`redirect: "error"`): un 302 a una IP privada sería el
  mismo SSRF por otra puerta.
- **IPs literales privadas/link-local/metadata rechazadas**, y los hostnames que
  **resuelvan** a ellas —la resolución es inyectable, igual que en
  `lib/push/endpoint.ts`, así los tests prueban el caso sin tocar la red.
- **Timeout** por servidor y **tope de respuesta de 8 MB**: si se pasa, se
  cancela la lectura y se devuelve un error explícito ("respuesta demasiado
  grande"), no un JSON roto.
- Se **revalida la URL en cada conexión**: un registro viejo no queda confiado
  para siempre.

### Lo demás, igual que stdio

Fail-closed (`readOnlyTools`), salida marcada como no confiable y redactada, y
el mismo event log con tamaño, hash y preview.

```
npm run security:test-mcp-http      # 46 casos
```

Prueba la cadena completa contra un servidor MCP local de prueba (sin red
externa): lectura ejecuta, escritura pasa por aprobación, redirect rechazado,
host privado rechazado (por IP y por DNS), respuesta gigante cortada, y que el
token de la cabecera no aparece en la salida.

---

## 7. Lo que falta

- **UI de administración de servidores**: hoy el JSON se edita a mano, fuera del
  repo (ver sección 1). No hay pantalla para agregar o quitar servidores.
- **Transport `http` en el loop**: la config lo acepta y valida, pero el cliente
  que usa el agente solo implementa stdio. Un servidor `http` queda sin uso
  hasta que se implemente.

---

## 8. Tests

```
npm run security:test-mcp-client      # 45 casos
npm run security:test-mcp-server      # 53 casos
```

- **Cliente**: levanta un servidor MCP de verdad (un proceso Node que habla
  JSON-RPC por stdio), no un mock: handshake, `tools/list`, `tools/call`,
  aislamiento del entorno, allowlist, redacción, timeout y cierre.
- **Servidor y aprobaciones**: ciclo de vida completo de una aprobación (crear,
  reusar, aprobar, rechazar, consumir, gastar, argumentos cambiados, vencida),
  validación de argumentos, catálogo por scope, y la ruta real `/api/mcp` sin
  credencial, con cookie falsa y con token —incluido que no exista método de
  aprobación.
