# Reporte de refactor — Consenso IA / Model Council MAGI

**Repo:** `C:\Users\Admin\Desktop\model council\model-council-magi`
**Fecha de inicio:** 2026-10-28
**Commit base:** `e65cf07` (Fase 9G)
**Entorno:** Windows, Git Bash; Node `v22.23.4`, npm `12.2.0`, Next `16.2.4`, React `19.0.0`, better-sqlite3 `13.0.3` operativo.

Este documento es acumulativo. Cada fase se agrega acá con su commit, archivos, verificación real y decisiones. Los logs completos de la línea base están en `C:\Users\Admin\AppData\Local\Temp\opencode\fase0-logs` y el reporte detallado original en `salidas/fase-0-linea-base.md`.

---

## 1. Resumen por fase

### Fase 0 — Línea base

**Qué se hizo:** se ejecutó `npm install`, `npx tsc --noEmit` y los 65 scripts de test offline (todos los `agent:test-*`, `provider-resilience:test-*` y `test-council-resilience`, excluyendo los harness live). Se documentaron los fallos preexistentes y los tests que necesitan proveedor real.

**Resultado:** 63/65 scripts offline exit 0; Fase 8 480/480; Fase 9 1.401/1.401; `tsc` exit 0. Los dos fallos offline son preexistentes y no se corrigieron en esta fase: `agent:test-project` (sin argumentos) y `agent:test-repo-map-tool` (ruta con espacios).

**Archivos:** `salidas/fase-0-linea-base.md` (reporte detallado), este documento.
**Commits:** `56f8c02` — `fase 0: línea base de tests y diagnóstico`.

### Fase 1 — Seguridad de /api/*

**Qué se hizo:**
- Se creó `proxy.ts` en la raíz (Next 16; `middleware.ts` está deprecado) con matcher `/api/:path*`.
- La política se extrajo a `lib/api-security.ts` como función pura `evaluateApiRequest`.
- Se agregó `lib/api-json.ts` para que un body JSON inválido devuelva 400 en vez de 500.
- Se auditaron todas las rutas que llaman `request.json()`; las que no tenían try/catch ahora usan `readJsonBody`.
- Se agregó el test `lib/test-api-security.ts` (54 casos) y el script `security:test-proxy`.
- Se documentaron `ALLOWED_HOSTS`, `ALLOWED_ORIGINS` y `APP_ACCESS_TOKEN` en `.env.example` y `README.md`.

**Archivos creados:** `proxy.ts`, `lib/api-security.ts`, `lib/api-json.ts`, `lib/test-api-security.ts`.
**Archivos modificados:** `package.json`, `.env.example`, `README.md`, `app/api/threads/migrate/route.ts`, `app/api/threads/route.ts`, `app/api/threads/[id]/favorite/route.ts`, `app/api/council/ping/route.ts`, `app/api/council/route.ts`, `app/api/council/apply-file-change/route.ts`, `app/api/council/stream/route.ts`.
**Commit:** pendiente al momento de escribir esta sección; se completa en el commit de la fase.

**Política aplicada:**
1. **Host:** allowlist. Default: `localhost`, `127.0.0.1` y `[::1]` con el puerto de `PORT` (o `3000`). Configurable con `ALLOWED_HOSTS` (coma). Una entrada sin puerto acepta cualquier puerto de ese host. Esto corta DNS rebinding.
2. **Token opcional:** si `APP_ACCESS_TOKEN` está definido, todo `/api/*` exige `Authorization: Bearer <token>` o cookie `magi_access_token=<token>`. Si no está definido, no se exige nada.
3. **Origin / Sec-Fetch-Site:** en `POST`, `PUT`, `PATCH` y `DELETE`, si viene `Origin` debe estar en `ALLOWED_ORIGINS` (default: mismo origen del Host permitido, en http y https). Si no viene `Origin`, se rechaza `Sec-Fetch-Site: cross-site`. Si no viene ninguno de los dos, se permite (clientes no navegador: curl, scripts).
4. **Content-Type:** si el método muta y hay body, se exige `application/json` o `*+json`. Todas las rutas mutantes que parsean body usan JSON; no hubo excepciones. Las rutas sin body (`cancel`, `discard`, `apply`, deletes) no se ven afectadas.
5. **Rechazos:** `403` con `{ "ok": false, "error": "..." }` en español para Host/Origin/token/Content-Type. Body JSON inválido: `400` con la misma forma.

**Tests nuevos:** `lib/test-api-security.ts` — 54 casos (matriz de host, origin, sec-fetch-site, content-type, token y métodos GET/POST/PUT/PATCH/DELETE).
**Script:** `npm run security:test-proxy`.

### Fase 2 — Lint, scripts unificados y CI

Pendiente de implementación.

### Fase 3 — Código muerto y duplicado

Pendiente de implementación.

