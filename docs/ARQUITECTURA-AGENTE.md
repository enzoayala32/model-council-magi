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
