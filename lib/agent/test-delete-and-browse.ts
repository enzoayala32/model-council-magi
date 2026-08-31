/**
 * Prueba de aceptación de "eliminar tasks viejas" + "navegador de
 * carpetas" (fase posterior a la 3): `DELETE /api/agent/tasks/[id]`
 * (rechaza tasks activas, borra terminadas junto con sus eventos/
 * proposals/workspaces) y `GET /api/agent/browse` (navega subcarpetas del
 * filesystem del server, sin salirse de directorios).
 *
 * Uso: npm run agent:test-delete-and-browse
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createProject } from "./project-store";
import { createTask, getTask, transitionTask } from "./task-store";
import { appendEvent, listEvents } from "./event-log";
import { persistProposals, getProposalsForTask } from "./proposal-store";
import { listWorkspacesForTask } from "./workspace-store";
import { createWorkspaceForTask } from "./workspace-manager";
import { GET as getTaskRoute, DELETE as deleteTaskRoute } from "../../app/api/agent/tasks/[id]/route";
import { GET as browseRoute } from "../../app/api/agent/browse/route";

const execFileAsync = promisify(execFile);

async function makeGitProject(name: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `consenso-ia-test-delbrowse-${name}-`));
  await fs.writeFile(path.join(dir, "README.md"), "proyecto de prueba\n");
  await execFileAsync("git", ["init"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
  await execFileAsync("git", ["add", "-A"], { cwd: dir });
  await execFileAsync("git", ["commit", "-m", "inicial"], { cwd: dir });
  return createProject({ name, localPath: dir });
}

async function main() {
  console.log("== Prueba de aceptación: eliminar tasks + navegador de carpetas ==\n");
  const results: boolean[] = [];

  // --- Caso 1: rechazo de borrar una task activa ---
  {
    console.log("--- Caso 1: DELETE sobre una task QUEUED/RUNNING → 409 ---");
    const project = await makeGitProject("caso1");
    const task = createTask({ projectId: project.id, modelId: "test-model", prompt: "activa" });
    const res = await deleteTaskRoute(new Request("http://localhost", { method: "DELETE" }), { params: Promise.resolve({ id: task.id }) });
    const ok = res.status === 409 && getTask(task.id) !== null;
    console.log(ok ? "✅ Rechazado (409), la task QUEUED sigue existiendo." : `❌ Falló. status=${res.status}`);
    results.push(ok);

    transitionTask(task.id, "RUNNING");
    const res2 = await deleteTaskRoute(new Request("http://localhost", { method: "DELETE" }), { params: Promise.resolve({ id: task.id }) });
    const ok2 = res2.status === 409 && getTask(task.id) !== null;
    console.log(ok2 ? "✅ Rechazado también en RUNNING (409)." : `❌ Falló. status=${res2.status}`);
    results.push(ok2);
  }

  // --- Caso 2: borrado exitoso de una task terminada, con su rastro completo ---
  {
    console.log("\n--- Caso 2: DELETE sobre una task terminada borra events/proposals/workspaces ---");
    const project = await makeGitProject("caso2");
    const task = createTask({ projectId: project.id, modelId: "test-model", prompt: "terminada" });
    transitionTask(task.id, "RUNNING");
    await createWorkspaceForTask(getTask(task.id)!, project);
    appendEvent(task.id, { type: "text", text: "hola" });
    persistProposals(task.id, [{ kind: "write", relPath: "a.ts", diff: "+a", nextContent: "a\n", baselineHash: "h", typeCheck: { status: "ok" } }]);
    transitionTask(task.id, "NO_CHANGES");

    const res = await deleteTaskRoute(new Request("http://localhost", { method: "DELETE" }), { params: Promise.resolve({ id: task.id }) });
    const body = await res.json();
    const gone = getTask(task.id) === null;
    const eventsGone = listEvents(task.id).length === 0;
    const proposalsGone = getProposalsForTask(task.id).length === 0;
    const workspacesGone = listWorkspacesForTask(task.id).length === 0;
    const ok = res.status === 200 && body.ok === true && gone && eventsGone && proposalsGone && workspacesGone;
    console.log(
      ok
        ? "✅ Borrado completo: la task y todo su rastro (eventos/proposals/workspaces) desaparecieron."
        : `❌ Falló. status=${res.status}, gone=${gone}, events=${eventsGone}, proposals=${proposalsGone}, workspaces=${workspacesGone}`,
    );
    results.push(ok);

    const getAfter = await getTaskRoute(new Request("http://localhost"), { params: Promise.resolve({ id: task.id }) });
    const okGet = getAfter.status === 404;
    console.log(okGet ? "✅ GET tras el borrado devuelve 404." : `❌ Falló. status=${getAfter.status}`);
    results.push(okGet);
  }

  // --- Caso 3: borrar una task inexistente → 404 ---
  {
    const res = await deleteTaskRoute(new Request("http://localhost", { method: "DELETE" }), { params: Promise.resolve({ id: "no-existe" }) });
    const ok = res.status === 404;
    console.log(ok ? "\n✅ Caso 3: DELETE de un id inexistente → 404." : `\n❌ Falló Caso 3. status=${res.status}`);
    results.push(ok);
  }

  // --- Caso 4: navegador de carpetas — arranca en homedir, no se sale de directorios reales ---
  {
    console.log("\n--- Caso 4: GET /api/agent/browse ---");
    const res = await browseRoute(new Request("http://localhost/api/agent/browse"));
    const body = await res.json();
    const home = os.homedir();
    const ok = res.status === 200 && body.ok === true && path.resolve(body.path) === path.resolve(home) && Array.isArray(body.entries);
    console.log(ok ? `✅ Sin ?path=, arranca en la carpeta del usuario (${body.path}).` : `❌ Falló. ${JSON.stringify(body)}`);
    results.push(ok);
  }

  // --- Caso 5: navegar a una carpeta puntual y subir con "parent" ---
  {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "consenso-ia-test-browse-"));
    const sub = path.join(dir, "subcarpeta");
    await fs.mkdir(sub);
    await fs.writeFile(path.join(dir, ".oculta_no_debe_verse"), "");
    await fs.mkdir(path.join(dir, ".git"));

    const res = await browseRoute(new Request(`http://localhost/api/agent/browse?path=${encodeURIComponent(dir)}`));
    const body = await res.json();
    const listsSub = body.entries.some((e: { name: string }) => e.name === "subcarpeta");
    const hidesGit = !body.entries.some((e: { name: string }) => e.name === ".git");
    const parentIsCorrect = path.resolve(body.parent) === path.resolve(path.dirname(dir));
    const ok = listsSub && hidesGit && parentIsCorrect;
    console.log(
      ok
        ? "✅ Lista subcarpetas reales, oculta las que empiezan con '.', y 'parent' apunta al directorio de arriba."
        : `❌ Falló. entries=${JSON.stringify(body.entries)}, parent=${body.parent}`,
    );
    results.push(ok);

    const res2 = await browseRoute(new Request(`http://localhost/api/agent/browse?path=${encodeURIComponent(sub)}`));
    const body2 = await res2.json();
    const okNav = path.resolve(body2.parent) === path.resolve(dir);
    console.log(okNav ? "✅ Al entrar a la subcarpeta, 'parent' apunta de vuelta al directorio original." : `❌ Falló. parent=${body2.parent}`);
    results.push(okNav);
  }

  // --- Caso 6: ruta inexistente → error controlado, no 500 crudo ---
  {
    const res = await browseRoute(new Request(`http://localhost/api/agent/browse?path=${encodeURIComponent("/esta/ruta/no/existe/seguro")}`));
    const body = await res.json();
    const ok = res.status === 400 && body.ok === false;
    console.log(ok ? "\n✅ Caso 6: ruta inexistente → 400 con mensaje, no una excepción cruda." : `\n❌ Falló Caso 6. status=${res.status}`);
    results.push(ok);
  }

  console.log(`\n${results.filter(Boolean).length}/${results.length} casos OK.`);
  if (results.some((r) => !r)) process.exit(1);
}

main().catch((error) => {
  console.error("Error inesperado en la prueba:", error);
  process.exit(1);
});
