/**
 * Fase 9F — cancelación con gracia, gate de tools y cierre con informe.
 *
 * Integración con fake model (nunca red/modelo real), tools reales, DB y
 * workspaces git en un cwd temporal. Cubre:
 * - cancelación durante PLANNING (eventos + informe),
 * - cancelación durante EXECUTING con tool en vuelo y gate de tools,
 * - cancelación durante VERIFYING con un verificador en vuelo,
 * - subproceso `run_script` cancelado por gracia,
 * - informe final persistido una sola vez y sin filtrar contenido/prompt,
 * - timeout sin proposals ⇒ FAILED.
 *
 * Uso: npm run agent:test-autonomy-cancel
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ModelMessage } from "ai";
import type { RunAutonomousLoopOptions } from "./dispatcher";
import type { VerifierExec } from "./verifier";
import { registerSecret } from "../../provider-resilience/redact";

const execFileAsync = promisify(execFile);
const sha256 = (value: string) => crypto.createHash("sha256").update(value, "utf8").digest("hex");

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

function emit(
  call: FakeCall,
  stepNumber: number,
  toolCalls: EmittedCall[],
  toolResults: EmittedResult[],
  usage = { inputTokens: 100, outputTokens: 10 },
): void {
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

const planInput = (acceptance: unknown[] = []) => ({
  objective: "Implementar feature 9F",
  acceptance,
  items: [
    {
      id: "t1",
      title: "Trabajo",
      acceptance: [{ kind: "manual", description: "revisar" }],
    },
  ],
});

async function initRepo(workspace: string, scripts: Record<string, string>): Promise<void> {
  await fs.mkdir(path.join(workspace, "src"), { recursive: true });
  await fs.writeFile(path.join(workspace, "package.json"), JSON.stringify({ name: path.basename(workspace), scripts }), "utf8");
  await fs.writeFile(path.join(workspace, "README.md"), "workspace de prueba 9F\n", "utf8");
  await execFileAsync("git", ["init"], { cwd: workspace });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: workspace });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: workspace });
  await execFileAsync("git", ["add", "-A"], { cwd: workspace });
  await execFileAsync("git", ["commit", "-m", "inicial"], { cwd: workspace });
}

async function main(): Promise<void> {
  console.log("== Fase 9F — cancelación e informe final ==\n");

  const originalCwd = process.cwd();
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "magi-autonomy-cancel-"));
  const workspace = path.join(temp, "workspace");
  const slowWorkspace = path.join(temp, "workspace-lento");
  await initRepo(workspace, { test: "node -e \"console.log('ok')\"" });
  await initRepo(slowWorkspace, { test: "node -e \"setTimeout(()=>{}, 15000)\"" });

  const originalKey = process.env.OPENROUTER_API_KEY;
  const originalLoopFlag = process.env.MAGI_AUTONOMOUS_LOOP;
  let db: SqliteDb | null = null;

  try {
    process.chdir(temp);
    process.env.OPENROUTER_API_KEY = "fake-key-9f-primary";
    delete process.env.MAGI_AUTONOMOUS_LOOP;

    const dbModule = (await import("../../db")) as { getDb(): SqliteDb };
    db = dbModule.getDb();
    db.pragma("foreign_keys = ON");

    const ledger = await import("./ledger");
    const { runAutonomousLoop } = await import("./dispatcher");
    const { __resetProviderPoolsForTests } = await import("../loop");
    const { listEvents } = await import("../event-log");
    const { cancelTask } = await import("../runner");
    type AutonomyLimits = import("./contract").AutonomyLimits;

    __resetProviderPoolsForTests();

    const now = Date.now();
    db.prepare(
      "INSERT INTO agent_projects (id, name, source_type, local_path, is_git_repo, archived, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("p1", "Proyecto 9F", "local", workspace, 1, 0, now, now);

    let taskCounter = 0;
    const newTask = (prompt: string): string => {
      const id = `task-9f-${++taskCounter}`;
      db!
        .prepare("INSERT INTO agent_tasks (id, project_id, model_id, prompt, status, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, "p1", "test-model", prompt, "QUEUED", Date.now());
      return id;
    };

    const runAuto = (
      taskId: string,
      fake: (options: unknown) => Promise<unknown>,
      options: {
        limits?: Partial<AutonomyLimits>;
        signal?: AbortSignal;
        workspaceRoot?: string;
        verifierExec?: VerifierExec;
        now?: () => number;
      } = {},
    ) =>
      runAutonomousLoop({
        taskId,
        task: "PROMPT_SECRETO_9F",
        workspaceRoot: options.workspaceRoot ?? workspace,
        repoRoot: options.workspaceRoot ?? workspace,
        modelId: "test/modelo-no-registrado",
        workspaceId: null,
        baseCommit: null,
        abortSignal: options.signal,
        generateTextImpl: fake as never,
        verifierExec: options.verifierExec,
        now: options.now,
        limits: { maxWallTimeMs: 60_000, ...options.limits },
      } satisfies RunAutonomousLoopOptions);

    const eventsOf = (taskId: string) => listEvents(taskId).map((event) => event.payload);
    const eventsOfType = (taskId: string, type: string) =>
      eventsOf(taskId).filter((event) => (event as { type?: string }).type === type);
    const resetWorkspace = async (): Promise<void> => {
      await execFileAsync("git", ["reset", "--hard", "HEAD"], { cwd: workspace });
      await execFileAsync("git", ["clean", "-fdx"], { cwd: workspace });
    };

    // -----------------------------------------------------------------------
    console.log("--- Cancelación durante PLANNING: evento + informe ---");
    {
      const taskId = newTask("Tarea cancelada en planning");
      const controller = new AbortController();
      const plan = planInput();
      const fake = makeFake({
        PLANNING: async (call) => {
          controller.abort();
          const output = await callTool(call, "update_plan", plan);
          emit(call, 0, [{ toolCallId: "plan-c", toolName: "update_plan", input: plan }], [{ toolCallId: "plan-c", toolName: "update_plan", input: plan, output }]);
        },
        EXECUTING: async () => {
          throw new Error("No debería ejecutar tras cancelar.");
        },
      });

      const result = await runAuto(taskId, fake, { signal: controller.signal });
      const run = ledger.listRunsForTask(taskId)[0];
      const report = run ? ledger.getFinalReport(run.id) : null;
      const cancellationRequested = eventsOfType(taskId, "cancellation_requested");
      const cancelled = eventsOfType(taskId, "cancelled") as Array<{ forced?: boolean }>;
      const finalReports = eventsOfType(taskId, "final_report");

      checkEq(result.state, "CANCELLED", "la corrida termina CANCELLED");
      checkEq(result.outcome.status, "CANCELLED", "el outcome es CANCELLED");
      checkEq(result.steps, 1, "solo se registró el paso de planning");
      checkEq(ledger.getPlanVersion(taskId, 1), null, "el gate impidió guardar el plan");
      checkEq(cancellationRequested.length, 1, "un único cancellation_requested");
      checkEq(cancelled.length, 1, "un único cancelled");
      checkEq(cancelled[0]?.forced, false, "la cancelación no necesitó forzar la gracia");
      checkEq(finalReports.length, 1, "un único final_report");
      check(report !== null, "el informe final quedó persistido");
      checkEq(report?.report.status, "cancelled", "el informe declara cancelled");
      checkEq(report?.report.changes, [], "sin cambios reales no hay changes");
      check(!JSON.stringify(report).includes("PROMPT_SECRETO_9F"), "el informe no filtra el prompt");
    }

    // -----------------------------------------------------------------------
    console.log("\n--- Cancelación durante EXECUTING: gate de tools ---");
    {
      const taskId = newTask("Tarea cancelada antes de escribir");
      const controller = new AbortController();
      const plan = planInput();
      const secretContent = "GATE_SECRET_CONTENT_9F";
      let gateOutput: Record<string, unknown> | null = null;
      const fake = makeFake({
        PLANNING: async (call) => {
          const output = await callTool(call, "update_plan", plan);
          emit(call, 0, [{ toolCallId: "plan-g", toolName: "update_plan", input: plan }], [{ toolCallId: "plan-g", toolName: "update_plan", input: plan, output }]);
        },
        EXECUTING: async (call) => {
          controller.abort();
          const input = { path: "src/gated.ts", content: secretContent };
          gateOutput = await callTool(call, "write_file", input);
          emit(call, 0, [{ toolCallId: "write-g", toolName: "write_file", input }], [{ toolCallId: "write-g", toolName: "write_file", input, output: gateOutput }]);
        },
      });

      const result = await runAuto(taskId, fake, { signal: controller.signal, limits: { cancelGraceMs: 5_000 } });
      const run = ledger.listRunsForTask(taskId)[0];
      const report = run ? ledger.getFinalReport(run.id) : null;
      const cancelled = eventsOfType(taskId, "cancelled") as Array<{ forced?: boolean }>;
      let fileExists = true;
      try {
        await fs.access(path.join(workspace, "src", "gated.ts"));
      } catch {
        fileExists = false;
      }

      const gate = gateOutput as Record<string, unknown> | null;
      checkEq(result.state, "CANCELLED", "la corrida termina CANCELLED");
      checkEq(gate?.ok, false, "la tool nueva devuelve ok:false");
      checkEq(gate?.errorCode, "cancelled", "la tool nueva devuelve errorCode cancelled");
      checkEq(fileExists, false, "el archivo no se escribió");
      checkEq(cancelled.length, 1, "un único cancelled");
      checkEq(cancelled[0]?.forced, false, "el paso en vuelo terminó antes de la gracia");
      checkEq(report?.report.status, "cancelled", "el informe declara cancelled");
      checkEq(report?.report.changes, [], "no inventa cambios que no ocurrieron");
      check(!JSON.stringify(report).includes(secretContent), "el informe no filtra el contenido intentado");
    }

    // -----------------------------------------------------------------------
    console.log("\n--- Cancelación durante VERIFYING: verificador en vuelo ---");
    {
      const taskId = newTask("Tarea cancelada verificando");
      const controller = new AbortController();
      const plan = planInput([{ kind: "typecheck" }]);
      let verifierCalls = 0;
      const verifierExec: VerifierExec = async () => {
        verifierCalls += 1;
        controller.abort();
        await new Promise((resolve) => setTimeout(resolve, 500));
        return { stdout: "", stderr: "" };
      };
      const fake = makeFake({
        PLANNING: async (call) => {
          const output = await callTool(call, "update_plan", plan);
          emit(call, 0, [{ toolCallId: "plan-v", toolName: "update_plan", input: plan }], [{ toolCallId: "plan-v", toolName: "update_plan", input: plan, output }]);
        },
        EXECUTING: async (call) => {
          const startInput = { id: "t1", status: "IN_PROGRESS" };
          const startOutput = await callTool(call, "update_plan_item", startInput);
          emit(call, 0, [{ toolCallId: "start-v", toolName: "update_plan_item", input: startInput }], [{ toolCallId: "start-v", toolName: "update_plan_item", input: startInput, output: startOutput }]);

          const doneInput = { id: "t1", status: "DONE", evidence: [{ kind: "manual", description: "revisado" }] };
          const doneOutput = await callTool(call, "update_plan_item", doneInput);
          emit(call, 1, [{ toolCallId: "done-v", toolName: "update_plan_item", input: doneInput }], [{ toolCallId: "done-v", toolName: "update_plan_item", input: doneInput, output: doneOutput }]);
        },
      });

      const result = await runAuto(taskId, fake, {
        signal: controller.signal,
        verifierExec,
        limits: { cancelGraceMs: 100 },
      });
      const run = ledger.listRunsForTask(taskId)[0];
      const report = run ? ledger.getFinalReport(run.id) : null;
      const cancelled = eventsOfType(taskId, "cancelled") as Array<{ forced?: boolean }>;
      const verifications = run ? ledger.getVerificationsForRun(run.id) : [];

      checkEq(result.state, "CANCELLED", "la corrida termina CANCELLED");
      checkEq(verifierCalls, 1, "el verificador se ejecutó una vez");
      checkEq(cancelled.length, 1, "un único cancelled");
      checkEq(cancelled[0]?.forced, true, "la gracia venció con el verificador en vuelo");
      checkEq(report?.report.status, "cancelled", "el informe declara cancelled");
      check(
        verifications.some((entry) => entry.criterion.kind === "typecheck" && entry.status === "passed"),
        "la verificación que terminó se registró igual",
      );
      checkEq(result.proposals.length, 0, "una cancelación no propone cambios");
    }

    // -----------------------------------------------------------------------
    console.log("\n--- Subproceso run_script: la gracia mata el árbol ---");
    {
      const taskId = newTask("Tarea con script lento");
      const controller = new AbortController();
      const plan = planInput();
      let scriptOutput: Record<string, unknown> | null = null;
      const fake = makeFake({
        PLANNING: async (call) => {
          const output = await callTool(call, "update_plan", plan);
          emit(call, 0, [{ toolCallId: "plan-s", toolName: "update_plan", input: plan }], [{ toolCallId: "plan-s", toolName: "update_plan", input: plan, output }]);
        },
        EXECUTING: async (call) => {
          const input = { name: "test" };
          const pending = callTool(call, "run_script", input);
          setTimeout(() => controller.abort(), 300);
          scriptOutput = await pending;
          emit(call, 0, [{ toolCallId: "script-s", toolName: "run_script", input }], [{ toolCallId: "script-s", toolName: "run_script", input, output: scriptOutput }]);
        },
      });

      const started = Date.now();
      const result = await runAuto(taskId, fake, {
        signal: controller.signal,
        workspaceRoot: slowWorkspace,
        limits: { cancelGraceMs: 1_000 },
      });
      const elapsed = Date.now() - started;
      const run = ledger.listRunsForTask(taskId)[0];
      const report = run ? ledger.getFinalReport(run.id) : null;
      const cancelled = eventsOfType(taskId, "cancelled") as Array<{ forced?: boolean }>;

      const script = scriptOutput as Record<string, unknown> | null;
      checkEq(result.state, "CANCELLED", "la corrida termina CANCELLED");
      checkEq(script?.ok, false, "run_script devuelve ok:false al abortarse");
      check(elapsed < 12_000, "el subproceso no sobrevive 15 s: la gracia lo cortó", () => ({ elapsed }));
      checkEq(cancelled.length, 1, "un único cancelled");
      checkEq(cancelled[0]?.forced, true, "la gracia venció con el subproceso en vuelo");
      checkEq(report?.report.commands.length, 1, "el informe registra el comando intentado");
      checkEq(report?.report.commands[0]?.ok, false, "el comando quedó marcado como fallido");
      check(!JSON.stringify(report).includes("setTimeout"), "el informe no filtra el contenido del script");
    }

    // -----------------------------------------------------------------------
    console.log("\n--- DONE: informe determinista, metadata-only e idempotente ---");
    await resetWorkspace();
    {
      const secretContent = "SECRET-CONTENT-9F-123";
      registerSecret(secretContent);
      const taskId = newTask("Tarea completa con informe");
      const content = `export const f9 = true;\n// ${secretContent}\n`;
      const fileHash = sha256(content);
      const plan = {
        objective: "Implementar feature 9F",
        acceptance: [{ kind: "script", name: "test" }],
        items: [
          {
            id: "t1",
            title: "Escribir src/feature9f.ts",
            acceptance: [{ kind: "manual", description: "revisar" }],
            paths: ["src/feature9f.ts"],
          },
        ],
      };
      const fake = makeFake({
        PLANNING: async (call) => {
          const output = await callTool(call, "update_plan", plan);
          emit(call, 0, [{ toolCallId: "plan-d", toolName: "update_plan", input: plan }], [{ toolCallId: "plan-d", toolName: "update_plan", input: plan, output }]);
        },
        EXECUTING: async (call) => {
          const writeInput = { path: "src/feature9f.ts", content };
          const writeOutput = await callTool(call, "write_file", writeInput);
          emit(call, 0, [{ toolCallId: "write-d", toolName: "write_file", input: writeInput }], [{ toolCallId: "write-d", toolName: "write_file", input: { path: "src/feature9f.ts" }, output: writeOutput }]);

          const startInput = { id: "t1", status: "IN_PROGRESS" };
          const startOutput = await callTool(call, "update_plan_item", startInput);
          emit(call, 1, [{ toolCallId: "start-d", toolName: "update_plan_item", input: startInput }], [{ toolCallId: "start-d", toolName: "update_plan_item", input: startInput, output: startOutput }]);

          const scriptInput = { name: "test" };
          const scriptOutput = await callTool(call, "run_script", scriptInput);
          emit(call, 2, [{ toolCallId: "script-d", toolName: "run_script", input: scriptInput }], [{ toolCallId: "script-d", toolName: "run_script", input: scriptInput, output: scriptOutput }]);

          const doneInput = { id: "t1", status: "DONE", evidence: [{ kind: "file", path: "src/feature9f.ts", sha256: fileHash }] };
          const doneOutput = await callTool(call, "update_plan_item", doneInput);
          emit(call, 3, [{ toolCallId: "done-d", toolName: "update_plan_item", input: doneInput }], [{ toolCallId: "done-d", toolName: "update_plan_item", input: doneInput, output: doneOutput }]);
        },
      });

      const result = await runAuto(taskId, fake);
      const run = ledger.listRunsForTask(taskId)[0];
      const persisted = run ? ledger.getFinalReport(run.id) : null;
      const report = persisted?.report;
      const finalReports = eventsOfType(taskId, "final_report") as Array<{ report?: unknown }>;
      const json = JSON.stringify(report);

      checkEq(result.state, "DONE", "la corrida termina DONE");
      checkEq(result.outcome.status, "READY_FOR_REVIEW", "DONE con proposals ⇒ READY_FOR_REVIEW");
      check(report !== undefined, "el informe final existe");
      checkEq(report?.status, "done", "el informe declara done");
      checkEq(report?.stopReason, "completed", "stopReason completed");
      checkEq(report?.plan, { version: 1, done: 1, total: 1, blocked: 0, skipped: 0 }, "plan resumido");
      checkEq(report?.changes.map((change) => change.path), ["src/feature9f.ts"], "changes desde proposals reales");
      checkEq(report?.changes[0]?.sha256, fileHash, "sha256 del contenido final");
      check((report?.changes[0]?.additions ?? 0) > 0, "additions del diff real");
      checkEq(report?.commands.length, 1, "un comando registrado");
      checkEq(report?.commands[0]?.name, "test", "nombre del script");
      checkEq(report?.commands[0]?.exitCode, 0, "exit code real");
      check((report?.commands[0]?.durationMs ?? -1) >= 0, "duración real");
      check(/^[a-f0-9]{64}$/.test(report?.commands[0]?.outputSha256 ?? ""), "hash del output");
      check((report?.tests.length ?? 0) >= 1, "hay al menos un test registrado");
      check((report?.tests ?? []).every((entry) => entry.ok), "todos los tests pasaron");
      check((report?.tests ?? []).every((entry) => entry.exitCode === 0), "todos los tests tienen exit code 0");
      check(
        (report?.verification ?? []).some((entry) => entry.criterion === "script:test" && entry.status === "passed"),
        "la verificación del script queda listada",
      );
      check(!json.includes(secretContent), "el informe no filtra el contenido del archivo");
      check(!json.includes("PROMPT_SECRETO_9F"), "el informe no filtra el prompt");
      check(!json.includes("console.log"), "el informe no filtra el output del script");
      checkEq(finalReports.length, 1, "un único evento final_report");
      checkEq(finalReports[0]?.report, report, "el evento lleva exactamente el informe persistido");

      const again = ledger.saveFinalReport({ runId: run!.id, taskId, report: report! });
      checkEq(again.created, false, "repetir la persistencia no crea otro informe");
      checkEq(eventsOfType(taskId, "final_report").length, 1, "tampoco duplica el evento");
      checkEq(ledger.getFinalReport(run!.id)?.report, report, "devuelve el informe existente");
    }

    // -----------------------------------------------------------------------
    console.log("\n--- Timeout sin proposals ⇒ FAILED (no NO_CHANGES) ---");
    await resetWorkspace();
    {
      const taskId = newTask("Tarea que agota el tiempo");
      let clock = Date.now();
      const plan = planInput();
      const fake = makeFake({
        PLANNING: async (call) => {
          const output = await callTool(call, "update_plan", plan);
          emit(call, 0, [{ toolCallId: "plan-t", toolName: "update_plan", input: plan }], [{ toolCallId: "plan-t", toolName: "update_plan", input: plan, output }]);
          clock += 2_000;
        },
        EXECUTING: async () => {
          throw new Error("No debería ejecutar: el tiempo ya se agotó.");
        },
      });

      const result = await runAuto(taskId, fake, { now: () => clock, limits: { maxWallTimeMs: 1_000 } });
      const run = ledger.listRunsForTask(taskId)[0];
      const report = run ? ledger.getFinalReport(run.id) : null;

      checkEq(result.state, "BUDGET_EXHAUSTED", "la corrida termina BUDGET_EXHAUSTED");
      checkEq(result.stopReason, "budget_exhausted", "el outcome de task conserva budget_exhausted");
      checkEq(result.outcome.status, "FAILED", "timeout sin proposals ⇒ FAILED");
      checkEq(report?.report.status, "budget_exhausted", "el informe declara budget_exhausted");
      checkEq(report?.report.stopReason, "timeout", "el informe conserva timeout");
      checkEq(eventsOfType(taskId, "cancelled").length, 0, "un timeout no emite cancelled");
      checkEq(eventsOfType(taskId, "final_report").length, 1, "el timeout también deja informe");
    }

    // -----------------------------------------------------------------------
    console.log("\n--- cancelTask sin corrida activa ---");
    {
      checkEq(cancelTask("task-inexistente"), false, "cancelar una task sin corrida activa devuelve false");
    }
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        // La DB ya pudo haberse cerrado.
      }
    }
    delete (globalThis as { __councilDb?: unknown }).__councilDb;
    process.chdir(originalCwd);
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
    if (originalLoopFlag === undefined) delete process.env.MAGI_AUTONOMOUS_LOOP;
    else process.env.MAGI_AUTONOMOUS_LOOP = originalLoopFlag;
    await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`\n${total - failed}/${total} aserciones OK.`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
