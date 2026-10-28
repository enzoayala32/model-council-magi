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
**Commit:** pendiente al momento de escribir esta sección; se completa en el commit de la fase.

**Verificación:** `npm run typecheck` exit 0 (los primeros intentos fallaron por la firma de `check` en dos archivos; se unificó a `check(ok, label, detail)` donde hacía falta). `npm run lint` exit 0 con **0 errores y 39 warnings** (los mismos de Fase 3). `npm test` **67/67 scripts OK**. `npm run build` exit 0 con **1 warning** de Turbopack (el mismo trace de `next.config.ts` → `lib/fs-tools.ts` → `route.ts`, que en Fase 3 aparecía duplicado).

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

Fase 3 no agrega casos nuevos: reejecuta los harness existentes para demostrar que el tipado no cambió el comportamiento (46 casos entre los cuatro scripts). Fase 4 agrega 245 casos y el total de scripts del runner pasa de 63 a 67.

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

---

## 5. Riesgos conocidos y deuda

- La app no tiene autenticación por defecto. `APP_ACCESS_TOKEN` es una cerradura opcional, no un sistema de usuarios.
- Detrás de un reverse proxy hay que preservar el `Host` o configurar `ALLOWED_HOSTS`/`ALLOWED_ORIGINS` con el host público.
- `agent:test-project` sigue siendo un harness manual: sin argumentos imprime el uso y sale 1; no está en `npm test`. Con argumentos en un repo temporal dio PASS.
- Los proveedores reales no quedaron validados: `agent:test` y `agent:test-runner-real` fallan con `ByteString ... 8212`; `agent:test-model-registry` no tiene keys. No se declaran como OK y `test:live` no se ejecuta en CI.
- `npm run lint` queda en 0 errores y 39 warnings (30 unused vars, 7 `set-state-in-effect`, 2 `<img>`); ya no hay `no-explicit-any`. La deuda restante se ataca en la Fase 5 (hooks/`page.tsx`) y en limpieza posterior.
- El workflow de CI está escrito pero **NO VERIFICADO** en GitHub; la suite local se validó solo en Windows. Si Linux falla, el primer paso es revisar los tests que asumen rutas de Windows.
- `provider-resilience:test-redact` se colgó una vez sin salida durante la suite completa y se canceló por timeout; en aislamiento pasó 20/20. No se reprodujo.
- **Ruta `POST /api/council` eliminada:** si existía un cliente externo (fuera del repo) que la usaba, ahora recibe 404. La UI interna no la usaba. Si se necesita compatibilidad, habría que restaurarla como alias de `/api/council/stream`.
- **Auditoría de exports heurística:** 167 exports “solo internos” y 30 “indirectos” siguen sin poda automática. El análisis por AST no detecta acceso dinámico por nombre (`tools[name]`) ni imports por barrel no resueltos; cualquier poda futura debe repetir la verificación con typecheck/build.
- **Typecheck tras borrar rutas:** si se elimina una ruta y se corre `tsc` sin rebuild, `.next/types` puede fallar con TS2307. No es un error de producto; se resuelve borrando `.next` o corriendo `npm run build`.
- **Cobertura nueva sin red:** los 245 casos de Fase 4 prueban funciones puras (parsing, scoring, prompts, extracción). No cubren llamadas a proveedores, streaming SSE ni persistencia. Un verde acá no reemplaza la validación live, que sigue bloqueada.
- **Fixture PDF mínimo:** el generador de PDF de test solo produce una página y fuente Helvetica/WinAnsi. No sirve para probar paginación real, PDFs escaneados ni fuentes embebidas; eso queda sin cobertura.
- **`check` con dos firmas:** la inconsistencia entre harnesses (`label` primero vs. `ok` primero) es deuda cosmética. Si alguien copia un bloque de un archivo a otro, typecheck lo detecta, pero conviene unificar en una limpieza futura.

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

### Fases 5–7

Pendiente de implementación.

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