### Fase 4 — Tests del núcleo del consejo

Pendiente de implementación.

### Fase 5 — Refactors behavior-preserving

Pendiente de implementación.

### Fase 6 — Documentación y configuración

Pendiente de implementación.

### Fase 7 — Funcionalidades nuevas

Pendiente de implementación.

---

## 2. Tabla de verificación

### Fase 0 — ANTES (línea base)

| Comando | Resultado real |
|---|---|
| `npm install` | exit 0. 4 install scripts bloqueados (`better-sqlite3`, `esbuild`, `sharp`, `unrs-resolver`); `better-sqlite3` ya compilado y verificado con una consulta en memoria. 13 vulnerabilidades reportadas por `npm audit`; no se aplicó `npm audit fix`. |
| `npx tsc --noEmit` | exit 0, sin salida. |
| 65 scripts offline | 63/65 exit 0. Fallos: `agent:test-project` y `agent:test-repo-map-tool` (preexistentes). |
| `npm run agent:test-phase8` | exit 0; 480/480 (suma de sub-tests). |
| `npm run agent:test-phase9` | exit 0; 1.401/1.401 (suma de sub-tests). |

#### Tabla script → resultado (Fase 0, offline)

| Script | Resultado | Motivo / resumen |
|---|---|---|
| `agent:test-project` | FALLA | Harness manual: sin args imprime el uso y sale 1. Con args en un repo temporal: PASS (ver Fase 0). |
| `agent:test-task-state` | OK | === PRUEBA DE ACEPTACIÓN 2B: PASS === |
| `agent:test-workspace-manager` | OK | === PRUEBA DE ACEPTACIÓN 2C: PASS === |
| `agent:test-runner` | OK | === PRUEBA DE ACEPTACIÓN 2D: PASS === |
| `agent:test-proposal-store` | OK | 4/4 casos OK. |
| `agent:test-apply` | OK | 5/5 casos OK. |
| `agent:test-agent-routes` | OK | 19/19 casos OK. |
| `agent:test-dispatcher` | OK | 5 casos; sin línea de resumen final (los mensajes de UNIQUE constraint son esperados). |
| `agent:test-delete-and-browse` | OK | 9/9 casos OK. |
| `agent:test-inspect` | OK | 5/5 casos OK. |
| `agent:test-4a-nogit` | OK | 5/5 casos OK. |
| `agent:test-run-script` | OK | 6/6 casos OK. |
| `agent:test-delete-file` | OK | 6/6 casos OK. |
| `agent:test-git-trace` | OK | 5/5 casos OK. |
| `agent:test-tool-policy` | OK | 15/15 casos OK. |
| `agent:test-exec-with-tree-kill` | OK | 16/16 casos OK. |
| `agent:test-search-provider` | OK | 12/12 casos OK. |
| `agent:test-web-search-tool` | OK | 19/19 casos OK. |
| `agent:test-web-search-compat` | OK | 17/17 casos OK. |
| `agent:test-repo-inventory` | OK | 19/19 casos OK. |
| `agent:test-repo-symbols` | OK | 71/71 casos OK. |
| `agent:test-repo-analysis` | OK | 31/31 casos OK. |
| `agent:test-resolution-config` | OK | 30/30 casos OK. |
| `agent:test-dependency-graph` | OK | 53/53 casos OK. |
| `agent:test-dependency-graph-repo` | OK | 19/19 casos OK. |
| `agent:test-repo-map-views` | OK | 59/59 casos OK. |
| `agent:test-repo-map-service` | OK | 72/72 casos OK. |
| `agent:test-repo-map-tool` | FALLA | Preexistente: el comando hijo no cita la ruta del repo y esta contiene un espacio (`Cannot find module ...\model`). |
| `agent:test-provider-resilience` | OK | 44/44 casos OK. |
| `test-council-resilience` | OK | 66/66 casos OK. |
| `agent:test-context-estimate` | OK | 23/23 casos OK. |
| `agent:test-context-budget` | OK | 43/43 casos OK. |
| `agent:test-context-usage` | OK | 26/26 casos OK. |
| `agent:test-context-sensitive` | OK | 97/97 casos OK. |
| `agent:test-context-select` | OK | 71/71 casos OK. |
| `agent:test-context-engine` | OK | 46/46 casos OK. |
| `agent:test-context-history-governor` | OK | 51/51 casos OK. |
| `agent:test-repo-map-snapshot` | OK | 36/36 casos OK. |
| `agent:test-read-range` | OK | 50/50 casos OK. |
| `agent:test-context-loop` | OK | 37/37 casos OK. |
| `agent:test-phase8` | OK | Agrupador: 480/480 (suma de los 10 sub-tests). |
| `agent:test-autonomy-contract` | OK | 230/230 casos OK. |
| `agent:test-autonomy-contract-db` | OK | 35/35 casos OK. |
| `agent:test-autonomy-plan` | OK | 182/182 casos OK. |
| `agent:test-autonomy-ledger` | OK | 130/130 casos OK. |
| `agent:test-autonomy-plan-tools` | OK | 41/41 casos OK. |
| `agent:test-autonomy-verifier` | OK | 47/47 aserciones OK |
| `agent:test-autonomy-briefing` | OK | 51/51 aserciones OK |
| `agent:test-autonomy-progress` | OK | 93/93 aserciones OK |
| `agent:test-autonomy-dispatcher` | OK | 150/150 aserciones OK |
| `agent:test-autonomy-final-report` | OK | 64/64 aserciones OK. |
| `agent:test-autonomy-cancel` | OK | 70/70 aserciones OK. |
| `agent:test-autonomy-validation` | OK | 114/114 aserciones OK. |
| `agent:test-autonomy-runner` | OK | 76/76 aserciones OK |
| `agent:test-autonomy-resume` | OK | 38/38 aserciones OK |
| `agent:test-autonomy-resume-integration` | OK | 80/80 aserciones OK |
| `agent:test-phase9` | OK | Agrupador: 1.401/1.401 (suma de los 15 sub-tests). |
| `provider-resilience:test-pool` | OK | 20/20 casos OK. |
| `provider-resilience:test-cooldown` | OK | 19/19 casos OK. |
| `provider-resilience:test-classify` | OK | 32/32 casos OK. |
| `provider-resilience:test-config` | OK | 19/19 casos OK. |
| `provider-resilience:test-redact` | OK | 20/20 casos OK. |
| `provider-resilience:test-events` | OK | 14/14 casos OK. |
| `provider-resilience:test-status-route` | OK | 5/5 casos OK. |
| `provider-resilience:test-concurrency` | OK | 190/190 casos OK. |

