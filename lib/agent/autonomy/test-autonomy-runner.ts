/**
 * Fase 9C — tests de integración de `runner.ts` con el loop autónomo.
 *
 * No usa modelo ni red: inyecta `autonomyRunner`/`loopRunner` falsos y
 * verifica la selección opt-in, el mapeo de `outcome.status` a estados de
 * task, la persistencia de proposals y que el camino legacy quede intacto.
 * La DB vive en un cwd temporal; la DB real NUNCA se toca.
 *
 * Uso: npm run agent:test-autonomy-runner
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentFileProposal, AgentLoopResult } from "../loop";
import type { AutonomousLoopResult, RunAutonomousLoopOptions } from "./dispatcher";
import type { AutonomyTaskOutcome } from "./contract";

const execFileAsync = promisify(execFile);

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

const PROPOSAL: AgentFileProposal = {
  kind: "write",
  relPath: "src/nuevo.ts",
  diff: "+export const nuevo = true;",
  nextContent: "export const nuevo = true;\n",
  baselineHash: "0".repeat(64),
  typeCheck: { status: "skipped" },
};

function autonomyResult(overrides: Partial<AutonomousLoopResult> & { outcome: AutonomyTaskOutcome }): AutonomousLoopResult {
  const state = overrides.outcome.status === "CANCELLED" ? "CANCELLED" : overrides.outcome.status === "FAILED" ? "FAILED" : "DONE";
  return {
    runId: "run-fake",
    state,
    stopReason: overrides.outcome.stopReason,
    steps: 4,
    transcript: ["(corrida autónoma simulada)"],
    proposals: [],
    touchedFiles: [],
    budget: {
      steps: 4,
      wallTimeMs: 10,
      inputTokens: 100,
      outputTokens: 10,
      estimatedCostUsd: null,
    },
    contextUsage: [],
    ...overrides,
  };
}

function legacyResult(overrides: Partial<AgentLoopResult> = {}): AgentLoopResult {
  return {
    stopReason: "completed",
    steps: 2,
    transcript: ["(corrida legacy simulada)"],
    proposals: [],
    touchedFiles: [],
    ...overrides,
  };
}

async function pathExists(target: string): Promise<boolean> {
  return fs.stat(target).then(() => true).catch(() => false);
}

async function main(): Promise<void> {
  console.log("== Fase 9C — runner autónomo ==\n");

  const originalCwd = process.cwd();
  const originalFlag = process.env.MAGI_AUTONOMOUS_LOOP;
  const originalContextDisabled = process.env.MAGI_CONTEXT_ENGINE_DISABLED;
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "magi-autonomy-runner-"));
  const projectDir = path.join(temp, "proyecto");
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(path.join(projectDir, "README.md"), "proyecto de prueba 9C\n", "utf8");
  await execFileAsync("git", ["init"], { cwd: projectDir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: projectDir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: projectDir });
  await execFileAsync("git", ["add", "-A"], { cwd: projectDir });
  await execFileAsync("git", ["commit", "-m", "inicial"], { cwd: projectDir });

  let db: { close(): void } | null = null;

  try {
    process.chdir(temp);
    delete process.env.MAGI_AUTONOMOUS_LOOP;
    delete process.env.MAGI_CONTEXT_ENGINE_DISABLED;

    const dbModule = (await import("../../db")) as { getDb(): { close(): void } };
    db = dbModule.getDb();

    const { createProject } = await import("../project-store");
    const { createTask, getTask } = await import("../task-store");
    const { getWorkspaceForTask } = await import("../workspace-store");
    const { getProposalsForTask } = await import("../proposal-store");
    const { runTask, resolveRunnerKind, autonomousLoopEnabled } = await import("../runner");

    const project = await createProject({ name: "proyecto-9c-runner", localPath: projectDir });
    let taskCounter = 0;
    const newTask = (prompt: string): string =>
      createTask({ projectId: project.id, modelId: "test-model-9c", prompt: `tarea-${++taskCounter}: ${prompt}` }).id;

    // -----------------------------------------------------------------------
    console.log("--- Selección opt-in del runner ---");
    {
      const envCases: Array<[string | undefined, boolean]> = [
        [undefined, false],
        ["", false],
        ["0", false],
        ["false", false],
        ["off", false],
        ["quizás", false],
        ["1", true],
        ["true", true],
        ["TRUE", true],
        [" yes ", true],
        ["on", true],
      ];
      for (const [value, expected] of envCases) {
        if (value === undefined) delete process.env.MAGI_AUTONOMOUS_LOOP;
        else process.env.MAGI_AUTONOMOUS_LOOP = value;
        checkEq(autonomousLoopEnabled(), expected, `MAGI_AUTONOMOUS_LOOP=${JSON.stringify(value)} → ${expected ? "on" : "off"}`);
        checkEq(resolveRunnerKind(), expected ? "autonomy" : "legacy", `resolveRunnerKind con flag ${JSON.stringify(value)}`);
      }

      delete process.env.MAGI_AUTONOMOUS_LOOP;
      const injected = async (_options: RunAutonomousLoopOptions): Promise<AutonomousLoopResult> =>
        autonomyResult({ outcome: { status: "NO_CHANGES", stopReason: "completed" } });
      checkEq(resolveRunnerKind({ autonomyRunner: injected }), "autonomy", "un autonomyRunner inyectado fuerza la ruta autónoma");
      process.env.MAGI_AUTONOMOUS_LOOP = "1";
      checkEq(resolveRunnerKind({ autonomyRunner: injected }), "autonomy", "el flag y la inyección coinciden en autonomía");
      delete process.env.MAGI_AUTONOMOUS_LOOP;
    }

    // -----------------------------------------------------------------------
    console.log("\n--- Autonomía: READY_FOR_REVIEW persiste proposals ---");
    {
      const taskId = newTask("producir un cambio");
      const calls: RunAutonomousLoopOptions[] = [];
      const autonomyRunner = async (options: RunAutonomousLoopOptions): Promise<AutonomousLoopResult> => {
        calls.push(options);
        return autonomyResult({
          outcome: { status: "READY_FOR_REVIEW", stopReason: "completed" },
          proposals: [PROPOSAL],
          touchedFiles: ["src/nuevo.ts"],
        });
      };

      const claimed = await runTask(taskId, { autonomyRunner });
      const task = getTask(taskId)!;
      const workspace = getWorkspaceForTask(taskId);
      const proposals = getProposalsForTask(taskId);

      checkEq(claimed, true, "runTask tomó el turno");
      checkEq(calls.length, 1, "se llamó exactamente una vez al runner autónomo");
      checkEq(calls[0]?.taskId, taskId, "el runner recibe el taskId");
      checkEq(calls[0]?.task, task.prompt, "el runner recibe el prompt de la task");
      checkEq(calls[0]?.modelId, "test-model-9c", "el runner recibe el modelId de la task");
      checkEq(calls[0]?.workspaceId, workspace?.id, "el runner recibe el workspaceId real");
      checkEq(calls[0]?.baseCommit, workspace?.baseCommit ?? null, "el runner recibe el baseCommit del workspace");
      checkEq(calls[0]?.workspaceRoot, workspace?.worktreePath, "el runner corre en el worktree aislado");
      checkEq(calls[0]?.contextEngine?.enabled, true, "el motor de contexto va encendido por defecto");
      checkEq(task.status, "READY_FOR_REVIEW", "la task queda READY_FOR_REVIEW");
      checkEq(task.stopReason, "completed", "se conserva el stopReason del outcome");
      checkEq(proposals.length, 1, "la propuesta quedó persistida");
      checkEq(proposals[0]?.relPath, "src/nuevo.ts", "la propuesta persistida es la correcta");
      checkEq(workspace?.destroyedAt, null, "el workspace sigue vivo para revisar el diff");
      checkEq(await pathExists(workspace!.worktreePath), true, "el worktree existe en disco");
    }

    // -----------------------------------------------------------------------
    console.log("\n--- Autonomía: NO_CHANGES destruye el workspace ---");
    {
      const taskId = newTask("no cambiar nada");
      const claimed = await runTask(taskId, {
        autonomyRunner: async () => autonomyResult({ outcome: { status: "NO_CHANGES", stopReason: "completed" } }),
      });
      const task = getTask(taskId)!;
      const workspace = getWorkspaceForTask(taskId);
      const proposals = getProposalsForTask(taskId);

      checkEq(claimed, true, "runTask tomó el turno");
      checkEq(task.status, "NO_CHANGES", "la task queda NO_CHANGES");
      checkEq(task.error, null, "NO_CHANGES no registra error");
      checkEq(proposals.length, 0, "no se persistió ninguna propuesta");
      check(workspace?.destroyedAt !== null, "el workspace fue destruido");
      checkEq(await pathExists(workspace!.worktreePath), false, "el worktree ya no existe");
    }

    // -----------------------------------------------------------------------
    console.log("\n--- Autonomía: STALLED con proposals → READY_FOR_REVIEW ---");
    {
      const taskId = newTask("trabajo parcial");
      const claimed = await runTask(taskId, {
        autonomyRunner: async () =>
          autonomyResult({
            state: "STALLED",
            outcome: { status: "READY_FOR_REVIEW", stopReason: "stalled" },
            proposals: [PROPOSAL],
            touchedFiles: ["src/nuevo.ts"],
          }),
      });
      const task = getTask(taskId)!;
      const workspace = getWorkspaceForTask(taskId);

      checkEq(claimed, true, "runTask tomó el turno");
      checkEq(task.status, "READY_FOR_REVIEW", "el trabajo parcial con proposals va a revisión");
      checkEq(task.stopReason, "stalled", "stopReason stalled");
      checkEq(task.error, null, "un stall con trabajo parcial no marca error");
      checkEq(getProposalsForTask(taskId).length, 1, "la propuesta parcial quedó persistida");
      checkEq(workspace?.destroyedAt, null, "el workspace queda vivo para revisar");
    }

    // -----------------------------------------------------------------------
    console.log("\n--- Autonomía: STALLED sin proposals → FAILED con error ---");
    {
      const taskId = newTask("stall sin trabajo");
      const claimed = await runTask(taskId, {
        autonomyRunner: async () =>
          autonomyResult({ state: "STALLED", outcome: { status: "FAILED", stopReason: "stalled" } }),
      });
      const task = getTask(taskId)!;
      const workspace = getWorkspaceForTask(taskId);

      checkEq(claimed, true, "runTask tomó el turno");
      checkEq(task.status, "FAILED", "sin proposals la task queda FAILED");
      checkEq(task.stopReason, "stalled", "stopReason stalled");
      check(task.error?.includes("STALLED") === true, "el error sintetizado menciona el estado real", () => task.error);
      check(workspace?.destroyedAt !== null, "el workspace fue destruido");
      checkEq(await pathExists(workspace!.worktreePath), false, "el worktree ya no existe");
    }

    // -----------------------------------------------------------------------
    console.log("\n--- Autonomía: BUDGET_EXHAUSTED sin proposals → FAILED con error ---");
    {
      const taskId = newTask("presupuesto agotado");
      await runTask(taskId, {
        autonomyRunner: async () =>
          autonomyResult({
            state: "BUDGET_EXHAUSTED",
            outcome: { status: "FAILED", stopReason: "budget_exhausted" },
          }),
      });
      const task = getTask(taskId)!;
      checkEq(task.status, "FAILED", "la task queda FAILED");
      checkEq(task.stopReason, "budget_exhausted", "stopReason budget_exhausted");
      check(task.error?.includes("BUDGET_EXHAUSTED") === true, "el error sintetizado menciona el presupuesto", () => task.error);
    }

    // -----------------------------------------------------------------------
    console.log("\n--- Autonomía: FAILED explícito conserva el error del loop ---");
    {
      const taskId = newTask("falla del proveedor");
      await runTask(taskId, {
        autonomyRunner: async () =>
          autonomyResult({
            state: "FAILED",
            outcome: { status: "FAILED", stopReason: "provider_error" },
            error: "el proveedor devolvió 401",
          }),
      });
      const task = getTask(taskId)!;
      checkEq(task.status, "FAILED", "la task queda FAILED");
      checkEq(task.error, "el proveedor devolvió 401", "se conserva el error original del loop");
      checkEq(task.stopReason, "provider_error", "se conserva el stopReason original");
    }

    // -----------------------------------------------------------------------
    console.log("\n--- Autonomía: CANCELLED no persiste proposals ---");
    {
      const taskId = newTask("cancelada");
      await runTask(taskId, {
        autonomyRunner: async () =>
          autonomyResult({
            state: "CANCELLED",
            outcome: { status: "CANCELLED", stopReason: "cancelled" },
            proposals: [PROPOSAL],
          }),
      });
      const task = getTask(taskId)!;
      checkEq(task.status, "CANCELLED", "la task queda CANCELLED");
      checkEq(getProposalsForTask(taskId).length, 0, "una cancelación no persiste proposals");
    }

    // -----------------------------------------------------------------------
    console.log("\n--- Legacy: sin flag y sin autonomyRunner, el camino de Fase 8 queda intacto ---");
    {
      const taskId = newTask("legacy con proposals");
      let legacyCalls = 0;
      let autonomyCalls = 0;
      await runTask(taskId, {
        loopRunner: async () => {
          legacyCalls += 1;
          return legacyResult({ proposals: [PROPOSAL] });
        },
        autonomyRunner: undefined,
      });
      const task = getTask(taskId)!;
      checkEq(legacyCalls, 1, "se llamó al loop legacy");
      checkEq(autonomyCalls, 0, "no se llamó al loop autónomo");
      checkEq(task.status, "READY_FOR_REVIEW", "el camino legacy sigue mapeando proposals a READY_FOR_REVIEW");
      checkEq(getProposalsForTask(taskId).length, 1, "el camino legacy sigue persistiendo proposals");
    }

    // -----------------------------------------------------------------------
    console.log("\n--- Legacy: error del loop sigue yendo a FAILED ---");
    {
      const taskId = newTask("legacy con error");
      await runTask(taskId, {
        loopRunner: async () => legacyResult({ stopReason: "error", error: "fallo legacy simulado" }),
      });
      const task = getTask(taskId)!;
      checkEq(task.status, "FAILED", "la task legacy queda FAILED");
      checkEq(task.error, "fallo legacy simulado", "se conserva el error legacy");
      checkEq(task.stopReason, "error", "se conserva el stopReason legacy");
    }

    // -----------------------------------------------------------------------
    console.log("\n--- Prioridad: autonomyRunner inyectado gana sobre loopRunner ---");
    {
      const taskId = newTask("ambos runners");
      let legacyCalls = 0;
      let autonomyCalls = 0;
      await runTask(taskId, {
        loopRunner: async () => {
          legacyCalls += 1;
          return legacyResult();
        },
        autonomyRunner: async () => {
          autonomyCalls += 1;
          return autonomyResult({ outcome: { status: "NO_CHANGES", stopReason: "completed" } });
        },
      });
      checkEq(legacyCalls, 0, "el loop legacy no se llamó");
      checkEq(autonomyCalls, 1, "se llamó al loop autónomo");
      checkEq(getTask(taskId)!.status, "NO_CHANGES", "la task refleja el outcome autónomo");
    }

    // -----------------------------------------------------------------------
    console.log("\n--- Flag de entorno sin inyección elige autonomía (sin ejecutarla acá) ---");
    {
      process.env.MAGI_AUTONOMOUS_LOOP = "1";
      checkEq(resolveRunnerKind(), "autonomy", "el flag de entorno solo alcanza para elegir la ruta");
      delete process.env.MAGI_AUTONOMOUS_LOOP;
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
    if (originalFlag === undefined) delete process.env.MAGI_AUTONOMOUS_LOOP;
    else process.env.MAGI_AUTONOMOUS_LOOP = originalFlag;
    if (originalContextDisabled === undefined) delete process.env.MAGI_CONTEXT_ENGINE_DISABLED;
    else process.env.MAGI_CONTEXT_ENGINE_DISABLED = originalContextDisabled;
    await fs.rm(temp, { recursive: true, force: true }).catch(() => undefined);
  }

  if (failed > 0) {
    console.error(`\n${failed} aserción(es) fallaron.`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("Error inesperado en el test del runner autónomo:", error);
  process.exitCode = 1;
});
