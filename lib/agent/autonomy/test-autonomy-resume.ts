/**
 * Fase 9E — tests de integración de reconciliación y reanudación.
 *
 * Cubre el flujo real de `reconcileOrphanedTasks` + `runTask`:
 * checkpoint transaccional, reanudación con hash correcto, drift sin
 * sobrescritura, base commit distinto, workspace borrado, plan persistido
 * inexistente, topes de reanudación/reintentos e idempotencia.
 *
 * La DB y los worktrees viven en un cwd temporal; la DB real NUNCA se toca.
 * No usa modelo ni red: el runner autónomo se inyecta.
 *
 * Uso: npm run agent:test-autonomy-resume-integration
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CodingTask } from "../task-store";
import type { AgentProject } from "../project-store";
import type { TaskWorkspace } from "../workspace-manager";
import type { AutonomousLoopResult, RunAutonomousLoopOptions } from "./dispatcher";
import type { AutonomyTaskOutcome } from "./contract";
import type { NormalizedPlan } from "./plan";

const execFileAsync = promisify(execFile);
const sha256 = (value: string | Buffer) => crypto.createHash("sha256").update(value).digest("hex");

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

async function pathExists(target: string): Promise<boolean> {
  return fs.stat(target).then(() => true).catch(() => false);
}

function fakeResult(outcome: AutonomyTaskOutcome, runId: string): AutonomousLoopResult {
  return {
    runId,
    state: outcome.status === "FAILED" ? "FAILED" : outcome.status === "CANCELLED" ? "CANCELLED" : "DONE",
    stopReason: outcome.stopReason,
    outcome,
    steps: 1,
    transcript: ["(reanudación simulada)"],
    proposals: [],
    touchedFiles: [],
    budget: { steps: 1, wallTimeMs: 1, inputTokens: 0, outputTokens: 0, estimatedCostUsd: null },
    contextUsage: [],
  };
}

type SqliteDb = {
  close(): void;
  pragma(sql: string): unknown;
  prepare(sql: string): { run(...args: unknown[]): { changes: number } };
};

async function main(): Promise<void> {
  console.log("== Fase 9E — reconciliación y reanudación ==\n");

  const originalCwd = process.cwd();
  const originalFlag = process.env.MAGI_AUTONOMOUS_LOOP;
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "magi-autonomy-resume-"));
  const projectDir = path.join(temp, "proyecto");
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(path.join(projectDir, "README.md"), "proyecto de prueba 9E\n", "utf8");
  await execFileAsync("git", ["init"], { cwd: projectDir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: projectDir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: projectDir });
  await execFileAsync("git", ["add", "-A"], { cwd: projectDir });
  await execFileAsync("git", ["commit", "-m", "inicial"], { cwd: projectDir });

  const createdWorktrees: string[] = [];
  let db: SqliteDb | null = null;

  try {
    process.chdir(temp);
    delete process.env.MAGI_AUTONOMOUS_LOOP;

    const dbModule = (await import("../../db")) as { getDb(): SqliteDb };
    db = dbModule.getDb();
    db.pragma("foreign_keys = ON");

    const ledger = await import("./ledger");
    const planModule = await import("./plan");
    const runnerModule = await import("../runner");
    const workspaceManager = await import("../workspace-manager");
    const taskStore = await import("../task-store");
    const projectStore = await import("../project-store");
    const workspaceStore = await import("../workspace-store");

    const project: AgentProject = await projectStore.createProject({ name: "proyecto-9e", localPath: projectDir });
    const { MAX_AUTO_RESTART_RETRIES } = runnerModule;

    let counter = 0;
    const newRunningTask = (restartRetryCount = 0): CodingTask => {
      const created = taskStore.createTask({
        projectId: project.id,
        modelId: "test-model-9e",
        prompt: `tarea 9e ${++counter}`,
      });
      return taskStore.transitionTask(created.id, "RUNNING", { restartRetryCount });
    };

    const newWorkspace = async (task: CodingTask): Promise<TaskWorkspace> => {
      const workspace = await workspaceManager.createWorkspaceForTask(task, project);
      createdWorktrees.push(workspace.worktreePath);
      return workspace;
    };

    const writeWorkspaceFile = async (
      workspace: TaskWorkspace,
      relPath: string,
      content: string,
    ): Promise<{ sha256: string; size: number; mtimeMs: number }> => {
      const absolute = path.join(workspace.worktreePath, relPath);
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await fs.writeFile(absolute, content, "utf8");
      const stat = await fs.stat(absolute);
      return { sha256: sha256(content), size: stat.size, mtimeMs: stat.mtimeMs };
    };

    const normalizedPlan = (): NormalizedPlan => {
      const result = planModule.normalizePlan({
        objective: "Implementar la feature de prueba 9E",
        constraints: ["No tocar archivos sensibles"],
        acceptance: [{ kind: "manual", description: "La feature funciona" }],
        items: [
          {
            id: "t1",
            title: "Implementar la feature",
            acceptance: [{ kind: "manual", description: "La feature funciona" }],
            paths: ["src/feature.ts"],
          },
        ],
      });
      if (!result.ok) throw new Error(`Plan de prueba inválido: ${result.errors.map((error) => error.message).join(" ")}`);
      return result.plan;
    };

    const createExecutingRun = (
      task: CodingTask,
      workspace: TaskWorkspace,
      options: { planVersion?: number; withPlan?: boolean } = {},
    ) => {
      const run = ledger.createRun({
        taskId: task.id,
        state: "EXECUTING",
        workspaceId: workspace.id,
        baseCommit: workspace.baseCommit,
        planVersion: options.planVersion ?? 0,
      });
      const plan =
        options.withPlan === false
          ? null
          : ledger.savePlanVersion({ taskId: task.id, runId: run.id, plan: normalizedPlan(), source: "model" });
      return { run, plan };
    };

    const checkpointStep = (
      runId: string,
      workspace: TaskWorkspace,
      relPath: string,
      file: { sha256: string; size: number; mtimeMs: number },
      options: { steps?: number; planVersion?: number; stepIndex?: number } = {},
    ) =>
      ledger.recordStepCheckpoint({
        step: {
          runId,
          stepIndex: options.stepIndex ?? 0,
          phase: "EXECUTING",
          actions: [
            {
              toolCallId: `call-${runId.slice(0, 8)}-${options.stepIndex ?? 0}`,
              toolName: "write_file",
              inputHash: "a".repeat(64),
              ok: true,
              files: [relPath],
            },
          ],
        },
        checkpoints: [{ runId, path: relPath, ...file }],
        run: {
          budget: { steps: options.steps ?? 1, wallTimeMs: 50, inputTokens: 100, outputTokens: 20, estimatedCostUsd: null },
          planVersion: options.planVersion ?? 1,
          headCommit: workspace.baseCommit,
        },
      });

    // -----------------------------------------------------------------------
    console.log("--- Checkpoint transaccional ---");
    {
      const task = newRunningTask();
      const run = ledger.createRun({ taskId: task.id, state: "EXECUTING" });

      let atomicError: unknown = null;
      try {
        ledger.recordStepCheckpoint({
          step: {
            runId: run.id,
            stepIndex: 0,
            phase: "EXECUTING",
            actions: [
              { toolCallId: "call-atomic", toolName: "write_file", inputHash: "b".repeat(64), ok: true, files: ["src/ok.ts"] },
            ],
          },
          checkpoints: [{ runId: run.id, path: ".env", sha256: "c".repeat(64), size: 10, mtimeMs: 1 }],
          run: { budget: { steps: 1 }, planVersion: 1, headCommit: "d".repeat(40) },
        });
      } catch (error) {
        atomicError = error;
      }

      check(atomicError instanceof Error && atomicError.message.includes(".env"), "un checkpoint sensible aborta la transacción", () =>
        atomicError instanceof Error ? atomicError.message : String(atomicError),
      );
      checkEq(ledger.getStepsForRun(run.id).length, 0, "el paso no quedó persistido tras el rollback");
      checkEq(ledger.getFileCheckpoints(run.id).length, 0, "el checkpoint no quedó persistido tras el rollback");
      checkEq(ledger.getRun(run.id)!.budget.steps, 0, "el presupuesto del run no se actualizó tras el rollback");
      checkEq(ledger.getRun(run.id)!.headCommit, null, "el HEAD del run no se actualizó tras el rollback");

      const ok = ledger.recordStepCheckpoint({
        step: {
          runId: run.id,
          stepIndex: 0,
          phase: "EXECUTING",
          actions: [
            { toolCallId: "call-atomic-ok", toolName: "write_file", inputHash: "e".repeat(64), ok: true, files: ["src/ok.ts"] },
          ],
        },
        checkpoints: [{ runId: run.id, path: "src/ok.ts", sha256: "f".repeat(64), size: 12, mtimeMs: 2 }],
        run: { budget: { steps: 1 }, planVersion: 1, headCommit: "d".repeat(40) },
      });

      checkEq(ok.step.stepIndex, 0, "un checkpoint válido persiste el paso");
      checkEq(ledger.getStepsForRun(run.id).length, 1, "el paso válido quedó persistido");
      checkEq(ledger.getFileCheckpoints(run.id).length, 1, "el checkpoint válido quedó persistido");
      checkEq(ledger.getRun(run.id)!.budget.steps, 1, "el presupuesto del run se actualizó");
      checkEq(ledger.getRun(run.id)!.headCommit, "d".repeat(40), "el HEAD del run se actualizó");

      // Libera el slot de RUNNING del proyecto para el resto de los casos.
      ledger.transitionRun(run.id, "CANCELLED");
      taskStore.transitionTask(task.id, "CANCELLED");
    }

    // -----------------------------------------------------------------------
    console.log("\n--- Reanudación válida + consumo del pedido ---");
    {
      const task = newRunningTask();
      const workspace = await newWorkspace(task);
      const file = await writeWorkspaceFile(workspace, "src/feature.ts", "export const feature = 1;\n");
      const { run, plan } = createExecutingRun(task, workspace);
      checkpointStep(run.id, workspace, "src/feature.ts", file, { steps: 3, planVersion: plan!.version });

      const recon = await runnerModule.reconcileOrphanedTasks();
      check(recon.resumed.includes(task.id), "la task huérfana con checkpoint válido se reanuda");
      check(recon.requeued.includes(task.id), "la task reanudada vuelve a QUEUED");
      checkEq(taskStore.getTask(task.id)!.status, "QUEUED", "la task queda QUEUED");

      const source = ledger.getRun(run.id)!;
      checkEq(source.state, "FAILED", "la corrida origen se cierra");
      checkEq(source.resumeRequested, true, "la corrida origen queda marcada para reanudar");
      checkEq(source.resumedByRunId, null, "todavía no hay corrida que la reanude");
      checkEq(ledger.getActivePlan(task.id)?.id, plan!.id, "el plan sigue ACTIVE (no se resetea al reanudar)");
      checkEq(await pathExists(workspace.worktreePath), true, "el worktree sigue en disco");

      const again = await runnerModule.reconcileOrphanedTasks();
      checkEq(again.resumed, [], "una segunda reconciliación no reanuda dos veces");
      checkEq(ledger.listRunsForTask(task.id).length, 1, "no se duplican corridas en la reconciliación");

      let captured: RunAutonomousLoopOptions | null = null;
      let resumedRunId: string | null = null;
      const autonomyRunner = async (options: RunAutonomousLoopOptions): Promise<AutonomousLoopResult> => {
        captured = options;
        const resume = options.resume!;
        const newRun = ledger.createRun({
          taskId: options.taskId,
          state: "RESUMING",
          workspaceId: options.workspaceId,
          baseCommit: options.baseCommit,
          headCommit: resume.headCommit,
          planVersion: resume.planVersion,
          budget: resume.budget,
          resumeOfRunId: resume.ofRunId,
        });
        ledger.transitionRun(newRun.id, "EXECUTING");
        resumedRunId = newRun.id;
        return fakeResult({ status: "READY_FOR_REVIEW", stopReason: "completed" }, newRun.id);
      };

      const claimed = await runnerModule.runTask(task.id, { autonomyRunner });
      checkEq(claimed, true, "runTask toma el turno de la task reanudada");
      check(captured !== null, "el runner autónomo recibió opciones");
      checkEq(captured!.resume?.ofRunId, run.id, "el ResumeContext apunta a la corrida origen");
      checkEq(captured!.resume?.planVersion, plan!.version, "se conserva la versión del plan");
      checkEq(captured!.resume?.budget.steps, 3, "el presupuesto acumulado se conserva");
      checkEq(captured!.workspaceId, workspace.id, "se reutiliza el workspace existente");
      checkEq(captured!.workspaceRoot, workspace.worktreePath, "el runner corre en el worktree reutilizado");
      checkEq(taskStore.getTask(task.id)!.status, "READY_FOR_REVIEW", "la task refleja el outcome");

      const consumed = ledger.getRun(run.id)!;
      checkEq(consumed.resumeRequested, false, "el pedido de reanudación se consumió");
      checkEq(consumed.resumedByRunId, resumedRunId, "la corrida origen apunta a la corrida nueva");
      const resumedRun = ledger.getRun(resumedRunId!)!;
      checkEq(resumedRun.resumeOfRunId, run.id, "la corrida nueva apunta al origen");
      checkEq(resumedRun.state, "EXECUTING", "la corrida nueva pasó a EXECUTING");
      checkEq(resumedRun.planVersion, plan!.version, "la corrida nueva arranca con el plan persistido");
      checkEq(resumedRun.budget.steps, 3, "la corrida nueva arranca con el presupuesto acumulado");

      let duplicate: unknown = null;
      try {
        ledger.createRun({ taskId: task.id, state: "RESUMING", resumeOfRunId: run.id });
      } catch (error) {
        duplicate = error;
      }
      check(
        duplicate instanceof Error && duplicate.message.includes("pedido de reanudación"),
        "no se puede consumir dos veces el mismo pedido",
        () => (duplicate instanceof Error ? duplicate.message : String(duplicate)),
      );
    }

    // -----------------------------------------------------------------------
    console.log("\n--- Drift: no se sobrescribe y se invalida evidencia ---");
    {
      const task = newRunningTask();
      const workspace = await newWorkspace(task);
      const original = await writeWorkspaceFile(workspace, "src/drift.ts", "export const drift = 1;\n");
      const { run, plan } = createExecutingRun(task, workspace);
      checkpointStep(run.id, workspace, "src/drift.ts", original, { planVersion: plan!.version });

      db.prepare(
        "UPDATE agent_plan_items SET status = 'DONE', evidence_json = ?, attempts = 1, started_at = ?, finished_at = ? WHERE id = ?",
      ).run(
        JSON.stringify([{ kind: "file", path: "src/drift.ts", sha256: original.sha256 }]),
        Date.now(),
        Date.now(),
        `${plan!.id}:t1`,
      );
      const changed = await writeWorkspaceFile(workspace, "src/drift.ts", "export const drift = 2;\n");

      const recon = await runnerModule.reconcileOrphanedTasks();
      check(recon.resumed.includes(task.id), "un archivo con drift no bloquea la reanudación");

      const item = ledger.getPlanById(plan!.id)!.items[0]!;
      checkEq(item.status, "PENDING", "el item DONE con evidencia drift vuelve a PENDING");
      checkEq(item.evidence, [], "la evidencia drift se descarta");
      check(item.lastError?.includes("drift") === true, "el item explica la invalidación por drift", () => item.lastError);
      checkEq(item.status !== "DONE" && changed.sha256 !== original.sha256, true, "el hash actual difiere del checkpoint");

      const content = await fs.readFile(path.join(workspace.worktreePath, "src/drift.ts"), "utf8");
      checkEq(content, "export const drift = 2;\n", "el archivo con drift nunca se sobrescribe");
      checkEq(ledger.getRun(run.id)!.resumeRequested, true, "el pedido de reanudación queda pendiente");
    }

    // -----------------------------------------------------------------------
    console.log("\n--- Base commit distinto: restart desde cero ---");
    {
      const task = newRunningTask();
      const workspace = await newWorkspace(task);
      const file = await writeWorkspaceFile(workspace, "src/base.ts", "export const base = 1;\n");
      const { run, plan } = createExecutingRun(task, workspace);
      checkpointStep(run.id, workspace, "src/base.ts", file, { planVersion: plan!.version });

      await execFileAsync("git", ["checkout", "--orphan", "otra-linea"], { cwd: workspace.worktreePath });
      await fs.writeFile(path.join(workspace.worktreePath, "otro.txt"), "otra raiz\n", "utf8");
      await execFileAsync("git", ["add", "-A"], { cwd: workspace.worktreePath });
      await execFileAsync("git", ["commit", "-m", "raiz alterna"], { cwd: workspace.worktreePath });

      const recon = await runnerModule.reconcileOrphanedTasks();
      checkEq(recon.resumed.includes(task.id), false, "una base distinta no se reanuda");
      check(recon.requeued.includes(task.id), "la task se reencola desde cero");
      checkEq(taskStore.getTask(task.id)!.status, "QUEUED", "la task vuelve a QUEUED");
      checkEq(ledger.getRun(run.id)!.state, "FAILED", "la corrida no reanudable se cierra");
      check(ledger.getRun(run.id)!.error?.includes("base_commit_mismatch") === true, "el cierre explica base_commit_mismatch", () =>
        ledger.getRun(run.id)!.error,
      );
      checkEq(ledger.getPlanById(plan!.id)!.status, "ABANDONED", "el plan viejo queda como historial");
      checkEq(ledger.getPlanById(plan!.id)!.items[0]!.status, "PENDING", "los items del plan viejo vuelven a PENDING");
      checkEq(ledger.getResumeSourceForTask(task.id), null, "no queda un pedido de reanudación fantasma");
      checkEq(workspaceStore.getWorkspaceForTask(task.id)!.destroyedAt !== null, true, "el workspace viejo se destruyó");
      checkEq(await pathExists(workspace.worktreePath), false, "el worktree viejo ya no existe");

      let captured: RunAutonomousLoopOptions | null = null;
      await runnerModule.runTask(task.id, {
        autonomyRunner: async (options) => {
          captured = options;
          return fakeResult({ status: "NO_CHANGES", stopReason: "completed" }, "run-restart-9e");
        },
      });
      check(captured !== null, "el restart desde cero corre con el runner inyectado");
      checkEq(captured!.resume, undefined, "el restart desde cero no lleva ResumeContext");
      check(captured!.workspaceId !== workspace.id, "se creó un workspace nuevo");
    }

    // -----------------------------------------------------------------------
    console.log("\n--- Workspace borrado: restart desde cero ---");
    {
      const task = newRunningTask();
      const workspace = await newWorkspace(task);
      const file = await writeWorkspaceFile(workspace, "src/missing.ts", "export const missing = 1;\n");
      const { run, plan } = createExecutingRun(task, workspace);
      checkpointStep(run.id, workspace, "src/missing.ts", file, { planVersion: plan!.version });

      await fs.rm(workspace.worktreePath, { recursive: true, force: true });

      const recon = await runnerModule.reconcileOrphanedTasks();
      checkEq(recon.resumed.includes(task.id), false, "un workspace ausente no se reanuda");
      check(recon.requeued.includes(task.id), "la task se reencola desde cero");
      checkEq(taskStore.getTask(task.id)!.status, "QUEUED", "la task vuelve a QUEUED");
      checkEq(ledger.getRun(run.id)!.state, "FAILED", "la corrida no reanudable se cierra");
      check(ledger.getRun(run.id)!.error?.includes("workspace_missing") === true, "el cierre explica workspace_missing", () =>
        ledger.getRun(run.id)!.error,
      );
      checkEq(ledger.getPlanById(plan!.id)!.status, "ABANDONED", "el plan viejo queda como historial");
      checkEq(ledger.getResumeSourceForTask(task.id), null, "no queda pedido de reanudación");
      checkEq(workspaceStore.getWorkspaceForTask(task.id)!.destroyedAt !== null, true, "el workspace ausente se marca destruido");
    }

    // -----------------------------------------------------------------------
    console.log("\n--- Plan persistido inexistente: se reanuda replanificando ---");
    {
      const task = newRunningTask();
      const workspace = await newWorkspace(task);
      const file = await writeWorkspaceFile(workspace, "src/sinplan.ts", "export const sinplan = 1;\n");
      const run = ledger.createRun({
        taskId: task.id,
        state: "EXECUTING",
        workspaceId: workspace.id,
        baseCommit: workspace.baseCommit,
        planVersion: 99,
      });
      checkpointStep(run.id, workspace, "src/sinplan.ts", file, { planVersion: 99 });

      const recon = await runnerModule.reconcileOrphanedTasks();
      check(recon.resumed.includes(task.id), "con checkpoints válidos se reanuda aunque el plan no exista");

      let captured: RunAutonomousLoopOptions | null = null;
      await runnerModule.runTask(task.id, {
        autonomyRunner: async (options) => {
          captured = options;
          return fakeResult({ status: "NO_CHANGES", stopReason: "completed" }, "run-sinplan-9e");
        },
      });
      check(captured !== null, "la task reanudada corre");
      checkEq(captured!.resume?.planVersion, 0, "sin plan utilizable se arranca con planVersion=0");
      check(
        captured!.resume?.warnings.some((warning) => warning.includes("plan persistido")) === true,
        "el briefing avisa que hay que replanificar",
        () => captured?.resume?.warnings,
      );
      checkEq(captured!.workspaceId, workspace.id, "se reutiliza el workspace verificado");
    }

    // -----------------------------------------------------------------------
    console.log("\n--- Tope de reanudaciones: INTERRUPTED ---");
    {
      const task = newRunningTask();
      const run1 = ledger.createRun({ taskId: task.id, state: "EXECUTING" });
      ledger.requestResumeAndClose(run1.id, "test cadena 1");
      const run2 = ledger.createRun({ taskId: task.id, state: "RESUMING", resumeOfRunId: run1.id });
      ledger.requestResumeAndClose(run2.id, "test cadena 2");
      const run3 = ledger.createRun({ taskId: task.id, state: "EXECUTING", resumeOfRunId: run2.id });

      checkEq(ledger.getResumeChainLength(run3.id), 2, "la cadena tiene dos reanudaciones");

      const recon = await runnerModule.reconcileOrphanedTasks();
      check(recon.interrupted.includes(task.id), "al agotar reanudaciones la task se interrumpe");
      checkEq(taskStore.getTask(task.id)!.status, "INTERRUPTED", "la task queda INTERRUPTED");
      checkEq(taskStore.getTask(task.id)!.stopReason, "resume_exhausted", "el stopReason es resume_exhausted");
      checkEq(ledger.getRun(run3.id)!.state, "FAILED", "la corrida activa se cierra");
      checkEq(ledger.getRun(run3.id)!.stopReason, "resume_exhausted", "la corrida registra resume_exhausted");
      checkEq(ledger.getResumeSourceForTask(task.id), null, "no queda pedido pendiente");
    }

    // -----------------------------------------------------------------------
    console.log("\n--- Tope de reintentos: INTERRUPTED ---");
    {
      const task = newRunningTask(MAX_AUTO_RESTART_RETRIES);
      const run = ledger.createRun({ taskId: task.id, state: "EXECUTING" });

      const recon = await runnerModule.reconcileOrphanedTasks();
      check(recon.interrupted.includes(task.id), "al agotar reintentos la task se interrumpe");
      checkEq(taskStore.getTask(task.id)!.status, "INTERRUPTED", "la task queda INTERRUPTED");
      checkEq(taskStore.getTask(task.id)!.stopReason, "retries_exhausted", "el stopReason es retries_exhausted");
      checkEq(ledger.getRun(run.id)!.state, "FAILED", "la corrida activa se cierra");
      checkEq(ledger.getRun(run.id)!.stopReason, "retries_exhausted", "la corrida registra retries_exhausted");
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
    for (const worktree of createdWorktrees) {
      await fs.rm(worktree, { recursive: true, force: true }).catch(() => undefined);
    }
    await execFileAsync("git", ["worktree", "prune"], { cwd: projectDir }).catch(() => undefined);
    await fs.rm(temp, { recursive: true, force: true }).catch(() => undefined);
  }

  if (failed > 0) {
    console.error(`\n${failed} aserción(es) fallaron.`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("Error inesperado en el test de reanudación:", error);
  process.exitCode = 1;
});
