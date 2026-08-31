/**
 * Prueba de aceptación de la Fase 2D — la parte que se puede validar SIN
 * depender de un modelo real ni de red: usa un `loopRunner` inyectado (fake)
 * para confirmar que `runTask` orquesta bien la máquina de estados, crea y
 * destruye el workspace en el momento correcto, y que
 * `reconcileOrphanedTasks` reencola (o interrumpe, si ya agotó el tope de
 * reintentos) a una task `RUNNING` huérfana.
 *
 * Esto NO reemplaza probar contra un modelo real — ver
 * `agent:test-runner-real` para eso, que sí necesita `OPENROUTER_API_KEY`
 * y corre contra un proyecto git real tuyo.
 *
 * Uso: npm run agent:test-runner
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createProject } from "./project-store";
import { createTask, getTask, transitionTask } from "./task-store";
import { runTask, reconcileOrphanedTasks, isTaskActive } from "./runner";
import { getWorkspaceForTask } from "./workspace-store";
import type { AgentLoopResult } from "./loop";

const execFileAsync = promisify(execFile);

async function makeGitProject(name: string): Promise<{ id: string; localPath: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `consenso-ia-test2d-${name}-`));
  await fs.writeFile(path.join(dir, "README.md"), "proyecto de prueba\n");
  await execFileAsync("git", ["init"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
  await execFileAsync("git", ["add", "-A"], { cwd: dir });
  await execFileAsync("git", ["commit", "-m", "inicial"], { cwd: dir });
  const project = await createProject({ name, localPath: dir });
  return { id: project.id, localPath: dir };
}

function fakeResult(overrides: Partial<AgentLoopResult>): AgentLoopResult {
  return {
    stopReason: "completed",
    steps: 3,
    transcript: ["(resultado simulado)"],
    proposals: [],
    touchedFiles: [],
    ...overrides,
  };
}

async function pathExists(p: string): Promise<boolean> {
  return fs.stat(p).then(() => true).catch(() => false);
}

async function main() {
  console.log("== Fase 2D — prueba de aceptación (task runner, con loop simulado) ==\n");
  const results: boolean[] = [];

  // --- Caso 1: el loop produce propuestas → READY_FOR_REVIEW, workspace vivo ---
  {
    console.log("--- Caso 1: hay propuestas → READY_FOR_REVIEW ---");
    const project = await makeGitProject("caso1");
    const task = createTask({ projectId: project.id, modelId: "test-model", prompt: "hacé algo" });
    await runTask(task.id, {
      loopRunner: async () => fakeResult({ proposals: [{ kind: "write", relPath: "a.ts", diff: "+x", nextContent: "x", baselineHash: "x", typeCheck: { status: "skipped" } }] }),
    });
    const finalTask = getTask(task.id)!;
    const workspace = getWorkspaceForTask(task.id);
    const ok =
      finalTask.status === "READY_FOR_REVIEW" &&
      workspace !== null &&
      workspace.destroyedAt === null &&
      (await pathExists(workspace.worktreePath));
    console.log(
      ok
        ? "✅ status=READY_FOR_REVIEW, workspace sigue vivo (correcto — todavía no se aplicó/descartó)."
        : `❌ Falló. status=${finalTask.status}, workspace destruido=${workspace?.destroyedAt}`,
    );
    results.push(ok);
  }

  // --- Caso 2: el loop no produce nada → NO_CHANGES, workspace destruido ---
  {
    console.log("\n--- Caso 2: no hay propuestas → NO_CHANGES ---");
    const project = await makeGitProject("caso2");
    const task = createTask({ projectId: project.id, modelId: "test-model", prompt: "tarea imposible" });
    await runTask(task.id, { loopRunner: async () => fakeResult({ stopReason: "no_progress" }) });
    const finalTask = getTask(task.id)!;
    const workspace = getWorkspaceForTask(task.id);
    const ok = finalTask.status === "NO_CHANGES" && workspace !== null && workspace.destroyedAt !== null && !(await pathExists(workspace.worktreePath));
    console.log(ok ? "✅ status=NO_CHANGES, workspace destruido." : `❌ Falló. status=${finalTask.status}`);
    results.push(ok);
  }

  // --- Caso 3: el loop tira error → FAILED, workspace destruido ---
  {
    console.log("\n--- Caso 3: el loop falla → FAILED ---");
    const project = await makeGitProject("caso3");
    const task = createTask({ projectId: project.id, modelId: "test-model", prompt: "tarea que rompe" });
    await runTask(task.id, {
      loopRunner: async () => fakeResult({ stopReason: "error", error: "el modelo devolvió un error simulado" }),
    });
    const finalTask = getTask(task.id)!;
    const workspace = getWorkspaceForTask(task.id);
    const ok = finalTask.status === "FAILED" && finalTask.error === "el modelo devolvió un error simulado" && workspace?.destroyedAt !== null;
    console.log(ok ? "✅ status=FAILED, error registrado, workspace destruido." : `❌ Falló. status=${finalTask.status}, error=${finalTask.error}`);
    results.push(ok);
  }

  // --- Caso 4: proyecto sin git → runTask rechaza de entrada ---
  {
    console.log("\n--- Caso 4: proyecto SIN git → runTask debe rechazar ---");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "consenso-ia-test2d-nogit-"));
    await fs.writeFile(path.join(dir, "marker.txt"), "sin git\n");
    const project = await createProject({ name: "sin-git", localPath: dir });
    const task = createTask({ projectId: project.id, modelId: "test-model", prompt: "algo" });
    let rejected = false;
    try {
      await runTask(task.id, { loopRunner: async () => fakeResult({}) });
    } catch {
      rejected = true;
    }
    const finalTask = getTask(task.id)!;
    const ok = rejected && finalTask.status === "QUEUED";
    console.log(ok ? "✅ runTask rechazó el proyecto sin git y la task quedó en QUEUED (no se tocó)." : `❌ Falló. rejected=${rejected}, status=${finalTask.status}`);
    results.push(ok);
  }

  // --- Caso 5: reconciliación al boot (Fase 3: reencola, no interrumpe de entrada) ---
  {
    console.log("\n--- Caso 5: reconciliación de una RUNNING huérfana ---");
    const project = await makeGitProject("caso5");
    const task = createTask({ projectId: project.id, modelId: "test-model", prompt: "algo" });
    // Simulamos "el server se reinició a mitad de una corrida": la task
    // queda en RUNNING sin que exista una entrada en el Map de runs activos
    // (nunca pasó por `runTask` en este proceso).
    transitionTask(task.id, "RUNNING");
    const activeBefore = isTaskActive(task.id);

    const { requeued, interrupted } = await reconcileOrphanedTasks();
    const finalTask = getTask(task.id)!;
    // Fase 3: con restart_retry_count en 0 (recién arrancada), el destino
    // correcto es QUEUED de nuevo (reintento automático invisible), NO
    // INTERRUPTED directo — eso solo pasa tras agotar el tope de reintentos
    // (ver test-dispatcher para ese caso específico).
    const ok = !activeBefore && requeued.includes(task.id) && !interrupted.includes(task.id) && finalTask.status === "QUEUED" && finalTask.restartRetryCount === 1;
    console.log(ok ? "✅ La task huérfana se reencoló sola (QUEUED, restartRetryCount=1)." : `❌ Falló. status=${finalTask.status}, restartRetryCount=${finalTask.restartRetryCount}`);
    results.push(ok);
  }

  const allPassed = results.every(Boolean);
  console.log(`\n${allPassed ? "=== PRUEBA DE ACEPTACIÓN 2D: PASS ===" : "=== PRUEBA DE ACEPTACIÓN 2D: FAIL ==="}`);
  if (!allPassed) process.exit(1);
}

main().catch((error) => {
  console.error("Falló la prueba de Fase 2D:", error);
  process.exit(1);
});
