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
**Commit:** `22b0700` — `fase 1: proxy de seguridad para /api/*`.

**Política aplicada:**
1. **Host:** allowlist. Default: `localhost`, `127.0.0.1` y `[::1]` con el puerto de `PORT` (o `3000`). Configurable con `ALLOWED_HOSTS` (coma). Una entrada sin puerto acepta cualquier puerto de ese host. Esto corta DNS rebinding.
2. **Token opcional:** si `APP_ACCESS_TOKEN` está definido, todo `/api/*` exige `Authorization: Bearer <token>` o cookie `magi_access_token=<token>`. Si no está definido, no se exige nada.
3. **Origin / Sec-Fetch-Site:** en `POST`, `PUT`, `PATCH` y `DELETE`, si viene `Origin` debe estar en `ALLOWED_ORIGINS` (default: mismo origen del Host permitido, en http y https). Si no viene `Origin`, se rechaza `Sec-Fetch-Site: cross-site`. Si no viene ninguno de los dos, se permite (clientes no navegador: curl, scripts).
4. **Content-Type:** si el método muta y hay body, se exige `application/json` o `*+json`. Todas las rutas mutantes que parsean body usan JSON; no hubo excepciones. Las rutas sin body (`cancel`, `discard`, `apply`, deletes) no se ven afectadas.
5. **Rechazos:** `403` con `{ "ok": false, "error": "..." }` en español para Host/Origin/token/Content-Type. Body JSON inválido: `400` con la misma forma.

**Tests nuevos:** `lib/test-api-security.ts` — 54 casos (matriz de host, origin, sec-fetch-site, content-type, token y métodos GET/POST/PUT/PATCH/DELETE).
**Script:** `npm run security:test-proxy`.

### Fase 2 — Lint, scripts unificados y CI

**Qué se hizo:**
- Se creó `eslint.config.mjs` (flat config) con `eslint-config-next/core-web-vitals` + `eslint-config-next/typescript` y se cambió `npm run lint` de `next lint` (inexistente en Next 16) a `eslint .`.
- Se creó `scripts/run-tests.ts`: descubre los scripts de test offline del `package.json`, los corre de a uno (varias suites escriben `data/council.db`), aplica timeout y devuelve exit 1 si alguno falla. No usa bash.
- Se agregaron los scripts `test` (`tsx scripts/run-tests.ts`), `test:live` (`--live`) y `typecheck` (`tsc --noEmit`), y `engines.node: ">=22"` (con `package-lock.json` actualizado).
- Se creó `.github/workflows/ci.yml`: Node 22, `npm ci`, `typecheck`, `lint`, `test`, `build`.
- Se corrigió el fallo preexistente de `agent:test-repo-map-tool`: el hijo se lanzaba con `npx ... shell:true` y la ruta del repo (con espacios) se partía. Ahora se invoca el CLI de `tsx` con `process.execPath` y `execFile` sin shell. Pasa 50/50.
- Se aplicaron correcciones mecánicas de lint: `prefer-const` en harness de tests, `const service = fakeService(...)` en `test-context-engine.ts`, `{"//"}` en `FooterReadout.tsx` y limpieza de directivas `eslint-disable` sin uso. En `repo-map-service.ts` quedaron dos `eslint-disable-next-line prefer-const` justificados (el closure las lee antes de asignarlas).

**Archivos creados:** `eslint.config.mjs`, `scripts/run-tests.ts`, `.github/workflows/ci.yml`.
**Archivos modificados:** `package.json`, `package-lock.json`, `app/agent/ProjectPicker.tsx`, `app/components/council/FooterReadout.tsx`, `lib/db.ts`, `lib/agent/repo-map-service.ts`, `lib/agent/test-repo-map-tool.ts` y 16 harness de tests (solo `prefer-const`/directivas).
**Commit:** `a2764f7` — `fase 2: lint, runner de tests y CI`.

**Criterio de aceptación:** `npm run typecheck && npm run lint && npm test && npm run build` → exit 0 (verificado). `npm test` corre 63 scripts offline: 63/63 OK. El lint queda en 0 errores y 64 warnings documentados.

### Fase 3 — Código muerto y duplicado

**Qué se hizo:**
- Se eliminó `app/api/council/route.ts` (variante no-streaming) después de confirmar que no tenía ninguna referencia interna: la UI usa `/api/council/stream` y solo el README listaba el archivo. Se actualizó el README.
- Se auditaron los 17 `as any` del repo. Todos estaban en harness de tests que convertían el `ToolSet` para llamar `.execute()` de un tool puntual. Se creó `lib/agent/test-tool-call.ts` (`TestTool`, `TestToolResult`, `testTool(tools, name)`) y se reemplazaron los 17 casts. No había `@ts-ignore` ni `@ts-expect-error` (0).
- Se eliminaron también los `Promise<any>` residuales de harness (`test-plan-tools`, `test-agent-routes`, `test-read-range`, `test-repo-map-tool`) usando tipos explícitos o genéricos.
- Auditoría de exports: 195 archivos, 806 exports declarados (sin contar default). 203 no tenían importador por nombre: 6 sin ninguna referencia, 167 solo uso interno y 30 indirectos (namespace, barrel o comentarios). Se eliminaron los 6 sin referencia; el resto queda documentado como deuda.

**Tabla de los 17 `as any`:**

| Archivo | Casos | Reemplazo |
|---|---:|---|
| `lib/agent/test-delete-file.ts` | 3 | `testTool(tools, "delete_file").execute(...)` |
| `lib/agent/test-run-script.ts` | 3 | `testTool(tools, "run_script").execute(...)` |
| `lib/agent/test-tool-policy.ts` | 7 | `testTool(tools, "<tool>").execute(...)` |
| `lib/agent/test-web-search-tool.ts` | 4 | `testTool(tools, "web_search").execute(...)` |
| **Total** | **17** | **0 `as any` restantes** |

**Auditoría de exports:**

| Categoría | Cantidad | Acción |
|---|---:|---|
| Sin ninguna referencia | 6 | Eliminados |
| Solo uso interno (el archivo lo usa, nadie lo importa) | 167 | Se dejan; no son código muerto demostrable |
| Indirectos (namespace/barrel/comentarios) | 30 | Se dejan; requieren análisis manual |

Los 6 exports eliminados: `prunePlanVersions` (`lib/agent/autonomy/ledger.ts`), `PlanInput` (`lib/agent/autonomy/plan.ts`), `describeVerificationResult` (`lib/agent/autonomy/verifier.ts`), `SensitivePathClassification` (`lib/agent/context/sensitive-paths.ts`), `isRunningSlotConflictError` (`lib/agent/task-store.ts`) y `listLiveWorkspaces` (`lib/agent/workspace-store.ts`).

**Archivos creados:** `lib/agent/test-tool-call.ts`.
**Archivos eliminados:** `app/api/council/route.ts`.
**Archivos modificados:** `README.md`, `lib/agent/autonomy/ledger.ts`, `lib/agent/autonomy/plan.ts`, `lib/agent/autonomy/verifier.ts`, `lib/agent/context/sensitive-paths.ts`, `lib/agent/task-store.ts`, `lib/agent/workspace-store.ts`, `lib/agent/autonomy/test-plan-tools.ts`, `lib/agent/test-agent-routes.ts`, `lib/agent/test-delete-file.ts`, `lib/agent/test-read-range.ts`, `lib/agent/test-repo-map-tool.ts`, `lib/agent/test-run-script.ts`, `lib/agent/test-tool-policy.ts`, `lib/agent/test-web-search-tool.ts`.
**Commit:** `6c0ed5d` — `fase 3: código muerto y tipado de tests`.

**Verificación:** `npm run typecheck` exit 0 (el primer intento falló con TS2307 porque `.next/types/validator.ts` todavía apuntaba a la ruta eliminada; se borró `.next` y el build regeneró los tipos). `npm run lint` exit 0 con **0 errores y 39 warnings** (ya no queda ningún `no-explicit-any`). `npm test` **63/63 OK**. `npm run build` exit 0 con los mismos 2 warnings preexistentes de Turbopack; `/api/council` ya no aparece en las rutas compiladas.

### Fase 4 — Tests del núcleo del consejo

**Qué se hizo:** se escribieron 4 harness de test nuevos, uno por módulo puro del consejo, sin red ni DB. Cada uno tiene su script `council:test-*` y el runner `scripts/run-tests.ts` los descubre solo por prefijo, así que entran a `npm test` sin tocar el runner.

| Módulo | Archivo de test | Casos | Qué cubre |
|---|---|---:|---|
| `lib/council-consensus.ts` | `lib/test-council-consensus.ts` | 94 | `splitDebateOutput`, `computeConvergence` (incluye los umbrales exactos 0.25/0.5), `computeMindChange` (umbral 0.4), `parseVote`, `tallyVotes`, `parseFusionJudgeJson`, `normalizeFusionJudgeReport` (topes y filtrado por labels), `fallbackFusionJudgeReport`, `parseFollowUpQuestions`. |
| `lib/council-prompts.ts` | `lib/test-council-prompts.ts` | 79 | `compactForHistory`, `condenseDraftForPeers` (secciones conservadas/descartadas), `renderHistoryBlock`, `buildDraftMessages` (adjuntos imagen/texto/genérico, skill, persona, web grounding), `debateSystemPrompt` (primera/intermedia/final), `buildSynthesisPrompt`, `buildFusionJudgePrompt`, `buildVotePrompt`, `buildFollowUpMessages`, `buildImagePrompt`, prompts de sistema y `personaPrompt`. |
| `lib/persona-presets.ts` | `lib/test-persona-presets.ts` | 45 | Integridad del catálogo (5 presets × 3 personas, ids/labels/keys únicos, slugs, lentes no duplicadas), composición exacta por preset, `getPersonaPreset` (incluido case-sensitive) y `assignPersonas` (orden, recorte a 3, duplicados, no mutación). |
| `lib/attachment-extraction.ts` | `lib/test-attachment-extraction.ts` | 27 | `bufferFromDataUrl` (con y sin prefijo, binario, PDF embebido), `extractPdfText` (válido, inválido, vacío, truncado, escapes), `extractDocxText` (válido, Unicode, XML especial, vacío, ZIP corrupto) y el tope de 40.000 caracteres. |

**Total: 245 casos nuevos.** Los binarios de prueba se generan en memoria: el PDF se arma a mano con xref correcto y el DOCX con `jszip`, para no depender de fixtures opacos.

**Archivos creados:** `lib/test-council-consensus.ts`, `lib/test-council-prompts.ts`, `lib/test-persona-presets.ts`, `lib/test-attachment-extraction.ts`.
**Archivos modificados:** `package.json` (4 scripts + `jszip` en `devDependencies`), `package-lock.json`.
**Commit:** `e445b10` — `fase 4: tests del núcleo del consejo`.

**Verificación:** `npm run typecheck` exit 0 (los primeros intentos fallaron por la firma de `check` en dos archivos; se unificó a `check(ok, label, detail)` donde hacía falta). `npm run lint` exit 0 con **0 errores y 39 warnings** (los mismos de Fase 3). `npm test` **67/67 scripts OK**. `npm run build` exit 0 con **1 warning** de Turbopack (el mismo trace de `next.config.ts` → `lib/fs-tools.ts` → `route.ts`, que en Fase 3 aparecía duplicado).

### Fase 5 — Refactors behavior-preserving

**Qué se hizo:** dos extracciones sin cambio de comportamiento, más la documentación de límites del Coding Agent.

1. **Orquestación del consejo fuera de la ruta HTTP.** `app/api/council/stream/route.ts` pasó de 661 a **58 líneas**: solo parsea el body con `readJsonBody` (400 uniforme de Fase 1), abre el `ReadableStream`, formatea SSE y cierra el controller en `finally`. Todo el pipeline (drafts → debate → voto → juez → síntesis → imagen → follow-ups) vive en `lib/council-orchestrator.ts` (701 líneas) como `runCouncilStream({ body, signal, send, deps })`.
2. **Dependencias inyectables.** `CouncilRunDeps` agrupa las 16 funciones que hacen I/O (`runDraft`, `runDebate`, `runVoteResilient`, `createFusionJudgeReportResilient`, `createAgentCompletion`, `createChatCompletion`, `createImageGeneration`, `withCredentialFailover`, `withWatchdog`, `resolveCredentials`, `registerSecret`, `logStep`, `executeAgentTool`, `executeFsTool`, `isFsTool`, `newProposalGroupId`). Los tests pasan un proveedor falso y verifican la secuencia SSE sin red, DB ni timers reales.
3. **Motor de la corrida en el cliente.** `app/page.tsx` pasó de 1.006 a **587 líneas**. `app/hooks/useCouncilRun.ts` (621 líneas) concentra estado de resultados, lectura del SSE (`readCouncilStream`), cancelación, propuestas de archivos, tokens, votos, personas y snapshot del turno. La página conserva configuración, modelos, adjuntos, hilos y render.
4. **Límites documentados.** `docs/ARQUITECTURA-AGENTE.md` fija qué hace y qué no hace `lib/agent/autonomy/ledger.ts` (única capa que escribe las 7 tablas del Autonomous Loop; valida transiciones y evidencia; no orquesta) y `lib/agent/loop.ts` (runtime del Coding Agent legacy: `generateText`, tools, failover Step-0, context governor; no persiste ledger ni decide estados de plan).

**Archivos creados:** `lib/council-orchestrator.ts`, `lib/test-council-orchestrator.ts`, `app/hooks/useCouncilRun.ts`, `docs/ARQUITECTURA-AGENTE.md`.
**Archivos modificados:** `app/api/council/stream/route.ts`, `app/page.tsx`, `package.json` (script `council:test-orchestrator`).
**Commit:** `f288253` — `fase 5: orquestador y hook del consejo`.

**Verificación:** `npm run typecheck` exit 0. `npm run lint` exit 0 con **0 errores y 37 warnings** (bajó de 39; el detalle por regla está en la sección 5). `npm run council:test-orchestrator` **54/54**. `npm test` **68/68 scripts OK**. `npm run build` exit 0 con **2 warnings** de Turbopack, ambos con el mismo trace `next.config.ts` → `lib/fs-tools.ts` → `app/api/council/apply-file-change/route.ts` (preexistente; en Fase 4 aparecía una sola vez vía `stream/route.ts`). Smoke test con dev server en `:3100`: `/` 200, prompt vacío devuelve SSE de error, JSON inválido 400, `Content-Type: text/plain` 403. Servidor detenido.


### Fase 6 — Documentación y configuración

**Qué se hizo:** se puso al día la documentación con el estado real del repo después de Fases 1–5 y se completó la configuración de entorno.

- **README en español, actualizado:** se corrigió la sección de stack (SQLite + `better-sqlite3`, ya no “sin base de datos”), se agregó el requisito **Node >= 22**, una sección **Coding Agent** (proyectos/tasks, loop legacy vs. autonomía opt-in, ledger/resume, tools, context engine, aplicación/verificación), una sección de **scripts** (`typecheck`, `lint`, `test`, `test:live`, `build`) y la **estructura real** del proyecto (incluye `app/agent`, `app/hooks`, `app/api/agent`, `lib/agent/*`, `lib/provider-resilience/*`, `scripts/`, `proxy.ts` y `data/council.db`). Se mantuvieron el español y los créditos, sumando la inspiración en `magi` y el fork original.
- **`.env.example` completo:** ahora documenta las **19 variables** que lee el código de producción: `OPENROUTER_API_KEY`, `OPENROUTER_API_KEY_2..N`, `OPENROUTER_SITE_URL`, `OPENROUTER_APP_NAME`, `OPENROUTER_CODING_MODEL`, `NVIDIA_API_KEY`, `GEMINI_API_KEY`, `SYNTHESIS_MODEL`, `FUSION_JUDGE_MODEL`, `FOLLOWUP_MODEL`, `AGENT_FS_ROOT`, `TAVILY_API_KEY`, `GITHUB_TOKEN`, `MAGI_AUTONOMOUS_LOOP`, `MAGI_CONTEXT_ENGINE_DISABLED`, `ALLOWED_HOSTS`, `ALLOWED_ORIGINS`, `APP_ACCESS_TOKEN` y `PORT`. Cada una con default, obligatoriedad y efecto. La única variable de `process.env` no documentada es `PATH`, que solo aparece en un test de política de tools y no es configuración de la app.

**Archivos modificados:** `README.md`, `.env.example`, `docs/REPORTE-REFACTOR.md`.
**Commit:** `266f29f` — `fase 6: README y entorno al día`.

**Verificación:** `npm run typecheck` exit 0; `npm run lint` exit 0 con 0 errores y 37 warnings; `npm test` **68/68 scripts OK**. No hubo cambios de código, rutas ni dependencias, así que no se repitió el build de producción (el de Fase 5 sigue siendo el último: exit 0 con 2 warnings de Turbopack). El inventario de variables se verificó con un script que recorre `app/`, `lib/`, `scripts/`, `proxy.ts` y `next.config.ts` y compara contra `.env.example`; no quedan faltantes salvo `PATH`.


### Fase 7 — Funcionalidades nuevas

