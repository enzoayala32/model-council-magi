# Arquitectura del Coding Agent — `ledger.ts` y `loop.ts`

Este documento fija los límites entre las dos piezas que más fácil se
confunden al tocar el Coding Agent: la **persistencia del estado** del
Autonomous Loop (`lib/agent/autonomy/ledger.ts`) y el **runtime del loop**
(`lib/agent/loop.ts`). No describe el producto ni la UI; solo quién hace qué,
qué invariantes se respetan y dónde NO hay que meter mano sin querer.

## Mapa de capas

```text
app/api/agent/*                rutas HTTP (tasks, browse, apply, events…)
        │
lib/agent/runner.ts            decide legacy vs. autónomo, crea/destruye el
        │                      workspace, mueve la task entre estados
        ├── lib/agent/loop.ts              runtime legacy (tool-use)
        └── lib/agent/autonomy/dispatcher.ts  orquestador autónomo
                    │
                    ├── contract.ts   estados, límites y presupuesto
                    ├── plan.ts       validación/normalización del plan
                    ├── ledger.ts     persistencia y transiciones
                    ├── verifier.ts   acceptance machine-checkable
                    └── briefing.ts   contexto phase-scoped para el modelo
        │
lib/agent/event-log.ts         `agent_events` (streaming de UI)
lib/agent/task-store.ts        `agent_tasks` (estado de la task)
lib/db.ts                      SQLite (better-sqlite3) + migraciones
```

Regla corta: **`loop.ts` ejecuta, `dispatcher.ts` decide, `ledger.ts`
persiste y valida.** Ninguna capa se saltea a la de abajo.

## `lib/agent/loop.ts` — runtime del Coding Agent (ruta legacy)

**Qué es.** El loop de tool-use "clásico": recibe una task en lenguaje
natural y un workspace, llama al modelo con `generateText` de `ai`, ejecuta
las tools (`read_file`, `propose_write_file`, `run_script`, `web_search`,
etc.), acumula un transcript y devuelve un `AgentLoopResult`.

**Qué hace:**

- Resuelve el modelo (`resolveCodingModelId`, `OPENROUTER_CODING_MODEL`) y el
  provider (`resolveProviderName`, `buildModelForId`).
- Detecta los scripts allowlisted del workspace (`detectAllowedScripts`) y
  arma el system prompt (`buildSystemPrompt`).
- Corre el ciclo de pasos con `stepCountIs(maxSteps)` y un timeout externo;
  combina el `abortSignal` del caller con el timeout interno.
- Aplica failover de credenciales **solo si el error ocurrió antes de que
  terminara el primer step** de esa llamada (regla Step-0, replicada del
  diseño de autonomía). Si el modelo ya emitió trabajo, no rota: evita
  duplicar efectos.
- Gobierna el contexto (Fase 8D): `createContextEngine` con repo-map
  tracker/service, briefing y presupuesto de tokens por paso. Si el engine
  falla al cargar o crear, la task sigue **sin** contexto automático; un
  fallo del engine nunca rompe la corrida.
- Emite eventos de tool (`AgentToolEvent`) y, si recibe `taskId`, los
  persiste en `agent_events` vía `appendEvent` (solo metadatos: nombre de
  tool, éxito, excerpt redactado).
- Al terminar, `buildProposals` lee `git status` y convierte los cambios en
  `AgentFileProposal[]` para la cola de revisión.

**Qué NO hace:**

- **No escribe el ledger.** No toca `agent_runs`, `agent_plans`,
  `agent_plan_items`, `agent_steps`, `agent_file_checkpoints`,
  `agent_verifications` ni `agent_final_reports`.
- **No decide estados de plan ni de task.** Devuelve `stopReason`
  (`completed` / `max_steps` / `timeout` / `no_progress` / `error`) y el
  `runner.ts` traduce eso a estados de task.
- **No aplica archivos.** Solo produce propuestas; aplicarlas es de
  `apply.ts`/`proposal-store.ts` y de la ruta `/apply`.
- **No conoce la autonomía.** No importa `autonomy/*`.

**Contrato de salida:** `AgentLoopResult` = `stopReason`, `steps`,
`transcript`, `proposals`, `touchedFiles`, `error?`, `contextUsage?`.
`touchedFiles` es la fuente de verdad de "la tool actuó", porque `proposals`
depende de que `git status` vea el cambio (un archivo gitignoreado puede
escribirse bien y no aparecer).

## `lib/agent/autonomy/ledger.ts` — persistencia y validación del estado

**Qué es.** La **única** capa que escribe las tablas del Autonomous Loop:

| Tabla | Qué guarda |
|---|---|
| `agent_runs` | Una corrida autónoma: estado, presupuesto, stop reason, cadena de resume. |
| `agent_plans` | Versiones del plan (inmutable por versión; una activa por task). |
| `agent_plan_items` | Ítems del plan con estado, acceptance y evidencia. |
| `agent_steps` | Pasos ejecutados: acción, tool call id, resultado, hashes. |
| `agent_file_checkpoints` | Hash antes/después por archivo y paso, para resume. |
| `agent_verifications` | Resultado del verificador de acceptance por ítem/comando. |
| `agent_final_reports` | Reporte final persistido de la corrida. |

