/**
 * Prueba de aceptación de la Fase 4D (ver `fase4-diseno-v3-final.md`,
 * sección 4D): el commit real que hace `apply.ts` cae SIEMPRE en el
 * worktree del agente (nunca en `project.localPath`), `git add --` incluye
 * solo `appliedPaths` (nunca archivos sueltos de más que anden dando
 * vueltas en ese worktree), `git_commit_status` es independiente del
 * `status` final de la task, la rama `agent/<taskId>` se conserva tras un
 * commit exitoso pero se borra si nunca hubo ninguno, y la reconciliación
 * de boot rescata una task atascada en `APPLYING` (crash a mitad de apply)
 * de vuelta a `READY_FOR_REVIEW`.
 *
 * Sin modelo real — mismo patrón que el resto de las fases: `loopRunner`
 * fake + `applyTask`/`transitionTask` directo.
 *
 * Uso: npm run agent:test-git-trace
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createProject } from "./project-store";
import { createTask, getTask, transitionTask } from "./task-store";
import { runTask, discardTask, reconcileOrphanedTasks, isTaskActive } from "./runner";
import { applyTask } from "./apply";
import { loadWorkspaceForTask } from "./workspace-manager";
import type { AgentLoopResult } from "./loop";

const execFileAsync = promisify(execFile);

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text, "utf-8").digest("hex");
}

async function makeGitProject(name: string, files: Record<string, string>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `consenso-ia-test4d-${name}-`));
  for (const [relPath, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, relPath)), { recursive: true });
    await fs.writeFile(path.join(dir, relPath), content);
  }
  await execFileAsync("git", ["init"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
  await execFileAsync("git", ["add", "-A"], { cwd: dir });
  await execFileAsync("git", ["commit", "-m", "inicial"], { cwd: dir });
  return { project: await createProject({ name, localPath: dir }), dir };
}

function fakeResult(overrides: Partial<AgentLoopResult>): AgentLoopResult {
  return { stopReason: "completed", steps: 1, transcript: [], proposals: [], touchedFiles: [], ...overrides };
}

/** En producción, el contenido de `nextContent` de cada proposal ya está
 * escrito en el WORKSPACE cuando `buildProposals` lo lee (lo escribió el
 * propio agente vía `write_file`/`edit_file`/`delete_file` durante RUN,
 * ver `loop.ts`/`tools.ts`) — es justamente diffeando esos cambios contra
 * `HEAD` que se arman las proposals. `apply.ts` después escribe ESE MISMO
 * contenido en `project.localPath` (el proyecto real) y commitea lo que ya
 * estaba en el workspace. Con un `loopRunner` fake (sin agente real) hay
 * que simular ese paso a mano: espejar las proposals en el workspace antes
 * de llamar a `applyTask`, o `git add`/`git commit` no van a tener nada
 * nuevo que commitear ahí. */
async function seedWorkspaceWithProposals(workspaceRoot: string, proposals: { kind: string; relPath: string; nextContent: string }[]) {
  for (const p of proposals) {
    const abs = path.join(workspaceRoot, p.relPath);
    if (p.kind === "delete") {
      await fs.unlink(abs).catch(() => {});
    } else {
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, p.nextContent, "utf-8");
    }
  }
}