**Qué se hizo:**
- **Persistencia aditiva de corridas:** tres tablas nuevas (`council_runs`, `council_run_usage`, `council_run_events`) creadas con `CREATE TABLE IF NOT EXISTS`; `SCHEMA_VERSION` no se sube porque no se altera ninguna tabla existente. `lib/council-run-store.ts` contiene el recorder (best-effort) y el CRUD/listado/comparación; `lib/council-run-trace.ts`, los tipos y las funciones puras (`buildRunTrace`, `compareCouncilRuns`, `describeEvent`, `renderRunMarkdown`).
- **7A — Tokens y costo por modelo:** `lib/model-pricing.ts` con tabla explícita de precios por millón de tokens. Los modelos `:free` cuestan USD 0; un modelo pago sin tabla devuelve `null` (la UI muestra “—”, no un falso USD 0). El usage se agrupa por modelo y fase (`draft`, `debate rN`, `vote`, `judge`, `synthesis`, `image`, `followups`) con prompt/completion/total, llamadas, latencia, fallbacks y reintentos.
- **7B — Export:** `GET /api/council/runs/[id]/export?format=markdown|json` devuelve la corrida completa con `Content-Disposition: attachment`. La vista de resultados agrega un botón de export JSON además del Markdown existente.
- **7C — Comparación:** `GET /api/council/runs/compare?a=<id>&b=<id>` devuelve ambas corridas y los deltas de tokens, duración y costo, más los modelos que solo aparecen en A o en B. La UI avisa si las preguntas no coinciden.
- **7D — Timeline y replay:** `GET /api/council/runs/[id]` devuelve la corrida, el usage y todos los eventos. La pestaña **Trazas** muestra el timeline con offset desde el inicio, permite ver el payload de cada evento y reproducir el debate (crítica, respuesta revisada, rationale del voto, convergencia).
- **7E — Trazas por corrida:** latencia desde el primer `Calling ` hasta el evento de cierre, fallbacks desde `viaFallbackFrom` y reintentos contando re-llamadas visibles. No cuenta los retries HTTP internos de los clientes de proveedor.
- **Correlación cliente/servidor:** `useCouncilRun` genera `runId`, `threadId` y `turnId`, los manda en el body del SSE y guarda `runId` en `StoredTurn` (opcional en turnos viejos). Si el body no trae `runId`, el servidor genera uno.
- **Atribución real del modelo:** los eventos `fusion_judge_complete`, `synthesis_complete` y `followups_complete` ahora incluyen `model` (incluido el modelo de fallback de síntesis). Sin eso, el usage quedaba a nombre de `fusion-judge`/`synthesis` y el costo no se podía estimar.
- **Rutas nuevas:** `app/api/council/runs/route.ts` (listado por hilo), `runs/[id]/route.ts` (detalle/delete), `runs/[id]/export/route.ts` (Markdown/JSON) y `runs/compare/route.ts`. Todas pasan por el proxy de Fase 1.

**Archivos creados:** `lib/model-pricing.ts`, `lib/council-run-trace.ts`, `lib/council-run-store.ts`, `lib/test-council-run-store.ts`, `app/components/main/run-traces.tsx`, `app/api/council/runs/route.ts`, `app/api/council/runs/[id]/route.ts`, `app/api/council/runs/[id]/export/route.ts`, `app/api/council/runs/compare/route.ts`.
**Archivos modificados:** `lib/db.ts`, `lib/council-types.ts`, `lib/council-orchestrator.ts`, `app/api/council/stream/route.ts`, `app/hooks/useCouncilRun.ts`, `app/page.tsx`, `app/lib/client-types.ts`, `app/components/main/results.tsx`, `app/globals.css`, `lib/threads.ts`, `package.json`, `README.md`, `docs/REPORTE-REFACTOR.md`.
**Commit:** `b3ba92f` — `fase 7: trazabilidad y comparación de corridas`.

**Verificación:** `npm run typecheck` exit 0; `npm run lint` exit 0 con 0 errores y 37 warnings (los mismos de Fase 6); `npm test` **69/69 scripts OK** (incluye `council:test-runs` 95/95); `npm run build` exit 0 con 2 warnings de Turbopack: el mismo trace preexistente de `apply-file-change` en sus variantes app route y output asset (en la corrida previa Turbopack había reportado 1). Smoke HTTP en `:3101`: dos POST al stream con prompt vacío persistieron dos corridas `error`, y list/detail/export Markdown/export JSON/compare/delete respondieron 200; la DB se limpió a 0 corridas y el servidor se detuvo. Una corrida completa con proveedores reales sigue **NO VERIFICADA** (keys y `ByteString ... 8212`).

---

## 1B. Misión 2 — correcciones, control remoto y MCP

Commit base de esta misión: `e4bcb2c`. Todo lo de abajo es verificable con los comandos citados.

### Fase 1.1 — Headers HTTP saneados (fix ByteString 8212)

**Qué se hizo:** el default de `X-Title` en `lib/agent/loop.ts` traía una raya larga (U+2014). Los valores de header son `ByteString` (Latin-1), así que `fetch` lanzaba `Cannot convert argument to a ByteString ... value of 8212` y mataba la llamada al proveedor. Es la causa de raíz de los fallos de `agent:test` y `agent:test-runner-real` que estaban registrados como "preexistentes".

- Se creó `lib/http-headers.ts`: `sanitizeHeaderValue` translitera a Latin-1 imprimible (rayas y comillas tipográficas a ASCII, acentos sin diacrítico, ß→ss, ø→o), descarta lo no representable y elimina CR/LF y caracteres de control.
- `openRouterHeaders()` es el ÚNICO lugar del repo que arma `HTTP-Referer`/`X-Title`. Se reemplazaron los cuatro sitios que los escribían a mano: `lib/agent/loop.ts`, `lib/openrouter.ts` (dos llamadas) y `lib/model-ping.ts`.
- El default quedó ASCII: `Consenso IA - Coding Agent`.

**Archivos creados:** `lib/http-headers.ts`, `lib/test-http-headers.ts`.
**Archivos modificados:** `lib/agent/loop.ts` (permitido explícitamente por esta fase), `lib/openrouter.ts`, `lib/model-ping.ts`, `package.json`, `scripts/run-tests.ts` (nuevo script descubierto por el runner).
**Commit:** `fase 1.1: sanear valores de header a Latin-1 (fix ByteString 8212)`.

**Verificación:** `npm run security:test-http-headers` → **46/46 casos OK**. `npm run agent:test` → **exit 0** (antes fallaba con el ByteString; es la prueba directa del fix). `npm run agent:test-runner-real` y `agent:test-model-registry` → **NO VERIFICADO**: el primero pide una ruta y un prompt por argumentos y el segundo salta cada modelo por falta de `NVIDIA_API_KEY`/`GEMINI_API_KEY` (no hay `.env` en este entorno).

### Fase 1.2 — Login del token de acceso (APP_ACCESS_TOKEN)

**Qué se hizo:** con `APP_ACCESS_TOKEN` definido, toda `/api/*` quedaba bloqueada y la UI no tenía forma de canjear el token. Se agregó lo mínimo funcional hasta que el emparejamiento por dispositivos (Fase 4) lo reemplace.

- `POST /api/auth/token` compara el token recibido con el configurado en tiempo constante y setea la cookie `magi_access_token` (`HttpOnly`, `SameSite=Strict`, `Path=/`, `Max-Age=86400`, `Secure` solo si la request vino por HTTPS o `x-forwarded-proto: https`). Sin token configurado responde 200 sin setear nada, para no delatar la configuración.
- `DELETE /api/auth/token` borra la cookie (logout local).
- El proxy exceptúa solo el path `/api/auth/token` del chequeo de token (`tokenExempt`), conservando Host, Origin y Content-Type. Se compara por path exacto, no por prefijo, para no eximir variantes.
- La UI muestra un diálogo cuando un GET real responde 403 con `reason: "token"` (la respuesta del proxy es la fuente de verdad; no se inventó un endpoint de estado). Cuando hay sesión, aparece un botón de logout local.

**Archivos creados:** `app/api/auth/token/route.ts`, `app/components/auth/token-access-gate.tsx`, `lib/test-auth-token.ts`.
**Archivos modificados:** `lib/api-security.ts` (exporta `constantTimeEqual`, `buildTokenCookie` y `APP_ACCESS_TOKEN_COOKIE`; nuevo campo `tokenExempt`), `proxy.ts`, `app/page.tsx`, `app/globals.css`, `package.json`, `scripts/run-tests.ts`.
**Commit:** pendiente.

**Verificación:** `npm run security:test-token-route` → **35/35 casos OK**. `npm run typecheck` exit 0; `npm run lint` 0 errores / 37 warnings. Smoke con dev server en `:3102` (`APP_ACCESS_TOKEN=smoke-secreto-123`), todo con curl/fetch: sin cookie `GET /api/threads` 403; login correcto 200 con `Set-Cookie: magi_access_token=…; HttpOnly; SameSite=Strict`; con cookie `GET /api/threads` 200; token inválido 403 sin `Set-Cookie`; `text/plain` en el login 403; Origin ajeno 403; JSON inválido 400; logout 200 con `Max-Age=0`.

**Deuda:** no hay rate limiting por IP (la app no tiene estado por IP y es single-user); se anota en Riesgos.

### Fase 1.3 — Host loopback en cualquier puerto

**Qué se hizo:** el default de `ALLOWED_HOSTS` ataba loopback al puerto de `PORT` (o 3000). Next arranca en 3001 cuando el 3000 está ocupado o con `-p`, y en esos casos el default rechazaba el acceso legítimo. Ahora el default es `localhost`, `127.0.0.1` y `[::1]` **sin puerto**, y `hostMatches` ya interpreta "entrada sin puerto = cualquier puerto de ese host". El Origin por default sigue calculándose con el host **real** de la request, así que `http://localhost:8080` contra un server en `:3000` se sigue rechazando: no se aflojó el origen, solo el host.

**Archivos modificados:** `lib/api-security.ts`, `lib/test-api-security.ts`.
**Commit:** `ddd9dc0` — `fase 1.3: hosts loopback en cualquier puerto sin aflojar Origin`.

**Verificación:** `npm run security:test-proxy` → **62/62 casos OK** (eran 61; se agregaron los que pide la fase y se sustituyó el caso obsoleto de `PORT`). Casos nuevos clave: `Host localhost:3001 permitido por default`, `Host [::1]:4000 permitido por default`, `Origin http://localhost:8080 con Host localhost:3000 se bloquea`, `mismo host y puerto en https también se acepta`. `npm run typecheck` exit 0; `npm run lint` 0 errores / 37 warnings.

### Fase 1.4 — Sin precios inventados

**Qué se hizo:** `lib/model-pricing.ts` tenía cuatro entradas "estimado sobre Gemini 2.5 Flash/Pro" para modelos sin precio propio publicado. Un costo inventado se muestra al usuario como si fuera real, así que se eliminaron: esos modelos ahora devuelven `costUsd: null` y la UI muestra "—". Se corrigió el comentario que afirmaba precios "consultados 2026-10-28" para toda la tabla. Quedan solo las tarifas públicas verificables de Google AI Studio (Gemini 2.5 Flash / Flash-Lite / Pro).

**Archivos modificados:** `lib/model-pricing.ts`, `lib/test-council-run-store.ts`.
**Commit:** `cb7c1b4` — `fase 1.4: quitar precios inventados, solo tarifas públicas verificables`.

**Verificación:** `npm run council:test-runs` → **107/107 casos OK** (95 previos + 12 nuevos que fijan la regla). Se agregó la comprobación de que `gemini-3.5-flash`, `gemini-3.5-flash-lite`, `gemini-3.7-flash`, `gemini-3.1-pro-preview` y `nvidia/nemotron-3.5-lightning-30b-a3b` devuelven `null` (no 0), y que una corrida que mezcla modelos con y sin precio pública un costo total `null` en vez de una suma parcial que pareciera real.

### Fase 1.5 — Aislamiento de datos de los tests

**Qué se hizo:** las suites que usan SQLite escribían en el `data/council.db` REAL del usuario y dejaban proyectos y tasks de prueba. Se agregó `MAGI_DATA_DIR` en `lib/db.ts` (override de `DATA_DIR`, default `<cwd>/data`) y `scripts/run-tests.ts` le asigna a cada script un directorio temporal propio, borrado al terminar. `lib/test-council-run-store.ts` ya se aislaba con `chdir`; ahora respeta la variable si está puesta (si no, seguiría usando el chdir) sin cambiar lo que prueba.

**Archivos modificados:** `lib/db.ts`, `scripts/run-tests.ts`, `lib/test-council-run-store.ts`.
**Commit:** `5c18896` — `fase 1.5: aislar la DB de cada test con MAGI_DATA_DIR`.

**Verificación (aceptación pedida):** hash SHA-256 de `data/council.db` **idéntico antes y después** de `npm test` completo: `f42d5d0f4b5c34e37e35fdeb14807f6ff3d53309abfa9e837e18edf448767cc5` en ambos casos. `npm test` → **71/71 OK** (sube de 69 por los dos scripts nuevos de Fase 1.1/1.2). `--no-isolate` permite debuggear contra la DB real.

### Fase 1.6 — Housekeeping

**Qué se hizo:** `salidas/` pasa a `.gitignore` (son archivos de trabajo del usuario, no documentación del producto; nada se borró). Se agregó un tope de warnings en CI (`npm run lint -- --max-warnings 37`) para que la deuda de lint no crezca en silencio. También se ignoraron `mcp.config.json` y `.env.local` por adelantado para la Fase 7+.

**Archivos modificados:** `.gitignore`, `.github/workflows/ci.yml`.
**Commit:** `f946b9c` — `fase 1.6: ignorar salidas/ y tope de warnings en CI`.

**Verificación:** `npm run lint -- --max-warnings 37` → exit 0; con `--max-warnings 10` → exit 1 con "ESLint found too many warnings". El tope queda documentado en el workflow y en la sección 5.

### Fase 1.7 — Plan de división (análisis, sin refactor)

**Qué se hizo:** se documentó en `docs/ARQUITECTURA-AGENTE.md` una propuesta concreta para partir `dispatcher.ts` (2017 líneas; `handleModelStep` 282, `createLoopContext` 179, `callModel` 129) y `ledger.ts` (1749): seis módulos para el dispatcher y cinco para el ledger, con responsabilidades, tamaños estimados y un orden de extracción seguro (primero lo puro, después lo que mueve estado, con `npm test` como red). No se tocó código.

**Archivos modificados:** `docs/ARQUITECTURA-AGENTE.md`.
**Commit:** `a44067d` — `fase 1.7: plan de división de dispatcher y ledger (sin tocar código)`.

### Corrección — rotación de credenciales de NVIDIA

**Hallazgo primero, antes de tocar nada** (verificado con un script que
corre el pool y un draft real con cliente falso): la rotación de NVIDIA
**ya funcionaba** en draft/debate/voto del consejo y en el Coding Agent —
`withCredentialFailover(providerName, …)` y `getProviderPool(providerName)`
son genéricos desde la Fase 5E/5D, y el descubrimiento de
`NVIDIA_API_KEY`/`NVIDIA_API_KEY_2…` ya existía en `resolveCredentials`. El
sondeo con dos keys y un 429 mostró: usa `nv-key-1`, luego `nv-key-2`, y el
modelo **no cambia**. No se reescribió lo que ya andaba.

**Los huecos reales que se corrigieron:**

| Dónde | Antes | Ahora |
|---|---|---|
| Síntesis | `withCredentialFailover("openrouter", …)` fijo | el pool se elige con `councilProviderForModel(SYNTHESIS_MODEL)` |
| Juez de fusión (`createFusionJudgeReportResilient`) | `"openrouter"` fijo | idem, con `FUSION_JUDGE_MODEL` |
| Follow-ups | usaba la primera key de OpenRouter de la corrida | rota por el pool del provider del modelo |
| `model-ping.ts` (salud de modelos) | `process.env.NVIDIA_API_KEY` a secas | rota por pool; 401/403 marca la credencial inválida y no insiste |
| Fallback OpenRouter → NVIDIA directo (`openrouter.ts`) | una sola key | rota por pool con la primitiva de 5A, sin importar `council-run.ts` (habría ciclo) |

Con `SYNTHESIS_MODEL`/`FUSION_JUDGE_MODEL`/`FOLLOWUP_MODEL` apuntando a
un id **nativo** de NVIDIA, antes se tomaban keys de OpenRouter: la cuota
equivocada. Ahora rota las `NVIDIA_API_KEY`.

**Sobre "el mismo modelo":** la rotación nunca cambia el modelo — es el
objetivo y está fijado por test (`EL MODELO NO CAMBIÓ al rotar`). La única
excepción, y es de diseño, es el fallback OpenRouter → NVIDIA directo: ahí
el id pasa del slug de OpenRouter al id nativo vía `NVIDIA_MODEL_MAP`
(`nvidia/nemotron-3.5-lightning:free` → `nvidia/nemotron-3.5-lightning-30b-a3b`),
porque son namespaces distintos de proveedor. No es una rotación, es un
cambio de proveedor documentado.

**Archivos modificados:** `lib/council-run.ts` (exporta
`councilProviderForModel`), `lib/council-orchestrator.ts`,
`lib/model-ping.ts`, `lib/openrouter.ts`.
**Archivos creados:** `lib/test-nvidia-rotation.ts`.
**Commits:** `5f36fe5` — `nvidia: rotar credenciales sin cambiar el modelo
(síntesis, juez, follow-ups, ping y fallback)`; `ab6a71b` — `test: verificar
la rotación del fallback OpenRouter a NVIDIA`.

**Verificación:** `npm run security:test-nvidia-rotation` → **36/36 casos OK**
(incluye el fallback real con `fetch` interceptado: 3 keys distintas, mismo
modelo, pool con 2 en cooldown y 1 disponible). `npm run typecheck` exit 0;
`npm run lint` 0 errores / 45 warnings; `npm test` **73/73 OK**;
`npm run build` exit 0.

### Corrección — catálogo automático de modelos (gratis vs. pago)

**Qué se hizo:** `lib/model-catalog.ts` descubre el listado real de los dos
proveedores y separa gratis de pago con un dato verificado, no con una
suposición.

- **OpenRouter** `GET /api/v1/models`: público, sin API key, 455 modelos el
  2026-11-04. Cada uno trae `pricing.prompt`/`pricing.completion` como
  strings en USD por token. Gratis = ambos exactamente `"0"` (18 modelos hoy).
  La key se manda solo si está configurada, para evitar rate limits; nunca se
  loguea.
- **NVIDIA** `GET /v1/models`: público, sin API key, 85 modelos. **No trae
  `pricing`** (la forma es `{id, object, created, owned_by}`). Por eso sus
  modelos quedan en `free: null` y la UI los muestra como “precio
  desconocido”: marcarlos gratis sería inventar un dato.
- Caché en memoria con TTL de 30 minutos, `?refresh=1` para forzar. Un fallo
  de red nunca lanza: devuelve el último listado conocido más el aviso.
- La key es opcional en los dos casos.

**Archivos creados:** `lib/model-catalog.ts`, `lib/test-model-catalog.ts`,
`app/api/models/catalog/route.ts`, `app/components/main/model-catalog.tsx`.
**Archivos modificados:** `app/components/main/settings-drawer.tsx`
(pestaña “Catálogo”), `app/lib/client-types.ts`, `app/globals.css`,
`package.json`.
**Commit:** `0dd3c56` — `catalogo: listado automatico de modelos con
separacion gratis/pago`.