**Qué hace:**

- **Transiciones validadas:** `transitionRun` solo acepta transiciones
  legales según `contract.ts`; `updatePlanItem` exige evidencia y que las
  acceptance machine-checkable hayan pasado por el verificador inyectado.
  Sin verificador el resultado es `verification_unavailable` — **nunca** se
  asume éxito.
- **Idempotencia:** `toolCallIdExists` evita re-ejecutar el mismo tool call
  tras un resume; `upsertFileCheckpoint` y `recordStepCheckpoint` son
  idempotentes por `(runId, stepIndex, path)`.
- **Resume:** `getResumeSourceForTask`, `requestResumeAndClose`,
  `closeRunForRestart`, `resetPlanForRestart`,
  `invalidatePlanItemsForPaths`, `getResumeChainLength` implementan la
  cadena de reanudación y la invalidación de ítems afectados por archivos
  cambiados fuera del loop.
- **Sanitización:** lo persistido son metadatos — hashes, ids, estados,
  códigos, conteos, rutas no sensibles. Nunca prompts, código, contenido de
  archivos ni stdout/stderr. Todo texto pasa por `redactSecrets`.
- **Rutas seguras:** `sensitive-paths.ts` clasifica; `resolveSafePath` es la
  única puerta contra symlinks/`..` para archivos reales.

**Qué NO hace:**

- **No orquesta.** No llama al modelo, no ejecuta tools, no decide si
  replanificar ni cuándo parar. Eso es `dispatcher.ts` (ruta autónoma) o
  `loop.ts` (ruta legacy).
- **No ejecuta comandos.** El verificador (`verifier.ts`) corre
  `typecheck`/`build`/`test`/`lint` allowlisted; el ledger solo registra el
  resultado que recibe.
- **No mueve la task.** `agent_tasks` es de `task-store.ts`; `runner.ts` es
  quien traduce el resultado del loop a estado de task.

**Contrato de entrada:** `CreateRunInput`, `SavePlanVersionInput`,
`UpdatePlanItemInput`, `RecordStepInput`, `RecordStepCheckpointInput`,
`RecordVerificationInput`, `SaveFinalReportInput`. Todos devuelven el
registro persistido o un resultado tipado (`UpdatePlanItemResult`,
`RecordStepCheckpointResult`), nunca `any`.

## `dispatcher.ts` — el pegamento que sí orquesta

Para contraste: `dispatcher.ts` es el ciclo PLANNING → EXECUTING →
VERIFYING → decisión. Usa `contract.ts` para estados/límites, `plan.ts` para
validar el plan, `ledger.ts` para persistir, `verifier.ts` para acceptance y
`briefing.ts` para el contexto por fase. Es **opt-in**: sin
`MAGI_AUTONOMOUS_LOOP=1`, `runner.ts` sigue usando `runAgentLoop` sin
cambios de comportamiento. No reemplaza a `loop.ts`.

## Reglas para futuras fases

1. Si necesitás un dato nuevo del loop, agregalo a `AgentLoopResult` y
   traducilo en `runner.ts`; no escribas el ledger desde `loop.ts`.
2. Si necesitás un estado o transición nueva, va en `contract.ts` y
   `ledger.ts`, con test en `test-contract.ts`/`test-ledger.ts`.
3. Si necesitás que el loop reaccione a un estado del plan, eso es
   `dispatcher.ts` (briefing), no `loop.ts`.
4. Cualquier escritura nueva a las 7 tablas del ledger debe pasar por una
   función del ledger, no por SQL suelto en otro módulo.
5. Los payloads nuevos siguen la regla de metadatos: nada de contenido.

---

## Propuesta de división (Fase 1.7 — solo análisis, sin tocar código)

Dos archivos quedaron grandes: `lib/agent/autonomy/dispatcher.ts` (2017
líneas) y `lib/agent/autonomy/ledger.ts` (1749). No se parte nada en esta
fase: esto es el plan, para que el próximo refactor sea mecánico y
verificable, no una cirugía a ciegas.

**Regla general del reparto:** nada cambia de comportamiento. Cada
extracción mueve código textual a un módulo nuevo y deja un re-export o
una llamada. Después de cada paso corren los mismos harness que ya
existen (`agent:test-dispatcher`, `test-contract-db`, `test-ledger`,
`test-tool-policy`, `npm test` completo). Si un paso no da verde
idéntico, se revierte.

### Módulos propuestos para `dispatcher.ts`

