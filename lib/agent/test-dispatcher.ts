/**
 * Prueba de aceptación de la Fase 3 (ver `fase3-diseno-corregido.md`,
 * sección 14): dispatcher, índice único a nivel SQLite, tope de
 * reintentos automáticos, `READY_FOR_REVIEW` no bloqueante, historial de
 * workspaces 1:N, y reconciliación tolerante a workspaces rotos.
 *
 * No depende de un modelo real (mismo patrón que el resto de la Fase 2/3:
 * `loopRunner` fake, o directamente manipulando `task-store`/
 * `workspace-manager` para simular crashes sin tener que matar un proceso
 * de verdad).
 *
 * Uso: npm run agent:test-dispatcher
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getDb } from "../db";
import { createProject, type AgentProject } from "./project-store";
import { createTask, getTask, transitionTask, type CodingTask } from "./task-store";
import { runTask, reconcileOrphanedTasks, MAX_AUTO_RESTART_RETRIES } from "./runner";
import { maybeDispatchNext, __resetDispatcherForTests } from "./dispatcher";
import { createWorkspaceForTask } from "./workspace-manager";
import { listWorkspacesForTask } from "./workspace-store";
import { listEvents, eventsToTranscript } from "./event-log";
import { applyTask } from "./apply";
import { POST as createTaskRoute } from "../../app/api/agent/tasks/route";
import { GET as listModelsRoute } from "../../app/api/agent/models/route";
import type { AgentLoopResult } from "./loop";

const execFileAsync = promisify(execFile);

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function makeGitProject(name: string, files: Record<string, string> = { "README.md": "proyecto de prueba\n" }): Promise<{ project: AgentProject; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `consenso-ia-test3-${name}-`));
  for (const [relPath, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, relPath)), { recursive: true });
    await fs.writeFile(path.join(dir, relPath), content);
  }
  await execFileAsync("git", ["init"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
  await execFileAsync("git", ["add", "-A"], { cwd: dir });
  await execFileAsync("git", ["commit", "-m", "inicial"], { cwd: dir });
  const project = await createProject({ name, localPath: dir });
  return { project, dir };
}

function fakeResult(overrides: Partial<AgentLoopResult>): AgentLoopResult {
  return {
    stopReason: "completed",
    steps: 1,
    transcript: ["(resultado simulado)"],
    proposals: [],
    touchedFiles: [],
    ...overrides,
  };
}

/** Un "intento" que llega a crear su workspace y después el proceso
 * "muere" (nunca transiciona a un estado final) — sin esto, simular varios
 * restarts consecutivos no generaría workspaces reales para poder verificar
 * después el historial (`agent_workspaces` 1:N) ni el transcript. */
async function simulateOrphanedRunningAttempt(task: CodingTask, project: AgentProject): Promise<void> {
  transitionTask(task.id, "RUNNING");
  await createWorkspaceForTask(getTask(task.id)!, project);
  // No se llama a ningún transitionAndLog de cierre — el "proceso" muere acá.
}

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text, "utf-8").digest("hex");
}

