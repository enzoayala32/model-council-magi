/**
 * Fase 9C/9D — tests de integración del dispatcher autónomo.
 *
 * Usa un `generateTextImpl` falso (nunca red, nunca modelo real) que imita
 * al AI SDK: llama `prepareStep`, ejecuta las tools REALES de 9B y entrega
 * pasos con usage. La DB y el workspace git viven en un cwd temporal; la
 * DB real NUNCA se toca.
 *
 * Cubre: happy path con proposals, replanificación por acceptance
 * fallida, plan fallback, DONE sin evidencia, corte por presupuesto,
 * cancelación, la regla de Step-0 del failover de credenciales y los
 * detectores de no-progreso de 9D (warning → recuperación, acción
 * repetida, no_progress y diff idéntico).
 *
 * Uso: npm run agent:test-autonomy-dispatcher
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ModelMessage } from "ai";

const execFileAsync = promisify(execFile);
const sha256 = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

let total = 0;
let failed = 0;

function check(condition: boolean, message: string, detail?: () => unknown): void {
  total += 1;
  if (condition) {
    console.log(`✅ ${message}`);
    return;
  }
  failed += 1;
  console.error(`❌ ${message}`);
  if (detail) console.error("   ", JSON.stringify(detail()));
}

function checkEq(actual: unknown, expected: unknown, message: string, detail?: () => unknown): void {
  check(JSON.stringify(actual) === JSON.stringify(expected), message, () => ({
    esperado: expected,
    actual,
    ...(detail ? { detalle: detail() } : {}),
  }));
}

type SqliteDb = {
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number };
    all(...params: unknown[]): Array<Record<string, unknown>>;
    get(...params: unknown[]): Record<string, unknown> | undefined;
  };
  pragma(sql: string, options?: { simple?: boolean }): unknown;
  close(): void;
};

type ToolLike = {
  execute?: (input: unknown, options?: { abortSignal?: AbortSignal }) => Promise<unknown>;
};

type FakeCall = {
  system: string;
  prompt: string;
  tools: Record<string, ToolLike>;
  abortSignal?: AbortSignal;
  prepareStep?: (input: { messages: ModelMessage[]; stepNumber: number }) => Promise<{ system?: string; messages?: ModelMessage[] }>;
  onStepFinish?: (step: unknown) => void;
};

type Phase = "PLANNING" | "EXECUTING" | "REPLANNING";

function phaseOf(system: string): Phase {
  if (system.includes("La verificación falló")) return "REPLANNING";
  if (system.includes("Sos el planificador de un agente de programación autónomo")) return "PLANNING";
  if (system.includes("Modo autónomo (Fase 9C)")) return "EXECUTING";
  throw new Error(`Fase desconocida en el system prompt: ${system.slice(0, 200)}`);
}

type FakeHandlers = Partial<Record<Phase, (call: FakeCall) => Promise<void>>>;

function makeFake(handlers: FakeHandlers): (options: unknown) => Promise<unknown> {
  return async (options: unknown) => {
    const call = options as FakeCall;
    const phase = phaseOf(call.system);
    await call.prepareStep?.({ messages: [{ role: "user", content: call.prompt }], stepNumber: 0 });
    const handler = handlers[phase];
    if (!handler) throw new Error(`No hay handler para la fase ${phase}.`);
    await handler(call);
    return {};
  };
}

async function callTool(call: FakeCall, name: string, input: unknown): Promise<Record<string, unknown>> {
  const tool = call.tools[name];
  if (!tool?.execute) throw new Error(`La tool ${name} no está disponible.`);
  return (await tool.execute(input, { abortSignal: call.abortSignal })) as Record<string, unknown>;
}

type EmittedCall = { toolCallId: string; toolName: string; input: unknown };
type EmittedResult = { toolCallId: string; toolName: string; input: unknown; output: unknown };

function emit(call: FakeCall, stepNumber: number, toolCalls: EmittedCall[], toolResults: EmittedResult[], usage = { inputTokens: 100, outputTokens: 10 }): void {
  call.onStepFinish?.({
    stepNumber,
    toolCalls,
    toolResults,
    content: [
      ...toolCalls.map((entry) => ({ type: "tool-call", ...entry })),
      ...toolResults.map((entry) => ({ type: "tool-result", ...entry })),
    ],
    usage,
  });
}

async function main(): Promise<void> {
  console.log("== Fase 9C/9D — dispatcher autónomo ==\n");

  const originalCwd = process.cwd();
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "magi-autonomy-dispatcher-"));
  const workspace = path.join(temp, "workspace");
  await fs.mkdir(path.join(workspace, "src"), { recursive: true });
  await fs.writeFile(path.join(workspace, "package.json"), JSON.stringify({ name: "tmp-9c", scripts: { test: "node -e \"console.log('ok')\"" } }), "utf8");
  await fs.writeFile(path.join(workspace, "README.md"), "workspace de prueba 9C\n", "utf8");
  await execFileAsync("git", ["init"], { cwd: workspace });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: workspace });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: workspace });
  await execFileAsync("git", ["add", "-A"], { cwd: workspace });
  await execFileAsync("git", ["commit", "-m", "inicial"], { cwd: workspace });

  const originalKey = process.env.OPENROUTER_API_KEY;
  const originalKey2 = process.env.OPENROUTER_API_KEY_2;
  const originalLoopFlag = process.env.MAGI_AUTONOMOUS_LOOP;
  let db: SqliteDb | null = null;

  try {
    process.chdir(temp);
    process.env.OPENROUTER_API_KEY = "fake-key-9c-primary";
    delete process.env.OPENROUTER_API_KEY_2;
    delete process.env.MAGI_AUTONOMOUS_LOOP;

    const dbModule = (await import("../../db")) as { getDb(): SqliteDb };
    db = dbModule.getDb();
    db.pragma("foreign_keys = ON");

    const ledger = await import("./ledger");
    const { runAutonomousLoop } = await import("./dispatcher");
    const { __resetProviderPoolsForTests } = await import("../loop");
    const { listEvents } = await import("../event-log");
    type AutonomyLimits = import("./contract").AutonomyLimits;

    __resetProviderPoolsForTests();

    const now = Date.now();
    db.prepare(
      "INSERT INTO agent_projects (id, name, source_type, local_path, is_git_repo, archived, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("p1", "Proyecto 9C", "local", workspace, 1, 0, now, now);

    let taskCounter = 0;
    const newTask = (prompt: string): string => {
      const id = `task-9c-${++taskCounter}`;
      db!
        .prepare("INSERT INTO agent_tasks (id, project_id, model_id, prompt, status, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, "p1", "test-model", prompt, "QUEUED", Date.now());
      return id;
    };

    /** Cada escenario arranca de un workspace limpio: los archivos que
     * escribió el escenario anterior no deben aparecer como proposals del
     * siguiente. */
    const resetWorkspace = async (): Promise<void> => {
      await execFileAsync("git", ["reset", "--hard", "HEAD"], { cwd: workspace });
      await execFileAsync("git", ["clean", "-fdx"], { cwd: workspace });
    };

    const runAuto = (taskId: string, fake: (options: unknown) => Promise<unknown>, limits: Partial<AutonomyLimits> = {}, signal?: AbortSignal) =>
      runAutonomousLoop({
        taskId,
        task: "Implementar la feature 9C",
        workspaceRoot: workspace,
        repoRoot: workspace,
        modelId: "test/modelo-no-registrado",
        workspaceId: null,
        baseCommit: null,
        abortSignal: signal,
        generateTextImpl: fake as never,
        limits: { maxWallTimeMs: 60_000, ...limits },
      });

    const planOf = (taskId: string, version: number) => ledger.getPlanVersion(taskId, version);
    const eventsOf = (taskId: string) => listEvents(taskId).map((event) => event.payload);

    // -----------------------------------------------------------------------
    console.log("--- Happy path: plan → write → DONE → verificación → DONE ---");
      await resetWorkspace();
    {
      const taskId = newTask("Implementar feature 9C");
      const content = "export const feature = '9c';\n// SECRET_CONTENT_9C\n";
      const fileHash = sha256(content);
      const plan = {
        objective: "Implementar feature 9C",
        constraints: ["no agregar dependencias"],
        acceptance: [{ kind: "file_hash", path: "src/feature.ts", sha256: fileHash }],
        items: [
          {
            id: "t1",
            title: "Escribir src/feature.ts",
            acceptance: [{ kind: "manual", description: "revisar el archivo" }],
            paths: ["src/feature.ts"],
          },
        ],
      };

      const fake = makeFake({
        PLANNING: async (call) => {
          const output = await callTool(call, "update_plan", plan);
          emit(call, 0, [{ toolCallId: "plan-1", toolName: "update_plan", input: plan }], [{ toolCallId: "plan-1", toolName: "update_plan", input: plan, output }]);
        },
        EXECUTING: async (call) => {
          const writeInput = { path: "src/feature.ts", content };
          const writeOutput = await callTool(call, "write_file", writeInput);
          emit(call, 0, [{ toolCallId: "write-1", toolName: "write_file", input: writeInput }], [{ toolCallId: "write-1", toolName: "write_file", input: { path: "src/feature.ts" }, output: writeOutput }]);

          const startInput = { id: "t1", status: "IN_PROGRESS" };
          const startOutput = await callTool(call, "update_plan_item", startInput);
          emit(call, 1, [{ toolCallId: "start-1", toolName: "update_plan_item", input: startInput }], [{ toolCallId: "start-1", toolName: "update_plan_item", input: startInput, output: startOutput }]);

          const doneInput = { id: "t1", status: "DONE", evidence: [{ kind: "file", path: "src/feature.ts", sha256: fileHash }] };
          const doneOutput = await callTool(call, "update_plan_item", doneInput);
          emit(call, 2, [{ toolCallId: "done-1", toolName: "update_plan_item", input: doneInput }], [{ toolCallId: "done-1", toolName: "update_plan_item", input: doneInput, output: doneOutput }]);
        },
        REPLANNING: async () => {
          throw new Error("No debería replanificar en el happy path.");
        },
      });

      const result = await runAuto(taskId, fake);
      const run = ledger.listRunsForTask(taskId)[0];
      const planV1 = planOf(taskId, 1);

      checkEq(result.state, "DONE", "la corrida termina DONE");
      checkEq(result.outcome.status, "READY_FOR_REVIEW", "DONE con proposals → READY_FOR_REVIEW");
      checkEq(result.stopReason, "completed", "stopReason completed");
      checkEq(result.proposals.length, 1, "hay exactamente una propuesta");
      checkEq(result.proposals[0]?.relPath, "src/feature.ts", "la propuesta es del archivo escrito");
      checkEq(result.proposals[0]?.kind, "write", "el archivo nuevo se propone como write");
      checkEq(result.proposals[0]?.nextContent, content, "la propuesta conserva el contenido final");
      checkEq(result.touchedFiles, ["src/feature.ts"], "touchedFiles reporta el archivo");
      check(result.transcript.some((line) => line.includes("🧭 Plan v1")), "el transcript registra el plan v1");
      check(result.transcript.some((line) => line.includes("⛔ DONE")), "el transcript registra el cierre DONE");
      check(!result.transcript.join("\n").includes("SECRET_CONTENT_9C"), "el transcript no filtra contenido del archivo");

      checkEq(run?.state, "DONE", "agent_runs.state = DONE");
      checkEq(run?.stopReason, "completed", "agent_runs.stop_reason = completed");
      checkEq(run?.planVersion, 1, "agent_runs.plan_version = 1");
      checkEq(typeof run?.finishedAt, "number", "la corrida tiene finishedAt");
      check((run?.budget.steps ?? 0) >= 4, "el presupuesto registra al menos 4 pasos", () => run?.budget);
      checkEq(typeof run?.lastEventSeq, "number", "la corrida registra lastEventSeq");
      checkEq(planV1?.status, "COMPLETED", "el plan queda COMPLETED");
      checkEq(planV1?.items[0]?.status, "DONE", "el item queda DONE");
      checkEq(planV1?.items[0]?.evidence[0]?.kind, "file", "el item conserva evidencia de archivo");

      const steps = ledger.getStepsForRun(run!.id);
      checkEq(steps.length, 4, "el ledger tiene 4 pasos (1 plan + 3 ejecución)");
      checkEq(steps[0]?.phase, "PLANNING", "el paso 0 es PLANNING");
      checkEq(steps[0]?.actions[0]?.toolName, "update_plan", "el paso 0 llamó update_plan");
      checkEq(steps[1]?.phase, "EXECUTING", "el paso 1 es EXECUTING");
      checkEq(steps[1]?.actions[0]?.files, ["src/feature.ts"], "el paso 1 registra el archivo escrito");
      checkEq(steps[3]?.actions[0]?.ok, true, "el paso 3 registró el DONE aceptado");

      const checkpoints = ledger.getFileCheckpoints(run!.id);
      checkEq(checkpoints.length, 1, "hay un checkpoint de archivo");
      checkEq(checkpoints[0]?.path, "src/feature.ts", "el checkpoint es del archivo escrito");
      checkEq(checkpoints[0]?.sha256, fileHash, "el checkpoint tiene el hash real");
      checkEq(checkpoints[0]?.size, Buffer.byteLength(content), "el checkpoint tiene el tamaño real");

      const verifications = ledger.getVerificationsForRun(run!.id);
      checkEq(verifications.length, 1, "hay una verificación global");
      checkEq(verifications[0]?.criterion.kind, "file_hash", "la verificación es de file_hash");
      checkEq(verifications[0]?.status, "passed", "la verificación global pasó");

      const events = eventsOf(taskId);
      check(events.some((event) => event.type === "tool_call" && event.toolName === "write_file"), "hay evento tool_call de write_file");
      check(events.some((event) => event.type === "tool_result" && event.toolName === "update_plan_item" && event.ok), "hay evento tool_result OK de update_plan_item");
      check(events.some((event) => event.type === "context_usage"), "hay telemetría context_usage");
      check(!JSON.stringify(events).includes("SECRET_CONTENT_9C"), "ningún evento filtra el contenido del archivo");
      check(!JSON.stringify(events).includes("revisar el archivo"), "ningún evento filtra la descripción del plan");
      check(result.contextUsage.length >= 4, "el resultado incluye telemetría por paso");
    }

    // -----------------------------------------------------------------------
    console.log("\n--- Replanificación: acceptance falla → plan v2 → DONE ---");
      await resetWorkspace();
    {
      const taskId = newTask("Implementar feature con replan");
      const content = "export const replanned = true;\n";
      const fileHash = sha256(content);
      const wrongHash = "0".repeat(64);
      const item = {
        id: "t1",
        title: "Escribir src/replan.ts",
        acceptance: [{ kind: "manual", description: "revisar" }],
        paths: ["src/replan.ts"],
      };
      const planV1Input = {
        objective: "Implementar feature (intento 1)",
        acceptance: [{ kind: "file_hash", path: "src/replan.ts", sha256: wrongHash }],
        items: [item],
      };
      const planV2Input = {
        objective: "Implementar feature (hash corregido)",
        acceptance: [{ kind: "file_hash", path: "src/replan.ts", sha256: fileHash }],
        items: [item],
      };

      let executingCalls = 0;
      const fake = makeFake({
        PLANNING: async (call) => {
          const output = await callTool(call, "update_plan", planV1Input);
          emit(call, 0, [{ toolCallId: "plan-v1", toolName: "update_plan", input: planV1Input }], [{ toolCallId: "plan-v1", toolName: "update_plan", input: planV1Input, output }]);
        },
        EXECUTING: async (call) => {
          executingCalls += 1;
          if (executingCalls > 1) return; // la segunda fase no debería ejecutar nada
          const writeInput = { path: "src/replan.ts", content };
          const writeOutput = await callTool(call, "write_file", writeInput);
          emit(call, 0, [{ toolCallId: "write-r", toolName: "write_file", input: writeInput }], [{ toolCallId: "write-r", toolName: "write_file", input: { path: "src/replan.ts" }, output: writeOutput }]);
          const startInput = { id: "t1", status: "IN_PROGRESS" };
          const startOutput = await callTool(call, "update_plan_item", startInput);
          emit(call, 1, [{ toolCallId: "start-r", toolName: "update_plan_item", input: startInput }], [{ toolCallId: "start-r", toolName: "update_plan_item", input: startInput, output: startOutput }]);
          const doneInput = { id: "t1", status: "DONE", evidence: [{ kind: "file", path: "src/replan.ts", sha256: fileHash }] };
          const doneOutput = await callTool(call, "update_plan_item", doneInput);
          emit(call, 2, [{ toolCallId: "done-r", toolName: "update_plan_item", input: doneInput }], [{ toolCallId: "done-r", toolName: "update_plan_item", input: doneInput, output: doneOutput }]);
        },
        REPLANNING: async (call) => {
          const output = await callTool(call, "update_plan", planV2Input);
          emit(call, 0, [{ toolCallId: "plan-v2", toolName: "update_plan", input: planV2Input }], [{ toolCallId: "plan-v2", toolName: "update_plan", input: planV2Input, output }]);
        },
      });

      const result = await runAuto(taskId, fake, { maxReplans: 3 });
      const run = ledger.listRunsForTask(taskId)[0];
      const versions = ledger.listPlanVersions(taskId);
      const verifications = ledger.getVerificationsForRun(run!.id);

      checkEq(result.state, "DONE", "tras replanificar, la corrida termina DONE");
      checkEq(result.outcome.status, "READY_FOR_REVIEW", "el resultado conserva trabajo parcial");
      checkEq(run?.planVersion, 2, "la corrida apunta al plan v2");
      checkEq(versions.length, 2, "hay dos versiones de plan");
      // `listPlanVersions` ordena por versión DESC (v2 primero).
      checkEq(versions[0]?.version, 2, "la primera versión listada es la v2");
      checkEq(versions[0]?.status, "COMPLETED", "la versión 2 queda COMPLETED");
      checkEq(versions[1]?.version, 1, "la segunda versión listada es la v1");
      checkEq(versions[1]?.status, "ABANDONED", "la versión 1 queda ABANDONED");
      checkEq(planOf(taskId, 2)?.items[0]?.status, "DONE", "el item t1 se conservó DONE en v2");
      check(result.transcript.some((line) => line.includes("Replanificación 1/3")), "el transcript registra la replanificación");
      check(verifications.some((entry) => entry.status === "failed" && entry.criterion.kind === "file_hash"), "la primera verificación falló");
      check(verifications.some((entry) => entry.status === "passed" && entry.criterion.kind === "file_hash"), "la verificación corregida pasó");
      checkEq(executingCalls, 1, "la segunda fase EXECUTING no hizo falta");
    }

    // -----------------------------------------------------------------------
    console.log("\n--- Plan fallback: el modelo no llama update_plan ---");
      await resetWorkspace();
    {
      const taskId = newTask("Tarea sin plan del modelo");
      const fake = makeFake({
        PLANNING: async (call) => {
          emit(call, 0, [], []);
        },
        EXECUTING: async (call) => {
          const active = ledger.getActivePlan(taskId);
          const itemId = active?.items[0]?.logicalId ?? "t1";
          const startInput = { id: itemId, status: "IN_PROGRESS" };
          const startOutput = await callTool(call, "update_plan_item", startInput);
          emit(call, 0, [{ toolCallId: "start-f", toolName: "update_plan_item", input: startInput }], [{ toolCallId: "start-f", toolName: "update_plan_item", input: startInput, output: startOutput }]);
          const doneInput = { id: itemId, status: "DONE", evidence: [{ kind: "manual", description: "revisado por el controlador" }] };
          const doneOutput = await callTool(call, "update_plan_item", doneInput);
          emit(call, 1, [{ toolCallId: "done-f", toolName: "update_plan_item", input: doneInput }], [{ toolCallId: "done-f", toolName: "update_plan_item", input: doneInput, output: doneOutput }]);
        },
        REPLANNING: async () => {
          throw new Error("No debería replanificar con el plan fallback.");
        },
      });

      const result = await runAuto(taskId, fake, { maxInvalidPlanAttempts: 1 });
      const run = ledger.listRunsForTask(taskId)[0];
      const plan = planOf(taskId, 1);

      checkEq(result.state, "DONE", "el plan fallback permite terminar DONE");
      checkEq(result.outcome.status, "NO_CHANGES", "sin archivos nuevos → NO_CHANGES");
      checkEq(result.proposals.length, 0, "no hay proposals");
      checkEq(plan?.source, "fallback", "el plan persistido tiene source=fallback");
      checkEq(plan?.items.length, 1, "el plan fallback tiene un item");
      checkEq(plan?.items[0]?.status, "DONE", "el item fallback queda DONE");
      checkEq(run?.state, "DONE", "agent_runs.state = DONE");
      check(result.transcript.some((line) => line.includes("Plan fallback v1")), "el transcript registra el fallback");
      const verifications = ledger.getVerificationsForRun(run!.id);
      check(verifications.some((entry) => entry.criterion.kind === "manual" && entry.status === "unverified"), "la acceptance manual queda unverified");
    }

    // -----------------------------------------------------------------------
    console.log("\n--- DONE sin evidencia: rechazo y STALLED ---");
      await resetWorkspace();
    {
      const taskId = newTask("Tarea que intenta mentir");
      const plan = {
        objective: "Implementar sin evidencia",
        acceptance: [],
        items: [{ id: "t1", title: "Trabajo", acceptance: [{ kind: "manual", description: "revisar" }] }],
      };
      let doneOutput: Record<string, unknown> | null = null;
      const fake = makeFake({
        PLANNING: async (call) => {
          const output = await callTool(call, "update_plan", plan);
          emit(call, 0, [{ toolCallId: "plan-l", toolName: "update_plan", input: plan }], [{ toolCallId: "plan-l", toolName: "update_plan", input: plan, output }]);
        },
        EXECUTING: async (call) => {
          const startInput = { id: "t1", status: "IN_PROGRESS" };
          const startOutput = await callTool(call, "update_plan_item", startInput);
          emit(call, 0, [{ toolCallId: "start-l", toolName: "update_plan_item", input: startInput }], [{ toolCallId: "start-l", toolName: "update_plan_item", input: startInput, output: startOutput }]);
          const doneInput = { id: "t1", status: "DONE" };
          doneOutput = await callTool(call, "update_plan_item", doneInput);
          emit(call, 1, [{ toolCallId: "done-l", toolName: "update_plan_item", input: doneInput }], [{ toolCallId: "done-l", toolName: "update_plan_item", input: doneInput, output: doneOutput }]);
        },
        REPLANNING: async () => {
          throw new Error("No debería replanificar.");
        },
      });

      const result = await runAuto(taskId, fake, { maxNoProgressSteps: 2 });
      const run = ledger.listRunsForTask(taskId)[0];
      const item = planOf(taskId, 1)?.items[0];
      const events = eventsOf(taskId);

      const rejected = doneOutput as Record<string, unknown> | null;
      checkEq(rejected?.ok, false, "el DONE sin evidencia es rechazado");
      checkEq(rejected?.code, "evidence_invalid", "el rechazo es evidence_invalid");
      checkEq(result.state, "STALLED", "sin progreso la corrida queda STALLED");
      checkEq(result.outcome.status, "FAILED", "STALLED sin proposals → FAILED");
      checkEq(result.stopReason, "stalled", "stopReason stalled");
      checkEq(run?.state, "STALLED", "agent_runs.state = STALLED");
      checkEq(item?.status, "IN_PROGRESS", "el item NO queda DONE");
      check(result.transcript.some((line) => line.includes("se estancó sin progreso")), "el transcript explica el estancamiento");
      check(
        events.some((event) => event.type === "tool_result" && event.toolName === "update_plan_item" && !event.ok && event.error?.includes("DONE requiere al menos una evidencia")),
        "el evento registra el rechazo sin evidencia",
      );
    }

    // -----------------------------------------------------------------------
    console.log("\n--- Presupuesto: corte antes de la llamada N ---");
      await resetWorkspace();
    {
      const taskId = newTask("Tarea con presupuesto corto");
      const plan = {
        objective: "Implementar con presupuesto",
        acceptance: [],
        items: [{ id: "t1", title: "Trabajo", acceptance: [{ kind: "manual", description: "revisar" }] }],
      };
      const fake = makeFake({
        PLANNING: async (call) => {
          const output = await callTool(call, "update_plan", plan);
          emit(call, 0, [{ toolCallId: "plan-b", toolName: "update_plan", input: plan }], [{ toolCallId: "plan-b", toolName: "update_plan", input: plan, output }]);
        },
        EXECUTING: async (call) => {
          emit(call, 0, [], []);
        },
        REPLANNING: async () => {
          throw new Error("No debería replanificar.");
        },
      });

      const result = await runAuto(taskId, fake, { maxSteps: 2, maxStepsPerPhase: 1 });
      const run = ledger.listRunsForTask(taskId)[0];

      checkEq(result.state, "BUDGET_EXHAUSTED", "la corrida termina BUDGET_EXHAUSTED");
      checkEq(result.outcome.status, "FAILED", "sin proposals → FAILED");
      checkEq(result.stopReason, "budget_exhausted", "stopReason budget_exhausted");
      checkEq(result.steps, 2, "se ejecutaron exactamente 2 pasos");
      checkEq(run?.budget.steps, 2, "el presupuesto persistido coincide");
      checkEq(run?.state, "BUDGET_EXHAUSTED", "agent_runs.state = BUDGET_EXHAUSTED");
      checkEq(planOf(taskId, 1)?.items[0]?.status, "PENDING", "el item queda PENDING");
      check(result.transcript.some((line) => line.includes("Se agotaron los 2 pasos")), "el transcript explica el presupuesto");
    }

    // -----------------------------------------------------------------------
    console.log("\n--- Cancelación: abort externo durante PLANNING ---");
      await resetWorkspace();
    {
      const taskId = newTask("Tarea cancelada");
      const controller = new AbortController();
      const plan = {
        objective: "No debería guardarse",
        acceptance: [],
        items: [{ id: "t1", title: "Trabajo" }],
      };
      const fake = makeFake({
        PLANNING: async (call) => {
          controller.abort();
          const output = await callTool(call, "update_plan", plan);
          emit(call, 0, [{ toolCallId: "plan-c", toolName: "update_plan", input: plan }], [{ toolCallId: "plan-c", toolName: "update_plan", input: plan, output }]);
        },
        EXECUTING: async () => {
          throw new Error("No debería ejecutar tras cancelar.");
        },
        REPLANNING: async () => {
          throw new Error("No debería replanificar tras cancelar.");
        },
      });

      const result = await runAuto(taskId, fake, {}, controller.signal);
      const run = ledger.listRunsForTask(taskId)[0];

      checkEq(result.state, "CANCELLED", "la corrida termina CANCELLED");
      checkEq(result.outcome.status, "CANCELLED", "el outcome es CANCELLED");
      checkEq(result.stopReason, "cancelled", "stopReason cancelled");
      checkEq(run?.state, "CANCELLED", "agent_runs.state = CANCELLED");
      checkEq(planOf(taskId, 1), null, "no se guardó ningún plan");
      checkEq(result.proposals.length, 0, "una cancelación no propone cambios");
      checkEq(result.steps, 1, "solo se registró el paso de planning");
    }

    // -----------------------------------------------------------------------
    console.log("\n--- Step-0: no se rota la credential si ya terminó un paso ---");
      await resetWorkspace();
    {
      process.env.OPENROUTER_API_KEY = "fake-key-9c-step0-a";
      process.env.OPENROUTER_API_KEY_2 = "fake-key-9c-step0-b";
      __resetProviderPoolsForTests();

      const taskId = newTask("Tarea con 401 después de un paso");
      const plan = {
        objective: "Implementar con 401",
        acceptance: [],
        items: [{ id: "t1", title: "Trabajo", acceptance: [{ kind: "manual", description: "revisar" }] }],
      };
      let attempts = 0;
      const fake = makeFake({
        PLANNING: async (call) => {
          attempts += 1;
          const output = await callTool(call, "update_plan", plan);
          emit(call, 0, [{ toolCallId: "plan-s0", toolName: "update_plan", input: plan }], [{ toolCallId: "plan-s0", toolName: "update_plan", input: plan, output }]);
          throw Object.assign(new Error("unauthorized"), { statusCode: 401 });
        },
        EXECUTING: async () => {
          throw new Error("No debería ejecutar.");
        },
        REPLANNING: async () => {
          throw new Error("No debería replanificar.");
        },
      });

      const result = await runAuto(taskId, fake);
      const events = eventsOf(taskId);
      const failover = events.find((event) => event.type === "credential_failover");

      checkEq(result.state, "FAILED", "el error posterior a un paso termina FAILED");
      checkEq(result.outcome.status, "FAILED", "el outcome es FAILED");
      checkEq(result.stopReason, "provider_error", "stopReason provider_error");
      checkEq(attempts, 1, "no se reintentó con otra credential");
      checkEq(failover?.type, "credential_failover", "se registró el evento de failover");
      checkEq(failover?.outcome, "stopped", "el failover se detuvo");
      check(failover?.note?.includes("regla de Step 0") === true, "el evento explica la regla de Step 0", () => failover);
      check(!JSON.stringify(events).includes("fake-key-9c-step0-a"), "el evento no filtra la API key A");
      check(!JSON.stringify(events).includes("fake-key-9c-step0-b"), "el evento no filtra la API key B");
    }

    // -----------------------------------------------------------------------
    console.log("\n--- Failover: 401 antes de cualquier paso → rota y sigue ---");
      await resetWorkspace();
    {
      process.env.OPENROUTER_API_KEY = "fake-key-9c-rotate-a";
      process.env.OPENROUTER_API_KEY_2 = "fake-key-9c-rotate-b";
      __resetProviderPoolsForTests();

      const taskId = newTask("Tarea con 401 antes de un paso");
      const plan = {
        objective: "Implementar con failover",
        acceptance: [],
        items: [{ id: "t1", title: "Trabajo", acceptance: [{ kind: "manual", description: "revisar" }] }],
      };
      let attempts = 0;
      const fake = makeFake({
        PLANNING: async (call) => {
          attempts += 1;
          if (attempts === 1) throw Object.assign(new Error("unauthorized"), { statusCode: 401 });
          const output = await callTool(call, "update_plan", plan);
          emit(call, 0, [{ toolCallId: "plan-rot", toolName: "update_plan", input: plan }], [{ toolCallId: "plan-rot", toolName: "update_plan", input: plan, output }]);
        },
        EXECUTING: async (call) => {
          const startInput = { id: "t1", status: "IN_PROGRESS" };
          const startOutput = await callTool(call, "update_plan_item", startInput);
          emit(call, 0, [{ toolCallId: "start-rot", toolName: "update_plan_item", input: startInput }], [{ toolCallId: "start-rot", toolName: "update_plan_item", input: startInput, output: startOutput }]);
          const doneInput = { id: "t1", status: "DONE", evidence: [{ kind: "manual", description: "revisado" }] };
          const doneOutput = await callTool(call, "update_plan_item", doneInput);
          emit(call, 1, [{ toolCallId: "done-rot", toolName: "update_plan_item", input: doneInput }], [{ toolCallId: "done-rot", toolName: "update_plan_item", input: doneInput, output: doneOutput }]);
        },
        REPLANNING: async () => {
          throw new Error("No debería replanificar.");
        },
      });

      const result = await runAuto(taskId, fake);
      const events = eventsOf(taskId);
      const failover = events.find((event) => event.type === "credential_failover");

      checkEq(result.state, "DONE", "tras rotar, la corrida termina DONE");
      checkEq(result.outcome.status, "NO_CHANGES", "sin archivos → NO_CHANGES");
      checkEq(attempts, 2, "se intentó una vez por credential");
      checkEq(failover?.outcome, "rotated", "el failover rotó de credential");
      checkEq(failover?.credentialId, "openrouter-1", "el evento usa el id sintético, no la key");
      check(!JSON.stringify(events).includes("fake-key-9c-rotate-a"), "el evento no filtra la API key A");
      check(!JSON.stringify(events).includes("fake-key-9c-rotate-b"), "el evento no filtra la API key B");
    }

    // -----------------------------------------------------------------------
    console.log("\n--- 9D: warning por acción repetida → recuperación sin STALLED ---");
      await resetWorkspace();
    {
      const taskId = newTask("Tarea con warning de acción repetida");
      const plan = {
        objective: "Implementar con warning",
        acceptance: [],
        items: [{ id: "t1", title: "Trabajo", acceptance: [{ kind: "manual", description: "revisar" }] }],
      };
      let executingCalls = 0;
      let warningSeenInBriefing = false;
      const fake = makeFake({
        PLANNING: async (call) => {
          const output = await callTool(call, "update_plan", plan);
          emit(call, 0, [{ toolCallId: "plan-w", toolName: "update_plan", input: plan }], [{ toolCallId: "plan-w", toolName: "update_plan", input: plan, output }]);
        },
        EXECUTING: async (call) => {
          executingCalls += 1;
          if (executingCalls === 1) {
            // Tres lecturas idénticas: el detector avisa en la tercera y la
            // fase se corta para que el próximo briefing traiga el warning.
            for (let index = 0; index < 3; index += 1) {
              const input = { path: "README.md" };
              const output = await callTool(call, "read_file", input);
              emit(call, index, [{ toolCallId: `read-w-${index}`, toolName: "read_file", input }], [{ toolCallId: `read-w-${index}`, toolName: "read_file", input, output }]);
            }
            return;
          }
          warningSeenInBriefing = call.system.includes("Estás repitiendo la misma acción");
          const startInput = { id: "t1", status: "IN_PROGRESS" };
          const startOutput = await callTool(call, "update_plan_item", startInput);
          emit(call, 0, [{ toolCallId: "start-w", toolName: "update_plan_item", input: startInput }], [{ toolCallId: "start-w", toolName: "update_plan_item", input: startInput, output: startOutput }]);
          const doneInput = { id: "t1", status: "DONE", evidence: [{ kind: "manual", description: "revisado" }] };
          const doneOutput = await callTool(call, "update_plan_item", doneInput);
          emit(call, 1, [{ toolCallId: "done-w", toolName: "update_plan_item", input: doneInput }], [{ toolCallId: "done-w", toolName: "update_plan_item", input: doneInput, output: doneOutput }]);
        },
        REPLANNING: async () => {
          throw new Error("No debería replanificar.");
        },
      });

      const result = await runAuto(taskId, fake, { maxIdenticalActions: 3 });
      const events = eventsOf(taskId);
      const warningEvent = events.find((event) => event.type === "progress_warning");

      checkEq(executingCalls, 2, "la fase se cortó tras el warning y se reanudó con un briefing nuevo");
      check(warningSeenInBriefing, "el briefing siguiente incluye la advertencia");
      checkEq(result.state, "DONE", "tras cambiar de estrategia, la corrida termina DONE");
      checkEq(result.stopReason, "completed", "stopReason completed");
      checkEq(warningEvent?.type, "progress_warning", "se emitió un evento progress_warning");
      checkEq(warningEvent?.detector, "repeated_action", "el warning es de repeated_action");
      checkEq(warningEvent?.count, 3, "el warning reporta 3 repeticiones");
      checkEq(warningEvent?.threshold, 3, "el warning reporta el umbral 3");
      check(result.transcript.some((line) => line.includes("Estás repitiendo la misma acción")), "el transcript registra el warning");
      check(!JSON.stringify(events).includes("workspace de prueba 9C"), "ningún evento filtra el contenido leído");
    }

    // -----------------------------------------------------------------------
    console.log("\n--- 9D: acción repetida después del warning → STALLED ---");
      await resetWorkspace();
    {
      const taskId = newTask("Tarea que repite una acción");
      const plan = {
        objective: "Implementar repitiendo",
        acceptance: [],
        items: [{ id: "t1", title: "Trabajo", acceptance: [{ kind: "manual", description: "revisar" }] }],
      };
      let executingCalls = 0;
      const fake = makeFake({
        PLANNING: async (call) => {
          const output = await callTool(call, "update_plan", plan);
          emit(call, 0, [{ toolCallId: "plan-ra", toolName: "update_plan", input: plan }], [{ toolCallId: "plan-ra", toolName: "update_plan", input: plan, output }]);
        },
        EXECUTING: async (call) => {
          executingCalls += 1;
          const count = executingCalls === 1 ? 2 : 1;
          for (let index = 0; index < count; index += 1) {
            const input = { path: "README.md" };
            const output = await callTool(call, "read_file", input);
            emit(call, index, [{ toolCallId: `read-ra-${executingCalls}-${index}`, toolName: "read_file", input }], [{ toolCallId: `read-ra-${executingCalls}-${index}`, toolName: "read_file", input, output }]);
          }
        },
        REPLANNING: async () => {
          throw new Error("No debería replanificar.");
        },
      });

      const result = await runAuto(taskId, fake, { maxIdenticalActions: 2 });
      const events = eventsOf(taskId);
      const warnings = events.filter((event) => event.type === "progress_warning");

      checkEq(executingCalls, 2, "la corrida se detuvo en la segunda fase");
      checkEq(result.state, "STALLED", "repetir después del warning termina STALLED");
      checkEq(result.stopReason, "stalled", "stopReason stalled");
      checkEq(warnings.length, 1, "solo se emite un warning antes de escalar");
      checkEq(warnings[0]?.detector, "repeated_action", "el warning es de repeated_action");
      checkEq(warnings[0]?.count, 2, "el warning reporta el umbral 2");
      check(result.transcript.some((line) => line.includes("repitiendo la misma acción")), "el transcript explica el estancamiento");
      checkEq(planOf(taskId, 1)?.items[0]?.status, "PENDING", "el item no avanzó");
    }

    // -----------------------------------------------------------------------
    console.log("\n--- 9D: no_progress con lecturas distintas → STALLED ---");
      await resetWorkspace();
    {
      const taskId = newTask("Tarea que solo lee");
      const plan = {
        objective: "Implementar leyendo",
        acceptance: [],
        items: [{ id: "t1", title: "Trabajo", acceptance: [{ kind: "manual", description: "revisar" }] }],
      };
      let executingCalls = 0;
      const fake = makeFake({
        PLANNING: async (call) => {
          const output = await callTool(call, "update_plan", plan);
          emit(call, 0, [{ toolCallId: "plan-np", toolName: "update_plan", input: plan }], [{ toolCallId: "plan-np", toolName: "update_plan", input: plan, output }]);
        },
        EXECUTING: async (call) => {
          executingCalls += 1;
          if (executingCalls === 1) {
            const reads = [
              { tool: "read_file", input: { path: "README.md" } },
              { tool: "read_file", input: { path: "package.json" } },
              { tool: "list_files", input: { extension: "json" } },
            ];
            for (let index = 0; index < reads.length; index += 1) {
              const entry = reads[index]!;
              const output = await callTool(call, entry.tool, entry.input);
              emit(call, index, [{ toolCallId: `np-${index}`, toolName: entry.tool, input: entry.input }], [{ toolCallId: `np-${index}`, toolName: entry.tool, input: entry.input, output }]);
            }
            return;
          }
          const input = { extension: "ts" };
          const output = await callTool(call, "list_files", input);
          emit(call, 0, [{ toolCallId: "np-ts", toolName: "list_files", input }], [{ toolCallId: "np-ts", toolName: "list_files", input, output }]);
        },
        REPLANNING: async () => {
          throw new Error("No debería replanificar.");
        },
      });

      const result = await runAuto(taskId, fake, { maxNoProgressSteps: 3 });
      const events = eventsOf(taskId);
      const warnings = events.filter((event) => event.type === "progress_warning");

      checkEq(executingCalls, 2, "la corrida se detuvo en la segunda fase");
      checkEq(result.state, "STALLED", "leer sin avanzar termina STALLED");
      checkEq(result.stopReason, "stalled", "stopReason stalled");
      checkEq(warnings.length, 1, "solo se emite un warning antes de escalar");
      checkEq(warnings[0]?.detector, "no_progress", "el warning es de no_progress");
      checkEq(warnings[0]?.count, 3, "el warning reporta el umbral 3");
      check(result.transcript.some((line) => line.includes("No hubo avance de ledger")), "el transcript explica la falta de progreso");
      checkEq(planOf(taskId, 1)?.items[0]?.status, "PENDING", "el item no avanzó");
    }

    // -----------------------------------------------------------------------
    console.log("\n--- 9D: diff idéntico sin completar item → STALLED ---");
      await resetWorkspace();
    {
      const taskId = newTask("Tarea que repite el mismo diff");
      const plan = {
        objective: "Implementar con diff repetido",
        acceptance: [],
        items: [{ id: "t1", title: "Trabajo", acceptance: [{ kind: "manual", description: "revisar" }] }],
      };
      const content = "export const repeat = true;\n";
      let executingCalls = 0;
      const fake = makeFake({
        PLANNING: async (call) => {
          const output = await callTool(call, "update_plan", plan);
          emit(call, 0, [{ toolCallId: "plan-id", toolName: "update_plan", input: plan }], [{ toolCallId: "plan-id", toolName: "update_plan", input: plan, output }]);
        },
        EXECUTING: async (call) => {
          executingCalls += 1;
          const count = executingCalls === 1 ? 2 : 1;
          for (let index = 0; index < count; index += 1) {
            const input = { path: "src/repeat.ts", content };
            const output = await callTool(call, "write_file", input);
            emit(call, index, [{ toolCallId: `id-${executingCalls}-${index}`, toolName: "write_file", input }], [{ toolCallId: `id-${executingCalls}-${index}`, toolName: "write_file", input: { path: "src/repeat.ts" }, output }]);
          }
        },
        REPLANNING: async () => {
          throw new Error("No debería replanificar.");
        },
      });

      // maxIdenticalActions alto para aislar identical_diff: la acción se
      // repite, pero el detector de diff tiene prioridad más baja y debe ser
      // el que explique el estancamiento.
      const result = await runAuto(taskId, fake, { maxIdenticalActions: 10, maxIdenticalDiffs: 2 });
      const events = eventsOf(taskId);
      const warnings = events.filter((event) => event.type === "progress_warning");

      checkEq(executingCalls, 2, "la corrida se detuvo en la segunda fase");
      checkEq(result.state, "STALLED", "repetir el mismo diff termina STALLED");
      checkEq(result.stopReason, "stalled", "stopReason stalled");
      checkEq(warnings.length, 1, "solo se emite un warning antes de escalar");
      checkEq(warnings[0]?.detector, "identical_diff", "el warning es de identical_diff");
      checkEq(warnings[0]?.count, 2, "el warning reporta el umbral 2");
      check(result.transcript.some((line) => line.includes("repitiendo el mismo diff")), "el transcript explica el diff repetido");
      checkEq(result.proposals.length, 1, "STALLED conserva el trabajo parcial para revisión");
      checkEq(result.outcome.status, "READY_FOR_REVIEW", "con proposals, el outcome es READY_FOR_REVIEW");
      checkEq(planOf(taskId, 1)?.items[0]?.status, "PENDING", "el item no se marcó DONE");
    }

    console.log("\n--- Resultado ---");
    checkEq(total - failed, total, `${total - failed}/${total} aserciones OK`);
  } finally {
    try {
      db?.close();
    } catch {
      // best-effort
    }
    (globalThis as unknown as { __councilDb?: unknown }).__councilDb = undefined;
    process.chdir(originalCwd);
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
    if (originalKey2 === undefined) delete process.env.OPENROUTER_API_KEY_2;
    else process.env.OPENROUTER_API_KEY_2 = originalKey2;
    if (originalLoopFlag === undefined) delete process.env.MAGI_AUTONOMOUS_LOOP;
    else process.env.MAGI_AUTONOMOUS_LOOP = originalLoopFlag;
    await fs.rm(temp, { recursive: true, force: true }).catch(() => undefined);
  }

  if (failed > 0) {
    console.error(`\n${failed} aserción(es) fallaron.`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("Error inesperado en el test del dispatcher:", error);
  process.exitCode = 1;
});