**Verificación:** `npm run council:test-catalog` → **45/45 casos OK** con un
`fetch` falso que replica la forma real de los dos endpoints (incluye filas
sin `pricing`, filas sin id, payload inesperado, HTTP 500, caída de red, y
que la key viaje solo en el header). `npm run typecheck` exit 0;
`npm run lint` 0 errores; `npm test` **72/72 OK**; `npm run build` exit 0 con
la ruta `/api/models/catalog` y `/m` servidas.

**Prueba manual:** abrir Ajustes → pestaña **Catálogo** → “Gratis”
(18 modelos de OpenRouter con precio 0), “De pago” (precio > 0) y “Precio
desconocido” (los 85 de NVIDIA).

### Fase 3.1 — Binding LAN y fail-closed

**Qué se hizo:** los scripts `dev:lan`/`start:lan` (`next` con `-H 0.0.0.0`)
y `scripts/print-access-urls.ts` (lista las IPv4 reales y arma las URLs; sin
dependencias, usa `node:os`). En la política, un Host que **no** es loopback
entra en una rama nueva: si `REMOTE_ACCESS=off`, se rechaza siempre; si no hay
ninguna credencial (`APP_ACCESS_TOKEN` ni cookie de dispositivo), también se
rechaza con un mensaje que dice cómo habilitarla. Loopback mantiene el acceso
implícito de siempre.

**Archivos creados:** `scripts/print-access-urls.ts`.
**Archivos modificados:** `lib/api-security.ts`, `lib/test-api-security.ts`,
`proxy.ts`, `package.json`.
**Commit:** `b60c50b` (junto con el resto de la Fase 3).

**Verificación:** `npm run security:test-proxy` → **70/70 casos OK** (62 de
antes + 8 nuevos: Host LAN sin credencial rechazado, con token o cookie de
dispositivo permitido, `REMOTE_ACCESS=off` en ambas formas, loopback no
afectado). Smoke con `next start` en background (puertos 3106–3109):

| Escenario | Resultado |
|---|---|
| `GET /m` (PWA) | **200** |
| `/manifest.webmanifest`, `/sw.js`, `/icons/icon-192.png` | **200** |
| Host LAN, sin credencial, sin `REMOTE_ACCESS` | **403** “Acceso desde fuera de esta PC requiere autenticación…” |
| Host LAN, `REMOTE_ACCESS=off` | **403** “Acceso remoto deshabilitado” |
| Host LAN con token válido | **200** |
| Host LAN con token inválido | **403** |
| Login desde Host LAN | **200** + `Set-Cookie: magi_access_token=…; HttpOnly; SameSite=Strict` |
| Loopback en todos los casos | **200** |

**NO VERIFICADO:** acceso desde un teléfono Android real y desde otra
máquina de la LAN (haría falta un segundo dispositivo). La lógica fail-closed
sí quedó probada.

### Fase 3.2 — PWA móvil `/m`

**Qué se hizo:** ruta `/m` mobile-first con `manifest.webmanifest`
(`display: standalone`, íconos 192/512 y maskable generados con `sharp` desde
`app/icon.svg` vía `scripts/gen-pwa-icons.ts`), service worker
`public/sw.js` que cachea **solo** el shell estático, y pantallas: panel,
lista de tareas con filtros por estado y proyecto, detalle con eventos en
vivo, revisión de propuestas en solo lectura, creación de tarea, y corridas
del consejo reusando `lib/council-run-trace.ts`.

Lo que modifica el proyecto (aplicar/rechazar propuestas)queda **deshabilitado**
a propósito hasta la Fase 4: desde el teléfono solo se puede cancelar y ver.

**Archivos creados:** `app/manifest.ts`, `app/offline/page.tsx`,
`app/m/{layout,page,mobile.css}.tsx`, `app/m/tasks/{page.tsx,[id]/page.tsx,
new/page.tsx}`, `app/m/runs/{page.tsx,[id]/page.tsx}`,
`app/m/settings/page.tsx`, `app/hooks/useTaskEventStream.ts`,
`app/components/mobile/{mobile-nav,mobile-shared}.tsx`, `public/sw.js`,
`scripts/gen-pwa-icons.ts`, `public/icons/*.png`.
**Archivos modificados:** `app/globals.css`.
**Commit:** `b60c50b`.

**Decisión (regla 9 — el código contradice el pedido):** el enunciado pedía
“cancelar, reanudar”. **No existe reanudar**: la tabla de transiciones de
`lib/agent/task-store.ts` no da salida desde los estados terminales, y
`RUNNING → QUEUED` es exclusiva de la reconciliación de boot (así lo dice su
propio comentario). Mi primer intento llamaba a un endpoint inexistente
(`/resume` → 404). Se reemplazó por “Reintentar”, que precarga el prompt en
`/m/tasks/new` y crea una tarea nueva — que es el mecanismo real.
**Commit del fix:** `c057f87`.

**Verificación:** `npm run typecheck` exit 0; `npm run build` exit 0 con
`/m`, `/m/tasks`, `/m/tasks/new`, `/m/tasks/[id]`, `/m/runs`, `/m/runs/[id]`,
`/m/settings` y `/offline` en la tabla de rutas; smoke HTTP: `GET /m` 200,
manifest/SW/iconos 200.

**NO VERIFICADO:** instalación en un Android real (no hay dispositivo acá).

### Fase 3.3 — SSE tolerante a móviles y túneles

**Qué se hizo:** heartbeat (`: heartbeat` cada 15 s) y limpieza del timer en
`cancel`/abort en `/api/agent/tasks/[id]/events`, que ya traía reanudación por
`?sinceSeq`/`Last-Event-ID` y los headers `no-transform`/`X-Accel-Buffering: no`.
Del lado del cliente, `useTaskEventStream.ts` reconecta con backoff
exponencial (1s→30s) con jitter, desduplica por `seq` y descarta eventos
partidos.

**Archivos modificados:** `app/api/agent/tasks/[id]/events/route.ts`.
**Archivos creados:** `app/hooks/useTaskEventStream.ts`.
**Commit:** `b60c50b`.

**Verificación:** `npm run build` exit 0; el contrato HTTP se comprobó con
`curl` contra el server de producción (404 limpio para una task inexistente,
`Content-Type: text/plain` en el error). Los tests de corte y reanudación sin
perder ni duplicar eventos que pide la fase **no están escritos**: no hay
fixture con una task que emita eventos reales (la DB de smoke no tenía
proyectos) y el runner ya cubre la lógica de replay del lado del servidor en
otras suites. Queda como deuda explícita.

### Fase 3.4 — `docs/API-AGENTE.md`

Contrato de todas las rutas que consume la PWA: método, ruta, parámetros,
forma de respuesta, scope requerido y qué está protegido por diseño (apply,
descarte, config MCP). Se aclara que los scopes formales llegan con la Fase 4
y que hoy la regla efectiva es la del proxy.

**Archivos creados:** `docs/API-AGENTE.md`.
**Archivos modificados:** `README.md` (enlace).
**Commit:** `36bd272`.

### Ajustes previos a la Fase 4 (un commit por bloque)

#### A. Tope de warnings de CI: 46 → 37

**Qué se hizo:** bajar el tope de `--max-warnings` de 46 a 37 arreglando los
9 warnings que había agregado la Fase 3 y el catálogo, sin silenciar reglas
ni cambiar `eslint.config.mjs`.

| Warning | Arreglo |
|---|---|
| `model-ping.ts` tipo `Endpoint` sin uso | se elimina (lo reemplazó `ResolvedEndpoint`) |
| `test-model-catalog.ts` variable sin uso | se usa en una aserción real en vez de descartarla |
| `m/tasks/new/page.tsx` `exhaustive-deps` | se agregan `prefillProjectId`/`prefillModelId` a las dependencias |
| 5 pantallas móviles + `model-catalog.tsx` `set-state-in-effect` | el fetch al montar pasa a un IIFE async: el setState corre dentro de un callback, no en el cuerpo sincrónico del effect (la forma que la propia regla pide) |
| `useTaskEventStream.ts` `set-state-in-effect` | se elimina un `setState("connecting")` que era redundante: el estado inicial ya es `connecting` y `onerror` lo restaura |

**Commits:** `72a13c8`. **Verificación:** `npm run lint -- --max-warnings 37`
→ exit 0; el desglose queda en **8** `set-state-in-effect`, **27**
`no-unused-vars` y **2** `no-img-element` — exactamente el mínimo desde que
se habilitó el lint. `typecheck` exit 0; `npm test` 73/73; `build` exit 0.

#### B. Test de corte y reanudación del SSE

**Qué se hizo:** `lib/test-agent-sse.ts` invoca el handler `GET` de
`/api/agent/tasks/[id]/events` **directo** (construye un `Request` y lee el
`ReadableStream`), sin levantar Next. Inserta eventos a mano con
`appendEvent` sobre una task `RUNNING` real en una DB aislada. No hace falta
proveedor.

Cubre: replay completo; reanudación por `?sinceSeq=` y por el header
`Last-Event-ID`; que el header tenga prioridad sobre el query; eventos
nuevos entrando con el stream abierto, sin perder ni duplicar; heartbeat;
headers anti-buffering; abort limpio; 404 de task inexistente; cierre solo
cuando la task sale de `RUNNING`.

**Hallazgo del test:** `appendEvent` asigna `seq` desde **0**, no desde 1.
Mis primeras expectativas asumían 1-based y el test las corrigió — el
comportamiento del servidor era el correcto.

Se agregó `MAGI_SSE_HEARTBEAT_MS` (default 15s) para poder verificar el
heartbeat sin esperar 15 segundos reales. El test lo fija en 250ms cuando
no viene definido.

**Commits:** `98d428f`. **Verificación:** `npm run security:test-agent-sse`
→ **21/21 casos OK**; `npm test` → **74/74 OK** (sube de 73 por el script
nuevo); `typecheck` exit 0; `build` exit 0.

#### C. Clasificador único de 401/403

**Qué se hizo:** la misma decisión estaba duplicada en `lib/model-ping.ts` y
`lib/openrouter.ts` con dos regex escritas a mano y **ligeramente
distintas**, ambas con el mismo bug: comparaban `401`/`403` contra el texto
sin delimitar, así que `HTTP 4010` se clasificaba como auth. Se agregó
`credentialOutcomeForError()` e `isAuthFailure()` a
`lib/provider-resilience/classify.ts` (puro, sin importar nada: duck typing
sobre `{status?: number}` + texto) y se reemplazaron los dos usos.
`isAuthPingError` se mantiene como nombre, ahora delegando.

Es conservador a propósito: 401 y 403 desconocido → `invalid` (no se
reintenta); 403 de cuota conocida, 429, 5xx y timeouts → `cooldown`.

**Commits:** `7d6a3b7`. **Verificación:**
`npm run provider-resilience:test-classify` → **50/50 casos OK** (32 previos
+ 18 nuevos, incluido el `HTTP 4010` que antes clasificaba mal);
`npm test` 74/74; `typecheck` exit 0; `lint` 0 errores/37 warnings;
`build` exit 0.

### Corrección 0 — el timeline del SSE se vaciaba al reconectar

**Bug (introducido al arreglar el lint del ajuste A):** `onopen` hacía
`setState({status:"open", events: []})`, y eso corría en **cada** conexión,
incluida la reconexión automática tras `onerror`. Como la reconexión no
llevaba cursor, el servidor reenviaba el historial completo; el dedup por
`seq` (que seguía teniendo todos los ya vistos) descartaba todo. Resultado:
**timeline vacío después de cada corte de red**.

**Commit:** `1afc17b` — `fix: no vaciar el timeline del SSE al reconectar
(reducer puro + sinceSeq)`.

**Cómo se corrigió:**
1. La lógica de estado se extrajo a un reducer puro,
   `lib/task-stream-reducer.ts`, con dos reglas explícitas: el reset
   (eventos + cursor) pasa **solo** cuando cambia `taskId`; `opened` y
   `dropped` solo cambian el estado de la conexión.
2. Al reconectar se pide `?sinceSeq=<último seq visto>`, así el servidor
   reenvía únicamente lo nuevo en lugar de todo el historial.
3. La reconexión usa un contador de intentos (`attempt`) en vez de que
   `connect` se reference a sí mismo — que es lo que marcaba la regla de
   React. El backoff exponencial con jitter se mantiene.
4. **Pantallas móviles:** al arreglar el lint había quitado el
   `setLoading(true)` del inicio de `load`, y los botones de refrescar
   (`/m`, `/m/tasks`, `/m/runs`) nunca volvían a mostrar el spinner. Se
   agregó un `reload()` en cada una: es un evento de usuario, así que ahí sí
   se puede llamar setState sincrónico.

**Tests nuevos:** `lib/test-task-stream-reducer.ts` — **46/46 casos OK**.
Conexión inicial, corte + reconexión sin perder ni duplicar (el caso del
bug), reenvío del servidor descartado, cambio de `taskId` que sí limpia,
heartbeat ignorado, evento partido descartado, snapshot, recorte de payloads
enormes y deduplicación de `opened` repetido.

**Verificación:** `npm run typecheck` exit 0; `npm run lint` 0 errores /
37 warnings; `npm test` **75/75 OK**; `npm run build` exit 0.

### Fase 4a — Emparejamiento, dispositivos y auditoría

**Commit:** `5eb0c34` — `fase 4a: emparejamiento con rate limiting, cookie de
dispositivo opaca y auditoria`.

**Qué se hizo:**

- **Tablas aditivas** en `lib/db.ts`: `devices`, `pairing_codes`, `audit_log` y
  `device_totp` (esta última para el step-up de 4c, creada ya para no volver a
  tocar el schema). Todas con `CREATE TABLE IF NOT EXISTS`, **sin subir
  `SCHEMA_VERSION`**.
- **Tokens hasheados, nunca en claro:** `lib/auth/devices.ts` guarda
  `token_hash` = SHA-256 hex de un token de 256 bits aleatorio. El valor en
  claro se devuelve **una sola vez** al crear el dispositivo; después no hay
  nada de dónde recuperarlo. La cookie viaja con el token (es un secreto del
  cliente), pero lo que se compara en cada request es el hash, y revocar el
  dispositivo la deja inservible.
- **Scopes cerrados** (`observe`/`operate`/`approve`) validados contra una
  lista: un typo no puede crear un nivel inexistente. Un scope corrupto en la
  DB cae al más restrictivo.
- **Códigos de emparejamiento** (`lib/auth/pairing.ts`): un solo uso (el
  `UPDATE` es condicional sobre `used_at IS NULL`, así que dos canjes
  simultáneos dejan pasar uno), expiran en 5 minutos, y también se guardan
  hasheados. Mensajes de error genéricos: no filtra si el código existía,
  expiró o ya se usó.
- **Rate limiting estricto con bloqueo progresivo** (`lib/auth/rate-limit.ts`):
  5 intentos por minuto por IP; cada fallo posterior duplica la penalización
  con tope de 1 hora. Un éxito limpia el medidor.
- **Cookie de dispositivo** (`lib/auth/cookie.ts`): `HttpOnly`,
  `SameSite=Strict`, `Path=/`, `Max-Age` 90 días, `Secure` solo si la request
  vino por HTTPS.
- **Auditoría** (`lib/auth/audit.ts`): acciones mutantes, aprobaciones,
  emparejamientos y fallos de autenticación. `recordAudit` **nunca lanza** y
  recorta el detalle a 200 caracteres. Nunca se guardan tokens, códigos,
  prompts ni contenido de archivos.
- **`POST /api/auth/token`** (el flujo de la Fase 1.2) queda **marcado como en
  retirada**: ahora tiene rate limiting y bloqueo progresivo, y el reporte lo
  documenta como reemplazado por el emparejamiento. La diferencia de fondo:
  su cookie comparte el secreto del servidor y no es revocable
  individualmente, por eso no otorga scope.

**Archivos creados:** `lib/auth/{devices,pairing,rate-limit,cookie,
cookie-parse,audit}.ts`, `lib/test-auth-devices.ts`,
`app/api/pairing/route.ts`, `app/api/pairing/redeem/route.ts`.
**Archivos modificados:** `lib/db.ts`, `app/api/auth/token/route.ts`,
`package.json`, `scripts/run-tests.ts`.

**Verificación:** `npm run security:test-devices` → **81/81 casos OK**.
`npm run typecheck` exit 0; `npm run lint` 0 errores / 37 warnings;
`npm test` **76/76 OK**; `npm run build` exit 0.

Smoke con `next start` en `:3110` (`APP_ACCESS_TOKEN` definido, Host de LAN
permitido), todo con `curl`:

| Escenario | Resultado |
|---|---|
| Generar código sin sesión | **403** (el proxy exige token antes que nada) |
| Login con token inválido ×6 | **403**, y el 7º **429** (bloqueo progresivo) |
| Login con token válido | **200** + `Set-Cookie` |
| Canje desde Host de LAN con credencial | **200** + `Set-Cookie: magi_device_token=…; HttpOnly; SameSite=Strict` |
| Segundo canje del mismo código | **403** genérico (un solo uso) |
| Fuerza bruta de códigos (6 fallos) | **429** a partir del 6º |

### Incidente: 45 dispositivos de prueba en la DB del usuario

**Qué pasó:** mientras desarrollaba 4a corrí `npm run
security:test-devices` **a mano**, sin el runner. En ese momento la variable
`MAGI_DATA_DIR` no estaba puesta y el test hacía `chdir` a un temporal…
pero `lib/db.ts` cargaba por los **imports estáticos** de
`lib/auth/devices.ts` antes del `chdir`, y congelaba `DATA_DIR` en el momento
de la carga. Resultado: 45 dispositivos y 1 código de emparejamiento de
prueba en el `data/council.db` real.

**No es un problema de seguridad** (los tokens se descartaron, son
irrecuperables) pero ensucia la lista. **No los borré**: es la DB del usuario
y borrar filas es destructivo; cuando la pantalla de Dispositivos de 4d
exista, se limpian con “Revocar todos” o a mano.

**Fix de raíz:** `lib/db.ts` ahora resuelve el directorio **dentro de
`getDb()`** y no como constante de módulo. Verificado: el hash de
`data/council.db` es idéntico antes y después de correr el test a mano. Los
45 registros siguen ahí, inertes.



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

### Fase 2 — ANTES / DESPUÉS

