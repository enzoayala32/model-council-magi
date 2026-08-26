/**
 * Prueba de aceptación de la Fase 2C: corre `createWorkspaceForTask` contra
 * un proyecto que ES un repo git y otro que NO lo es, y confirma que cada
 * uno usa el modo correcto (`"worktree"` / `"copy"`), que el contenido
 * quedó accesible en ambos, y que la destrucción limpia todo — incluido el
 * registro persistido en `agent_workspaces`.
 *
 * Uso: npm run agent:test-workspace-manager
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createProject } from "./project-store";
import { createTask, transitionTask } from "./task-store";
import { createWorkspaceForTask, destroyWorkspaceForTask } from "./workspace-manager";
import { getWorkspaceForTask } from "./workspace-store";

const execFileAsync = promisify(execFile);

async function makeGitProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "consenso-ia-test2c-git-"));
  await fs.writeFile(path.join(dir, "README.md"), "proyecto de prueba con git\n");
  await execFileAsync("git", ["init"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
  await execFileAsync("git", ["add", "-A"], { cwd: dir });
  await execFileAsync("git", ["commit", "-m", "inicial"], { cwd: dir });
  return dir;
}

async function makeNonGitProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "consenso-ia-test2c-nogit-"));
  await fs.writeFile(path.join(dir, "marker.txt"), "esto NO es un repo git\n");
  return dir;
}

async function pathExists(p: string): Promise<boolean> {
  return fs.stat(p).then(() => true).catch(() => false);
}

async function testCase(label: string, localPath: string, expectedMode: "worktree" | "copy"): Promise<boolean> {
  console.log(`\n--- ${label} ---`);
  let ok = true;

  const project = await createProject({ name: label, localPath });
  console.log(`Project: isGitRepo=${project.isGitRepo}`);

  const task = createTask({ projectId: project.id, modelId: "test-model", prompt: "tarea de prueba 2C" });
  transitionTask(task.id, "RUNNING");

  const workspace = await createWorkspaceForTask(task, project);
  console.log(`mode: ${workspace.mode} (esperado: ${expectedMode})`);
  if (workspace.mode !== expectedMode) {
    console.log(`❌ Modo incorrecto.`);
    ok = false;
  } else {
    console.log(`✅ Modo correcto.`);
  }

  const contentExists = await pathExists(workspace.worktreePath);
  console.log(contentExists ? "✅ El workspace existe físicamente." : "❌ El workspace NO existe.");
  ok = ok && contentExists;

  const persisted = getWorkspaceForTask(task.id);
  const persistedOk = persisted !== null && persisted.destroyedAt === null && persisted.mode === expectedMode;
  console.log(persistedOk ? "✅ Registro persistido correcto (agent_workspaces)." : "❌ Registro persistido incorrecto o ausente.");
  ok = ok && persistedOk;

  await destroyWorkspaceForTask(workspace);

  const contentGone = !(await pathExists(workspace.worktreePath));
  console.log(contentGone ? "✅ El workspace se destruyó físicamente." : "❌ El workspace sigue existiendo tras destroyWorkspaceForTask.");
  ok = ok && contentGone;

  const persistedAfter = getWorkspaceForTask(task.id);
  const destroyedOk = persistedAfter !== null && persistedAfter.destroyedAt !== null;
  console.log(destroyedOk ? "✅ destroyedAt quedó registrado." : "❌ destroyedAt no se registró.");
  ok = ok && destroyedOk;

  return ok;
}

async function main() {
  console.log("== Fase 2C — prueba de aceptación (Workspace manager: worktree vs. copy) ==");

  const gitDir = await makeGitProject();
  const nonGitDir = await makeNonGitProject();

  const gitOk = await testCase("Proyecto CON git", gitDir, "worktree");
  const nonGitOk = await testCase("Proyecto SIN git", nonGitDir, "copy");

  const allPassed = gitOk && nonGitOk;
  console.log(`\n${allPassed ? "=== PRUEBA DE ACEPTACIÓN 2C: PASS ===" : "=== PRUEBA DE ACEPTACIÓN 2C: FAIL ==="}`);
  if (!allPassed) process.exit(1);
}

main().catch((error) => {
  console.error("Falló la prueba de Fase 2C:", error);
  process.exit(1);
});