#### Tests live (excluidos de la línea base, no cuentan como OK)

| Script | Resultado | Motivo |
|---|---|---|
| `agent:test` | NO EJECUTADO (live) | Requiere proveedor real. Se intentó: `stopReason: error`, 0 pasos, `ByteString ... 8212`. No se cuenta como aprobado. |
| `agent:test-runner-real` | NO EJECUTADO (live) | Requiere proveedor real. Se intentó: task `FAILED`, `ByteString ... 8212`. No se cuenta como aprobado. |
| `agent:test-model-registry` | NO EJECUTADO (live) | Requiere `NVIDIA_API_KEY` y/o `GEMINI_API_KEY`; imprime `SIN CORRER (no cuenta como aprobada)`. |
| `agent:stress` | NO EJECUTADO (live) | Requiere LLM real / red; no se ejecutó en la línea base. |

### Fase 1 — DESPUÉS

| Comando | Resultado real |
|---|---|
| `npx tsc --noEmit` | exit 0, sin salida. |
| `npm run security:test-proxy` | 54/54 casos OK, exit 0. |
| Suite offline completa (66 scripts, incluye `security:test-proxy`) | 64/66 exit 0. Fallos: `agent:test-project` y `agent:test-repo-map-tool`, ambos preexistentes. |
| `npm run agent:test-phase8` | exit 0; 480/480. |
| `npm run agent:test-phase9` | exit 0; 1.401/1.401. |
| `npm run build` | exit 0. La salida incluye `ƒ Proxy (Middleware)`; Next detecta y compila `proxy.ts`. |
| Aceptación end-to-end con `next dev` en 3211 | PASS. Tasks antes: 174; después: 174. `POST /api/agent/tasks` con Origin ajeno: 403. Con `Content-Type: text/plain`: 403. `GET /api/agent/browse` con Host `evil.example`: 403. `GET /api/agent/projects` normal: 200. |

**Salida resumida real de la aceptación:**

```text
tasks antes: 174
GET /api/agent/projects normal: 200
POST Origin ajeno: 403 {"ok":false,"error":"Origen no permitido."}
POST text/plain: 403 {"ok":false,"error":"Content-Type no soportado: se esperaba application/json."}
GET /api/agent/browse con Host ajeno: 403 {"ok":false,"error":"Host no permitido."}
tasks después: 174
ACEPTACIÓN FASE 1: PASS
```

---

## 3. Tests nuevos

| Fase | Archivo | Casos | Script |
|---|---|---:|---|
| 0 | — | — | — |
| 1 | `lib/test-api-security.ts` | 54 | `security:test-proxy` |

---

## 4. Decisiones y dudas

### Fase 0

- Solo se recibió la Fase 0 en el primer mensaje; no se inventaron fases. El mensaje posterior completó Fases 1–7.
- No se corrigieron los fallos preexistentes `agent:test-project` ni `agent:test-repo-map-tool`; quedan documentados.
- `agent:test-project` se verificó aparte con argumentos en un repo temporal: PASS.
- Los tests live no se marcaron como OK. El error `ByteString ... 8212` y la falta de `NVIDIA_API_KEY`/`GEMINI_API_KEY` quedaron registrados.
- La DB `data/council.db` cambió de hash porque varias suites escriben en ella; está ignorada por git y no se commiteó.

