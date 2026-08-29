/**
 * Prueba de aceptación de la Fase 2H (ver diseño de Fase 2, sección 20):
 * los endpoints REST y el SSE con replay desde `seq`. Llama a los route
 * handlers de Next.js DIRECTAMENTE (son funciones `(Request, {params}) =>
 * Response` normales, sin necesitar un server real levantado — mismo
 * espíritu que el resto de las pruebas de esta fase: nada de HTTP de
 * verdad, nada de un modelo real corriendo).
 *
 * El caso central (prueba de aceptación de 2H): una task en RUNNING con
 * eventos ya emitidos, conectada por SSE — confirmar que una conexión
 * NUEVA (simula "reabrir el navegador") siempre trae el historial
 * completo desde el principio, que los eventos que se agregan DESPUÉS de
 * conectarse llegan igual por el mismo stream (el poll en vivo), y que al
 * llegar a un estado no-streaming el stream se cierra solo.
 *
 * Uso: npm run agent:test-agent-routes
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createTask, getTask } from "./task-store";
import { appendEvent } from "./event-log";
import { persistProposals, getProposalsForTask } from "./proposal-store";
import { transitionAndLog } from "./runner";
import { GET as listProjectsRoute, POST as createProjectRoute } from "../../app/api/agent/projects/route";
import { GET as listModelsRoute } from "../../app/api/agent/models/route";
import { GET as listTasksRoute, POST as createTaskRoute } from "../../app/api/agent/tasks/route";
import { GET as getTaskRoute } from "../../app/api/agent/tasks/[id]/route";
import { GET as getProposalsRoute } from "../../app/api/agent/tasks/[id]/proposals/route";
import { GET as getEventsRoute } from "../../app/api/agent/tasks/[id]/events/route";
import { POST as discardRoute } from "../../app/api/agent/tasks/[id]/discard/route";
import { POST as cancelRoute } from "../../app/api/agent/tasks/[id]/cancel/route";

const execFileAsync = promisify(execFile);

async function makeGitProject(name: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `consenso-ia-test2h-${name}-`));
  await fs.writeFile(path.join(dir, "README.md"), "proyecto de prueba\n");
  await execFileAsync("git", ["init"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
  await execFileAsync("git", ["add", "-A"], { cwd: dir });
  await execFileAsync("git", ["commit", "-m", "inicial"], { cwd: dir });
  return dir;
}

function jsonRequest(url: string, method: string, body?: unknown): Request {
  return new Request(url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function readJson(response: Response): Promise<any> {
  return response.json();
}

/** Lee el body de un `Response` de SSE como texto, con un timeout total,
 * parseando los bloques `id:`/`event:`/`data:` separados por línea en
 * blanco al formato mínimo que necesita el test. No corta la conexión —
 * eso lo hace el caller con `reader.cancel()`. */
type SseChunk = { id?: string; event?: string; data: string };

function parseSse(raw: string): SseChunk[] {
  return raw
    .split("\n\n")
    .filter((block) => block.trim().length > 0)
    .map((block) => {
      const lines = block.split("\n");
      const chunk: SseChunk = { data: "" };
      for (const line of lines) {
        if (line.startsWith("id: ")) chunk.id = line.slice(4);
        else if (line.startsWith("event: ")) chunk.event = line.slice(7);
        else if (line.startsWith("data: ")) chunk.data = line.slice(6);
      }
      return chunk;
    });
}

/** Lee del stream hasta que `predicate(acumulado)` de `true`, o hasta
 * agotar `maxReads` lecturas — cada `reader.read()` entrega UN chunk
 * (`controller.enqueue` en el handler produce un ítem de cola por llamada,
 * y una sola vuelta del `setInterval` del endpoint puede encolar varios:
 * un evento por cada fila nueva de `agent_events` + un snapshot `task`),
 * así que hace falta más de una lectura por *tick* de polling para juntar
 * todo. Deliberadamente NO usa un `Promise.race` con timeout por lectura:
 * eso deja la lectura "lenta" flotando sin nadie que la consuma cuando se
 * la abandona por el timeout, y ese chunk se pierde para siempre (se
 * probó y así fue como se manifestó el primer intento de este test) — acá
 * cada `read()` se espera de punta a punta, sin overlap. `maxReads` es la
 * única cota (60 lecturas cubre de sobra varias vueltas del poll de
 * 400ms del endpoint). */