| Orden | Módulo nuevo | Se mueve desde | Líneas aprox. | Responsabilidad |
|---:|---|---|---:|---|
| 1 | ` autonomy/trace-hash.ts` | `isPlainObject`, `stableStringify`, `hashJson`, `safeText`, `sanitizeError`, `sanitizeToolInput`, `filesForTool`, `describeToolResult`, `extractUsage` | ~170 | Normalizar y hashear lo que se persiste: mismo resultado, sin tocar la DB. Es el bloque más puro y el más fácil de testear aislado. |
| 2 | `autonomy/workspace-state.ts` | `resolveInsideWorkspace`, `fileStateFingerprint`, `hashFileStates`, `hashWorkspaceState`, `buildFileCheckpoint`, `currentHeadCommit` | ~150 | Huella del estado de archivos y checkpoints. Lee disco/git, no persiste. |
| 3 | `autonomy/autonomy-budget.ts` | `snapshotBudget`, `checkBudget`, `abortDecision`, `summarizePlan`, `currentPlan` | ~120 | Decidir si el loop sigue. Funciones puras sobre `LoopContext`. |
| 4 | `autonomy/briefing-builder.ts` | `briefingBudget`, `buildBriefing`, `buildPlanningSystemPrompt`, `buildReplanningSystemPrompt`, `buildExecutingSystemPrompt`, `recentSteps`, `recordContextUsage` | ~200 | Armar el briefing y los system prompts por fase. |
| 5 | `autonomy/model-phase-handler.ts` | `handleModelStep` (282 líneas) + `callModel` (129) | ~420 | La parte más difícil: mueve el estado del loop. Va última y con test de dispatcher como red. |
| 6 | `autonomy/dispatcher-finalize.ts` | `finalize`, `finalizeUnexpected`, `cleanup`, `collectProposals` | ~180 | Cierre de la corrida y recolección de propuestas. |

Resultado estimado: `dispatcher.ts` baja de ~2000 a ~700 líneas y queda
como lo que su nombre dice: PLANNING → EXECUTING → VERIFYING y el armado
de `LoopContext` (`createLoopContext`, 179 líneas, se puede dividir
después en `autonomy/loop-context.ts`).

### Módulos propuestos para `ledger.ts`

| Orden | Módulo nuevo | Se mueve desde | Líneas aprox. | Responsabilidad |
|---:|---|---|---:|---|
| 1 | `autonomy/ledger-rows.ts` | tipos de fila (`RunRow`, `PlanRow`, `PlanItemRow`, `StepRow`, `VerificationRow`) y los `rowTo*` + `parse*` | ~230 | Traducción fila ↔ objeto de dominio. Cero SQL. |
| 2 | `autonomy/ledger-runs.ts` | `createRun`, `getRun`, `getActiveRunForTask`, `listRunsForTask`, `getResumeSourceForTask`, `getResumeChainLength`, `requestResumeAndClose`, `closeRunForRestart`, `cancelResumeRequest`, `transitionRun`, `updateRunProgress` | ~330 | Ciclo de vida de `AutonomyRun` y sus transiciones. |
| 3 | `autonomy/ledger-plans.ts` | `getPlanItemRows`, `getPlanById`, `getPlanVersion`, `getActivePlan`, `getPlanForRun`, `listPlanVersions`, `savePlanVersion`, `markPlanStatus`, `getPlanItemById`, `resetPlanItemToPending`, `invalidatePlanItemsForPaths`, `resetPlanForRestart` | ~330 | Versiones de plan y sus ítems. |
| 4 | `autonomy/ledger-steps.ts` | `sanitizeResults`, `sanitizeFiles`, `sanitizeActions`, `recordStep`, `getStepByIndex`, `getStepsForRun`, `toolCallIdExists`, `upsertFileCheckpoint`, `recordStepCheckpoint` | ~330 | Pasos, checkpoints y saneo de payloads. |
| 5 | `autonomy/ledger-verify.ts` | `validateEvidenceReferences`, `updatePlanItem`, `recordVerification`, `saveFinalReport`, `appendFinalReport` | ~350 | Lo que depende de las reglas de evidencia/acceptance. |

Resultado estimado: `ledger.ts` queda en ~200 líneas como fachada que
abre la DB y re-exporta (para no romper los imports existentes), y el
SQL vive en cinco módulos con una responsabilidad clara cada uno.

### Orden seguro de ejecución

1. Primero los módulos **sin SQL** (`trace-hash`, `autonomy-budget`):
   se pueden testear solos y el riesgo de romper el loop es casi nulo.
2. Después los de **estado de workspace** (`workspace-state`) y
   **briefing** (`briefing-builder`).
3. Recién ahí los que **mueven estado del loop** (`model-phase-handler`,
   `dispatcher-finalize`), con `agent:test-dispatcher` y el resto de la
   suite como red.
4. Para `ledger.ts`, el orden de la tabla: los `rowTo*` son mecánicos y
   verificables por diff; `runs` y `plans` tienen transiciones con
   invariantes (van con `test-ledger` y `test-contract` al día).
5. Cada paso: commit propio, `npm test` completo verde antes de seguir.

**Riesgo principal:** `handleModelStep` y `updatePlanItem` son los dos
lugares donde el dispatcher y el ledger están acoplados por side effects
(uno escribe pasos, el otro ítems y evidencia). Si el reparto se hace
mal, es fácil terminar con un módulo que importa del otro y volver al
acoplamiento circular. La mitigación es que estos dos pasos van últimos y
con test.
