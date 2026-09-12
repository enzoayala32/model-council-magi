/**
 * Prueba de aceptación de la Fase 4A (ver `fase4-diseno-v3-final.md`,
 * sección 2): un proyecto sin git no puede producir una task real, en
 * ninguna de las dos capas de validación, y el bug de loop infinito del
 * dispatcher (encontrado revisando el diseño, confirmado leyendo
 * `runner.ts`) queda cerrado.
 *
 * Uso: npm run agent:test-4a-nogit
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createProject } from "./project-store";
import { createTask, getTask } from "./task-store";
import { runTask } from "./runner";
import { maybeDispatchNext, __resetDispatcherForTests } from "./dispatcher";
import { listWorkspacesForTask } from "./workspace-store";
import { POST as createTaskRoute } from "../../app/api/agent/tasks/route";
import { GET as listModelsRoute } from "../../app/api/agent/models/route";
import type { AgentLoopResult } from "./loop";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fakeResult(overrides: Partial<AgentLoopResult>): AgentLoopResult {
  return { stopReason: "completed", steps: 1, transcript: [], proposals: [], touchedFiles: [], ...overrides };
}

async function main() {
  console.log("== Fase 4A — prueba de aceptación (proyectos sin git) ==\n");
  const results: boolean[] = [];

  const modelsBody = await (await listModelsRoute()).json();
  const modelId: string = modelsBody.models[0].id;

  // --- Caso 1: capa PRIMARIA — POST /api/agent/tasks rechaza de entrada, la task ni se crea ---
  {
    console.log("--- Caso 1: POST /api/agent/tasks sobre un proyecto sin git → 400, sin crear nada ---");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "consenso-ia-test4a-primary-"));
    await fs.writeFile(path.join(dir, "marker.txt"), "sin git\n");
    const project = await createProject({ name: "sin-git-primaria", localPath: dir });

    const res = await createTaskRoute(
      new Request("http://localhost/api/agent/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project.id, modelId, prompt: "algo" }),
      }),
    );
    const body = await res.json();
    const ok = res.status === 400 && body.ok === false && typeof body.error === "string" && body.error.includes("no es un repositorio git");
    console.log(ok ? `✅ Rechazado con 400 y mensaje claro: "${body.error}"` : `❌ Falló. status=${res.status}, body=${JSON.stringify(body)}`);
    results.push(ok);
  }

  // --- Caso 2: capa DEFENSIVA — si una task igual se crea (bypaseando la API), runTask falla limpio ---
  {
    console.log("\n--- Caso 2: capa defensiva de runner.ts — task creada a mano sobre proyecto sin git ---");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "consenso-ia-test4a-defensive-"));
    await fs.writeFile(path.join(dir, "marker.txt"), "sin git\n");
    const project = await createProject({ name: "sin-git-defensiva", localPath: dir });
    // Creamos la task directamente en task-store, saltando la capa primaria
    // a propósito — simula el caso borde de una llamada directa a la API
    // vieja, o un project.isGitRepo que cambió después de crear la task.
    const task = createTask({ projectId: project.id, modelId, prompt: "algo" });

    const claimedTheRun = await runTask(task.id, { loopRunner: async () => fakeResult({}) });
    const finalTask = getTask(task.id)!;
    const workspaces = listWorkspacesForTask(task.id);
    const ok =
      claimedTheRun === true &&
      finalTask.status === "FAILED" &&
      typeof finalTask.error === "string" &&
      finalTask.error.includes("no es un repositorio git") &&
      workspaces.length === 0; // nunca debe llegar a crear un workspace
    console.log(
      ok
        ? "✅ runTask no tiró: devolvió true, la task quedó FAILED con mensaje claro, y nunca se creó ningún workspace huérfano."
        : `❌ Falló. claimedTheRun=${claimedTheRun}, status=${finalTask.status}, error=${finalTask.error}, workspaces=${workspaces.length}`,
    );
    results.push(ok);
  }

  // --- Caso 3: el bug real — vía el dispatcher, no debe loopear ni quedar en QUEUED ---
  {
    console.log("\n--- Caso 3: vía el dispatcher — no hay loop infinito, la cola no queda bloqueada ---");
    __resetDispatcherForTests();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "consenso-ia-test4a-dispatcher-"));
    await fs.writeFile(path.join(dir, "marker.txt"), "sin git\n");
    const project = await createProject({ name: "sin-git-dispatcher", localPath: dir });
    const brokenTask = createTask({ projectId: project.id, modelId, prompt: "la que rompe" });
    const healthyTask = createTask({ projectId: project.id, modelId, prompt: "la que debería poder correr después" });

    maybeDispatchNext(project.id);
    await sleep(80); // tiempo de sobra para UN intento (no debería necesitar más de uno)

    const brokenAfter = getTask(brokenTask.id)!;
    const healthyAfter = getTask(healthyTask.id)!;
    const settledOnFirstTry = brokenAfter.status === "FAILED";
    console.log(
      settledOnFirstTry
        ? "✅ La task rota terminó FAILED en el primer intento, no quedó QUEUED reintentando."
        : `❌ Falló. status=${brokenAfter.status} (esperado FAILED)`,
    );
    results.push(settledOnFirstTry);

    // Como la rota falla limpio y libera el slot, la sana del mismo
    // proyecto debería poder arrancar (o al menos ya no estar bloqueada
    // detrás de una QUEUED-para-siempre). Le damos otro respiro: si el
    // proyecto es sin git, ESTA también va a fallar defensivamente — lo
    // que importa acá es que NO se quede colgada esperando un turno que
    // nunca llega por culpa de la rota.
    await sleep(80);
    const healthyFinal = getTask(healthyTask.id)!;
    const queueNotStuck = healthyFinal.status !== "QUEUED";
    console.log(
      queueNotStuck
        ? `✅ La cola no quedó bloqueada — la segunda task también se resolvió (status=${healthyFinal.status}).`
        : "❌ Falló: la segunda task quedó QUEUED para siempre, la cola sigue bloqueada.",
    );
    results.push(queueNotStuck);
    void healthyAfter;
  }

  // --- Caso 4: sanity — un proyecto CON git sigue pudiendo crear tasks normalmente ---
  {
    console.log("\n--- Caso 4: sanity — proyecto CON git no se ve afectado por el fix ---");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "consenso-ia-test4a-git-"));
    await fs.writeFile(path.join(dir, "README.md"), "proyecto con git\n");
    await execFileAsync("git", ["init"], { cwd: dir });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
    await execFileAsync("git", ["add", "-A"], { cwd: dir });
    await execFileAsync("git", ["commit", "-m", "inicial"], { cwd: dir });
    const project = await createProject({ name: "con-git", localPath: dir });

    const res = await createTaskRoute(
      new Request("http://localhost/api/agent/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project.id, modelId, prompt: "algo" }),
      }),
    );
    const body = await res.json();
    const ok = res.status === 201 && body.ok === true && body.task.status === "QUEUED";
    console.log(ok ? "✅ Un proyecto con git sigue creando tasks normalmente (201, QUEUED)." : `❌ Falló. status=${res.status}, body=${JSON.stringify(body)}`);
    results.push(ok);
  }

  console.log(`\n${results.filter(Boolean).length}/${results.length} casos OK.`);
  if (results.some((r) => !r)) process.exit(1);
}

main().catch((error) => {
  console.error("Error inesperado en la prueba:", error);
  process.exit(1);
});