| Comando | ANTES (Fase 1) | DESPUÉS (Fase 2) |
|---|---|---|
| `npm run lint` | FALLA: `next lint` no existe en Next 16; salida real: `Invalid project directory provided, no such directory: ...\lint` (exit 1). | exit 0; `eslint .` sobre 203 archivos: **0 errores, 64 warnings**. |
| `npm run typecheck` | No existía el script. `npx tsc --noEmit` daba exit 0. | exit 0, sin salida. |
| `npm test` | No existía el script. | exit 0; **63/63 scripts offline OK**. |
| `npm run test:live` | No existía. | Script creado; no ejecutado (requiere proveedores/keys). |
| `npm run build` | exit 0 (Fase 1). | exit 0; se mantienen 2 warnings de Turbopack sobre el trace de `next.config.ts` (preexistentes, no bloquean). |
| `npm run agent:test-repo-map-tool` | FALLA por ruta con espacios (preexistente). | exit 0; **50/50 casos OK** tras citar correctamente el hijo. |
| Aceptación encadenada | — | `npm run typecheck && npm run lint && npm test && npm run build` → **exit 0**. |

**Desglose real de los 64 warnings de lint:** `@typescript-eslint/no-unused-vars` 30, `@typescript-eslint/no-explicit-any` 25, `react-hooks/set-state-in-effect` 7, `@next/next/no-img-element` 2. No hay errores.

**Salida resumida real de `npm test`:**

```text
=== Tests offline — 63 script(s) ===
...
=== Resumen: 63/63 OK ===
```

**Salida real de la aceptación encadenada:**

```text
npm notice run consenso-ia@0.1.0 typecheck
npm notice run consenso-ia@0.1.0 lint
npm notice run consenso-ia@0.1.0 test
...
=== Resumen: 63/63 OK ===
npm notice run consenso-ia@0.1.0 build
✓ Compiled successfully
ACCEPTANCE_EXIT=0
```

### Fase 3 — ANTES / DESPUÉS

| Comando | ANTES (Fase 2) | DESPUÉS (Fase 3) |
|---|---|---|
| `grep -rn "as any" app lib` | 17 coincidencias | **0 coincidencias**. |
| `grep -rn "@ts-ignore\|@ts-expect-error" app lib` | 0 | 0 (no había supresiones). |
| `app/api/council/route.ts` | Existía sin referencias internas; solo el README lo listaba. | **Eliminado**; el build ya no lista `/api/council`. |
| `npm run typecheck` | exit 0 | exit 0. Primer intento con TS2307 por `.next/types/validator.ts` obsoleto; tras borrar `.next` y regenerar, 0. |
| `npm run lint` | 0 errores, 64 warnings (25 `any`) | 0 errores, **39 warnings** (0 `any`): 30 unused vars, 7 `set-state-in-effect`, 2 `<img>`. |
| `npm test` | 63/63 OK | **63/63 OK**. |
| `npm run build` | exit 0, 2 warnings Turbopack | exit 0, mismos 2 warnings preexistentes. |
| `agent:test-delete-file` | 6/6 | 6/6. |
| `agent:test-run-script` | 6/6 | 6/6. |
| `agent:test-tool-policy` | 15/15 | 15/15. |
| `agent:test-web-search-tool` | 19/19 | 19/19. |

**Salida real resumida:**

```text
npm notice run consenso-ia@0.1.0 typecheck
TSC=0
✖ 39 problems (0 errors, 39 warnings)
=== Resumen: 63/63 OK ===
npm notice run consenso-ia@0.1.0 build
EXIT=0
```

### Fase 4 — ANTES / DESPUÉS

| Comando | ANTES (Fase 3) | DESPUÉS (Fase 4) |
|---|---|---|
| `npm test` | 63/63 scripts OK | **67/67 scripts OK** (+4 scripts `council:test-*`). |
| Casos de los 4 módulos del consejo | 0 (sin cobertura directa) | **245 casos** (94 + 79 + 45 + 27). |
| `npm run council:test-consensus` | No existía | 94/94. |
| `npm run council:test-prompts` | No existía | 79/79. |
| `npm run council:test-persona-presets` | No existía | 45/45. |
| `npm run council:test-attachment-extraction` | No existía | 27/27. |
| `npm run typecheck` | exit 0 | exit 0. |
| `npm run lint` | 0 errores, 39 warnings | 0 errores, **39 warnings** (sin cambios). |
| `npm run build` | exit 0, 2 warnings Turbopack | exit 0, **1 warning**: el mismo trace de `next.config.ts` → `lib/fs-tools.ts` → `route.ts` que Turbopack reportaba duplicado en Fase 3. |
| `package-lock.json` | sin `jszip` directo | `jszip@^3.10.1` en `devDependencies` (ya venía transitivo de `mammoth`). |

**Salida real resumida:**

```text
npm notice run consenso-ia@0.1.0 typecheck
TSC=0
✖ 39 problems (0 errors, 39 warnings)
=== Resumen: 67/67 OK ===
npm notice run consenso-ia@0.1.0 build
EXIT=0
```

### Fase 5 — ANTES / DESPUÉS

| Comando | ANTES (Fase 4) | DESPUÉS (Fase 5) |
|---|---|---|
| `wc -l app/api/council/stream/route.ts` | 661 | **58**. |
| `wc -l app/page.tsx` | 1.006 | **587**. |
| `wc -l lib/council-orchestrator.ts` | No existía | **701** (pipeline completo + normalización + `CouncilRunDeps`). |
| `wc -l app/hooks/useCouncilRun.ts` | No existía | **621** (motor cliente de la corrida). |
| `npm test` | **67/67 OK** | **68/68 OK** (incluye `council:test-orchestrator`). |
| `npm run council:test-orchestrator` | No existía | **54/54**. |
| `npm run typecheck` | exit 0 | exit 0. |
| `npm run lint` | 0 errores, 39 warnings | 0 errores, **37 warnings** (27 unused, 8 set-state, 2 `<img>`). |
| `npm run build` | exit 0, 1 warning Turbopack | exit 0, **2 warnings** (mismo trace vía `apply-file-change`). |
| Smoke HTTP (`:3100`) | — | `/` 200; prompt vacío SSE de error; JSON inválido 400; `text/plain` 403. |

**Salida real resumida:**

```text
npm notice run consenso-ia@0.1.0 typecheck
TSC=0
✖ 37 problems (0 errors, 37 warnings)
54/54 casos OK.
=== Resumen: 68/68 OK ===
npm notice run consenso-ia@0.1.0 build
EXIT=0
```

### Fase 6 — ANTES / DESPUÉS

| Comando / artefacto | ANTES (Fase 5) | DESPUÉS (Fase 6) |
|---|---|---|
| `README.md` → Stack técnico | “Persistencia: `localStorage`… sin base de datos”. | SQLite + `better-sqlite3`, `data/council.db`, Node >= 22 y Coding Agent. |
| `README.md` → Coding Agent | No existía. | Sección completa: proyectos/tasks, loop legacy vs. autonomía, ledger/resume, tools, context engine, aplicación/verificación. |
| `README.md` → Scripts | No había sección de verificación local. | `typecheck`, `lint`, `test`, `test:live`, `build` y qué omite el runner. |
| `README.md` → Estructura | 13 líneas, desactualizada (sin `app/agent`, hooks, `lib/agent`, `provider-resilience`, `scripts`, `proxy.ts`). | Árbol real con esas carpetas y `data/council.db`. |
| `.env.example` | 14 variables documentadas; faltaban `OPENROUTER_API_KEY_2..N`, `OPENROUTER_CODING_MODEL`, `MAGI_AUTONOMOUS_LOOP`, `MAGI_CONTEXT_ENGINE_DISABLED` y `PORT`. | **19 variables** de producción documentadas; única omisión: `PATH` (solo test). |
| `npm run typecheck` | exit 0 | exit 0. |
| `npm run lint` | 0 errores, 37 warnings | 0 errores, 37 warnings (sin cambios). |
| `npm test` | 68/68 OK | **68/68 OK**. |
| `npm run build` | exit 0, 2 warnings Turbopack | No se repitió (solo docs/config); último build sigue siendo el de Fase 5. |

**Salida real resumida:**

```text
npm notice run consenso-ia@0.1.0 typecheck
TSC=0
✖ 37 problems (0 errors, 37 warnings)
=== Resumen: 68/68 OK ===
```

### Fase 7 — ANTES / DESPUÉS

| Comando / artefacto | ANTES (Fase 6) | DESPUÉS (Fase 7) |
|---|---|---|
| `npm test` | 68/68 OK | **69/69 OK** (incluye `council:test-runs`). |
| `npm run council:test-runs` | No existía | **95/95**. |
| `npm run typecheck` | exit 0 | exit 0. |
| `npm run lint` | 0 errores, 37 warnings | 0 errores, **37 warnings** (27 unused, 8 set-state, 2 `<img>`). |
| `npm run build` | Último válido de Fase 5 (2 warnings). | exit 0, **2 warnings** de Turbopack: el mismo trace preexistente de `apply-file-change` (app route + output asset). |
| Tablas SQLite | `threads` + tablas del Coding Agent. | + `council_runs`, `council_run_usage`, `council_run_events` (aditivas). |
| `SCHEMA_VERSION` | — | Sin cambios: no se alteró ninguna tabla existente. |
| Rutas de API | `/api/council/stream`, `/ping`, `/model-health`, `/apply-file-change`. | + `/api/council/runs`, `/runs/[id]`, `/runs/[id]/export`, `/runs/compare`. |
| Export | Solo Markdown de la vista actual. | Markdown y JSON por corrida + JSON de la vista actual. |
| UI de resultados | Pestañas Respuesta / Debate / Fuentes / Pasos. | + pestaña **Trazas** (timeline, replay, comparación, export). |
| Trazabilidad | Ninguna: el turno guardaba solo el snapshot final. | Tokens/costo/latencia/fallbacks/reintentos por modelo y fase, eventos y debate completo. |
| Smoke HTTP | — | `:3101`: 2 corridas persistidas; list/detail/export md+json/compare/delete 200; DB limpiada a 0. |

**Salida real resumida:**

```text
npm notice run consenso-ia@0.1.0 typecheck
TSC=0
✖ 37 problems (0 errors, 37 warnings)
95/95 casos OK.
=== Resumen: 69/69 OK ===
npm notice run consenso-ia@0.1.0 build
EXIT=0
```

### Fase 4b — Scopes y autorización central

**Commit:** `c31bcc2` — `fase 4b: scopes observe/operate/approve con
autorizacion central y test de cobertura`.

**Qué se hizo:**

- **Tabla central** `lib/auth/scopes.ts`: una entrada por (ruta, metodo) con
  scope, nota del porqué, y `stepUp` para las que aplican cambios. Jerarquia
  `approve > operate > observe`; un scope mayor hereda lo del menor.
- **Autorización central** `lib/auth/authorize.ts` con este orden:
  1. ruta sin clasificar -> **DENEGADA** (no existe "ruta nueva sin pensar");
  2. ruta `public` -> pasa (se autentica sola: login y canje);
  3. loopback **sin ninguna credencial configurada** -> pasa (uso local de
     siempre, sin cambios);
  4. token del operador valido -> pasa con `approve` (es su secreto);
  5. dispositivo -> pasa solo si su scope alcanza;
  6. cualquier otra cosa -> DENEGADA.
- **Precedencia de patrones**: `ruleFor` elige el patrón **mas especifico**
  (menos parametros), igual que el router de Next. Sin eso,
  `/api/council/runs/compare` quedaba tapado por `/api/council/runs/:id` —
  un bug real que encontro el test de cobertura.
- **Enforcement**: `requireScope` aplicado en las 7 rutas sensibles — crear
  task, cancelar, aplicar, descartar, `apply-file-change`, `council/stream` y
  `council/ping`. En `stream` va **antes** de abrir el SSE, para que un 403 no
  sea un 200 con error adentro.
- **Loopback con credencial configurada NO es via libre**: si se define
  `APP_ACCESS_TOKEN`, tambien se pide en localhost. Igual que desde la Fase 1.

**Archivos creados:** `lib/auth/scopes.ts`, `lib/auth/authorize.ts`,
`lib/test-route-scopes.ts`.
**Archivos modificados:** `app/api/{agent/tasks,agent/tasks/[id]/apply,
agent/tasks/[id]/cancel,agent/tasks/[id]/discard,council/stream,council/ping,
council/apply-file-change}/route.ts`, `package.json`, `scripts/run-tests.ts`.

**El test de cobertura** (`lib/test-route-scopes.ts`, **68/68**) recorre
`app/api` real, deriva ruta y metodos exportados, y falla si:
- alguna (ruta, metodo) no tiene regla;
- alguna regla apunta a una ruta inexistente;
- hay metodos huerfanos.

Ademas fija la matriz de scopes (observe no puede crear; operate no puede
aplicar; approve sin step-up no puede aplicar; revocado corta al instante;
ruta sin clasificar deniega incluso con token de operador) y la precedencia de
patrones.

**Verificacion:** `npm run security:test-route-scopes` -> **68/68**.
`typecheck` exit 0; `lint` 0 errores / 37 warnings; `npm test` **77/77**;
`build` exit 0.

Smoke con `next start` en `:3111` (`APP_ACCESS_TOKEN` definido, LAN permitida):

| Escenario | Resultado |
|---|---|
| `POST /tasks/x/apply` con token de operador | pasa el guard (llega al handler) |
| `POST /tasks/x/cancel` desde LAN **sin** token | **403** |
| `POST /tasks/x/cancel` desde LAN **con** token | **200** (es el operador) |
| `GET /api/no/existe` | 404 de Next (no hay handler) |

**Decision (Fase 4b):** las rutas con `stepUp` (`apply`, `discard`,
`apply-file-change`) hoy **no se pueden satisfacer desde un dispositivo
remoto**, porque el TOTP todavia no existe (llega en 4c). Es a proposito,
fail-closed: hasta 4c, un dispositivo `approve` necesita el step-up y sin el
queda bloqueado. Desde la PC del operador no cambia nada.

**Aislamiento de los tests nuevos:** `lib/test-auth-devices.ts` y
`lib/test-route-scopes.ts` se auto-aislan (crean su `MAGI_DATA_DIR` temporal si
nadie lo fijó), asi correrlos a mano ya no escribe en la DB del usuario. El
hash de `data/council.db` queda identico tras `npm test` completo.

### Fase 4c — Step-up TOTP para aprobar desde remoto

**Commit:** `ed25cca` — `fase 4c: step-up TOTP (RFC 6238) sin dependencias
para aprobar desde remoto`.

**Qué se hizo:**

- **TOTP puro** (`lib/auth/totp.ts`, sin dependencias): HMAC-SHA1 + truncado
  dinámico, Base32 RFC 4648 (implementado a mano, ~15 líneas) y URI
  `otpauth://` para el QR.
- **Secreto cifrado en la DB** (`lib/auth/step-up.ts`): AES-256-GCM con clave
  derivada por SHA-256 de un *pepper* que vive en el entorno
  (`MAGI_TOTP_KEY`, o en su defecto `APP_ACCESS_TOKEN`), nunca en el archivo
  .db. **Si no hay pepper, la inscripción falla cerrada** con un mensaje que
  dice cómo habilitarlo: es preferible no poder anotar el dispositivo que
  dejar el secreto legible.
- **Sesión de step-up** en memoria, TTL de 5 minutos, token de 256 bits
  guardado por hash. Un reinicio la pierde a propósito (no hay nada que
  robar de un archivo) y el usuario vuelve a confirmar.
- **El token viaja en el header `x-magi-step-up`, no en la cookie**: así no
  queda expuesto a un XSS que lea `document.cookie`.
- **Inscripción solo desde loopback** (`POST /api/auth/totp/enroll`): el
  teléfono no puede anotarse su propio segundo factor.
- **Canje** (`POST /api/auth/step-up`): requiere dispositivo autenticado +
  código + rate limiting (mismo trato que el login).
- **Integrado en la autorización central**: `authorize` valida el step-up
  cuando la regla lo pide. El operador y el uso local implícito **no** lo
  necesitan: es la PC del operador, no un control remoto.

**Archivos creados:** `lib/auth/totp.ts`, `lib/auth/step-up.ts`,
`lib/test-auth-step-up.ts`, `app/api/auth/totp/enroll/route.ts`,
`app/api/auth/step-up/route.ts`.
**Archivos modificados:** `lib/auth/authorize.ts`, `lib/auth/scopes.ts`,
`lib/test-route-scopes.ts`, `package.json`, `scripts/run-tests.ts`.

**Tests:** `security:test-step-up` → **64/64**. Incluye los **vectores del RFC
6238** (apéndice B) para validar el algoritmo contra el estándar.

**Hallazgo honesto sobre los vectores:** uno de los seis valores que había
anotado de memoria (`T=1111111111`) no coincidía con lo que produce el
algoritmo. En vez de cambiar el código, lo verifiqué con una **implementación
de referencia independiente** (escrita aparte, sin compartir código): da el
mismo resultado que mi implementación. Los otros cinco coinciden con los
valores más citados del RFC. Conclusión: mi valor recordado estaba mal, el
algoritmo es correcto. Quedó documentado en el comentario del test, y el
valor fijado es el que produce el RFC.

**Verificación de aceptación (4c):** `lib/test-route-scopes.ts` (75/75)
incluye el caso end-to-end pedido: dispositivo `approve` **sin** step-up →
`apply` devuelve 403 con `reason: "step_up_requerido"`; con un token
inventado → 403; con un TOTP **real** → permitido, y el contexto es el
dispositivo correcto. Un token de otro paso no sirve.

`npm run typecheck` exit 0; `npm run lint` 0 errores / 37 warnings;
`npm test` **78/78 OK**; `npm run build` exit 0 con
`/api/auth/step-up` y `/api/auth/totp/enroll` en la tabla de rutas.

## 1C. Misión 2 — correcciones de seguridad de la revisión

### Punto 1 — El loopback no se decide por el header Host

**Commits:** `d6cf83e` (fix), `84e09c4` (test del ataque).

**El problema, reproducido con el build de producción:** conectándose desde una
IP real no-loopback con `Host: localhost:<puerto>`, `GET /api/agent/projects`
devolvía **200**, `POST /api/pairing` generaba un código y
`POST /api/pairing/redeem` lo canjeaba como dispositivo `approve`. Todo sin
ninguna credencial.

**La causa:** `Host` es un header que manda el cliente. Toda la cadena de
decisiones de "es esta PC" (acceso implícito, generación de códigos de
emparejamiento) miraba ese header.

**El fix, en dos capas:**

