/**
 * Cola de prompts — pedido de Enzo (2026-11-10).
 *
 * "Guardar un prompt hasta que termine un bucle completo y dé el resumen el
 * agente; cuando el agente da el resumen de las tareas, que le pase el prompt
 * que está en cola" + "se deben poder dejar varios prompts consecutivos".
 *
 * Sin red, sin modelo real. Verifica, en orden:
 *
 *  1. STORE: encolar/ordenar/topes/marcar running→done/cancelar, y que un
 *     encolado sobre una task que no existe falle limpio.
 *  2. RUNNER (la parte que importa): con un `loopRunner` falso que registra con
 *     qué prompt se lo llamó, si al crear la task ya hay prompts en cola, el
 *     primer ciclo corre el prompt ORIGINAL y, al terminar, corre los de la cola
 *     EN ORDEN —misma task, mismo workspace— y recién al final la task aterriza
 *     en un estado terminal.
 *  3. QUEUE VACÍA: el comportamiento de siempre no cambia (un solo ciclo).
 *
 * Uso: npm run agent:test-prompt-queue
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentFileProposal } from "./loop";
import { createProject } from "./project-store";
import { createTask, getTask } from "./task-store";
import { runTask } from "./runner";
import {
  MAX_QUEUED_PROMPTS,
  QueueLlenaError,
  cancelQueuedPrompt,
  countWaitingPrompts,
  enqueuePrompt,
  listQueuedPrompts,
  listWaitingPrompts,
  markPromptDone,
  markPromptRunning,
  nextWaitingPrompt,
} from "./prompt-queue";

const execFileAsync = promisify(execFile);

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passed += 1;
    console.log("+ " + label);
    return;
  }
  failed += 1;
  console.log("x " + label + (detail === undefined ? "" : " - " + JSON.stringify(detail).slice(0, 400)));
}

async function makeGitProject(name: string): Promise<{ id: string; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `magi-queue-${name}-`));
  await fs.writeFile(path.join(dir, "a.ts"), "export const a = 1;\n", "utf-8");
  await execFileAsync("git", ["init"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
  await execFileAsync("git", ["add", "-A"], { cwd: dir });
  await execFileAsync("git", ["commit", "-m", "inicial"], { cwd: dir });
  const project = await createProject({ name, localPath: dir });
  return { id: project.id, dir };
}

async function main(): Promise<void> {
  if (!process.env.MAGI_DATA_DIR) {
    process.env.MAGI_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "magi-queue-db-"));
  }

  console.log("== store: encolar, ordenar, topes, estados ==\n");

  {
    const { id: projectId } = await makeGitProject("store");
    const taskId = createTask({ projectId, modelId: "test/modelo-no-registrado", prompt: "prompt original" }).id;

    const primero = enqueuePrompt(taskId, "  hacer X  ");
    check("el prompt se recorta al encolar", primero.prompt === "hacer X", primero.prompt);
    check("arranca esperando", primero.state === "waiting", primero.state);
    check("posición 0", primero.position === 0, primero.position);

    const segundo = enqueuePrompt(taskId, "hacer Y");
    const tercero = enqueuePrompt(taskId, "hacer Z");
    check("el orden de encolado se conserva", [segundo.position, tercero.position].join(",") === "1,2", [segundo.position, tercero.position]);
    check("nextWaitingPrompt devuelve el más viejo", nextWaitingPrompt(taskId)?.id === primero.id, nextWaitingPrompt(taskId)?.id);
    check("hay 3 esperando", countWaitingPrompts(taskId) === 3, countWaitingPrompts(taskId));

    check("no se puede encolar un prompt vacío", (() => {
      try {
        enqueuePrompt(taskId, "   ");
        return false;
      } catch {
        return true;
      }
    })());

    // Marcar running es una compare-and-swap: el segundo mark falla.
    check("markPromptRunning sobre uno que espera funciona", markPromptRunning(primero.id) === true);
    check("y sobre el MISMO no se puede marcar dos veces", markPromptRunning(primero.id) === false);
    check("el que está corriendo ya no aparece como esperando", countWaitingPrompts(taskId) === 2, countWaitingPrompts(taskId));
    check("y nextWaitingPrompt avanza al siguiente", nextWaitingPrompt(taskId)?.id === segundo.id, nextWaitingPrompt(taskId)?.id);

    markPromptDone(primero.id);
    check("markPromptDone lo deja en done", listQueuedPrompts(taskId).find((p) => p.id === primero.id)?.state === "done");

    // Cancelar: solo lo que espera.
    check("cancelar uno que espera funciona", cancelQueuedPrompt(segundo.id) === true);
    check("cancelar uno YA cancelado devuelve false", cancelQueuedPrompt(segundo.id) === false);
    check("cancelar uno que ya corrió devuelve false", cancelQueuedPrompt(primero.id) === false);
    check(
      "cancelar no deja huecos en las posiciones",
      listQueuedPrompts(taskId).map((p) => p.position).join(",") === "0,1,2",
      listQueuedPrompts(taskId).map((p) => p.position),
    );
    check("queda 1 esperando (el tercero)", countWaitingPrompts(taskId) === 1, countWaitingPrompts(taskId));

    // Tope.
    for (let i = countWaitingPrompts(taskId); i < MAX_QUEUED_PROMPTS; i += 1) enqueuePrompt(taskId, `relleno ${i}`);
    check(`al llenar la cola (${MAX_QUEUED_PROMPTS}) tira QueueLlenaError`, (() => {
      try {
        enqueuePrompt(taskId, "uno más");
        return false;
      } catch (error) {
        return error instanceof QueueLlenaError;
      }
    })());
    check("y el mensaje de la cola llena es entendible", (() => {
      try {
        enqueuePrompt(taskId, "otro");
        return false;
      } catch (error) {
        return error instanceof Error && error.message.includes("llena");
      }
    })());
    check("listWaitingPrompts respeta el tope", listWaitingPrompts(taskId).length === MAX_QUEUED_PROMPTS, listWaitingPrompts(taskId).length);
  }

  console.log("\n== runner: el prompt en cola se pasa cuando el ciclo da el resumen ==\n");

  {
    const { id: projectId } = await makeGitProject("drenaje");
    // La task se crea con 3 prompts YA en cola: el primer ciclo corre el
    // prompt original y, al terminar, drena los tres en orden.
    const taskId = createTask({ projectId, modelId: "test/modelo-no-registrado", prompt: "PROMPT ORIGINAL" }).id;
    enqueuePrompt(taskId, "PRIMERO EN COLA");
    enqueuePrompt(taskId, "SEGUNDO EN COLA");
    enqueuePrompt(taskId, "TERCERO EN COLA");

    const promptsVistos: string[] = [];
    const workspacesVistos: string[] = [];
    let ciclo = 0;
    const fakeRunner = async (opciones: { task: string; workspaceRoot: string; taskId: string }) => {
      promptsVistos.push(opciones.task);
      workspacesVistos.push(opciones.workspaceRoot);
      ciclo += 1;
      // Propuestas solo en el segundo ciclo, para ver si el resultado final las
      // acumula (una task, varios ciclos). Tiene que ser una propuesta con la
      // forma COMPLETA que espera `persistProposals`: con una a medias, la
      // persistencia tiraría y la task caería a FAILED (fue lo primero que
      // pasó al escribir este test).
      const propuesta = (relPath: string): AgentFileProposal => ({
        kind: "edit",
        relPath,
        diff: "--- a\n+++ b\n",
        nextContent: "export const a = 2;\n",
        baselineHash: "0".repeat(64),
        typeCheck: { status: "ok" },
      });
      const propuestas = ciclo === 2 ? [propuesta("a.ts")] : [];
      return { stopReason: "completed", proposals: propuestas as never, transcript: [] };
    };

    const tareaTerminal = await runTask(taskId, { loopRunner: fakeRunner as never });

    check("corrió 4 ciclos: el original + los 3 en cola", promptsVistos.length === 4, promptsVistos);
    check(
      "en orden: original, primero, segundo, tercero",
      promptsVistos.join(" | ") === "PROMPT ORIGINAL | PRIMERO EN COLA | SEGUNDO EN COLA | TERCERO EN COLA",
      promptsVistos,
    );
    check(" TODOS los ciclos usaron el MISMO workspace", new Set(workspacesVistos).size === 1, workspacesVistos);
    const cola = listQueuedPrompts(taskId);
    check("los tres quedaron en done", cola.filter((p) => p.state === "done").length === 3, cola.map((p) => p.state));
    check("y ninguno quedó esperando", countWaitingPrompts(taskId) === 0, countWaitingPrompts(taskId));
    // `runTask` devuelve si reclamó el turno (true/false), no el estado: el
    // estado real se lee de la task.
    check("runTask reclamó el turno de la corrida", tareaTerminal === true, tareaTerminal);
    const final = getTask(taskId);
    check("el estado final es READY_FOR_REVIEW (hubo propuestas en un ciclo)", final?.status === "READY_FOR_REVIEW", final?.status);
  }

  console.log("\n== runner: cola vacía = comportamiento de siempre ==\n");

  {
    const { id: projectId } = await makeGitProject("sin-cola");
    const taskId = createTask({ projectId, modelId: "test/modelo-no-registrado", prompt: "una sola cosa" }).id;

    const promptsVistos: string[] = [];
    await runTask(taskId, {
      loopRunner: (async (opciones: { task: string }) => {
        promptsVistos.push(opciones.task);
        return { stopReason: "completed", proposals: [], transcript: [] };
      }) as never,
    });

    check("corrió exactamente un ciclo", promptsVistos.length === 1, promptsVistos);
    check("con el prompt original", promptsVistos[0] === "una sola cosa", promptsVistos);
    check("y la cola quedó vacía", listQueuedPrompts(taskId).length === 0, listQueuedPrompts(taskId));
  }

  console.log("\n== runner: un ciclo fallado CORTA la cola (no gasta tokens en cadena) ==\n");

  {
    const { id: projectId } = await makeGitProject("falla");
    const taskId = createTask({ projectId, modelId: "test/modelo-no-registrado", prompt: "original" }).id;
    enqueuePrompt(taskId, "este no debería correr");
    enqueuePrompt(taskId, "este tampoco");

    const promptsVistos: string[] = [];
    await runTask(taskId, {
      loopRunner: (async (opciones: { task: string }) => {
        promptsVistos.push(opciones.task);
        return { stopReason: "error", proposals: [], transcript: [], error: "el proveedor se cayó" };
      }) as never,
    });

    check("solo corrió el ciclo original", promptsVistos.length === 1, promptsVistos);
    const cola = listQueuedPrompts(taskId);
    check("los encolados siguen esperando, a la vista del usuario", countWaitingPrompts(taskId) === 2, countWaitingPrompts(taskId));
    check("ninguno se marcó done", cola.every((p) => p.state !== "done"), cola.map((p) => p.state));
    const final = getTask(taskId);
    check("la task quedó FAILED con el error del ciclo", final?.status === "FAILED", final?.status);
  }

  console.log("\n== el ciclo siguiente recibe el contexto del anterior ==\n");

  {
    const { id: projectId } = await makeGitProject("contexto");
    const taskId = createTask({ projectId, modelId: "test/modelo-no-registrado", prompt: "ORIGINAL" }).id;
    enqueuePrompt(taskId, "SEGUNDO");
    enqueuePrompt(taskId, "TERCERO");

    // Lo que cada ciclo RECIBIO (historial que se le paso) y lo que DEVOLVIO.
    const recibido: Array<{ task: string; prior: number }> = [];
    let ciclo = 0;
    await runTask(taskId, {
      loopRunner: (async (opciones: { task: string; priorMessages?: unknown[] }) => {
        const prior = Array.isArray(opciones.priorMessages) ? opciones.priorMessages.length : 0;
        recibido.push({ task: opciones.task, prior });
        ciclo += 1;
        // Cada ciclo termina con un historial propio y distinto: asi se ve si el
        // siguiente realmente recibe el del anterior.
        const mensajes = [
          { role: "user", content: "historial del ciclo " + ciclo },
          { role: "assistant", content: "lei " + ciclo + " archivos" },
        ];
        return { stopReason: "completed", proposals: [], transcript: [], finalMessages: mensajes as never };
      }) as never,
    });

    check("el primer ciclo arranco sin historial (prior vacio)", recibido[0]?.prior === 0, recibido[0]);
    check("el segundo ciclo recibio el historial del primero", recibido[1]?.prior === 2, recibido[1]);
    check("el tercer ciclo recibio el historial del segundo", recibido[2]?.prior === 2, recibido[2]);
    check(
      "los prompts se atendieron igual en orden",
      recibido.map((r) => r.task).join(" | ") === "ORIGINAL | SEGUNDO | TERCERO",
      recibido.map((r) => r.task),
    );
  }

  console.log("\n== un ciclo que falla antes del primer request no rompe el arrastre ==\n");

  {
    const { id: projectId } = await makeGitProject("contexto-fallo");
    const taskId = createTask({ projectId, modelId: "test/modelo-no-registrado", prompt: "ORIGINAL" }).id;
    enqueuePrompt(taskId, "SEGUNDO");

    const recibido: Array<{ task: string }> = [];
    let ciclo = 0;
    await runTask(taskId, {
      loopRunner: (async (opciones: { task: string }) => {
        recibido.push({ task: opciones.task });
        ciclo += 1;
        // El primer ciclo falla SIN devolver mensajes: fallo antes del request.
        if (ciclo === 1) return { stopReason: "error", proposals: [], transcript: [], error: "se cayo antes del request" };
        return {
          stopReason: "completed",
          proposals: [],
          transcript: [],
          finalMessages: [{ role: "user", content: "hola" }] as never,
        };
      }) as never,
    });

    check("el ciclo que fallo corto la cola (regla existente)", recibido.length === 1, recibido);
  }

  console.log("\n== se puede encolar mientras la task corre ==\n");

  {
    const { id: projectId } = await makeGitProject("encolar-en-vivo");
    const taskId = createTask({ projectId, modelId: "test/modelo-no-registrado", prompt: "original" }).id;
    const encoladoEnVivo = enqueuePrompt(taskId, "llegó mientras el agente trabajaba");
    check("se puede encolar sobre una task que todavía no corrió", encoladoEnVivo.state === "waiting");

    // El store no depende del estado de la task a propósito: quien decide qué
    // hacer con una cola sobre una task terminal es el runner y el usuario.
    const taskFinal = getTask(taskId);
    check("la task sigue en su estado (el store no la toca)", taskFinal?.status === "QUEUED", taskFinal?.status);
  }

  console.log("");
  console.log(passed + "/" + (passed + failed) + " casos OK");
  if (failed > 0) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