async function branchExists(dir: string, branch: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["rev-parse", "--verify", branch], { cwd: dir });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  console.log("== Fase 4D — prueba de aceptación (trazabilidad git) ==\n");
  const results: boolean[] = [];

  // --- Caso 1: el commit cae en el worktree (rama agent/<taskId>), no en la rama principal del repo real ---
  {
    console.log("--- Caso 1: commit real en agent/<taskId>, HEAD del repo real intacto ---");
    const { project, dir } = await makeGitProject("caso1", { "a.ts": "contenido a\n" });
    const { stdout: headBefore } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: dir });
    const task = createTask({ projectId: project.id, modelId: "test-model", prompt: "editar a.ts" });
    const proposalsCaso1 = [{ kind: "edit" as const, relPath: "a.ts", diff: "-contenido a\n+contenido a editado", nextContent: "contenido a editado\n", baselineHash: sha256("contenido a\n"), typeCheck: { status: "ok" as const } }];
    await runTask(task.id, { loopRunner: async () => fakeResult({ proposals: proposalsCaso1 }) });
    await seedWorkspaceWithProposals(loadWorkspaceForTask(task.id)!.worktreePath, proposalsCaso1);
    const applyResult = await applyTask(task.id);
    const { stdout: headAfter } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: dir });
    const finalTask = getTask(task.id)!;
    const branchLog = await execFileAsync("git", ["log", "-1", "--pretty=%s", finalTask.appliedBranchName ?? ""], { cwd: dir }).catch(() => ({ stdout: "" }));
    const ok =
      applyResult.status === "APPLIED" &&
      finalTask.gitCommitStatus === "success" &&
      typeof finalTask.appliedCommitSha === "string" &&
      finalTask.appliedBranchName === `agent/${task.id}` &&
      headBefore.trim() === headAfter.trim() && // el checkout principal del repo real nunca se movió
      branchLog.stdout.startsWith("agent:");
    console.log(
      ok
        ? "✅ El commit cayó en la rama agent/<taskId>, y HEAD del repo real (rama principal) no se movió."
        : `❌ Falló. applyResult=${JSON.stringify(applyResult)}, finalTask=${JSON.stringify(finalTask)}, headBefore=${headBefore}, headAfter=${headAfter}, branchLog=${JSON.stringify(branchLog)}`,
    );
    results.push(ok);
  }

  // --- Caso 2: git add -- incluye solo appliedPaths, nunca archivos sueltos de más ---
  {
    console.log("\n--- Caso 2: el commit incluye solo los appliedPaths, no un archivo suelto que ande en el worktree ---");
    const { project, dir } = await makeGitProject("caso2", { "b.ts": "contenido b\n" });
    const task = createTask({ projectId: project.id, modelId: "test-model", prompt: "editar b.ts" });
    const proposalsCaso2 = [{ kind: "edit" as const, relPath: "b.ts", diff: "-contenido b\n+contenido b editado", nextContent: "contenido b editado\n", baselineHash: sha256("contenido b\n"), typeCheck: { status: "ok" as const } }];
    await runTask(task.id, { loopRunner: async () => fakeResult({ proposals: proposalsCaso2 }) });
    const workspaceBeforeApply = loadWorkspaceForTask(task.id)!;
    await seedWorkspaceWithProposals(workspaceBeforeApply.worktreePath, proposalsCaso2);
    // Un archivo suelto que quedó en el worktree por fuera de la proposal
    // (ej. un artefacto de build) — NO debe terminar commiteado.
    await fs.writeFile(path.join(workspaceBeforeApply.worktreePath, "suelto.txt"), "no debería commitearse\n");

    const applyResult = await applyTask(task.id);
    const finalTask = getTask(task.id)!;
    const { stdout: filesInCommit } = await execFileAsync("git", ["show", "--stat", "--pretty=format:", finalTask.appliedBranchName ?? ""], { cwd: dir });
    const ok = applyResult.status === "APPLIED" && finalTask.gitCommitStatus === "success" && filesInCommit.includes("b.ts") && !filesInCommit.includes("suelto.txt");
    console.log(
      ok
        ? "✅ El commit incluyó solo b.ts (appliedPaths) — el archivo suelto quedó afuera."
        : `❌ Falló. filesInCommit=${filesInCommit}`,
    );
    results.push(ok);
  }

  // --- Caso 3: git_commit_status desacoplado del status final de la task ---
  {
    console.log("\n--- Caso 3: un commit fallido no hace fallar el apply — la task queda APPLIED con git_commit_status:\"failed\" ---");
    const { project, dir } = await makeGitProject("caso3", { "c.ts": "contenido c\n" });
    const task = createTask({ projectId: project.id, modelId: "test-model", prompt: "editar c.ts" });
    await runTask(task.id, {
      loopRunner: async () =>
        fakeResult({
          proposals: [{ kind: "edit", relPath: "c.ts", diff: "-contenido c\n+contenido c editado", nextContent: "contenido c editado\n", baselineHash: sha256("contenido c\n"), typeCheck: { status: "ok" } }],
        }),
    });
    // Se borra el worktree a mano justo antes del intento de commit, para
    // forzar que `git add`/`git commit` fallen (cwd inexistente).
    const workspace = loadWorkspaceForTask(task.id)!;
    await fs.rm(workspace.worktreePath, { recursive: true, force: true });

    const applyResult = await applyTask(task.id);
    const finalTask = getTask(task.id)!;
    const contentAfter = await fs.readFile(path.join(dir, "c.ts"), "utf-8");
    const ok =
      applyResult.status === "APPLIED" &&
      finalTask.status === "APPLIED" &&
      finalTask.gitCommitStatus === "failed" &&
      typeof finalTask.gitCommitError === "string" &&
      contentAfter === "contenido c editado\n"; // el archivo real SÍ se aplicó — el commit es solo trazabilidad
    console.log(
      ok
        ? "✅ La task quedó APPLIED igual (el cambio real se aplicó) con git_commit_status:\"failed\" — desacoplado del status de la task."
        : `❌ Falló. applyResult=${JSON.stringify(applyResult)}, finalTask=${JSON.stringify(finalTask)}, contentAfter="${contentAfter}"`,
    );
    results.push(ok);
  }

  // --- Caso 4: rama conservada tras commit exitoso vs. borrada tras DISCARDED sin ningún commit ---
  {
    console.log("\n--- Caso 4: rama conservada tras commit exitoso vs. borrada si nunca hubo commit ---");
    const { project: projectA, dir: dirA } = await makeGitProject("caso4a", { "d.ts": "contenido d\n" });
    const taskA = createTask({ projectId: projectA.id, modelId: "test-model", prompt: "editar d.ts" });
    const proposalsCaso4a = [{ kind: "edit" as const, relPath: "d.ts", diff: "-contenido d\n+contenido d editado", nextContent: "contenido d editado\n", baselineHash: sha256("contenido d\n"), typeCheck: { status: "ok" as const } }];
    await runTask(taskA.id, { loopRunner: async () => fakeResult({ proposals: proposalsCaso4a }) });
    await seedWorkspaceWithProposals(loadWorkspaceForTask(taskA.id)!.worktreePath, proposalsCaso4a);
    await applyTask(taskA.id); // aplica y commitea con éxito → destruye el workspace conservando la rama
    const branchKept = await branchExists(dirA, `agent/${taskA.id}`);

    const { project: projectB, dir: dirB } = await makeGitProject("caso4b", { "e.ts": "contenido e\n" });
    const taskB = createTask({ projectId: projectB.id, modelId: "test-model", prompt: "editar e.ts (nunca se aplica)" });
    await runTask(taskB.id, {
      loopRunner: async () =>
        fakeResult({
          proposals: [{ kind: "edit", relPath: "e.ts", diff: "-contenido e\n+contenido e editado", nextContent: "contenido e editado\n", baselineHash: sha256("contenido e\n"), typeCheck: { status: "ok" } }],
        }),
    });
    await discardTask(taskB.id); // se descarta SIN aplicar nada → nunca hubo commit → la rama se borra
    const branchDeleted = !(await branchExists(dirB, `agent/${taskB.id}`));

    const ok = branchKept && branchDeleted;
    console.log(
      ok
        ? "✅ Rama conservada tras commit exitoso; rama borrada cuando se descarta sin haber commiteado nunca."
        : `❌ Falló. branchKept=${branchKept}, branchDeleted=${branchDeleted}`,
    );
    results.push(ok);
  }

  // --- Caso 5: reconciliación de una APPLYING huérfana simulada ---
  {
    console.log("\n--- Caso 5: una task atascada en APPLYING (crash a mitad de apply) se recupera a READY_FOR_REVIEW ---");
    const { project } = await makeGitProject("caso5", { "f.ts": "contenido f\n" });
    const task = createTask({ projectId: project.id, modelId: "test-model", prompt: "editar f.ts" });
    await runTask(task.id, {
      loopRunner: async () =>
        fakeResult({
          proposals: [{ kind: "edit", relPath: "f.ts", diff: "-contenido f\n+contenido f editado", nextContent: "contenido f editado\n", baselineHash: sha256("contenido f\n"), typeCheck: { status: "ok" } }],
        }),
    });
    // Simula el crash: la task queda en APPLYING sin que ningún proceso la
    // esté corriendo de verdad (no pasa por `applyTask`, que ya se
    // encargaría de resolverla sola).
    transitionTask(task.id, "APPLYING");
    const activeBefore = isTaskActive(task.id);

    const { recoveredApplying } = await reconcileOrphanedTasks();
    const finalTask = getTask(task.id)!;
    const ok = !activeBefore && recoveredApplying.includes(task.id) && finalTask.status === "READY_FOR_REVIEW";
    console.log(
      ok
        ? "✅ La task atascada en APPLYING volvió a READY_FOR_REVIEW vía la reconciliación de boot."
        : `❌ Falló. activeBefore=${activeBefore}, recoveredApplying=${JSON.stringify(recoveredApplying)}, finalTask=${JSON.stringify(finalTask)}`,
    );
    results.push(ok);
  }

  console.log(`\n${results.filter(Boolean).length}/${results.length} casos OK.`);
  if (results.some((r) => !r)) process.exit(1);
}

main().catch((error) => {
  console.error("Error inesperado en la prueba:", error);
  process.exit(1);
});
