/**
 * Prueba de aceptación de la Fase 5D (Coding Agent Integration — ver
 * diseño de Fase 5, rondas de 5D + revisión final). Integra `runAgentLoop`
 * con la infraestructura REAL de `lib/provider-resilience/` (pool,
 * classify, cooldown) — solo se mockea `generateText` (vía
 * `generateTextImpl`, el mismo punto de inyección que ya usa `loopRunner`
 * en `runner.ts`) para controlar 401/429/503/timeout/success sin red real.
 *
 * No se mockea `CredentialPool`/`OperationCursor`/`classifyProviderError`/
 * `computeCooldownMs` — son los reales de 5A/5B, importados sin cambios.
 *
 * Uso: npm run agent:test-provider-resilience
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runAgentLoop, __resetProviderPoolsForTests, __getProviderPoolForTests, type RunAgentLoopOptions } from "./loop";
import { createProject } from "./project-store";
import { createTask } from "./task-store";
import { listEvents, type AgentEventPayload } from "./event-log";

let results: boolean[] = [];

function check(label: string, ok: boolean, detail?: unknown): void {
  results.push(ok);
  console.log(`${ok ? "✅" : "❌"} ${label}${ok ? "" : ` — ${JSON.stringify(detail)}`}`);
}

type FakeGenerateText = NonNullable<RunAgentLoopOptions["generateTextImpl"]>;

/** Setea las credentials de OPENROUTER_API_KEY(+_2,+_3,...) a mano para un
 * caso de test, limpiando cualquier resto de un caso anterior. Usa el
 * nombre REAL de la env var (loop.ts lo tiene fijo en
 * `ENV_PREFIX_BY_PROVIDER`) — por eso cada caso llama
 * `__resetProviderPoolsForTests()` ANTES de esto, para que el pool
 * singleton se reconstruya recién la próxima vez que `runAgentLoop` lo
 * pida, ya con los valores de ESTE caso. */
function setOpenRouterCredentials(...values: string[]): void {
  const prefix = "OPENROUTER_API_KEY";
  delete process.env[prefix];
  for (const key of Object.keys(process.env)) {
    if (key.startsWith(`${prefix}_`)) delete process.env[key];
  }
  values.forEach((value, index) => {
    if (index === 0) process.env[prefix] = value;
    else process.env[`${prefix}_${index + 1}`] = value;
  });
}

function httpError(status: number, message?: string, retryAfterHeader?: string): Error {
  const err = new Error(message ?? `HTTP ${status}`) as Error & {
    statusCode: number;
    responseBody?: string;
    responseHeaders?: Record<string, string>;
  };
  err.statusCode = status;
  err.responseBody = message;
  if (retryAfterHeader) err.responseHeaders = { "retry-after": retryAfterHeader };
  return err;
}

async function tempWorkspace(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "test-provider-resilience-"));
}

/** Fase 5F: `agent_events.task_id` tiene una FK real contra `agent_tasks`
 * (`better-sqlite3` trae `foreign_keys = ON` por default) — no alcanza con
 * un `taskId` inventado, hace falta una fila real de `agent_projects` +
 * `agent_tasks`. No hace falta git real acá (a diferencia de
 * `test-git-trace.ts`): `runAgentLoop` nunca toca `project.localPath`, solo
 * `workspaceRoot`, así que un directorio cualquiera alcanza para que
 * `createProject` lo acepte. */
async function makeRealTask(workspaceRoot: string): Promise<string> {
  const project = await createProject({ name: `test-5f-${Math.random().toString(36).slice(2, 8)}`, localPath: workspaceRoot });
  const task = createTask({ projectId: project.id, modelId: "test/modelo-no-registrado", prompt: "tarea de prueba, sin agente real" });
  return task.id;
}