async function main() {
  console.log("== Fase 3 — prueba de aceptación (dispatcher, serialización, reintentos) ==\n");
  const results: boolean[] = [];

  // --- Caso 1: el índice único a nivel SQL es la garantía real ---
  {
    console.log("--- Caso 1: índice único parcial rechaza una 2ª RUNNING del mismo proyecto ---");
    const { project } = await makeGitProject("caso1");
    const taskA = createTask({ projectId: project.id, modelId: "test-model", prompt: "A" });
    const taskB = createTask({ projectId: project.id, modelId: "test-model", prompt: "B" });

    const db = getDb();
    db.prepare("UPDATE agent_tasks SET status = 'RUNNING' WHERE id = ?").run(taskA.id);

    let rejected = false;
    try {
      db.prepare("UPDATE agent_tasks SET status = 'RUNNING' WHERE id = ?").run(taskB.id);
    } catch (error) {
      rejected = error instanceof Error && error.message.includes("UNIQUE constraint failed");
    }
    const ok = rejected && getTask(taskA.id)!.status === "RUNNING" && getTask(taskB.id)!.status === "QUEUED";
    console.log(ok ? "✅ El segundo UPDATE directo a RUNNING fue rechazado por SQLite." : "❌ Falló: se permitieron dos RUNNING del mismo proyecto a nivel SQL.");
    results.push(ok);
  }

  // --- Caso 2: doble dispatch, incluso bypaseando la optimización en memoria ---
  {
    console.log("\n--- Caso 2: doble dispatch no arranca dos veces (protección real, no solo el Map) ---");
    __resetDispatcherForTests();
    const { project } = await makeGitProject("caso2");
    const taskA = createTask({ projectId: project.id, modelId: "test-model", prompt: "A" });
    const taskB = createTask({ projectId: project.id, modelId: "test-model", prompt: "B" });

    // loopRunner lento a propósito, para que A siga RUNNING cuando probamos B.
    const state: { resolveA: (() => void) | null } = { resolveA: null };
    const slowLoopRunner = () =>
      new Promise<AgentLoopResult>((resolve) => {
        state.resolveA = () => resolve(fakeResult({}));
      });

    // Arrancamos A directamente con runTask (no vía el dispatcher, para
    // simular "ya está corriendo" sin depender del Map).
    const runA = runTask(taskA.id, { loopRunner: slowLoopRunner });
    await sleep(30); // darle tiempo a que el claim síncrono de A se aplique

    // "Perdemos" la optimización en memoria a propósito — la protección
    // real tiene que venir de la DB, no del Map.
    __resetDispatcherForTests();
    maybeDispatchNext(project.id); // intenta arrancar B igual

    await sleep(30);
    const taskBStillQueued = getTask(taskB.id)!.status === "QUEUED";
    const taskARunning = getTask(taskA.id)!.status === "RUNNING";

    state.resolveA?.();
    await runA;
    await sleep(30);

    const ok = taskBStillQueued && taskARunning;
    console.log(ok ? "✅ B se quedó QUEUED mientras A corría — ni el Map ni la ausencia de él permitieron una doble RUNNING." : `❌ Falló. B=${getTask(taskB.id)!.status}, A(antes)=${taskARunning}`);
    results.push(ok);

    // Tras terminar A, el dispatcher debería poder arrancar B solo.
    maybeDispatchNext(project.id);
    await sleep(50);
    const bEventuallyRan = getTask(taskB.id)!.status !== "QUEUED";
    console.log(bEventuallyRan ? "✅ B arrancó solo apenas A liberó el proyecto." : "❌ B se quedó colgado en QUEUED para siempre.");
    results.push(bEventuallyRan);
  }

  // --- Caso 3: dos POST simultáneos sobre el mismo proyecto, vía el endpoint HTTP real ---
  {
    console.log("\n--- Caso 3: dos POST /api/agent/tasks simultáneos (Promise.all) → solo una arranca ---");
    __resetDispatcherForTests();
    const { project } = await makeGitProject("caso3");
    const modelsBody = await (await listModelsRoute()).json();
    const modelId: string = modelsBody.models[0].id;

    const jsonReq = (prompt: string) =>
      new Request("http://localhost/api/agent/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project.id, modelId, prompt }),
      });

    const [resA, resB] = await Promise.all([createTaskRoute(jsonReq("A")), createTaskRoute(jsonReq("B"))]);
    const [bodyA, bodyB] = await Promise.all([resA.json(), resB.json()]);
    await sleep(50); // el dispatch en sí es async (createWorkspaceForTask, etc.) — darle un respiro

    const statusA = getTask(bodyA.task.id)!.status;
    const statusB = getTask(bodyB.task.id)!.status;
    // Lo único que nos importa acá es la invariante real: nunca las dos a
    // la vez en RUNNING. Qué termine pasando después (una de las dos puede
    // fallar rápido por no tener red hacia un modelo real en este sandbox)
    // no es parte de lo que este caso puntual verifica.
    const neverBothRunning = [statusA, statusB].filter((s) => s === "RUNNING").length <= 1;
    console.log(neverBothRunning ? `✅ Nunca hubo dos RUNNING simultáneas (A=${statusA}, B=${statusB}).` : `❌ Falló. A=${statusA}, B=${statusB}`);
    results.push(neverBothRunning);

    // Limpieza: si alguna quedó RUNNING de verdad (intentando pegarle a un
    // modelo real sin red en este sandbox), la cancelamos para no dejar
    // handles colgados entre casos de prueba.
    const { cancelTask } = await import("./runner");
    cancelTask(bodyA.task.id);
    cancelTask(bodyB.task.id);
    await sleep(20);
  }

  // --- Caso 4: cola FIFO de 3+ tasks del mismo proyecto ---
  {
    console.log("\n--- Caso 4: cola de 3 tasks del mismo proyecto respeta el orden FIFO ---");
    __resetDispatcherForTests();
    const { project } = await makeGitProject("caso4");
    const created: CodingTask[] = [];
    for (const label of ["primera", "segunda", "tercera"]) {
      created.push(createTask({ projectId: project.id, modelId: "test-model", prompt: label }));
      await sleep(5); // asegurar created_at estrictamente creciente
    }

    // Validamos el orden de despacho consumiendo la cola con
    // getOldestQueuedTaskForProject + una transición mínima por vuelta
    // (equivalente a "correr y terminar ya"), sin depender de runAgentLoop.
    const { getOldestQueuedTaskForProject } = await import("./task-store");
    const picked: string[] = [];
    for (let i = 0; i < created.length; i++) {
      const next = getOldestQueuedTaskForProject(project.id);
      if (!next) break;
      picked.push(next.prompt);
      transitionTask(next.id, "RUNNING");
      transitionTask(next.id, "NO_CHANGES");
    }
    const ok = picked.join(",") === "primera,segunda,tercera";
    console.log(ok ? `✅ Orden FIFO respetado: ${picked.join(" → ")}.` : `❌ Falló. orden=${picked.join(",")}`);
    results.push(ok);
  }

  // --- Caso 5: proyectos distintos no se serializan entre sí ---
  {
    console.log("\n--- Caso 5: dos proyectos distintos arrancan en paralelo ---");
    __resetDispatcherForTests();
    const { project: p1 } = await makeGitProject("caso5a");
    const { project: p2 } = await makeGitProject("caso5b");
    const t1 = createTask({ projectId: p1.id, modelId: "test-model", prompt: "p1" });
    const t2 = createTask({ projectId: p2.id, modelId: "test-model", prompt: "p2" });

    const state5: { resolve1: (() => void) | null; resolve2: (() => void) | null } = { resolve1: null, resolve2: null };
    const slow1 = () => new Promise<AgentLoopResult>((r) => { state5.resolve1 = () => r(fakeResult({})); });
    const slow2 = () => new Promise<AgentLoopResult>((r) => { state5.resolve2 = () => r(fakeResult({})); });

    const p1run = runTask(t1.id, { loopRunner: slow1 });
    const p2run = runTask(t2.id, { loopRunner: slow2 });
    await sleep(30);

    const ok = getTask(t1.id)!.status === "RUNNING" && getTask(t2.id)!.status === "RUNNING";
    console.log(ok ? "✅ Ambos proyectos tienen su task RUNNING al mismo tiempo — no se serializan entre sí." : `❌ Falló. p1=${getTask(t1.id)!.status}, p2=${getTask(t2.id)!.status}`);
    results.push(ok);

    state5.resolve1?.();
    state5.resolve2?.();
    await Promise.all([p1run, p2run]);
  }

  // --- Caso 6: READY_FOR_REVIEW no bloqueante ---
  {
    console.log("\n--- Caso 6: READY_FOR_REVIEW no bloquea la siguiente task del mismo proyecto ---");
    __resetDispatcherForTests();
    const { project } = await makeGitProject("caso6");
    const taskA = createTask({ projectId: project.id, modelId: "test-model", prompt: "A" });
    const taskB = createTask({ projectId: project.id, modelId: "test-model", prompt: "B" });

    await runTask(taskA.id, { loopRunner: async () => fakeResult({ proposals: [{ kind: "write", relPath: "x.ts", diff: "+x", nextContent: "x\n", baselineHash: sha256(""), typeCheck: { status: "ok" } }] }) });
    const aStatus = getTask(taskA.id)!.status;

    maybeDispatchNext(project.id);
    await sleep(50);
    const bStatus = getTask(taskB.id)!.status;

    const ok = aStatus === "READY_FOR_REVIEW" && bStatus !== "QUEUED";
    console.log(ok ? `✅ A quedó READY_FOR_REVIEW y B arrancó igual (B=${bStatus}).` : `❌ Falló. A=${aStatus}, B=${bStatus}`);
    results.push(ok);
  }

  // --- Casos 7, 8, 10 y 11: reintentos, tope, historial de workspaces y transcript ---
  {
    console.log("\n--- Casos 7/8/10/11: reintentos automáticos, tope, historial y transcript ---");
    const { project, dir } = await makeGitProject("caso78", { "a.ts": "let a = 1;\n" });
    const task = createTask({ projectId: project.id, modelId: "test-model", prompt: "modificar a.ts" });

    // Intento 1: crashea.
    await simulateOrphanedRunningAttempt(task, project);
    let recon = await reconcileOrphanedTasks();
    let t = getTask(task.id)!;
    const step1Ok = recon.requeued.includes(task.id) && t.status === "QUEUED" && t.restartRetryCount === 1;
    console.log(step1Ok ? "✅ 1er crash → QUEUED, restartRetryCount=1." : `❌ Falló paso 1. status=${t.status}, rrc=${t.restartRetryCount}`);
    results.push(step1Ok);

    // Intento 2: crashea de nuevo.
    await simulateOrphanedRunningAttempt(t, project);
    recon = await reconcileOrphanedTasks();
    t = getTask(task.id)!;
    const step2Ok = recon.requeued.includes(task.id) && t.status === "QUEUED" && t.restartRetryCount === 2;
    console.log(step2Ok ? "✅ 2do crash → QUEUED, restartRetryCount=2." : `❌ Falló paso 2. status=${t.status}, rrc=${t.restartRetryCount}`);
    results.push(step2Ok);

    // Intento 3: esta vez SÍ termina bien (READY_FOR_REVIEW) — Caso 7: el reset.
    await runTask(task.id, {
      loopRunner: async () => fakeResult({ proposals: [{ kind: "edit", relPath: "a.ts", diff: "-let a = 1;\n+let a = 2;", nextContent: "let a = 2;\n", baselineHash: sha256("let a = 1;\n"), typeCheck: { status: "ok" } }] }),
    });
    t = getTask(task.id)!;
    const step3Ok = t.status === "READY_FOR_REVIEW" && t.restartRetryCount === 0;
    console.log(step3Ok ? "✅ Caso 7: el intento exitoso reseteó restartRetryCount a 0." : `❌ Falló Caso 7. status=${t.status}, rrc=${t.restartRetryCount}`);
    results.push(step3Ok);

    // Caso 10: historial de workspaces — 3 filas, las 2 primeras destruidas, la 3ª no.
    const workspaces = listWorkspacesForTask(task.id);
    const finalTaskRow = getTask(task.id)!;
    const historyOk =
      workspaces.length === 3 &&
      workspaces[0].destroyedAt !== null &&
      workspaces[1].destroyedAt !== null &&
      workspaces[2].destroyedAt === null &&
      finalTaskRow.workspaceId === workspaces[2].id;
    console.log(historyOk ? "✅ Caso 10: 3 workspaces en el historial, los 2 primeros destruidos, el 3º activo y apuntado por workspace_id." : `❌ Falló Caso 10. workspaces=${JSON.stringify(workspaces.map((w) => ({ id: w.id, destroyedAt: w.destroyedAt })))}, taskWorkspaceId=${finalTaskRow.workspaceId}`);
    results.push(historyOk);

    // Caso 11: el transcript deja ver los 2 restarts sin ambigüedad.
    const events = listEvents(task.id);
    const transcript = eventsToTranscript(events);
    const requeueMentions = transcript.filter((line) => line.includes("RUNNING") && line.includes("QUEUED")).length;
    const transcriptOk = requeueMentions >= 2 && transcript.some((line) => line.includes("READY_FOR_REVIEW"));
    console.log(transcriptOk ? `✅ Caso 11: el transcript muestra los 2 restarts + el final READY_FOR_REVIEW sin ambigüedad.` : `❌ Falló Caso 11. transcript=${JSON.stringify(transcript)}`);
    results.push(transcriptOk);

    // --- Caso 8 (tarea aparte, para no ensuciar la que ya llegó a buen puerto): tope de reintentos ---
    console.log("\n--- Caso 8: tope de reintentos automáticos → INTERRUPTED ---");
    const task2 = createTask({ projectId: project.id, modelId: "test-model", prompt: "siempre crashea" });
    for (let i = 0; i < MAX_AUTO_RESTART_RETRIES; i++) {
      await simulateOrphanedRunningAttempt(getTask(task2.id)!, project);
      await reconcileOrphanedTasks();
    }
    let t2 = getTask(task2.id)!;
    const beforeCapOk = t2.status === "QUEUED" && t2.restartRetryCount === MAX_AUTO_RESTART_RETRIES;
    console.log(beforeCapOk ? `✅ Tras ${MAX_AUTO_RESTART_RETRIES} crashes: QUEUED, restartRetryCount=${MAX_AUTO_RESTART_RETRIES} (todavía no interrumpida).` : `❌ Falló. status=${t2.status}, rrc=${t2.restartRetryCount}`);
    results.push(beforeCapOk);

    // Un crash más (el 4to) — recién ahora debe interrumpirse.
    await simulateOrphanedRunningAttempt(t2, project);
    const finalRecon = await reconcileOrphanedTasks();
    t2 = getTask(task2.id)!;
    const capOk = finalRecon.interrupted.includes(task2.id) && t2.status === "INTERRUPTED";
    console.log(capOk ? `✅ El ${MAX_AUTO_RESTART_RETRIES + 1}° crash → INTERRUPTED, no se reencola más.` : `❌ Falló. status=${t2.status}`);
    results.push(capOk);

    void dir;
  }

  // --- Caso 9: conflicto de APPLY entre dos tasks del mismo proyecto ---
  {
    console.log("\n--- Caso 9: dos tasks del mismo proyecto, mismo archivo → la 2ª en aplicar detecta el conflicto ---");
    const { project, dir } = await makeGitProject("caso9", { "shared.ts": "let shared = 1;\n" });

    const taskA = createTask({ projectId: project.id, modelId: "test-model", prompt: "A toca shared.ts" });
    await runTask(taskA.id, {
      loopRunner: async () => fakeResult({ proposals: [{ kind: "edit", relPath: "shared.ts", diff: "-let shared = 1;\n+let shared = 2; // de A", nextContent: "let shared = 2; // de A\n", baselineHash: sha256("let shared = 1;\n"), typeCheck: { status: "ok" } }] }),
    });

    const taskB = createTask({ projectId: project.id, modelId: "test-model", prompt: "B también toca shared.ts" });
    await runTask(taskB.id, {
      loopRunner: async () => fakeResult({ proposals: [{ kind: "edit", relPath: "shared.ts", diff: "-let shared = 1;\n+let shared = 2; // de B", nextContent: "let shared = 2; // de B\n", baselineHash: sha256("let shared = 1;\n"), typeCheck: { status: "ok" } }] }),
    });

    const applyA = await applyTask(taskA.id);
    const contentAfterA = await fs.readFile(path.join(dir, "shared.ts"), "utf-8");
    const applyB = await applyTask(taskB.id);
    const contentAfterB = await fs.readFile(path.join(dir, "shared.ts"), "utf-8");

    const ok =
      applyA.status === "APPLIED" &&
      contentAfterA === "let shared = 2; // de A\n" &&
      applyB.status === "READY_FOR_REVIEW" &&
      applyB.conflictedPaths.includes("shared.ts") &&
      contentAfterB === "let shared = 2; // de A\n"; // NUNCA se sobrescribió con la versión de B
    console.log(
      ok
        ? "✅ A aplicó primero sin problema; B detectó el conflicto en shared.ts y NO sobrescribió el cambio de A."
        : `❌ Falló. applyA=${JSON.stringify(applyA)}, applyB=${JSON.stringify(applyB)}, contenido final="${contentAfterB.trim()}"`,
    );
    results.push(ok);
  }

  // --- Caso 12: reconciliación tolera un workspace roto/ausente sin tirar excepción ---
  {
    console.log("\n--- Caso 12: reconciliación tolera task RUNNING sin workspace, y con directorio ya borrado ---");
    const { project } = await makeGitProject("caso12");

    // 12a: RUNNING sin ningún workspace asociado (createWorkspaceForTask nunca se llamó).
    const taskNoWorkspace = createTask({ projectId: project.id, modelId: "test-model", prompt: "sin workspace" });
    transitionTask(taskNoWorkspace.id, "RUNNING");
    let threw = false;
    try {
      await reconcileOrphanedTasks();
    } catch {
      threw = true;
    }
    const noWorkspaceOk = !threw && getTask(taskNoWorkspace.id)!.status === "QUEUED";
    console.log(noWorkspaceOk ? "✅ RUNNING sin workspace: reconciliación no tira excepción, reencola igual." : "❌ Falló: tiró excepción o no reencoló.");
    results.push(noWorkspaceOk);

    // 12b: RUNNING con workspace registrado pero el directorio ya no existe en disco.
    const taskBrokenWorkspace = createTask({ projectId: project.id, modelId: "test-model", prompt: "workspace roto" });
    await simulateOrphanedRunningAttempt(taskBrokenWorkspace, project);
    const workspaces = listWorkspacesForTask(taskBrokenWorkspace.id);
    await fs.rm(workspaces[0].worktreePath, { recursive: true, force: true }); // lo borramos a mano ANTES de reconciliar
    let threw2 = false;
    try {
      await reconcileOrphanedTasks();
    } catch {
      threw2 = true;
    }
    const brokenOk = !threw2 && getTask(taskBrokenWorkspace.id)!.status === "QUEUED";
    console.log(brokenOk ? "✅ RUNNING con directorio ya borrado a mano: reconciliación no tira excepción, reencola igual." : "❌ Falló: tiró excepción o no reencoló.");
    results.push(brokenOk);
  }

  console.log(`\n${results.filter(Boolean).length}/${results.length} casos OK.`);
  if (results.some((r) => !r)) process.exit(1);
}

main().catch((error) => {
  console.error("Error inesperado en la prueba:", error);
  process.exit(1);
});
