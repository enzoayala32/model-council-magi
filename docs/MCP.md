# MCP — Model Context Protocol

Cómo se conecta la app a servidores MCP externos (Fase 7), qué hace falta para
que puedan escribir (Fase 8) y cómo se expone la app como servidor (Fase 9).

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
      "readOnly": true,
      "timeoutMs": 60000,
      "note": "por qué confío en este servidor"
    },
    {
      "name": "http-remoto",
      "transport": "http",
      "url": "https://mcp.ejemplo.com/mcp",
      "headersForward": ["TOKEN_MCP"],
      "tools": ["listar"],
      "readOnly": true
    }
  ]
}
```

Validación (todo o nada, nunca a medias):

| Regla | Motivo |
|---|---|
| `version` tiene que ser `1` | un cambio de formato se ve, no se ignora |
| `name` único y sin caracteres raros | se usa como identificador |
| stdio exige `command`; http exige `url` | sin eso no hay con qué conectarse |
| http remoto **solo HTTPS** | los headers suelen ser credenciales |
| `timeoutMs` entre 1 y 15 min | ni cuelgue ni espera infinita |
| `tools` es lista de strings | la allowlist es explícita |

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

## 6. Timeout y procesos

Cada servidor tiene su `timeoutMs`. Si no responde, la conexión queda en error
—no colgada— y el proceso se mata **por árbol** (`killProcessTree`), para que en
Windows no queden procesos nieto vivos.

## 5. Tests

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