1. **Peer real del kernel.** `server.ts` envuelve al server de Next con
   `node:http`, lee `req.socket.remoteAddress` (lo fija el kernel al aceptar la
   conexión TCP, no viaja en ningún header), **borra** cualquier `x-magi-peer`
   que haya mandado el cliente y escribe el valor real. `lib/peer.ts` lo lee, y
   `lib/auth/authorize.ts` y `app/api/pairing/route.ts` deciden por ese dato.
   Fallo cerrado: si el header no está, el peer es `unknown`, que **no** es
   loopback.
   - `npm run dev` y `npm start` ahora usan ese server (`scripts/dev-server.ts`);
     antes eran `next dev`/`next start` directos.
   - `POST /api/pairing` exige credencial de operador **o** peer loopback
     verificado, nunca solo el Host.
2. **Defensa en profundidad.** `-H 127.0.0.1` por defecto. `dev:lan`/`start:lan`
   son opt-in explícito, y en ese modo:
   - el acceso local implícito queda **deshabilitado** (ni loopback entra sin
     credencial);
   - el server **se niega a arrancar** sin `APP_ACCESS_TOKEN`, con un mensaje
     que explica por qué.

**Tests:** `lib/test-peer-spoof.ts` (**20/20**) levanta el server real en un
puerto libre y se conecta por una IP LAN real (`os.networkInterfaces()`; si no
hay ninguna, el test **se salta y lo dice**, no falla):

| Escenario | Resultado |
|---|---|
| Peer remoto + `Host: localhost` sin token | **403** (antes 200) |
| `POST /api/pairing` con Host falsificado | **403**, sin código |
| Falsificar `x-magi-peer: loopback` desde el cliente | **403** (el server lo pisa) |
| `POST /api/pairing/redeem` con Host falsificado | **403** |
| Remoto + token de operador | **200** |
| Loopback + token de operador | **200** |
| Modo LAN sin `APP_ACCESS_TOKEN` | el server **sale con error**, no arranca |
| Server loopback sin credencial (uso local) | **200** en projects/threads/pairing/m — no cambió nada |

**Verificación adicional por HTTP** (smoke con `next start` vía el server propio,
puertos 3123/3124/3125): los 3 ataques bloqueados con build fresco, y los caminos
legítimos (LAN+token, loopback+token, pairing con token, login correcto tras
expirar el bloqueo) en 200.

**Hallazgo durante la verificación que debe quedar registrado:** mi primera
medición del rate limiting dio un falso negativo porque el server corre con
`dev: false` y estaba sirviendo un build **viejo**. Los cambios en `proxy.ts` y
`rate-limit.ts` no estaban compilados. Después de `npm run build`, el
comportamiento medido fue el correcto. Queda como recordatorio: para medir
cambios en el proxy o en el rate limiting hay que reconstruir antes.

## 1D. Misión 2 — correcciones de seguridad #2

### Punto 1 — Guardia obligatoria en todas las rutas (default-deny)

**El problema, reproducido con el server real:** en modo LAN con `APP_ACCESS_TOKEN`,
`Cookie: magi_device_token=falsa` (sin token) devolvía **200** en
`GET /api/agent/projects`, `GET /api/agent/browse?path=/` (lista el disco),
`GET /api/agent/models`, `GET /api/threads`, `GET /api/council/runs`,
`GET /api/models/catalog` y `GET /api/provider-resilience/status`, y **201** en
`POST /api/agent/projects`.

**La causa:** el proxy no puede consultar la DB, así que deja pasar cualquier
request con una cookie `magi_device_token`. La decisión la tenía que tomar la
ruta, y solo **7 de 35** rutas lo hacían: 28 no tenían ninguna verificación.

**El fix (default-deny, en un solo lugar):**
- `lib/auth/guard.ts` con `guardRequest(request)`: lee método y path del propio
  request, busca el scope en `lib/auth/scopes.ts` (que ya estaba completo y
  verificado) y autoriza. Si la ruta no está declarada, deniega.
- La guardia es la **primera sentencia** de cada uno de los 39 handlers
  (ruta + método) de las 35 rutas. Un script la aplicó a todas; otro verificó el
  orden (en `council/stream` había quedado después del parseo del body, lo que
  devolvía 400 en vez de 403).
- Solo `/api/auth/token` (POST y DELETE), `/api/auth/step-up`, `/api/pairing` y
  `/api/pairing/redeem` son `public`, porque se autentican solas.

**Tests:** `lib/test-route-enforcement.ts` (**13/13**) recorre las 35 rutas y por
cada método exportado llama el handler:
- peer remoto sin credencial -> **401/403 en las 35 rutas**;
- cookie de dispositivo falsa -> **401/403 en las 35 rutas**;
- `observe` -> 403 en todo lo que muta; `operate` -> 403 en `apply`; `approve`
  sin step-up -> 403 en `apply`; operador con token -> pasa; loopback sin
  credencial -> pasa (uso local de siempre).

`lib/test-peer-spoof.ts` suma **9 casos** con el server real: cookie falsa + Host
mentido contra 7 GET, un POST y un DELETE.

**Trampa de medición que debe quedar registrada:** el test corría contra un build
viejo (`dev: false` sirve `.next`). Después de `npm run build` la medición fue la
correcta. `lib/test-peer-spoof.ts` ahora levanta sus servers con `MAGI_DEV=1`
justamente para probar el código fuente.

### Punto 2 — isLoopbackHost fuera de la autorización

**Usos antes (7, todos falsificables por `Host`):**

| Archivo | Uso |
|---|---|
| `app/api/devices/route.ts` | GET /api/devices |
| `app/api/devices/[id]/route.ts` | PATCH y DELETE |
| `app/api/devices/revoke-all/route.ts` | POST |
| `app/api/audit/route.ts` | GET y POST |
| `app/api/auth/totp/enroll/route.ts` | POST |

**Después:** **0 usos** en `app/`. Esas 5 rutas usan `requireLocalAccess(request)`
(creado en `lib/auth/guard.ts`), que exige **credencial de operador o peer
loopback verificado**, nunca el `Host`. `isLoopbackHost` queda definido en
`lib/auth/scopes.ts` **solo para los tests** que verifican el helper mismo; el
proxy usa su propia lógica de `Host` (defensa contra navegadores), que no
autoriza nada.

**Test:** `security:test-device-routes` (43/43) ahora manda requests desde LAN
con peer `remote` y sin credencial: las 5 rutas devuelven 403.

### Punto 3 — Acceso local implícito y túneles

**Problema:** un túnel local (`tailscale serve`, Cloudflare) termina en esta
máquina, así que **todo el tráfico remoto llega como peer loopback**. Sin
protección, un request desde internet sin credencial se trataba como local.

**Fix:** `server.ts` fuerza `MAGI_DISABLE_LOCAL_IMPLICIT=1` automáticamente
cuando `ALLOWED_HOSTS` contiene cualquier host no-loopback **o** `MAGI_LAN_MODE`
está activo. El chequeo de arranque (rechazar sin `APP_ACCESS_TOKEN`) se
mantiene solo para el modo LAN explícito: un `ALLOWED_HOSTS` remoto desactiva el
acceso implícito pero no impide arrancar.

**Test con reverse proxy local de prueba** (en `lib/test-peer-spoof.ts`, 3 casos):
un proxy TCP local reenvía al server real; el server interno tiene
`ALLOWED_HOSTS` con un host de túnel.

| Escenario | Resultado |
|---|---|
| Request vía túnel, sin credencial | **401/403** |
| `POST /api/pairing` vía túnel, sin credencial | **401/403** |
| Loopback directo, sin credencial (mismo server) | **401/403** (fail-closed) |

**Estabilidad del test:** los servers se levantan en modo dev y varios comparten
`.next/dev`, por lo que el primero responde antes de compilar las rutas (404 de
warmup). Se agregó `fetchWarm` (reintento sobre 404) y un calentamiento previo de
las rutas usadas. Verificado 3/3 corridas estables vía el runner y en la suite
completa.

### Punto 4 — Menores

- **`x-magi-peer-addr` también se borra en el handler de upgrade** (HTTP Upgrade),
  no solo en el handler normal. Antes quedaba el valor del cliente y servía para
  el rate limiting.
- **Los hosts loopback se suman a `ALLOWED_HOSTS`** en vez de reemplazarlos.
  Antes, configurar un host de túnel te dejaba sin poder abrir la app en tu
  propia PC con `localhost`. No es un agujero: el `Host` ya no autoriza nada; el
  allowlist es solo la defensa contra navegadores (CSRF, DNS rebinding).

### Punto 5 — Documentación

`README.md` (modelo de amenaza y modos de arranque) y este reporte. La matriz
completa ruta por scope está en el apéndice de abajo.

---

### Punto 2 — Rate limiting por peer real

**Commit:** `b839454`.

**El problema:** `clientIdentifier()` usaba `X-Forwarded-For`, que manda el
cliente. Rotándolo se hacían infinitos fallos sin llegar al límite (reproducido:
14 fallos sin 429). Además los clientes sin ese header compartían el bucket
`"desconocido"`, así que un atacante podía bloquear el emparejamiento legítimo
de otro.

**El fix:**
- La clave es el peer real (`x-magi-peer-addr`, que escribe `server.ts`). No lo
  puede elegir el cliente.
- `X-Forwarded-For` solo se usa si `TRUST_PROXY` está definido, y tomando el
  **último** salto (el que agregó el proxy de confianza), no el primero (que
  escribe el cliente).
- El mapa de buckets tiene tope (`MAX_BUCKETS = 5000`) con poda del más viejo.
- `api/auth/token` tiene además un **límite global** con retardo progresivo,
  independiente de la IP: si el total de fallos se dispara, se frena a todos.

**Tests:** `lib/test-rate-limit.ts` (**20/20**): rotar XFF ya no evada el límite
(se frena en el 7º intento igual), `TRUST_PROXY` toma el último salto, un
atacante no puede hacerse pasar por otro vía el primer salto, el mapa no crece
sin límite, el freno global corta aunque cambie el peer, y un cliente legítimo
no queda bloqueado por otro.

Reproducido por HTTP tras el rebuild: 10 intentos rotando XFF → **429 desde el
7º** (antes 10/10 en 403).

---

### Fase 4d — Dispositivos, Actividad y kill switch

**Commit:** `52279f4`.

**Qué se hizo:**

- **Pantalla “Dispositivos”** (pestaña nueva en Ajustes): lista con estado,
  permiso, último acceso, renombrar, cambiar scope, revocar y **“Revocar
  todos”** (con exclusión del dispositivo desde el que se opera).
- **Pantalla “Actividad”**: el `audit_log` con acción, dispositivo, objetivo,
  resultado y detalle, más el botón de poda con la retención configurada
  (90 días).
- **Emparejamiento con QR**: `POST /api/pairing` ahora devuelve además la URL
  y el QR (PNG data URL). El código viaja en el **fragmento** (`#code=…`),
  no en la query. Se usa `next/image` con `unoptimized` porque es un data URL.
- **Rutas nuevas** (todas restringidas a loopback dentro de la ruta, además
  del scope): `GET /api/devices`, `PATCH`/`DELETE /api/devices/[id]`,
  `POST /api/devices/revoke-all`, `GET`/`POST /api/audit`.
- **Cambiar el scope de un dispositivo invalida el step-up en curso**: si le
  bajás el nivel, una sesión de aprobación vieja no debe seguir sirviendo con
  el scope anterior.
- **Kill switch `REMOTE_ACCESS=off`**: ya estaba en el proxy desde la Fase 3;
  ahora queda verificado por test (corta Hosts no-loopback incluso con
  credencial, y **no** afecta a loopback) y documentado en `.env.example`.

**Bug de diseño encontrado y corregido:** el proxy exigía `APP_ACCESS_TOKEN`
incluso cuando la request traía una **cookie de dispositivo válida**, así que
un teléfono emparejado no podía autenticarse *nunca* desde la LAN: además de
su cookie, tenía que conocer el token del operador. Se corrigió: la cookie de
dispositivo es credencial suficiente para pasar el proxy, y la validación real
(¿existe? ¿está revocado? ¿tiene scope?) la hace `lib/auth/authorize.ts`, que
es quien puede tocar la DB. La separación queda: proxy = “hay credencial”,
ruta = “la credencial vale”.

**Dependencia nueva justificada:** `qrcode` (`^1.5.4`). Resuelve el QR del
emparejamiento, que pide la Fase 4.2. Es JavaScript puro (sin compilación
nativa), sin dependencias propias, y lleva años mantenida. La alternativa —
escribir un encoder QR a mano — no la elegí justamente porque no podría
verificar sin un escáner real que el código se lee, y un QR que no escanea es
peor que no tenerlo. Los tipos se declararon a mano en `types/qrcode.d.ts`
(2 funciones) en vez de sumar `@types/qrcode`.

**Archivos creados:** `app/api/devices/{route,[id]/route,revoke-all/route}.ts`,
`app/api/audit/route.ts`, `app/components/main/{devices,pairing}.tsx`,
`lib/test-device-routes.ts`, `types/qrcode.d.ts`.
**Archivos modificados:** `app/api/pairing/route.ts`,
`app/components/main/settings-drawer.tsx`, `app/lib/client-types.ts`,
`app/globals.css`, `lib/api-security.ts`, `lib/auth/{scopes,audit}.ts`,
`lib/test-api-security.ts`, `package.json`, `package-lock.json`,
`scripts/run-tests.ts`.

**Tests:** `security:test-device-routes` → **43/43** (kill switch, todas las
rutas rechazando fuera de loopback, renombrar/cambiar scope/revocar,
invalidación del step-up al cambiar scope, revoke-all con exclusión, poda de
auditoría). `security:test-proxy` → **74/74** (suma 4 casos nuevos de la
cookie de dispositivo).

**Verificación:** `typecheck` exit 0; `lint` 0 errores / 37 warnings;
`npm test` **79/79 OK**; `build` exit 0.

**Smoke end-to-end con `next start` en `:3112`** (Host de LAN permitido,
`APP_ACCESS_TOKEN` y `MAGI_TOTP_KEY` definidos):

| Escenario | Resultado |
|---|---|
| Generar pairing desde loopback | 200 + `code` + `url` con `#code=` + QR PNG (2986 chars) |
| Generar pairing desde LAN | **403** “solo se generan desde esta PC” |
| Canje desde LAN con cookie de dispositivo | 200 + cookie `magi_device_token` |
| `apply` desde LAN **solo** con cookie de dispositivo (sin token de operador) | **403** `step_up_requerido` |
| Inscribir TOTP desde LAN | **403** “solo desde esta PC” |
| `apply` desde LAN con TOTP real + header `x-magi-step-up` | pasa el guard (llega al handler) |
| `apply` con token de step-up inventado | **403** `step_up_requerido` |

Ese smoke es la verificación de la aceptación de 4c/4d junta: un dispositivo
`approve` no puede aplicar sin step-up, y con un TOTP válido sí.

---

## 3. Tests nuevos

| Fase | Archivo | Casos | Script |
|---|---|---:|---|
| 0 | — | — | — |
| 1 | `lib/test-api-security.ts` | 54 | `security:test-proxy` |
| 2 | `scripts/run-tests.ts` (runner, no casos propios) | — | `npm test` / `npm run test:live` |
| 3 | — (sin archivos nuevos; harness existentes tipados con `test-tool-call.ts`) | — | `agent:test-delete-file`, `agent:test-run-script`, `agent:test-tool-policy`, `agent:test-web-search-tool` |
| 4 | `lib/test-council-consensus.ts` | 94 | `council:test-consensus` |
| 4 | `lib/test-council-prompts.ts` | 79 | `council:test-prompts` |
| 4 | `lib/test-persona-presets.ts` | 45 | `council:test-persona-presets` |
| 4 | `lib/test-attachment-extraction.ts` | 27 | `council:test-attachment-extraction` |
| 5 | `lib/test-council-orchestrator.ts` | 54 | `council:test-orchestrator` |
| 7 | `lib/test-council-run-store.ts` | 95 | `council:test-runs` |
| seg. | `lib/test-peer-spoof.ts` | 34 | `security:test-peer-spoof` |
| seg. | `lib/test-route-enforcement.ts` | 13 | `security:test-route-enforcement` |
| seg. | `lib/test-operator-routes.ts` | 40 | `security:test-operator-routes` |
| seg. | `lib/test-operator-sessions.ts` | 33 | `security:test-operator-sessions` |
| seg. | `lib/test-remote-doctor.ts` | 65 | `security:test-remote-doctor` |
| seg. | `lib/test-sse-proxy.ts` | 26 | `security:test-sse-proxy` |
| seg. | `lib/test-request-proto.ts` | 34 | `security:test-request-proto` |
| seg. | `lib/test-web-push.ts` | 92 | `security:test-web-push` |
| seg. | `lib/test-push-endpoint.ts` | 78 | `security:test-push-endpoint` |
| seg. | `lib/test-mcp-client.ts` | 45 | `security:test-mcp-client` |
| seg. | `lib/test-mcp-loop.ts` | 39 | `security:test-mcp-loop` |
| seg. | `lib/test-mcp-failclosed.ts` | 61 | `security:test-mcp-failclosed` |
| seg. | `lib/test-mcp-server.ts` | 53 | `security:test-mcp-server` |

Fase 3 no agrega casos nuevos: reejecuta los harness existentes para demostrar que el tipado no cambió el comportamiento (46 casos entre los cuatro scripts). Fase 4 agrega 245 casos y el total de scripts del runner pasa de 63 a 67. Fase 5 agrega 54 casos con un proveedor falso y el total pasa a 68 scripts. Fase 7 agrega 95 casos (pricing, trazas puras y persistencia en una DB temporal con migración aditiva) y el total pasa a **69 scripts**.

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

### Fase 2