async function readSseUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (chunks: SseChunk[]) => boolean,
  maxReads = 60,
): Promise<{ chunks: SseChunk[]; done: boolean }> {
  const decoder = new TextDecoder();
  let buffer = "";
  for (let i = 0; i < maxReads; i++) {
    const { value, done } = await reader.read();
    if (done) return { chunks: parseSse(buffer), done: true };
    if (value) buffer += decoder.decode(value, { stream: true });
    const chunks = parseSse(buffer);
    if (predicate(chunks)) return { chunks, done: false };
  }
  return { chunks: parseSse(buffer), done: false };
}

async function main() {
  console.log("== Fase 2H — prueba de aceptación (endpoints REST + SSE con replay) ==\n");
  const results: boolean[] = [];

  // --- Caso 1: crear proyecto vía POST, listarlo vía GET ---
  console.log("--- Caso 1: POST /api/agent/projects + GET listado ---");
  const dir = await makeGitProject("caso1");
  const createProjectRes = await createProjectRoute(jsonRequest("http://localhost/api/agent/projects", "POST", { name: "Proyecto 2H", localPath: dir }));
  const createProjectBody = await readJson(createProjectRes);
  const listProjectsBody = await readJson(await listProjectsRoute());
  const ok1 =
    createProjectRes.status === 201 &&
    createProjectBody.ok === true &&
    createProjectBody.project.localPath === dir &&
    listProjectsBody.projects.some((p: { id: string }) => p.id === createProjectBody.project.id);
  console.log(ok1 ? "✅ Proyecto creado y aparece en el listado." : `❌ Falló. create=${JSON.stringify(createProjectBody)}`);
  results.push(ok1);
  const projectId: string = createProjectBody.project.id;

  // --- Caso 1b: rechazo de body inválido ---
  const badProjectRes = await createProjectRoute(jsonRequest("http://localhost/api/agent/projects", "POST", { name: "" }));
  const ok1b = badProjectRes.status === 400;
  console.log(ok1b ? "✅ POST con body inválido (name vacío, sin localPath) → 400." : `❌ Falló. status=${badProjectRes.status}`);
  results.push(ok1b);

  // --- Caso 2: GET /api/agent/models devuelve solo modelos habilitados ---
  console.log("\n--- Caso 2: GET /api/agent/models ---");
  const modelsBody = await readJson(await listModelsRoute());
  const ok2 = modelsBody.ok === true && Array.isArray(modelsBody.models) && modelsBody.models.length > 0 && modelsBody.models.every((m: { id: string }) => typeof m.id === "string");
  console.log(ok2 ? `✅ ${modelsBody.models.length} modelo(s) habilitado(s) para el Coding Agent.` : `❌ Falló. ${JSON.stringify(modelsBody)}`);
  results.push(ok2);
  const modelId: string = modelsBody.models[0].id;

  // --- Caso 3: POST tasks rechaza projectId inexistente y modelId no habilitado ---
  console.log("\n--- Caso 3: POST /api/agent/tasks — rechazos ---");
  const badProjectTaskRes = await createTaskRoute(jsonRequest("http://localhost/api/agent/tasks", "POST", { projectId: "no-existe", modelId, prompt: "algo" }));
  const badModelTaskRes = await createTaskRoute(jsonRequest("http://localhost/api/agent/tasks", "POST", { projectId, modelId: "modelo-inexistente-xyz", prompt: "algo" }));
  const ok3 = badProjectTaskRes.status === 404 && badModelTaskRes.status === 400;
  console.log(ok3 ? "✅ projectId inexistente → 404, modelId no habilitado → 400." : `❌ Falló. project=${badProjectTaskRes.status}, model=${badModelTaskRes.status}`);
  results.push(ok3);

  // --- Caso 4: task manejada a mano (sin loop real) progresando por los endpoints ---
  console.log("\n--- Caso 4: ciclo de vida completo de una task vía los endpoints, con SSE en vivo ---");
  const task = createTask({ projectId, modelId, prompt: "tarea de prueba 2H" });
  transitionAndLog(task.id, "RUNNING");
  appendEvent(task.id, { type: "text", text: "arrancando" });
  appendEvent(task.id, { type: "tool_call", toolName: "read_file", input: { path: "a.ts" } });

  const getTaskBody = await readJson(await getTaskRoute(new Request("http://localhost"), { params: Promise.resolve({ id: task.id }) }));
  const ok4a = getTaskBody.ok === true && getTaskBody.task.status === "RUNNING";
  console.log(ok4a ? "✅ GET /api/agent/tasks/[id] refleja RUNNING." : `❌ Falló. ${JSON.stringify(getTaskBody)}`);
  results.push(ok4a);

  // Primera conexión SSE ("abrí la task por primera vez") — debe traer los
  // 3 eventos ya emitidos: el status_change QUEUED→RUNNING (que emite
  // `transitionAndLog` solo, seq 0) + los 2 que agregamos a mano (seq 1 y 2).
  const sseReq1 = new Request(`http://localhost/api/agent/tasks/${task.id}/events`);
  const sseRes1 = await getEventsRoute(sseReq1, { params: Promise.resolve({ id: task.id }) });
  const reader1 = sseRes1.body!.getReader();
  const { chunks: chunks1 } = await readSseUntil(reader1, (chunks) => chunks.some((c) => c.event === "task"));
  const dataChunks1 = chunks1.filter((c) => !c.event);
  const ok4b =
    sseRes1.headers.get("content-type")?.includes("text/event-stream") === true &&
    dataChunks1.length === 3 &&
    dataChunks1[0].id === "0" &&
    dataChunks1[1].id === "1" &&
    dataChunks1[2].id === "2";
  console.log(ok4b ? "✅ Primera conexión SSE trae los 3 eventos ya emitidos (seq 0, 1 y 2), en orden." : `❌ Falló. chunks=${JSON.stringify(chunks1)}`);
  results.push(ok4b);

  // "Reabrir el navegador" MIENTRAS la task sigue RUNNING: una conexión
  // nueva e independiente, SIN sinceSeq, tiene que traer el historial
  // COMPLETO de nuevo — no perder nada, no depender de la primera conexión.
  const sseReq2 = new Request(`http://localhost/api/agent/tasks/${task.id}/events`);
  const sseRes2 = await getEventsRoute(sseReq2, { params: Promise.resolve({ id: task.id }) });
  const reader2 = sseRes2.body!.getReader();
  const { chunks: chunks2 } = await readSseUntil(reader2, (chunks) => chunks.some((c) => c.event === "task"));
  const dataChunks2 = chunks2.filter((c) => !c.event);
  const ok4c = dataChunks2.length === 3;
  console.log(ok4c ? "✅ Una SEGUNDA conexión (simulando reabrir el navegador) también trae el historial completo, no cero eventos." : `❌ Falló. chunks=${JSON.stringify(chunks2)}`);
  results.push(ok4c);
  await reader2.cancel();

  // Progreso EN VIVO: se agrega un evento nuevo (seq 3) mientras la primera
  // conexión sigue abierta — tiene que llegar por el MISMO stream, sin
  // reconectar.
  appendEvent(task.id, { type: "typecheck_result", success: true });
  const { chunks: liveChunks } = await readSseUntil(reader1, (chunks) => chunks.some((c) => !c.event && c.id === "3"));
  const liveEvent = liveChunks.find((c) => !c.event && c.id === "3");
  const ok4d = liveEvent !== undefined && JSON.parse(liveEvent.data).payload.type === "typecheck_result";
  console.log(ok4d ? "✅ Un evento agregado DESPUÉS de conectarse (seq 3) llega igual por el mismo stream (poll en vivo)." : `❌ Falló: el evento nuevo no llegó por el stream ya abierto. liveChunks=${JSON.stringify(liveChunks)}`);
  results.push(ok4d);

  // La task pasa a READY_FOR_REVIEW con una proposal — el stream debe
  // cerrarse solo apenas deja de estar en QUEUED/RUNNING.
  persistProposals(task.id, [
    { kind: "edit", relPath: "a.ts", diff: "-viejo\n+nuevo", nextContent: "nuevo\n", baselineHash: "hash-a", typeCheck: { status: "ok" } },
  ]);
  transitionAndLog(task.id, "READY_FOR_REVIEW");
  const { chunks: closingChunks, done: streamDone } = await readSseUntil(
    reader1,
    (chunks) => chunks.some((c) => c.event === "task" && JSON.parse(c.data).status === "READY_FOR_REVIEW"),
  );
  const finalSnapshot = closingChunks.filter((c) => c.event === "task").pop();
  const ok4e = finalSnapshot !== undefined && JSON.parse(finalSnapshot.data).status === "READY_FOR_REVIEW";
  console.log(ok4e ? "✅ Al pasar a READY_FOR_REVIEW, el snapshot 'task' del stream lo refleja." : `❌ Falló. closingChunks=${JSON.stringify(closingChunks)}`);
  results.push(ok4e);
  // El próximo read() debe resolver con done=true: el handler cierra el
  // stream apenas nota (en su siguiente tick de poll) que ya no está en
  // QUEUED/RUNNING — no debería hacer falta esperar más de una lectura extra.
  const { done: eventuallyDone } = await readSseUntil(reader1, () => false, 3);
  console.log(eventuallyDone || streamDone ? "✅ El stream se cierra solo al salir de QUEUED/RUNNING." : "⚠️  El stream no se cerró todavía (no bloqueante para el resto de la prueba).");
  results.push(eventuallyDone || streamDone);

  // --- Caso 5: GET proposals refleja applied/conflict ---
  const proposalsBody = await readJson(await getProposalsRoute(new Request("http://localhost"), { params: Promise.resolve({ id: task.id }) }));
  const ok5 = proposalsBody.ok === true && proposalsBody.proposals.length === 1 && proposalsBody.proposals[0].applied === false && proposalsBody.proposals[0].conflict === false && proposalsBody.proposals[0].relPath === "a.ts";
  console.log(ok5 ? "✅ GET proposals devuelve la proposal con applied/conflict en false." : `❌ Falló. ${JSON.stringify(proposalsBody)}`);
  results.push(ok5);

  // --- Caso 6: discard — rechazo fuera de READY_FOR_REVIEW, éxito en READY_FOR_REVIEW ---
  console.log("\n--- Caso 6: POST discard ---");
  const otherTask = createTask({ projectId, modelId, prompt: "otra tarea, sigue en QUEUED" });
  const discardQueuedRes = await discardRoute(new Request("http://localhost", { method: "POST" }), { params: Promise.resolve({ id: otherTask.id }) });
  const ok6a = discardQueuedRes.status === 409;
  console.log(ok6a ? "✅ Descartar una task en QUEUED (no READY_FOR_REVIEW) → 409." : `❌ Falló. status=${discardQueuedRes.status}`);
  results.push(ok6a);

  const discardReadyRes = await discardRoute(new Request("http://localhost", { method: "POST" }), { params: Promise.resolve({ id: task.id }) });
  const discardReadyBody = await readJson(discardReadyRes);
  const ok6b = discardReadyRes.status === 200 && discardReadyBody.task.status === "DISCARDED" && discardReadyBody.task.discardReason === "user";
  console.log(ok6b ? "✅ Descartar una task en READY_FOR_REVIEW → 200, status=DISCARDED." : `❌ Falló. ${JSON.stringify(discardReadyBody)}`);
  results.push(ok6b);

  const discardAgainRes = await discardRoute(new Request("http://localhost", { method: "POST" }), { params: Promise.resolve({ id: task.id }) });
  const ok6c = discardAgainRes.status === 409;
  console.log(ok6c ? "✅ Descartar de nuevo una task ya DISCARDED → 409 (no se puede dos veces)." : `❌ Falló. status=${discardAgainRes.status}`);
  results.push(ok6c);

  // --- Caso 7: cancel best-effort cuando no hay corrida activa en memoria ---
  console.log("\n--- Caso 7: POST cancel sin corrida activa en memoria ---");
  const cancelRes = await cancelRoute(new Request("http://localhost", { method: "POST" }), { params: Promise.resolve({ id: otherTask.id }) });
  const cancelBody = await readJson(cancelRes);
  const ok7 = cancelRes.status === 200 && cancelBody.ok === true && cancelBody.cancelled === false;
  console.log(ok7 ? "✅ Cancelar una task sin proceso activo en memoria → 200, cancelled=false (no es un error)." : `❌ Falló. ${JSON.stringify(cancelBody)}`);
  results.push(ok7);

  // --- Caso 8: GET tasks filtrado por projectId ---
  const listTasksRes = await listTasksRoute(new Request(`http://localhost/api/agent/tasks?projectId=${projectId}`));
  const listTasksBody = await readJson(listTasksRes);
  const ok8 = listTasksBody.ok === true && listTasksBody.tasks.length >= 2 && listTasksBody.tasks.every((t: { projectId: string }) => t.projectId === projectId);
  console.log(ok8 ? `✅ GET tasks?projectId= devuelve ${listTasksBody.tasks.length} tasks, todas del proyecto correcto.` : `❌ Falló. ${JSON.stringify(listTasksBody)}`);
  results.push(ok8);

  console.log(`\n${results.filter(Boolean).length}/${results.length} casos OK.`);
  if (results.some((r) => !r)) process.exit(1);
}

main().catch((error) => {
  console.error("Error inesperado en la prueba:", error);
  process.exit(1);
});