### Fase 1

- **403 uniforme:** el criterio de aceptación pedía 403 tanto para Origin ajeno como para `Content-Type: text/plain`. Se unificó todo rechazo de seguridad a 403 (no 415).
- **Sin Origin y sin Sec-Fetch-Site:** se permite. Un cliente no navegador (curl, script) no puede ser víctima de CSRF y la app es self-hosted. Un navegador cross-site manda `Sec-Fetch-Site: cross-site` y se bloquea.
- **Allowlist de Host:** una entrada sin puerto acepta cualquier puerto de ese host; los defaults sí incluyen el puerto de `PORT` (o 3000). Si `ALLOWED_HOSTS` está definido pero todas sus entradas son inválidas, falla cerrado.
- **Allowlist de Origin:** si `ALLOWED_ORIGINS` no está definido, se aceptan `http://` y `https://` del Host permitido. No se soportan comodines.
- **Token:** se acepta `Authorization: Bearer` o cookie `magi_access_token`. No se agregó login ni UI de autenticación; la app sigue siendo single-user. Si se define el token, el cliente debe enviarlo.
- **Content-Type:** se aplica a todos los métodos que mutan y tienen body. Las rutas que no parsean body no se ven afectadas. No hubo rutas que reciban adjuntos u otro tipo en un método mutante.
- **Auditoría de `request.json()`:** `agent/tasks` y `agent/projects` ya tenían try/catch con 400; el resto se migró a `readJsonBody`. `council/stream` ahora parsea antes de abrir el SSE, así un body inválido es 400 JSON y no un stream 200 con error adentro.
- **Test de grafo:** el test existente `agent:test-dependency-graph-repo` copia solo `app/` y `lib/`. Un import `../proxy` desde `lib/test-api-security.ts` quedaba irresoluble y hacía fallar ese test. Se quitó el import de wiring del test puro; el wiring de `proxy.ts` se verificó con el build y con el dev server real.
- **Runtime:** se confirmó en `node_modules/next` que Next 16.2.4 usa `mod.proxy || mod.default` y que el proxy corre siempre en runtime Node.js; por eso `process.env` se usa sin restricciones de Edge.

---

## 5. Riesgos conocidos y deuda

- La app no tiene autenticación por defecto. `APP_ACCESS_TOKEN` es una cerradura opcional, no un sistema de usuarios.
- Detrás de un reverse proxy hay que preservar el `Host` o configurar `ALLOWED_HOSTS`/`ALLOWED_ORIGINS` con el host público.
- `agent:test-project` sigue fallando sin argumentos (es un harness manual) y `agent:test-repo-map-tool` sigue fallando por la ruta con espacios; son fallos preexistentes.
- Los proveedores reales no quedaron validados: `agent:test` y `agent:test-runner-real` fallan con `ByteString ... 8212`; `agent:test-model-registry` no tiene keys. No se declaran como OK.
- El lint de Fase 2 todavía no está implementado; `npm run lint` sigue apuntando a `next lint`, que no existe en Next 16.
- El runner unificado `npm test` todavía no existe; `security:test-proxy` se ejecuta individualmente hasta Fase 2.

---

## 6. Cómo probar manualmente cada fase

### Fase 0

1. `npm install` y `npx tsc --noEmit`.
2. `npm run agent:test-phase8` y `npm run agent:test-phase9`.
3. Revisar la tabla de scripts en este documento y los logs de `fase0-logs`.

### Fase 1

1. `npm run dev` y abrir `http://localhost:3000`; la UI debe cargar y los GET de lectura deben funcionar.
2. `curl -i -X POST http://localhost:3000/api/agent/tasks -H "Origin: http://evil.example" -H "Content-Type: application/json" --data "{}"` → 403.
3. `curl -i http://localhost:3000/api/agent/browse?path=C:\\ -H "Host: evil.example"` → 403; el mismo GET con Host normal → 200.

### Fases 2–7

Pendiente de implementación.

---

## Apéndice — Evidencia

- Línea base detallada: `salidas/fase-0-linea-base.md`.
- Logs de línea base: `C:\Users\Admin\AppData\Local\Temp\opencode\fase0-logs`.
- Logs de Fase 1: `C:\Users\Admin\AppData\Local\Temp\opencode\fase1-logs-final`.
- Build de Fase 1: `C:\Users\Admin\AppData\Local\Temp\opencode\fase1-build.log`.
- Aceptación Fase 1: `C:\Users\Admin\AppData\Local\Temp\opencode\fase1-acceptance.js` (script) y su salida en la sección 2.