- **Lint con 0 errores y warnings:** no se silenció todo. `prefer-const` y el comentario JSX se corrigieron; quedan warnings en reglas que requieren decisiones de diseño: `no-explicit-any` (25, casi todos casts de `ToolSet` en harness; se auditan en Fase 3), `set-state-in-effect` (7, inicializaciones legítimas desde `localStorage`/SSE; la Fase 5 refactoriza `page.tsx` y hooks), `no-unused-vars` (30, imports/tipos de tests) y `no-img-element` (2, imágenes existentes). Se prefiere un lint verde con deuda visible a un lint que no corre.
- **`npm test` no corre los agrupadores** `agent:test-phase8`/`agent:test-phase9` porque sus sub-tests ya están en la lista; tampoco corre `agent:test-project` (harness manual que exige una ruta) ni los live. El runner imprime qué omite y por qué.
- **`agent:test-repo-map-tool` se arregló en Fase 2:** era un fallo preexistente de quoting en Windows, no un cambio de producto. Ahora el hijo usa `process.execPath` + CLI de `tsx` y no depende de `shell:true`.
- **CI en `ubuntu-latest`:** se eligió Linux para que el CI valide la compatibilidad declarada. **NO VERIFICADO**: el workflow no se ejecutó en GitHub desde este entorno; localmente solo se validó en Windows. `npm ci` tampoco se corrió localmente (se usó `npm install`); el `package-lock.json` se actualizó con `npm install --package-lock-only --ignore-scripts`.
- **`eslint --fix` borró directivas `eslint-disable` sin uso** en `ProjectPicker.tsx`, `lib/db.ts` y `test-council-resilience.ts`. Se revisó el diff: no cambia comportamiento y los tests siguen pasando.
- **Timeout del runner:** 15 minutos por script por defecto (configurable con `--timeout=segundos`). En la primera corrida `provider-resilience:test-redact` quedó colgado sin emitir salida y se canceló; al repetirlo aislado pasó 20/20 en 2s. Se documenta como evento transitorio de la máquina, no como fallo del test.
- **Install scripts en CI:** npm 12 bloquea por defecto los scripts de `better-sqlite3`, `esbuild`, `sharp` y `unrs-resolver`. Se aprobaron explícitamente en `package.json` (`allowScripts`, versiones pinneadas) para que `npm ci` en un entorno limpio pueda compilar/instalar las dependencias nativas. Sin esto, la suite que usa SQLite fallaría en CI aunque localmente ande.

### Fase 3

- **Ruta eliminada:** `app/api/council/route.ts` no tenía referencias internas; la UI y los hooks usan `/api/council/stream`, `/api/council/ping` y `/api/council/model-health`. Se eliminó en vez de mantenerla “por si acaso”. Riesgo asumido: un cliente externo que llamara `POST /api/council` recibe ahora 404.
- **Helper de tests:** `lib/agent/test-tool-call.ts` usa un contrato laxo (`TestToolResult`) en vez de importar el union completo de tools. Los harness ya verificaban el shape a mano; el helper solo evita el `any` y mantiene el test legible. No se exporta desde producción.
- **6 exports muertos eliminados:** la auditoría fue por AST + conteo de palabras, así que los 6 se confirmaron con `grep` y con typecheck/build. `isRunningSlotConflictError` tenía un comentario que decía que lo usaban `transitionTask`/`runTask`, pero ninguna llamada existía; la restricción real la sigue imponiendo el índice único de SQLite. `listLiveWorkspaces` era una query reservada para un barrido futuro que nunca se implementó. `prunePlanVersions` no se llamaba desde ningún lado; `clampInt` sigue en uso.
- **167 + 30 exports no eliminados:** “solo uso interno” no es código muerto (el archivo los usa) y los “indirectos” pueden ser re-exports, namespaces o menciones en comentarios. Eliminarlos sin análisis manual rompería contratos. Quedan como deuda explícita, no como deuda silenciosa.
- **`.next` obsoleto:** borrar una ruta deja `.next/types/validator.ts` apuntando al módulo eliminado. El fallo TS2307 es de caché de build, no del código; se resolvió borrando `.next` y regenerando con `npm run build`. En CI el checkout es limpio, así que no aplica.
- **`Promise<any>` residuales:** además de los 17 `as any`, se tiparon los retornos de harness (`readJson<T>`, `TestToolResult`, `PlanToolResult`, `RepoMapResult`). No cambia la lógica de los tests; solo el tipo.

### Fase 4

- **Tests contra el comportamiento real, no contra la intención:** tres supuestos iniciales chocaron con el código y se corrigió el test, no el módulo. `normalizeFusionJudgeReport` recorta longitudes pero **no** hace `trim()` de `finding`/`evidence`/`topic`/`positions`/`judgment`/`insight` (solo de `panelVerdict`); el test ahora lo documenta. El PDF mínimo con Helvetica no round-tripéa acentos (`Paréntesis` → `ParØntesis`), así que el caso de escapes usa ASCII y el Unicode se cubre con DOCX. `pdf-parse` agrega `-- 1 of 1 --` y no pagina texto largo de una sola página, así que el truncado a 40.000 se prueba con DOCX.
- **`jszip` como devDependency explícita:** ya venía transitivo de `mammoth`, pero depender de un transitivo para generar fixtures es frágil. Se declaró `^3.10.1` y se actualizó el lock con `npm install --package-lock-only --ignore-scripts` (sin recompilar nativos).
- **Firma de `check` por archivo:** `test-council-consensus` y `test-attachment-extraction` usan `check(label, ok, detail)`; `test-council-prompts` y `test-persona-presets` usan `check(ok, label, detail)`. No se unificó para no reescribir 245 llamadas; queda como inconsistencia cosmética conocida.
- **Sin red ni DB:** los cuatro harness son puramente locales. No cubren proveedores reales ni el orquestador SSE; eso es Fase 5. Un verde acá no prueba que el consejo funcione end-to-end.
- **Runner automático:** `scripts/run-tests.ts` descubre `council:test-*` por prefijo, así que no hubo que registrar los 4 scripts a mano en el runner. El orden es el de `package.json`.

### Fase 5

- **Extracción sin cambio de comportamiento:** `runCouncilStream` es una copia literal del cuerpo del `POST` anterior, con dos ajustes de plomería: el controller ya no se cierra dentro del orquestador (lo cierra la ruta en `finally`) y `send` se inyecta. La secuencia de eventos, los textos y los umbrales quedaron idénticos; los 54 casos fijan el contrato.
- **`CouncilRunDeps` completo, no parcial:** los tests pueden pisar cualquier función, pero el default siempre es la implementación real. Se eligió un objeto plano de funciones (no clases ni módulos mockeados) para que el test sea legible y no dependa de `vi.mock`/`jest.mock`, que el repo no usa.
- **El hook no reemplaza a `useThreads`:** `useCouncilRun` recibe `commitActiveTurn`, `syncThread` y `activeThreadIdRef` de la página. Los hilos siguen siendo responsabilidad de `useThreads`; el hook solo produce la corrida y su snapshot.
- **`runFusionPanelId` arranca en `DEFAULT_FUSION_PANEL_ID`:** el estado original de `page.tsx` arrancaba con ese valor (no `null`). Se preservó para que el panel de fusión se muestre igual antes de la primera corrida; `resetRunState` lo recalcula desde `selectedFusionPanelId`.
- **Dos firmas de `send`:** el orquestador recibe `send(event)` y la ruta lo envuelve en SSE. Los tests del orquestador asertan eventos, no el framing `data: ...\n\n`; el framing se validó en el smoke HTTP, no con un test unitario.
- **Límites ledger/loop documentados, no refactorizados:** la fase pedía documentar responsabilidades, no mover código. En esta fase `ledger.ts` y `loop.ts` quedaron intactos; el doc `docs/ARQUITECTURA-AGENTE.md` fija la regla para futuras fases.
- **Smoke test acotado:** se validó `/` 200, prompt vacío, JSON inválido y `Content-Type` incorrecto. No se ejecutó una corrida real con proveedores (siguen bloqueados por `ByteString ... 8212` y falta de keys), así que la UI de resultados no se verificó end-to-end. **NO VERIFICADO.**

### Fase 6

- **README como documento de producto, no de refactor:** se mantuvieron las secciones que explican el consejo (modo adaptativo, personas, resiliencia, adjuntos, Tribunal, panel MAGI) y se agregó lo que faltaba del estado real: SQLite, Coding Agent, Node >= 22, scripts y estructura. El detalle del refactor sigue en este reporte, no en el README.
- **`.env.example` con defaults reales:** cada variable documenta el default que usa el código (`SYNTHESIS_MODEL`, `FUSION_JUDGE_MODEL` y `FOLLOWUP_MODEL` caen a `nvidia/nemotron-3.5-lightning:free`; `OPENROUTER_SITE_URL` a `http://localhost:3000`; `OPENROUTER_APP_NAME` a `Consenso IA`). No se inventaron variables nuevas.
- **`OPENROUTER_API_KEY_2..N`:** el pool descubre cualquier sufijo numérico, no solo `_2`; se documenta como `_2` para no sugerir que hay un tope. Las keys duplicadas por valor se deduplican.
- **`GITHUB_TOKEN` sí se documentó:** el inventario inicial lo omitió porque la primera pasada solo miró `process.env.X` en `lib/` y `app/`; el script de verificación lo encontró. Se agregó a `.env.example` antes de cerrar la fase.
- **`PATH` queda fuera:** aparece en `lib/agent/test-tool-policy.ts` para simular un entorno sin scripts; no es configuración de la app y no debe ir en `.env`.
- **Sin cambios de código:** la fase es solo documentación/configuración. No se repitió el build porque no cambió ningún archivo que Next compile; el último build válido sigue siendo el de Fase 5. `typecheck`, `lint` y `npm test` sí se corrieron.

### Fase 7

- **Migración aditiva, sin subir `SCHEMA_VERSION`:** las tres tablas son nuevas y se crean con `CREATE TABLE IF NOT EXISTS`; ninguna tabla existente cambia de forma. El test abre una DB “vieja” con `threads` y una fila, importa `lib/db.ts` después del `chdir` y verifica que la fila sobrevive. Si en el futuro se agrega una columna a `council_runs`, ahí sí hará falta una migración real.
- **Persistencia best-effort:** el recorder nunca propaga un error de DB al SSE. Si `start`, un `INSERT` de evento o `finish` fallan, se marca `disabled`, se emite un único `console.warn` y la corrida sigue. Un fallo de DB no debe tumbar la respuesta del consejo.
- **Estados:** un evento `error` deja la corrida en `error`; un abort del cliente en `stopped`; `finish()` no pisa un estado que ya no sea `running`. El `run_complete` no cierra la transacción por sí solo: `finish()` es el único que escribe usage y resumen, así un error posterior al evento no deja la corrida marcada como completa.
- **Costo:** se usa una tabla explícita, no una API de precios. `:free` = USD 0; modelo pago sin tabla = `null` → “—”; Gemini se marca como estimado. No se inventan precios para modelos desconocidos ni se redondea un `null` a 0.
- **Reintentos y fallbacks:** `retries` cuenta re-llamadas visibles (cada `model_step` que empieza con `Calling `) por modelo y fase; no cuenta los retries HTTP internos de los clientes. `fallbacks` sale de `viaFallbackFrom`. Es una traza de lo que ve el usuario, no telemetría interna del proveedor.
- **Replay vs. tamaño:** se guardan completos `critique` y `revisedAnswer` (son el contenido del replay); se recorta `content` de los borradores a un preview de 280 caracteres y el `diff` de las propuestas a id/groupId/kind/path. El debate es lo que importa para reconstruir la deliberación; el borrador completo ya vive en el hilo.
- **IDs generados en el cliente:** permiten correlacionar la corrida con el hilo/turno y consultar la traza apenas termina, sin una vuelta extra. `StoredTurn.runId` es opcional para no romper turnos viejos; un turno sin `runId` simplemente no ofrece traza.
- **`model` en eventos de juez/síntesis/follow-ups:** se agregó al contrato del stream para atribuir el usage al modelo real. En síntesis, si se usa el fallback, el evento manda el modelo de fallback, no el primario. Es un campo opcional: un cliente viejo lo ignora.
- **Dos exports distintos:** el export por corrida (`/runs/[id]/export`) sale de la DB y es el que tiene eventos y usage; el botón JSON de la vista actual serializa lo que hay en memoria y funciona aunque la persistencia esté desactivada. No son el mismo contrato y se documenta así.
- **Agrupación de usage:** la clave única es `(run_id, model_id, phase)`. Si dos asientos usan el mismo modelo, o un fallback coincide con otro asiento, sus filas se fusionan; el total de tokens sigue siendo correcto, pero el desglose por asiento no. Se acepta para esta fase.
- **Sin FK a `threads`:** borrar un hilo no borra sus corridas. Es intencional: la traza sirve para auditar incluso después de borrar el hilo. El costo es que quedan filas huérfanas de `thread_id`; se pueden borrar por API.
- **Rutas protegidas por el proxy:** los GET nuevos no exigen Origin (son lecturas), pero el DELETE de una corrida sí pasa por la regla de métodos mutantes de Fase 1. No se agregó autorización por usuario porque la app sigue siendo single-user.

---

## 5. Riesgos conocidos y deuda

- La app no tiene autenticación por defecto. `APP_ACCESS_TOKEN` es una cerradura opcional, no un sistema de usuarios.
- Detrás de un reverse proxy hay que preservar el `Host` o configurar `ALLOWED_HOSTS`/`ALLOWED_ORIGINS` con el host público.
- `agent:test-project` sigue siendo un harness manual: sin argumentos imprime el uso y sale 1; no está en `npm test`. Con argumentos en un repo temporal dio PASS.
- Los proveedores reales no quedaron validados: `agent:test` y `agent:test-runner-real` fallan con `ByteString ... 8212`; `agent:test-model-registry` no tiene keys. No se declaran como OK y `test:live` no se ejecuta en CI.
- `npm run lint` queda en 0 errores y **37 warnings** (27 unused vars, 8 `set-state-in-effect`, 2 `<img>`); ya no hay `no-explicit-any`. Respecto de Fase 4 bajaron 3 unused vars y subió 1 `set-state-in-effect`; el resto es limpieza posterior.
- El workflow de CI está escrito pero **NO VERIFICADO** en GitHub; la suite local se validó solo en Windows. Si Linux falla, el primer paso es revisar los tests que asumen rutas de Windows.
- `provider-resilience:test-redact` se colgó una vez sin salida durante la suite completa y se canceló por timeout; en aislamiento pasó 20/20. No se reprodujo.
- **Ruta `POST /api/council` eliminada:** si existía un cliente externo (fuera del repo) que la usaba, ahora recibe 404. La UI interna no la usaba. Si se necesita compatibilidad, habría que restaurarla como alias de `/api/council/stream`.
- **Auditoría de exports heurística:** 167 exports “solo internos” y 30 “indirectos” siguen sin poda automática. El análisis por AST no detecta acceso dinámico por nombre (`tools[name]`) ni imports por barrel no resueltos; cualquier poda futura debe repetir la verificación con typecheck/build.
- **Typecheck tras borrar rutas:** si se elimina una ruta y se corre `tsc` sin rebuild, `.next/types` puede fallar con TS2307. No es un error de producto; se resuelve borrando `.next` o corriendo `npm run build`.
- **Cobertura nueva sin red:** los 245 casos de Fase 4 prueban funciones puras (parsing, scoring, prompts, extracción). No cubren llamadas a proveedores, streaming SSE ni persistencia. Un verde acá no reemplaza la validación live, que sigue bloqueada.
- **Fixture PDF mínimo:** el generador de PDF de test solo produce una página y fuente Helvetica/WinAnsi. No sirve para probar paginación real, PDFs escaneados ni fuentes embebidas; eso queda sin cobertura.
- **`check` con dos firmas:** la inconsistencia entre harnesses (`label` primero vs. `ok` primero) es deuda cosmética. Si alguien copia un bloque de un archivo a otro, typecheck lo detecta, pero conviene unificar en una limpieza futura.
- **Orquestador con proveedor falso:** los 54 casos de Fase 5 prueban el pipeline y la secuencia de eventos, pero no la integración real con OpenRouter/NVIDIA/Google ni el framing SSE byte a byte. El smoke HTTP cubrió cuatro escenarios; una corrida completa con modelos reales sigue **NO VERIFICADA**.
- **UI sin tests de render:** `useCouncilRun` se movió sin tests de React (el repo no tiene Testing Library ni jsdom). La paridad se apoya en typecheck, lint, build y smoke; un cambio de estado que no rompa tipos podría pasar desapercibido.
- **Doble fuente de verdad del snapshot:** `useCouncilRun` escribe `liveStateRef.current.synthesis/fusionJudge/followUps/generatedImages` además de su propio estado, porque `useThreads` lee ese ref al cerrar el turno. Es intencional para preservar el comportamiento, pero es un acoplamiento a vigilar si se parte más la página.
- **El README puede desactualizarse otra vez:** no hay un chequeo automático de que `.env.example` cubra todas las `process.env` ni de que el árbol de estructura coincida con el repo. El inventario de Fase 6 se hizo con un script ad hoc; si se agrega una variable nueva, hay que actualizar `.env.example` a mano.
- **`.env.example` no valida nada:** son placeholders (`sk-or-v1-your-key`, `nvapi-your-key`, etc.). La app no verifica formato; una key inválida falla recién en la primera llamada al proveedor.
- **Build de Fase 6 no ejecutado:** al no haber cambios de código, se aceptó el build de Fase 5 como último válido. Si se toca `README.md`/`.env.example` no hace falta, pero cualquier cambio futuro de código sí debe recompilar.
- **Fase 7 sin corrida real:** el smoke usó prompt vacío, así que persistió corridas `error` con 1 evento y 0 usage. Los 95 casos prueban pricing, trazas y el recorder contra una DB temporal, pero **no** una corrida SSE completa con tokens, latencia y debate reales. Eso sigue **NO VERIFICADO** por las keys faltantes y el `ByteString ... 8212`.
- **Crecimiento de la DB:** cada corrida guarda todos sus eventos. No hay retención automática ni límite de tamaño; solo `DELETE /api/council/runs/[id]` (sin botón en la UI). En uso intensivo `data/council.db` puede crecer más rápido que antes.
- **Precios manuales:** `lib/model-pricing.ts` es una tabla escrita a mano. Si un proveedor cambia precios o se agrega un modelo pago, el costo queda desactualizado o en “—”. No hay test contra una fuente externa.
- **Uso fusionado por modelo+fase:** dos asientos con el mismo modelo (o un fallback que coincide) comparten fila de usage. El total es correcto; el desglose por asiento no. Si se necesita por asiento, la clave tendría que incluir el seat/label.
- **Reintentos heurísticos:** dependen de que el texto del paso siga empezando con `Calling `. Un cambio de copy en `council-run.ts` haría que los reintentos se cuenten como 0 sin que ningún test lo note (el test fija el texto actual).
- **UI sin tests de render:** `run-traces.tsx` se validó con typecheck, lint, build y smoke HTTP, pero no hay Testing Library/jsdom en el repo. Un cambio de estado que no rompa tipos podría pasar desapercibido.
- **Export JSON de la vista actual:** no incluye los eventos ni el usage por fase; para eso está el export por corrida, que requiere que la persistencia haya funcionado. Si la DB falló, la pestaña Trazas muestra el error y el export por corrida no existe.
- **Borrar corridas no borra turnos:** el `DELETE` es solo de la traza. El hilo sigue mostrando el turno con su `runId`, que pasa a apuntar a una corrida inexistente; la UI lo trata como “sin traza”.
- **Tasks de prueba en la DB de desarrollo:** las suites que usan SQLite dejan filas de prueba en `data/council.db` (comportamiento preexistente, no de Fase 7). La corrida final dejó tasks con prompts como “tarea de prueba 2C”; no se borraron para no tocar datos que podrían ser del usuario. La tabla `council_runs` sí quedó en 0 después del smoke.

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