function baseOptions(workspaceRoot: string, generateTextImpl: FakeGenerateText): RunAgentLoopOptions {
  return {
    task: "tarea de prueba, sin agente real",
    workspaceRoot,
    repoRoot: workspaceRoot,
    modelId: "test/modelo-no-registrado", // getCouncilModel() devuelve undefined → resuelve a "openrouter" por default
    timeoutMs: 5_000,
    generateTextImpl,
  };
}

async function main(): Promise<void> {
  console.log("== Fase 5D — prueba de aceptación (Coding Agent + Provider Resilience) ==\n");

  // --- Caso 1: una sola credential disponible → ejecución normal ---
  {
    console.log("--- Caso 1: una sola credential → ejecución normal ---");
    __resetProviderPoolsForTests();
    setOpenRouterCredentials("secret-caso1-unica");
    const ws = await tempWorkspace();
    let calls = 0;
    const fake: FakeGenerateText = async (opts) => {
      calls++;
      opts.onStepFinish?.({ text: "listo", content: [] } as never);
      return {};
    };
    const result = await runAgentLoop(baseOptions(ws, fake));
    check("stopReason completed", result.stopReason === "completed", result);
    check("generateText se llamó exactamente 1 vez", calls === 1, calls);
    const snap = __getProviderPoolForTests("openrouter").snapshot();
    check("la única credential queda AVAILABLE con consecutiveFailures=0", snap[0]?.status === "AVAILABLE" && snap[0]?.consecutiveFailures === 0, snap);
  }

  // --- Caso 2: múltiples credentials → failover (A falla en step 0, B funciona) ---
  {
    console.log("\n--- Caso 2: credential failover — A falla con 429 en step 0, B responde bien ---");
    __resetProviderPoolsForTests();
    setOpenRouterCredentials("secret-caso2-A", "secret-caso2-B");
    const ws = await tempWorkspace();
    let calls = 0;
    const fake: FakeGenerateText = async () => {
      calls++;
      if (calls === 1) throw httpError(429, "rate limited");
      return {};
    };
    const result = await runAgentLoop(baseOptions(ws, fake));
    check("stopReason completed tras el failover", result.stopReason === "completed", result);
    check("generateText se llamó exactamente 2 veces (A falló, B funcionó)", calls === 2, calls);
    const snap = __getProviderPoolForTests("openrouter").snapshot();
    check("A quedó en COOLDOWN", snap.find((s) => s.consecutiveFailures > 0)?.status === "COOLDOWN", snap);
    check("B quedó AVAILABLE", snap.some((s) => s.status === "AVAILABLE" && s.consecutiveFailures === 0), snap);
  }

  // --- Caso 3: no reutilización de credential dentro del mismo cursor (agotamiento) ---
  {
    console.log("\n--- Caso 3: A y B fallan las dos en step 0 → nunca vuelve a probar A, termina en error ---");
    __resetProviderPoolsForTests();
    setOpenRouterCredentials("secret-caso3-A", "secret-caso3-B");
    const ws = await tempWorkspace();
    let calls = 0;
    const fake: FakeGenerateText = async () => {
      calls++;
      throw httpError(429, "rate limited otra vez");
    };
    const result = await runAgentLoop(baseOptions(ws, fake));
    check("stopReason error tras agotar las 2 credentials", result.stopReason === "error", result);
    check("generateText se llamó EXACTAMENTE 2 veces — nunca una 3ra (repetiría A)", calls === 2, calls);
    check("el mensaje final distingue el estado real (COOLDOWN), no el genérico anterior de INVALID", (result.error ?? "").includes("están todas en cooldown ahora mismo"), result.error);
  }

  // --- Caso 4a: 401 → INVALID ---
  {
    console.log("\n--- Caso 4a: 401 clasifica a INVALID, failover a la siguiente ---");
    __resetProviderPoolsForTests();
    setOpenRouterCredentials("secret-caso4a-A", "secret-caso4a-B");
    const ws = await tempWorkspace();
    let calls = 0;
    const fake: FakeGenerateText = async () => {
      calls++;
      if (calls === 1) throw httpError(401, "Invalid API key provided");
      return {};
    };
    const result = await runAgentLoop(baseOptions(ws, fake));
    check("completed tras el failover", result.stopReason === "completed", result);
    const snap = __getProviderPoolForTests("openrouter").snapshot();
    check("la credential que falló quedó INVALID", snap.some((s) => s.status === "INVALID"), snap);
  }

  // --- Caso 4b: 429 → COOLDOWN (ya cubierto en detalle por el Caso 2, acá solo confirma el status exacto) ---
  {
    console.log("\n--- Caso 4b: 429 clasifica a COOLDOWN ---");
    __resetProviderPoolsForTests();
    setOpenRouterCredentials("secret-caso4b-A", "secret-caso4b-B");
    const ws = await tempWorkspace();
    let calls = 0;
    const fake: FakeGenerateText = async () => {
      calls++;
      if (calls === 1) throw httpError(429, "rate limited");
      return {};
    };
    await runAgentLoop(baseOptions(ws, fake));
    const snap = __getProviderPoolForTests("openrouter").snapshot();
    check("la credential que falló quedó exactamente en COOLDOWN (no INVALID)", snap.some((s) => s.status === "COOLDOWN"), snap);
  }

  // --- Caso 4c: 403 con evidencia de cuota → COOLDOWN ---
  {
    console.log("\n--- Caso 4c: 403 con mensaje de cuota clasifica a COOLDOWN (no INVALID) ---");
    __resetProviderPoolsForTests();
    setOpenRouterCredentials("secret-caso4c-A", "secret-caso4c-B");
    const ws = await tempWorkspace();
    let calls = 0;
    const fake: FakeGenerateText = async () => {
      calls++;
      if (calls === 1) throw httpError(403, "You have exceeded your current quota, please check your plan");
      return {};
    };
    const result = await runAgentLoop(baseOptions(ws, fake));
    check("completed tras el failover", result.stopReason === "completed", result);
    const snap = __getProviderPoolForTests("openrouter").snapshot();
    check("403 de cuota → COOLDOWN, no INVALID", snap.some((s) => s.status === "COOLDOWN"), snap);
  }

  // --- Caso 5: 500/502/503 → NO afectan la salud de la credential ---
  {
    console.log("\n--- Caso 5: 503 → la credential que falló sigue AVAILABLE, sin cooldown ni consecutiveFailures ---");
    __resetProviderPoolsForTests();
    setOpenRouterCredentials("secret-caso5-A", "secret-caso5-B");
    const ws = await tempWorkspace();
    let calls = 0;
    const fake: FakeGenerateText = async () => {
      calls++;
      if (calls === 1) throw httpError(503, "provider overloaded");
      return {};
    };
    const result = await runAgentLoop(baseOptions(ws, fake));
    check("completed tras el failover", result.stopReason === "completed", result);
    check("generateText se llamó 2 veces (A falló con 503, B funcionó)", calls === 2, calls);
    const snap = __getProviderPoolForTests("openrouter").snapshot();
    check(
      "TODAS las credentials quedan AVAILABLE con consecutiveFailures=0 y cooldownUntil=null — el 503 no tocó la salud de ninguna",
      snap.every((s) => s.status === "AVAILABLE" && s.consecutiveFailures === 0 && s.cooldownUntil === null),
      snap,
    );
  }

  // --- Caso 6: timeout/network — clasificación best-effort ---
  {
    console.log("\n--- Caso 6a: 'Request timed out' (sin statusCode) → heurística timeout, failover permitido ---");
    __resetProviderPoolsForTests();
    setOpenRouterCredentials("secret-caso6a-A", "secret-caso6a-B");
    const ws = await tempWorkspace();
    let calls = 0;
    const fake: FakeGenerateText = async () => {
      calls++;
      if (calls === 1) throw new Error("Request timed out");
      return {};
    };
    const result = await runAgentLoop(baseOptions(ws, fake));
    check("completed tras el failover por timeout heurístico", result.stopReason === "completed" && calls === 2, { result, calls });
    const snapA = __getProviderPoolForTests("openrouter").snapshot();
    check("timeout tampoco afecta la salud de la credential (poolAction NONE)", snapA.every((s) => s.consecutiveFailures === 0), snapA);
  }
  {
    console.log("--- Caso 6b: 'fetch failed: ECONNRESET' (sin statusCode) → heurística network, failover permitido ---");
    __resetProviderPoolsForTests();
    setOpenRouterCredentials("secret-caso6b-A", "secret-caso6b-B");
    const ws = await tempWorkspace();
    let calls = 0;
    const fake: FakeGenerateText = async () => {
      calls++;
      if (calls === 1) throw new Error("fetch failed: ECONNRESET");
      return {};
    };
    const result = await runAgentLoop(baseOptions(ws, fake));
    check("completed tras el failover por network heurístico", result.stopReason === "completed" && calls === 2, { result, calls });
  }

  // --- Caso 7: error en step 0 → failover permitido (ya demostrado en los casos 2/4/5/6 — este lo deja explícito) ---
  {
    console.log("\n--- Caso 7: confirmación explícita — el failover de los casos anteriores siempre ocurrió con currentStepIndex en 0 (nunca se llamó onStepFinish antes del error) ---");
    check("los casos 2, 4a-c, 5 y 6a-b ya son, todos, casos de 'falla en step 0' — ninguno llamó onStepFinish antes de tirar el error", true);
  }

  // --- Caso 8: error DESPUÉS de onStepFinish → failover PROHIBIDO, task FAILED ---
  {
    console.log("\n--- Caso 8: la 1ra credential completa un step (onStepFinish) y RECIÉN AHÍ falla con un error normalmente failover-eligible → NO debe intentar la 2da ---");
    __resetProviderPoolsForTests();
    setOpenRouterCredentials("secret-caso8-A", "secret-caso8-B");
    const ws = await tempWorkspace();
    let calls = 0;
    const fake: FakeGenerateText = async (opts) => {
      calls++;
      opts.onStepFinish?.({ text: "primer step completado", content: [] } as never); // currentStepIndex pasa a 1
      throw httpError(429, "rate limited — pero YA HUBO progreso real");
    };
    const result = await runAgentLoop(baseOptions(ws, fake));
    check("termina FAILED, no completed", result.stopReason === "error", result);
    check("generateText se llamó UNA SOLA VEZ — nunca intentó la 2da credential pese a ser failover-eligible", calls === 1, calls);
    const snap = __getProviderPoolForTests("openrouter").snapshot();
    check("la credential que falló SÍ queda en COOLDOWN igual (la salud se sigue actualizando aunque no se rote)", snap.some((s) => s.status === "COOLDOWN"), snap);
    check("la 2da credential nunca se tocó — sigue AVAILABLE con consecutiveFailures=0", snap.some((s) => s.status === "AVAILABLE" && s.consecutiveFailures === 0), snap);
  }

  // --- Caso 9: sin retry externo adicional — con 1 sola credential, exactamente 1 intento antes de rendirse ---
  {
    console.log("\n--- Caso 9: una sola credential que falla → generateText se llama UNA sola vez (5D no agrega ningún retry propio con la misma credential) ---");
    __resetProviderPoolsForTests();
    setOpenRouterCredentials("secret-caso9-unica");
    const ws = await tempWorkspace();
    let calls = 0;
    const fake: FakeGenerateText = async () => {
      calls++;
      throw httpError(429, "rate limited, sin nadie más a quien rotar");
    };
    const result = await runAgentLoop(baseOptions(ws, fake));
    check("stopReason error", result.stopReason === "error", result);
    check("generateText se llamó EXACTAMENTE 1 vez — nunca 2 ni 3 (eso sería un retry propio de 5D, que no debe existir)", calls === 1, calls);
  }

  // --- Caso 10: redacción de secrets en el error final ---
  {
    console.log("\n--- Caso 10: si un error (hipotético bug) trae el secreto real embebido en su mensaje, NUNCA debe llegar así al resultado final ---");
    __resetProviderPoolsForTests();
    const secretoUnico = "SECRETO-QUE-NUNCA-DEBE-APARECER-CASO10";
    setOpenRouterCredentials(secretoUnico);
    const ws = await tempWorkspace();
    const fake: FakeGenerateText = async () => {
      // 400 = PERMANENT, no failover-eligible → termina inmediato, es el
      // camino más corto para llegar al `errorMessage` final.
      throw httpError(400, `Bad request usando la key ${secretoUnico} en el header`);
    };
    const result = await runAgentLoop(baseOptions(ws, fake));
    check("stopReason error", result.stopReason === "error", result);
    check("el secreto NUNCA aparece en el mensaje final", !(result.error ?? "").includes(secretoUnico), result.error);
    check("el mensaje final contiene [REDACTED] en su lugar", (result.error ?? "").includes("[REDACTED]"), result.error);
  }

  // --- Caso 11: concurrencia — dos runAgentLoop() simultáneos sobre el mismo pool, cursores independientes ---
  {
    console.log("\n--- Caso 11: dos runAgentLoop() concurrentes comparten el pool sin pisarse ---");
    __resetProviderPoolsForTests();
    setOpenRouterCredentials("secret-caso11-A", "secret-caso11-B", "secret-caso11-C");
    const ws1 = await tempWorkspace();
    const ws2 = await tempWorkspace();
    let calls1 = 0;
    let calls2 = 0;
    const fake1: FakeGenerateText = async () => {
      calls1++;
      if (calls1 === 1) throw httpError(429, "op1 primer intento falla");
      return {};
    };
    const fake2: FakeGenerateText = async () => {
      calls2++;
      return {}; // op2 siempre funciona a la primera
    };
    const [r1, r2] = await Promise.all([runAgentLoop(baseOptions(ws1, fake1)), runAgentLoop(baseOptions(ws2, fake2))]);
    check("ambas operaciones terminan completed, sin deadlock ni excepción cruzada", r1.stopReason === "completed" && r2.stopReason === "completed", { r1, r2 });
    check("op1 necesitó 2 intentos (failover), op2 necesitó 1 — cada una con su propio cursor, sin mezclarse", calls1 === 2 && calls2 === 1, { calls1, calls2 });
  }

  // --- Caso 12 (5F): rotación exitosa (mismo escenario del Caso 2) queda como evento "credential_failover" en agent_events ---
  {
    console.log("\n--- Caso 12 (5F): la rotación del Caso 2 queda registrada como evento credential_failover con outcome=rotated ---");
    __resetProviderPoolsForTests();
    setOpenRouterCredentials("secret-caso12-A", "secret-caso12-B");
    const ws = await tempWorkspace();
    const taskId = await makeRealTask(ws);
    let calls = 0;
    const fake: FakeGenerateText = async () => {
      calls++;
      if (calls === 1) throw httpError(429, "rate limited");
      return {};
    };
    await runAgentLoop({ ...baseOptions(ws, fake), taskId });
    const events = listEvents(taskId).filter((e) => e.type === "credential_failover");
    check("se registró exactamente 1 evento credential_failover", events.length === 1, events);
    const ev = events[0]?.payload as Extract<AgentEventPayload, { type: "credential_failover" }> | undefined;
    check("outcome=rotated, provider=openrouter, credentialId presente, reason no vacío", ev?.outcome === "rotated" && ev.provider === "openrouter" && !!ev.credentialId && ev.reason.length > 0, ev);
    check("el evento nunca contiene el secreto real de ninguna credential", !JSON.stringify(ev).includes("secret-caso12"), ev);
  }

  // --- Caso 13 (5F): agotamiento (mismo escenario del Caso 3) queda como evento con outcome=exhausted, credentialId null ---
  {
    console.log("\n--- Caso 13 (5F): el agotamiento del Caso 3 queda registrado como evento credential_failover con outcome=exhausted ---");
    __resetProviderPoolsForTests();
    setOpenRouterCredentials("secret-caso13-A", "secret-caso13-B");
    const ws = await tempWorkspace();
    const taskId = await makeRealTask(ws);
    const fake: FakeGenerateText = async () => {
      throw httpError(429, "rate limited otra vez");
    };
    await runAgentLoop({ ...baseOptions(ws, fake), taskId });
    const events = listEvents(taskId).filter((e) => e.type === "credential_failover");
    // 2 credentials fallando (rotated, rotated) + 1 agotamiento final (exhausted) = 3
    check("se registraron 3 eventos: 2 rotaciones + 1 agotamiento final, sin corromperse entre sí", events.length === 3, events);
    const last = events[events.length - 1]?.payload as Extract<AgentEventPayload, { type: "credential_failover" }> | undefined;
    check("el último evento es el agotamiento: outcome=exhausted, credentialId y poolAction en null", last?.outcome === "exhausted" && last.credentialId === null && last.poolAction === null, last);
    check("reason del agotamiento es 'all_cooldown' (las 2 credentials están realmente en COOLDOWN, no INVALID)", last?.reason === "all_cooldown", last);
  }

  // --- Caso 14 (5F): la regla de Step 0 bloqueando la rotación (Caso 8) queda como outcome=stopped con nota explicativa ---
  {
    console.log("\n--- Caso 14 (5F): un error failover-eligible bloqueado por la regla de Step 0 (Caso 8) queda como outcome=stopped con nota ---");
    __resetProviderPoolsForTests();
    setOpenRouterCredentials("secret-caso14-A", "secret-caso14-B");
    const ws = await tempWorkspace();
    const taskId = await makeRealTask(ws);
    const fake: FakeGenerateText = async (opts) => {
      opts.onStepFinish?.({ text: "primer step completado", content: [] } as never);
      throw httpError(429, "rate limited — pero YA HUBO progreso real");
    };
    await runAgentLoop({ ...baseOptions(ws, fake), taskId });
    const events = listEvents(taskId).filter((e) => e.type === "credential_failover");
    check("se registró exactamente 1 evento (nunca llegó a intentar rotar)", events.length === 1, events);
    const ev = events[0]?.payload as Extract<AgentEventPayload, { type: "credential_failover" }> | undefined;
    check("outcome=stopped pese a ser un error failover-eligible, con nota explicando la regla de Step 0", ev?.outcome === "stopped" && !!ev.note && ev.note.includes("Step 0"), ev);
  }

  // --- Caso 15 (5F): sin credentials configuradas en absoluto → reason distingue "no_credentials_configured" de "all_invalid"/"all_cooldown" ---
  {
    console.log("\n--- Caso 15 (5F): sin ninguna credential en .env → reason=no_credentials_configured, no confundido con INVALID/COOLDOWN ---");
    __resetProviderPoolsForTests();
    setOpenRouterCredentials(); // ninguna
    const ws = await tempWorkspace();
    const taskId = await makeRealTask(ws);
    const fake: FakeGenerateText = async () => ({});
    const result = await runAgentLoop({ ...baseOptions(ws, fake), taskId });
    check("stopReason error", result.stopReason === "error", result);
    check("el mensaje dice 'no hay ninguna credential configurada', no habla de INVALID/cooldown", (result.error ?? "").includes("No hay ninguna credential configurada"), result.error);
    const events = listEvents(taskId).filter((e) => e.type === "credential_failover");
    const ev = events[0]?.payload as Extract<AgentEventPayload, { type: "credential_failover" }> | undefined;
    check("reason=no_credentials_configured", ev?.reason === "no_credentials_configured", ev);
  }

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} casos OK.`);
  if (passed !== results.length) process.exit(1);
}

main().catch((error) => {
  console.error("Error inesperado en la prueba:", error);
  process.exit(1);
});
