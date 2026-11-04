# API del agente — contrato de las rutas que usa la PWA

Documento de referencia para las rutas que consume la vista móvil (`/m`) y
cualquier cliente externo. Describe método, ruta, respuesta y scope
requerido.

**Sobre “scope”:** hoy los niveles formales (`observe` / `operate` /
`approve`) todavía no existen — llegan con el emparejamiento por
dispositivos. Hasta entonces, la regla efectiva es la del proxy
(`lib/api-security.ts`): **loopback con acceso implícito; cualquier otro
Host (LAN o túnel) exige autenticación siempre**. Donde el documento dice
“observe”, hoy significa “cualquier request autenticada”.

## Reglas transversales

- Todo `/api/*` pasa por `proxy.ts` (`matcher: /api/:path*`). Un Host que
  no es `localhost`/`127.0.0.1`/`[::1]` se rechaza con 403 si no hay
  `APP_ACCESS_TOKEN` ni cookie de dispositivo configurada.
- Los métodos que mutan (`POST`, `PUT`, `PATCH`, `DELETE`) exigen
  `Content-Type: application/json` y un `Origin` válido cuando el cliente
  es un navegador. Sin `Origin`, se rechaza `Sec-Fetch-Site: cross-site`.
- Los rechazos son JSON en español: `{ "ok": false, "error": "…" }`.
- Un body JSON inválido devuelve **400**, no 500.

---

## Tareas

### `GET /api/agent/tasks`

Lista de tareas. Filtros opcionales por query string.

| Parámetro | Tipo | Notas |
|---|---|---|
| `projectId` | string | Filtra por proyecto. |
| `status` | `TaskStatus` | `QUEUED`, `RUNNING`, `READY_FOR_REVIEW`, `APPLYING`, `APPLIED`, `DISCARDED`, `FAILED`, `NO_CHANGES`, `CANCELLED`, `INTERRUPTED`. |

**Respuesta 200**

```json
{ "ok": true, "tasks": [ { "id": "…", "projectId": "…", "modelId": "…", "prompt": "…", "status": "RUNNING", "createdAt": 1793238594047, "startedAt": 1793238594047, "finishedAt": null, "baseCommit": "abc123", "workspaceId": null, "stopReason": null, "error": null, "discardReason": null, "conflictedPaths": null, "restartRetryCount": 0, "gitCommitStatus": null, "appliedCommitSha": null, "appliedBranchName": null, "gitCommitError": null } ] }
```

**Scope:** observe.

### `POST /api/agent/tasks`

Crea una tarea en `QUEUED` y avisa al dispatcher (no espera la corrida).
Body: `{ projectId, modelId, prompt }`.

**Respuesta 200** `{ "ok": true, "task": { …mismo shape… } }`.
**Error 400** si falta algún campo o el JSON es inválido; **404** si el
proyecto no existe; **409** si el Coding Agent está deshabilitado.

**Scope:** operate.

> Crear no ejecuta nada por sí solo: la tarea queda encolada y corre en la
> PC del servidor.

### `GET /api/agent/tasks/[id]`

Detalle de una tarea. **404** si no existe. **Scope:** observe.

### `POST /api/agent/tasks/[id]/cancel`

Pide la cancelación. **Scope:** operate (no modifica el proyecto: detiene
la corrida, no toca archivos).

### `POST /api/agent/tasks/[id]/discard`

Descarta una tarea en `READY_FOR_REVIEW`, descartando sus propuestas.
**Scope:** approve.

### `POST /api/agent/tasks/[id]/apply`

Aplica los cambios de una tarea al proyecto real. **Scope:** approve.
**Ruta protegida:** modifica el proyecto, así que tras el emparejamiento
exigirá además step-up (TOTP).

### `GET /api/agent/tasks/[id]/events`

Stream SSE de los eventos de la tarea.

- Cabeceras: `Content-Type: text/event-stream`,
  `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`.
- **Reanudación:** acepta `?sinceSeq=<n>` o el header estándar
  `Last-Event-ID`. Sin ninguno, manda el historial completo desde el
  principio. Nunca se pierde un evento entre el replay y el vivo: ambos
  leen con la misma condición `seq > lastSeq`.
- **Heartbeat:** un comentario (`: heartbeat`) cada ~15 s, para que ni un
  proxy con buffering ni una red móvil cierren la conexión por inactividad.
- Eventos con `id: <seq>`; el snapshot periódico llega como `event: task`.
- El stream se cierra cuando la tarea sale de `QUEUED`/`RUNNING`.

**Scope:** observe.

### `GET /api/agent/tasks/[id]/proposals`

Propuestas de cambio de una tarea (con `diff`). **Scope:** observe.

---

## Proyectos y modelos

### `GET /api/agent/projects`

Proyectos registrados. **Scope:** observe.

### `GET /api/agent/models`

Modelos habilitados para el Coding Agent. **Scope:** observe.

---

## Consejo

### `GET /api/council/runs`

Lista de corridas persistidas.

| Parámetro | Tipo | Default |
|---|---|---|
| `threadId` | string | sin filtro |
| `limit` | number | 50 (máximo 200) |

**Scope:** observe.

### `GET /api/council/runs/[id]`

Detalle con uso por modelo/fase y eventos. **404** si no existe.
**Scope:** observe.

### `GET /api/council/runs/[id]/export`

Export de la corrida. `?format=markdown` (default) o `?format=json`.
Devuelve `Content-Disposition: attachment`. **Scope:** observe.

### `GET /api/council/runs/compare?a=<id>&b=<id>`

Compara dos corridas: deltas de tokens, duración y costo, y modelos
exclusivos de cada una. **400** si falta un parámetro o ambas son iguales;
**404** si alguna no existe. **Scope:** observe.

### `DELETE /api/council/runs/[id]`

Borra una corrida y sus eventos/uso. **404** si no existe.
**Scope:** operate.

---

## Hilos

### `GET /api/threads` · `POST /api/threads` · `GET /api/threads/[id]` · `DELETE /api/threads/[id]` · `PATCH /api/threads/[id]/favorite`

Persistencia del historial de conversaciones. **Scope:** observe para las
lecturas, operate para escrituras.

---

## Catálogo de modelos

### `GET /api/models/catalog`

Listado automático descubierto desde los endpoints públicos de OpenRouter y
NVIDIA, separado en `free` (precio 0 verificado), `paid` (precio > 0) y
`unknown` (el proveedor no publica precio — hoy, todos los de NVIDIA).
`?refresh=1` ignora el caché de 30 minutos. **Scope:** observe.

---

## Autenticación

### `POST /api/auth/token`

Canjea `APP_ACCESS_TOKEN` por la cookie `magi_access_token`
(`HttpOnly`, `SameSite=Strict`, `Path=/`, `Secure` si la request vino por
HTTPS). Body: `{ "token": "…" }`. Respuesta 200 en ambos casos —con y sin
token configurado— para no delatar la configuración; **403** si el token no
coincide.

Exceptuada del chequeo de token (si no, no se podría usar nunca), pero
**sigue sujeta a Host, Origin y Content-Type**.

### `DELETE /api/auth/token`

Borra la cookie (logout local).

---

## No expuesto por diseño

Ninguna ruta bajo `/api/` permite, sin un humano autenticado con step-up:

- aplicar cambios al proyecto (`apply`) desde un dispositivo remoto;
- modificar la configuración de servidores MCP;
- revocar dispositivos o cambiar scopes.

Esto es deliberado: controlar el agente a distancia equivale a ejecución
remota de código.