### Fase 2

1. `npm run typecheck && npm run lint` → exit 0; el lint muestra warnings pero ningún error.
2. `npm test` → debe terminar con `=== Resumen: 63/63 OK ===` y exit 0.
3. `npm run build` → exit 0; opcionalmente `npm run test:live` si hay proveedores/keys configurados.

### Fase 3

1. `grep -rn "as any" app lib` → sin resultados; `npm run typecheck && npm run lint` → exit 0 (39 warnings, 0 errores).
2. `npm test` → `=== Resumen: 63/63 OK ===`; en particular `npm run agent:test-tool-policy` → 15/15.
3. `npm run build` → exit 0 y `POST /api/council` ya no aparece en la tabla de rutas; la UI sigue funcionando con `/api/council/stream`.

### Fase 4

1. `npm run council:test-consensus && npm run council:test-prompts && npm run council:test-persona-presets && npm run council:test-attachment-extraction` → 94/94, 79/79, 45/45 y 27/27.
2. `npm test` → `=== Resumen: 67/67 OK ===` (el runner descubre los 4 scripts por prefijo).
3. `npm run build` → exit 0 con 1 warning de Turbopack; los tests no agregan rutas ni tocan la UI.

### Fase 5

1. `npm run council:test-orchestrator` → 54/54; `npm test` → `=== Resumen: 68/68 OK ===`.
2. `npm run dev` y abrir `http://localhost:3000`: la UI debe cargar igual que antes (sidebar, selector de modelos, composer).
3. En otra terminal: `curl -i -X POST http://localhost:3000/api/council/stream -H "Content-Type: application/json" --data '{"prompt":""}'` → 200 SSE con `{"type":"error","error":"Enter a prompt for the council."}`; el mismo POST con `Content-Type: text/plain` → 403; con `{"` → 400.

### Fase 6

1. `cp .env.example .env` y revisar que estén las 19 variables; `npm run typecheck && npm run lint` → exit 0 (37 warnings, 0 errores).
2. `npm test` → `=== Resumen: 68/68 OK ===`.
3. Abrir `README.md` y confirmar las secciones “Stack técnico” (SQLite, Node >= 22), “Coding Agent”, “Instalación rápida” (scripts) y “Estructura del proyecto”; contrastar el árbol con `ls app lib`.

### Fase 7

1. `npm run council:test-runs` → **95/95**; `npm test` → **69/69**. El test de DB corre en un directorio temporal y no toca `data/council.db`.
2. `npm run dev` y abrir `http://localhost:3000`. Hacer una pregunta al consejo (requiere keys): al terminar, abrir la pestaña **Trazas**, elegir la corrida y verificar stats, tabla de tokens/costo/latencia/fallbacks/reintentos, timeline y replay. Probar los botones Markdown/JSON y comparar dos corridas. Sin keys, un prompt vacío igual persiste una corrida `error` visible en la pestaña.
3. Por API: `curl "http://localhost:3000/api/council/runs"`; `curl "http://localhost:3000/api/council/runs/<id>/export?format=markdown"`; `curl "http://localhost:3000/api/council/runs/compare?a=<id>&b=<id>"`; `curl -X DELETE "http://localhost:3000/api/council/runs/<id>"`. Con `APP_ACCESS_TOKEN` definido, agregar `-H "Authorization: Bearer <token>"`.

---

## 1E. Misión 2 — correcciones de la revisión (segunda ronda)

### Punto 1 — La UI de administración andaba rota en modo LAN

**El bug, reproducido con el server real:** en modo LAN con `APP_ACCESS_TOKEN`,
la cookie del operador daba 200 en `GET /api/agent/projects` pero **403** en
`GET /api/devices`, `GET /api/audit` y `POST /api/pairing`; con `Bearer` daban
200. La causa: `requireLocalAccess()` (lib/auth/guard.ts) y la ruta de pairing
aceptaban **solo** `Authorization: Bearer`, y el navegador nunca manda Bearer:
manda la cookie.

**Fix:** `lib/auth/operator.ts` — un solo helper, `isOperatorRequest()`, que
acepta las dos vías (Bearer o cookie) con comparación en tiempo constante. Lo
reusan `authorize.ts` (Fase 4b), `guard.ts` y la ruta de pairing, así no pueden
divergir.

**Commit:** `0fac5cb`.

**Tests:** `lib/test-operator-routes.ts` (**40/40**): matriz modo LAN ×
(Bearer / cookie de operador / cookie falsa / nada) × 8 rutas de administración.
Con Bearer o cookie → autorizado; con cookie falsa o sin credencial → 403. También
verifica que un dispositivo emparejado `observe` no es operador (sigue las reglas
de scope) y que sin `APP_ACCESS_TOKEN` nadie lo es.

### Punto 2 — La cookie del operador guardaba el token en crudo

**El problema:** la cookie `magi_access_token` contenía `APP_ACCESS_TOKEN` tal
cual. Cualquiera con acceso a esa cookie tenía el token maestro para siempre.

**Fix:** sesión opaca. Al hacer login, el server genera un id aleatorio de 256
bits, guarda su SHA-256 en la tabla aditiva `operator_sessions` (con expiración e
idle timeout de 2 horas) y la cookie lleva solo ese id. Logout y "Revocar todos"
invalidan la sesión. La cookie sigue siendo `HttpOnly`, `SameSite=Strict` y
`Secure` cuando la request viene por HTTPS. `Bearer` se mantiene para scripts (el
operador ya tiene el token en su entorno).

**Hallazgo durante el fix:** si el operador deja de definir `APP_ACCESS_TOKEN`,
las sesiones existentes quedaban válidas: cualquiera con la cookie seguía teniendo
acceso sin nada que lo justificara. Se agregó la guarda: sin token configurado,
toda sesión caduca.

**Commit:** `30bc510`.

**Tests:** `lib/test-operator-sessions.ts` (**33/33**): el id tiene 64 hex, no
contiene el token maestro, la cookie no lo expone, `HttpOnly`/`SameSite`/`Secure
solo en HTTPS, valores inválidos, revocación (una y todas), cookie robada tras
logout queda inútil, Bearer sigue funcionando, poda.

Verificación end-to-end contra el server real en `:3151`:

| Escenario | Resultado |
|---|---|
| Cookie recibida tras login | 64 hex, **0 ocurrencias** del token maestro |
| Admin (devices/audit/projects/pairing) con la cookie | **200** |
| Cookie con valor basura | **403** |
| Tras logout, la misma cookie | **403** |

Además el proxy (que no puede consultar la DB) deja pasar cualquier cookie de
sesión y deja la validación a la ruta, igual que con la cookie de dispositivo.

### Punto 3 — CI: tope de warnings

**Problema:** el workflow exigía `--max-warnings 37` y había 45. Ocho venían de
imports que quedaron sin uso al reemplazar la guardia inline por `guardRequest`
(`requireScope`, `NextResponse` en `council/stream`).

**Fix:** se eliminaron los 8 imports muertos → **37 warnings**. Se agregó
`--verify` a `scripts/run-tests.ts`, que tras correr los tests ejecuta
`npm run lint -- --max-warnings=37` y reporta el exit code real, para que esto no
vuelva a pasar desapercibido.

**Commit:** `09f472d`.

**Verificación:**
```
npx tsx scripts/run-tests.ts --filter=security:test-token-route --verify
→ ✅ Lint dentro del tope (37 warnings).          exit 0
MAX_WARNINGS=10 npx tsx scripts/run-tests.ts --verify
→ ❌ El lint superó los 10 warnings permitidos.   exit 1
```

### Punto 4 — Documentación

`docs/ACCESO-REMOTO.md` con la advertencia de HTTP en LAN (expone cookies y
tokens a cualquiera en la red), Tailscale recomendado, Cloudflare Tunnel +
Access como alternativa, port-forwarding desaconsejado, notas de "PC encendida"
y checklist manual de 5 pasos para Android. Enlazado desde el README, con un
aviso corto en la sección de modos de arranque.

**Commit:** `b49d41f`.

---

## 1F. Misión 2 — Fase 5 completa (doctor, SSE tras proxy, cookie Secure)

### 5.3 — `npm run doctor:remote`

`lib/auth/remote-doctor.ts` es la decisión (función pura, sin red ni procesos) y
`scripts/doctor-remote.ts` solo imprime: lee el entorno, `.env`/`.env.local`
(solo lectura) y la DB, y arma el snapshot. Se agregó el script
`doctor:remote`.

Reglas que fija el doctor, y el nivel de cada una:

| Situación | Nivel |
|---|---|
| Hosts remotos sin `APP_ACCESS_TOKEN` ni dispositivos activos | **FAIL** |
| Server en `0.0.0.0` sin ninguna credencial | **FAIL** |
| Modo LAN sin `APP_ACCESS_TOKEN` | **FAIL** |
| `tailscale funnel` activo (expone a internet) | **FAIL** |
| Host público en `ALLOWED_HOSTS` (no tailnet ni IP privada) | WARN |
| Acceso remoto por HTTP plano | WARN |
| Acceso local implícito apagado (fail-closed) | WARN |
| Sin dispositivos, solo token de operador | WARN |
| Dispositivos con scope `operate` / `approve` | WARN |
| Sesiones de operador vivas con el server expuesto | WARN |
| `REMOTE_ACCESS=off` (corta lo remoto) / solo loopback / tailnet con credencial | PASS |

El exit code es 1 si hay algún FAIL, así que sirve para dejarlo en un script de
arranque. **Nunca imprime el valor de `APP_ACCESS_TOKEN`**: solo si está
definida.

Tests: `lib/test-remote-doctor.ts` (**65/65**). Dos hallazgos salieron de
escribirlos: `[::1]` se rompía al partir el host por `:` (quedaba un string
vacío y no se reconocía como loopback), y `REMOTE_ACCESS=off` debe anular el
FAIL por falta de credencial, porque el proxy rechaza esos hosts.

### 5.4 — SSE detrás de un proxy HTTP real

`lib/test-sse-proxy.ts` arma la cadena completa con dos servers HTTP reales:
cliente `fetch` → **proxy de prueba** (latencia de conexión + buffering: no
reenvía cada chunk al llegar, los acumula) → **server de origen** que envuelve
el handler de la ruta SSE. Es el escenario que un túnel o un proxy corporativo
puede romper.

Verificado (**26/26**, tres corridas seguidas sin diferencias):

- los eventos llegan **en orden** y **completos**: cada `data` sigue siendo
  JSON válido, así que el buffering no troza ni reordena frames;
- el **heartbeat** pasa el proxy aunque acumule bytes, y el stream sigue vivo
  después (siguen entrando eventos);
- al **cortar** la conexión y reconectar con `?sinceSeq=`, la unión de las dos
  lecturas es una secuencia continua desde 0, sin huecos ni duplicados —
  incluidos los eventos emitidos **mientras el cliente estaba desconectado**;
- lo mismo por el header `Last-Event-ID` (lo que reenvía `EventSource` solo);
- los headers anti-buffering (`no-transform`, `X-Accel-Buffering: no`)
  sobreviven el proxy;
- el stream se cierra cuando la task queda en estado terminal.

Dos lecciones al escribirlo: el id de la task es el segmento **anterior** a
`events` (tomar el último daba 404), y el acumulador de bytes tiene que
persistir entre lecturas de la **misma** conexión o parece que faltan eventos.

Además, `lib/test-peer-spoof.ts` ahora **precompila** las rutas al levantar el
server: en modo dev Next compila cada ruta la primera vez que se pide, y con la
máquina cargada ese retardo producía 404 que el test leía como fallo real
(falso negativo). Con la máquina cargada el test pasó de 300s y 11 fallos a
87s y 34/34.

### 5.5 — Cookie `Secure` con HTTPS detrás del túnel

`lib/auth/request-proto.ts` es el único lugar que lee los headers de protocolo:
`X-Forwarded-Proto` (manda el **primero** de la lista si pasó por varios
proxies), `Forwarded: proto=https` (RFC 7239) y `X-Forwarded-Ssl: on`. Lo usan
el login de operador (`POST /api/auth/token`) y el canje de emparejamiento
(`POST /api/pairing/redeem`), para las dos cookies.

Por qué se puede confiar en esos headers **acá y solo acá**: no autorizan nada,
deciden un atributo de cookie. Un atacante que falsifique
`X-Forwarded-Proto: https` sobre HTTP plano logra que el navegador descarte la
cookie y se rompa su propio login. La autorización sigue saliendo del peer
verificado del socket y de las credenciales.

Regla verificada: en HTTP plano **nunca** se marca `Secure` (el navegador
descartaría la cookie y el login fallaría sin explicación) y con HTTPS
**siempre** se marca. Tests: `lib/test-request-proto.ts` (**34/34**), que
incluye las dos rutas reales y comprueba que el valor de la cookie sigue siendo
opaco (no el token maestro, no el token de dispositivo).

`docs/ACCESO-REMOTO.md` documenta la tabla de headers detrás de
`tailscale serve` y Cloudflare Tunnel, y cuáles **no** se usan para autorizar:
`X-Forwarded-For`, `X-Real-IP`, `CF-Connecting-IP`, `X-Forwarded-Host`,
`CF-Access-JWT`, `Origin` y `Referer`.

## 1G. Misión 2 — Fase 6: notificaciones push

### Arquitectura (todo local, sin dependencias)

| Módulo | Responsabilidad |
|---|---|
| `lib/push/vapid.ts` | Par EC P-256 generado localmente, clave privada cifrada en `push_config`, JWT VAPID (ES256) |
| `lib/push/web-push.ts` | Cifrado del payload (RFC 8291 `aes128gcm`) y envío HTTP; nunca lanza |
| `lib/push/subscriptions.ts` | CRUD por endpoint (UNIQUE), preferencias de lista CERRADA, marcado de exito/fallo |
| `lib/push/emit.ts` | Lógica PURA: coalescencia, tope por minuto, saneamiento del payload, despacho con emisor inyectable |
| `lib/push/notify.ts` | Qué estados del agente notifican; único punto de entrada |
| `app/api/push/*` | `key` (GET), `subscribe` (POST), `subscriptions` (GET/PATCH), `unsubscribe` (POST), `test` (POST) |
| `app/components/mobile/push-settings.tsx` | UI en Ajustes → Notificaciones |
| `public/sw.js` | `push` y `notificationclick` (ya estaban; el tag colapsa en el SO) |

### Decisiones

- **La clave privada se guarda cifrada**, con el mismo pepper que los secretos
  TOTP (`MAGI_TOTP_KEY` o `APP_ACCESS_TOKEN`). Sin pepper la app responde "no
  configurado" (503) y no guarda nada en claro.
- **El cifrado es obligatorio**: los servicios de push rechazan texto plano, y
  es lo que evita que un proxy intermedio lea la notificación. Implementado a
  mano (HKDF-SHA256 + AES-128-GCM) para no sumar dependencias.
- **Coalescencia por (suscripcion, tag)**: una tarea es un tag, así que dos
  tareas distintas generan dos notificaciones distintas y 40 eventos de la
  misma tarea generan UNA que dice "(+39 más)".
- **Tope de 6 notificaciones por suscripción por minuto.**
- **Saneamiento por allowlist**: el payload solo lleva `title`, `body`, `tag`
  y `url`. Ni prompts, ni diffs, ni tokens, ni rutas del filesystem.
- **Se notifica desde `transitionTask`, DESPUÉS de persistir**: un servicio de
  push caído no puede deshacer una transición ya guardada. Sin suscripciones,
  `notifyStatusChange` sale sin abrir claves ni tocar la red — los tests no
  cambian de comportamiento.
- **Estados que notifican**: `APPLIED`, `NO_CHANGES` (tarea terminada),
  `FAILED`, `CANCELLED`, `INTERRUPTED` (con error), `READY_FOR_REVIEW`
  (esperando aprobación). Los demás son ruido.
- **Suscripción muerta (404/410)**: se desactiva sola para no insistir con algo
  que nunca va a llegar.
- **El payload de las rutas nunca devuelve `p256dh` ni `auth`**: alcanzaría con
  ellos para secuestrar notificaciones.

### Scopes (Fase 6)

| Ruta | Método | Scope | Por qué |
|---|---|---|---|
| `/api/push/key` | GET | observe | Clave pública; no es secreta, pero se pide credencial |
| `/api/push/subscribe` | POST | observe | Cualquiera que ya entró puede pedir notificaciones |
| `/api/push/subscriptions` | GET | observe | Lista las propias (nunca las ajenas) |
| `/api/push/subscriptions` | PATCH | observe | Preferencias o pausa de una suscripción PROPIA |
| `/api/push/unsubscribe` | POST | observe | Baja por endpoint, verificando que sea propia |
| `/api/push/test` | POST | operate | Enviar push opera sobre el sistema de notificaciones |

El barrido de `security:test-route-enforcement` pasó de 44 a **45 pares
ruta+método con guardia verificada**, todos denegando con peer remoto y sin
credencial o con cookie falsa.

### Tests

`lib/test-web-push.ts` (**77/77**, sin red y sin servicios reales):

- **JWT VAPID verificado de verdad**: se firma con la privada y se verifica con
  la pública reconstruida desde el punto sin comprimir. Una firma modificada no
  verifica. (Al escribir esto apareció un bloque muerto que lanzaba antes de
  verificar: el test lo delató.)
- **Estructura del registro RFC 8291**: salt de 16 bytes, record size 4096,
  id de la clave efímera de 65 bytes, tag de GCM al final, y el texto plano no
  aparece en el cuerpo.
- **Envío con emisor inyectable**: headers `Authorization: vapid t=…, k=…`,
  `Encryption: salt=…`, `Crypto-Key: dh=…; p256ecdsa=…`, cuerpo binario; 404 →
  `ok:false` con status; error de red no lanza; endpoint inválido se rechaza.
- **CRUD**: re-suscribirse actualiza en vez de duplicar; preferencias con lista
  cerrada; altas/bajas; marcas de éxito y fallo.
- **Emisión**: coalescencia por tag con contador, tope por minuto, saneamiento
  (recorta strings y descarta campos desconocidos), despacho con hooks.

### NO VERIFICADO

- **Push real a Android**: sin dispositivo no se pudo comprobar de punta a
  punta. Pendiente la checklist manual (`docs/ACCESO-REMOTO.md`): activar desde
  Ajustes, enviar prueba, tocar la notificación, pausar/reanudar.

## 1H. Misión 2 — Fases 7, 8 y 9 (MCP)

### Fase 7 — cliente MCP de solo lectura

`lib/mcp/config.ts` + `lib/mcp/client.ts`. Sin dependencias: JSON-RPC 2.0 por
stdio, una petición por línea.

| Regla | Dónde | Verificación |
|---|---|---|
| La config vive FUERA del repo (`%APPDATA%\consenso-ia\mcp.json`, o `MAGI_MCP_CONFIG`) | `defaultConfigPath()` | test: la ruta no contiene la raíz del repo |
| Validación todo-o-nada (versión, nombre único, comando/url, http remoto solo HTTPS, timeout acotado) | `validateConfig()` | test: 9 casos de rechazo |
| **El hijo no hereda `process.env`**: allowlist + lista de NUNCA reenviar (`APP_ACCESS_TOKEN`, `MAGI_TOTP_KEY`, `NVIDIA_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `GITHUB_TOKEN`, `TAVILY_API_KEY`) | `childEnvFor()` | test: el servidor falso responde con su propio entorno y las claves NO están |
| Allowlist de herramientas enforced en el CLIENTE, antes de hablar con el servidor | `callTool()` | test: `borrar_todo` fuera de la allowlist se rechaza |
| Salida = contenido no confiable, recortada y redactada | `parseResult()` | test: preámbulo + redacción |
| Timeout y muerte por árbol de procesos | `request()` + `killProcessTree` | test: un servidor que no contesta da timeout en ~700ms |

Dos decisiones que salieron de escribirlo: `killProcessTree` no estaba exportado
(hubo que exportarlo para poder matar procesos nieto en Windows), y la
detección de "herramienta de escritura" tiene que incluir español — un servidor
puede llamar a su herramienta `borrar_todo`, y es tan de escritura como
`delete_all`.

### Fase 8 — aprobación humana

`lib/mcp/approvals.ts`. Mismo patrón que el emparejamiento, a propósito:

- código de 128 bits en 4 grupos (`XXXX-XXXX-XXXX-XXXX`), devuelto **una sola
  vez**; en la DB queda el hash;
- **un solo uso**: al ejecutar se consume;
- **atado a los argumentos**: se compara el hash. Si el agente cambió la ruta
  que iba a borrar, la aprobación no sirve;
- vence en 5 minutos; errores genéricos (no filtra si existía);
- **reuso**: el mismo pedido dentro de 10 segundos reusa la misma solicitud, para
  que un agente que insigue no genere 10 aprobaciones;
- el hash de argumentos ordena las claves: `{a, b}` y `{b, a}` son el mismo
  pedido.

Aprobar es acto humano con segundo factor (operador, o dispositivo `approve` +
step-up); la ruta es la que lo decide, no este módulo.

### Fase 9 — la app como servidor MCP

`app/api/mcp/route.ts` + `lib/mcp/server-tools.ts`. JSON-RPC 2.0 por POST con
`guardRequest()` como primera sentencia y scope en la tabla: un cliente
emparejado es un dispositivo más.

- Métodos: `initialize`, `ping`, `tools/list`, `tools/call`.
- Herramientas, **todas de solo lectura**: `tasks.list`, `tasks.status`,
  `tasks.events`, `council.runs`, `council.run`.
- **No hay método de aprobación**: si un cliente pide `approvals/approve`,
  recibe `-32601`. Aprobar es humano, con segundo factor, desde la app.
- El catálogo se filtra por el scope del cliente.
- Los argumentos se validan contra un conjunto cerrado (límites acotados, id
  obligatorio) antes de tocar ningún store.

Tests: `lib/test-mcp-server.ts` (**53/53**).

El barrido de rutas quedó en **46 pares ruta+método con guardia verificada**.

## 1I. Misión 2 — correcciones de la revisión sobre Fases 5-9

### Punto 1 — Push: el endpoint era un SSRF

**El bug, reproducido contra las rutas reales:** `app/api/push/subscribe/route.ts`
solo exigía `https:`. Con eso daban **200** `https://127.0.0.1:1/x`,
`https://localhost:9/x`, `https://10.0.0.5/x`, `https://192.168.0.104/x`,
`https://169.254.1.2/x`, `https://[::1]/x`, `https://fcm.googleapis.com:8443/x`
y `https://user:pass@fcm.googleapis.com/x`. El server habría mandado un POST
—con el JWT VAPID en el header `Authorization`— a donde dijera la URL.

**Fix** (`lib/push/endpoint.ts`):

- allowlist de servicios de push: `fcm.googleapis.com`,
  `*.push.services.mozilla.com`, `*.notify.windows.com`, `web.push.apple.com`,
  ampliable **solo** por `PUSH_ALLOWED_HOSTS` (el cliente nunca puede);
- rechazo de IPs literales, de hosts que resuelvan a loopback/privadas/
  link-local (la resolución DNS es **inyectable**, así el test prueba
  "hostname de la allowlist que apunta a 10.x" sin tocar la red), de puertos
  distintos de 443 y de credenciales en la URL;
- **revalidación al enviar** (por si el registro es anterior a la allowlist),
  `redirect: "error"`, y errores persistidos solo como **categoría**
  (`rechazado`, `expirado`, `red`, `tiempo`) — nunca el cuerpo de la respuesta;
- las claves de la suscripción se validan con la forma que manda un navegador
  (punto P-256 sin comprimir de 65 bytes + secreto de 16). Sin eso, una clave
  corrupta hacía que OpenSSL lanzara y **tumbara el proceso** en el primer
  envío (tercer bug encontrado al verificar el fix).

**Tests:** `lib/test-push-endpoint.ts` (**78/78**) con la matriz completa de
válidos e inválidos, más 8 casos nuevos en `lib/test-web-push.ts`
(**90/90**).

**Otros dos bugs que el mismo repro destapó:**

- `GET /api/push/subscriptions` devolvía lista **vacía** para el operador: el
  SQL usaba `owner_id = ?` con `null`, y en SQL `col = NULL` nunca matchea.
  Ahora se pregunta por `IS NULL`.
- `GET /api/push/key` decía "no configurado" con `MAGI_TOTP_KEY` puesta: la ruta
  solo **leía** la clave, y nadie la había generado todavía (se generaba recién
  en el primer envío). Ahora la genera. El requisito exacto queda documentado en
  `docs/ACCESO-REMOTO.md`.

### Punto 2 — MCP conectado al producto

Antes `lib/mcp/client.ts`, `config.ts` y `approvals.ts` **solo se usaban en sus
tests**.

**7.4 — herramientas en el loop** (`lib/agent/mcp-tools.ts`):
`mcp__<servidor>__<herramienta>`, solo para servidores de la config del usuario
y solo herramientas de la allowlist. La de lectura se ejecuta; la de escritura
crea una aprobación y le dice al modelo que espere. La salida vuelve marcada
como no confiable, recortada a 20.000 caracteres, y se registra en el event log
como **metadato** (`chars`, `sha256`, `preview` de 160 caracteres redactado),
nunca como contenido. Las conexiones se cachean por servidor y se cierran al
terminar la corrida.

**Bug de diseño que encontró el primer test de punta a punta:** la decisión de
"puede escribir" era **por servidor**, no por herramienta. Con un servidor
`readOnly: false`, hasta la herramienta de lectura pedía aprobación humana.
Ahora se consulta al servidor (`tools/list`) y se cachea por
servidor+herramienta.

**8.1-8.3 — aprobación humana:** rutas `/api/mcp/approvals` (GET/POST) y
`/api/mcp/approvals/approve` (POST), con scope `approve` y **step-up** para
dispositivos remotos. Un cliente MCP externo no puede aprobar: `/api/mcp` no
expone ningún método de aprobación (`-32601`) y las rutas exigen `approve`.
UI en `/m/settings` y en la PC, con campo de TOTP cuando corresponde.
El evento `approval.required` ya existe para push.

**Tests:** `lib/test-mcp-loop.ts` (**39/39**) con un servidor MCP real por
stdio: lectura ejecuta y viene marcada, escritura espera, aprobar consume una
sola vez, argumentos distintos invalidan, vencimiento, rechazo, servidor fuera
de allowlist, y los cuatro intentos de aprobar desde `/api/mcp` o con scope
insuficiente (todos 403 / `-32601`).

El barrido de rutas quedó en **49 pares ruta+método con guardia verificada**.

### Punto 3 — documentación del estado real

`docs/MCP.md` arranca con una tabla de qué está conectado y qué no; aclara que
`GITHUB_TOKEN` y los demás secretos de la app **no** se reenvían y que un
servidor que los necesite debe usar una variable con otro nombre; y lista lo
que falta (UI de administración de servidores, transport `http` en el loop).
`docs/ROADMAP.md` y `docs/REPORTE-REFACTOR.md` dicen lo mismo, y los NO
VERIFICADOS quedaron explícitos (servidores MCP reales de terceros, push real).

## 1J. Misión 2 — correcciones de la revisión, segunda tanda

### Punto 1 — MCP: clasificación lectura/escritura fail-closed

**El bug, reproducido:** `looksWriteCapable` acertaba con ~20 palabras en
inglés. Los 29 nombres reportados (`post_message`, `deploy`, `restart_service`,
`kill_process`, `transfer_funds`, `publish`, `commit`, `merge_pull_request`,
`approve`, `pay_invoice`, `charge_card`, `grant_access`, `revoke_token`,
`shutdown`, `reboot`, `format_disk`, `drop_table`, `chmod`, `eval`,
`install_package`, `upload`, `submit`, `click`, `navigate`, `fill_form`,
`type_text`, `set_config`, `toggle`, `trigger`) se clasificaban como **lectura**
y se ejecutaban sin ninguna aprobación. El comentario del código decía "si duda,
escritura", que era exactamente lo contrario de lo que hacía.

**Fix:**

- campo nuevo por servidor, `readOnlyTools` (subconjunto de `tools`): la ÚNICA
  exención de aprobación. Config sin él = todo con aprobación.
- `readOnlyHint` del servidor ya no exime nada: el servidor es el no confiable.
  Solo se muestra en la UI como dato.
- la heurística sobrevive como **advertencia** (`McpToolRegistry.configWarnings()`):
  si el operador eximió algo cuyo nombre parece de escritura, se lo dice; no
  bloquea.
- `readOnlyTools` que no está en `tools` = error de config (rechazo total).

**Tests:** `lib/test-mcp-failclosed.ts` (**61/61**) con los ~50 nombres
reportados más los de lectura típicos: por defecto TODOS piden aprobación, y
solo los listados ejecutan directo. Incluye los casos de config inválida.

### Punto 2 — el código de aprobación ya no viaja al modelo

El resultado de la herramienta devolvía `approvalCode` y el mensaje lo repetía.
Eso dejaba el código de un solo uso en el historial de mensajes del loop, en el
event log y en el transcript: quien los leyera podía aprobar sin ser el humano.

Ahora el resultado trae solo `approvalId` y la advertencia de que hay una
decisión pendiente; el código lo ve el humano en la UI. Verificado por test
(ningún campo del resultado matchea el formato del código, y el mensaje
tampoco). De paso, el metadato `mcp` del event log solo se adjunta cuando la
tool trajo salida real: un resultado "pendiente" no tiene chars ni hash que
reportar.

**Tests:** `lib/test-mcp-loop.ts` (**43/43**).

### Punto 3 — hermetismo: la suite corre sin red

`lib/test-web-push.ts` hacía DNS real al revalidar el endpoint antes de enviar.
Ahora el resolver se inyecta en el test, y un fallo de DNS al enviar se
categoriza como **`red`** (no `rechazado`) con `status: 0`, para que **no**
desactive la suscripción: el navegador seguiría intentando suscribirse a un
endpoint válido.

**Aceptación verificada:** la suite completa (**93/93**, exit 0) corre con un
preload que rompe toda resolución DNS que no sea loopback
(`NODE_OPTIONS=--require dns-block.js`). Los otros tests que tocan
`validatePushEndpoint` usan resolución inyectada o `skipDns`.

## Apéndice — Matriz ruta por scope

Las 35 rutas (39 handlers). Todas pasan por `guardRequest`; verificado por
`lib/test-route-enforcement.ts`.

| Ruta | Metodo | Scope | Nota |
|---|---|---|---|
| `/api/agent/browse` | GET | observe | Lee el árbol del proyecto |
| `/api/agent/inspect` | GET | observe | Símbolos/estructura |
| `/api/agent/models` | GET | observe | Catálogo |
| `/api/agent/projects` | GET | observe | Lista proyectos |
| `/api/agent/projects` | POST | operate | Registra proyecto |
| `/api/agent/projects/:id` | DELETE | operate | Borra proyecto |
| `/api/agent/tasks` | GET | observe | Lista tasks |
| `/api/agent/tasks` | POST | operate | Crea task |
| `/api/agent/tasks/:id` | GET | observe | Detalle |
| `/api/agent/tasks/:id` | DELETE | operate | Borra registro |
| `/api/agent/tasks/:id/cancel` | POST | operate | Detiene corrida |
| `/api/agent/tasks/:id/apply` | POST | approve + step-up | Aplica cambios al repo |
| `/api/agent/tasks/:id/discard` | POST | approve + step-up | Descarta propuestas |
| `/api/agent/tasks/:id/events` | GET | observe | SSE |
| `/api/agent/tasks/:id/proposals` | GET | observe | Ver diffs |
| `/api/council/runs` | GET | observe | Lista corridas |
| `/api/council/runs/:id` | GET | observe | Detalle |
| `/api/council/runs/:id` | DELETE | operate | Borra traza |
| `/api/council/runs/:id/export` | GET | observe | Export md/json |
| `/api/council/runs/compare` | GET | observe | Compara corridas |
| `/api/council/stream` | POST | operate | Corrida completa (cuota) |
| `/api/council/ping` | POST | operate | Llamadas reales (cuota) |
| `/api/council/apply-file-change` | POST | approve + step-up | Aplica propuestas |
| `/api/council/model-health` | GET | observe | Salud de modelos |
| `/api/models/catalog` | GET | observe | Listado público de modelos |
| `/api/threads` | GET | observe | Historial |
| `/api/threads` | POST | operate | Guarda hilo |
| `/api/threads/:id` | GET | observe | Un hilo |
| `/api/threads/:id` | DELETE | operate | Borra hilo |
| `/api/threads/:id/favorite` | PATCH | operate | Marca favorito |
| `/api/threads/migrate` | POST | operate | Migra localStorage |
| `/api/provider-resilience/status` | GET | operate | Metadata de credenciales |
| `/api/devices` | GET | operate | Loopback + operador |
| `/api/devices/:id` | PATCH | approve + step-up | Renombrar/cambiar scope |
| `/api/devices/:id` | DELETE | approve + step-up | Revocar |
| `/api/devices/revoke-all` | POST | approve + step-up | Kill switch |
| `/api/audit` | GET | operate | Registro de actividad |
| `/api/audit` | POST | approve + step-up | Poda |
| `/api/auth/token` | POST | publica | Login del token |
| `/api/auth/token` | DELETE | publica | Logout local |
| `/api/auth/totp/enroll` | POST | approve + step-up | Loopback + operador |
| `/api/auth/step-up` | POST | publica | Canje de TOTP |
| `/api/pairing` | POST | publica | Genera código (loopback + operador) |
| `/api/pairing/redeem` | POST | publica | Canje de código |

---

## Apéndice — Evidencia

- Línea base detallada: `salidas/fase-0-linea-base.md`.
- Logs de línea base: `C:\Users\Admin\AppData\Local\Temp\opencode\fase0-logs`.
- Logs de Fase 1: `C:\Users\Admin\AppData\Local\Temp\opencode\fase1-logs-final`.
- Build de Fase 1: `C:\Users\Admin\AppData\Local\Temp\opencode\fase1-build.log`.
- Aceptación Fase 1: `C:\Users\Admin\AppData\Local\Temp\opencode\fase1-acceptance.js` (script) y su salida en la sección 2.
- Logs de Fase 2: `C:\Users\Admin\AppData\Local\Temp\opencode\fase2-acceptance.log`, `fase2-npm-test.log`, `fase2-eslint-first.log`, `fase2-next-lint-before.log`.
- Logs de Fase 3: `C:\Users\Admin\AppData\Local\Temp\opencode\fase3-npm-test.log`, `fase3-lint-final.log`, `fase3-build.log`, `fase3-exports2.txt`.
- Logs de Fase 4: `C:\Users\Admin\AppData\Local\Temp\opencode\fase4-npm-test.log`, `fase4-lint.log`, `fase4-lint2.log`, `fase4-build.log`, `fase4-lock.log`.
- Logs de Fase 5: `C:\Users\Admin\AppData\Local\Temp\opencode\fase5-npm-test.log`, `fase5-lint.log`, `fase5-build.log`, `fase5-dev.log`.
- Logs de Fase 6: `C:\Users\Admin\AppData\Local\Temp\opencode\fase6-npm-test.log`.
- Logs de Fase 7: `C:\Users\Admin\AppData\Local\Temp\opencode\fase7-npm-test-final.log` (69/69, `council:test-runs` 95/95), `fase7-build-final.log` (exit 0, 2 warnings del mismo trace preexistente), `fase7-dev.log`, `fase7-eslint.json` y `fase7-smoke.mjs` (script del smoke HTTP).
- Arquitectura del Coding Agent: `docs/ARQUITECTURA-AGENTE.md`.
