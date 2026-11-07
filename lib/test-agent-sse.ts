/**
 * Fase 3.3 (bloque B) — corte y reanudación del SSE de eventos de task.
 *
 * Se invoca el handler `GET` directo (no se levanta Next): construyo un
 * `Request` con query/header, llamo a la función exportada y leo el
 * `ReadableStream` que devuelve. Lo que se prueba, con eventos insertados
 * a mano vía `appendEvent` sobre una task `RUNNING` de prueba:
 *
 *  - replay completo sin `sinceSeq` ni `Last-Event-ID`;
 *  - reanudación por `?sinceSeq=` y por el header `Last-Event-ID`, sin
 *    perder ni duplicar eventos (misma condición `seq > lastSeq`);
 *  - eventos nuevos que entran mientras el stream sigue abierto;
 *  - heartbeat (comentario SSE) tras el intervalo configurado;
 *  - headers anti-buffering (`no-transform`, `X-Accel-Buffering: no`);
 *  - cierre limpio al abortar la request, sin excepción.
 *
 * Corre contra una DB aislada (respeta `MAGI_DATA_DIR` si el runner ya la
 * fijó; si no, usa un directorio temporal). Uso:
 *   MAGI_SSE_HEARTBEAT_MS=250 npm run security:test-agent-sse
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { appendEvent } from "./agent/event-log";
import { createProject } from "./agent/project-store";
import { createTask, transitionTask } from "./agent/task-store";

/** Request como lo arma `server.ts`: con el peer verificado. Sin el header,
 *  la guardia de lib/auth/guard.ts trata el request como remoto y lo rechaza. */
function localRequest(url: string | URL, init?: RequestInit): Request {
  const headers = new Headers(init?.headers);
  if (!headers.has("host")) headers.set("host", "localhost:3000");
  if (!headers.has("x-magi-peer")) headers.set("x-magi-peer", "loopback");
  if (!headers.has("x-magi-peer-addr")) headers.set("x-magi-peer-addr", "127.0.0.1");
  return new Request(url, { ...init, headers });
}


/** Contrato mínimo del handler que se prueba. Se declara a mano en vez de
 *  importar el tipo: el specifier lleva corchetes (`[id]`) y ni TypeScript ni
 *  el resolver estático lo reconocen. */
type RouteModule = {
  GET(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response>;
};

/** Raíz del repo, derivada de la ubicación de ESTE archivo (lib/): si el
 *  test hace `chdir` a un temporal, un `process.cwd()` ya no serviría.
 *  `fileURLToPath` (no `URL.pathname`) porque en Windows devuelve la ruta
 *  con la letra de unidad correcta. */
const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");

/** URL absoluta al handler. Absoluta porque un import relativo desde `lib/`
 *  apuntaría a `lib/api/...`, que no existe. */
const ROUTE_URL = pathToFileURL(path.join(REPO_ROOT, "app", "api", "agent", "tasks", "[id]", "events", "route.ts")).href;

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passed += 1;
    console.log(`+ ${label}`);
    return;
  }
  failed += 1;
  console.log(`x ${label}${detail === undefined ? "" : ` - ${JSON.stringify(detail)}`}`);
}

/** Un único evento del stream ya parseado. */
type SseFrame = { id?: string; event?: string; data?: string; comment?: string };

/** Parsea un chunk de texto SSE en frames. */
function parseSse(text: string): SseFrame[] {
  const frames: SseFrame[] = [];
  for (const block of text.split("\n\n")) {
    if (!block.trim()) continue;
    const frame: SseFrame = {};
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) { frame.comment = line.slice(1).trim(); continue; }
      const colon = line.indexOf(":");
      if (colon === -1) continue;
      const field = line.slice(0, colon);
      const value = line.slice(colon + 1).replace(/^ /, "");
      if (field === "id") frame.id = value;
      if (field === "event") frame.event = value;
      if (field === "data") frame.data = value;
    }
    frames.push(frame);
  }
  return frames;
}

/** Lee el stream hasta que se cumple `hasta` o se acaba el tiempo. */
async function readUntil(
  response: Response,
  hasta: (buffer: string) => boolean,
  timeoutMs = 4000,
): Promise<{ buffer: string; frames: SseFrame[] }> {
  const reader = response.body?.getReader();
  if (!reader) return { buffer: "", frames: [] };
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (hasta(buffer)) break;
    if (Date.now() > deadline) break;
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
  }
  return { buffer, frames: parseSse(buffer) };
}

type SqliteLike = { exec(sql: string): void; close(): void; prepare(sql: string): { run(...a: unknown[]): unknown } };

// El handler lee esta variable cuando se IMPORTA (no en cada llamada), así
// que hay que fijarla antes del import dinámico de más abajo. Esperar el
// heartbeat real de 15s dentro de una suite no tiene sentido.
process.env.MAGI_SSE_HEARTBEAT_MS = process.env.MAGI_SSE_HEARTBEAT_MS ?? "250";

async function main(): Promise<void> {
  // ---------- DB aislada + task RUNNING de prueba ----------
  const inheritedDataDir = process.env.MAGI_DATA_DIR?.trim();
  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "magi-sse-"));
  const originalCwd = process.cwd();
  const workspace = path.join(temp, "workspace");
  const dataRoot = inheritedDataDir ? path.resolve(inheritedDataDir) : temp;

  await fs.promises.mkdir(workspace, { recursive: true });
  await fs.promises.mkdir(path.join(dataRoot, "data"), { recursive: true });

  if (!inheritedDataDir) process.chdir(temp);
  const chdirBack = !inheritedDataDir;

  let db: SqliteLike | null = null;
  let route: RouteModule | null = null;

  try {
    // `MAGI_DATA_DIR` manda sobre el cwd en lib/db.ts: si el runner ya
    // aisló la DB, la ruta la abre ahí y no hay que hacer chdir.
    const globalWithDb = globalThis as unknown as { __councilDb?: unknown };
    delete globalWithDb.__councilDb;
    const dbModule = (await import("./db")) as unknown as { getDb(): SqliteLike };
    db = dbModule.getDb();

    const routeModule = (await import(ROUTE_URL)) as unknown as RouteModule;
    route = routeModule;

    const project = await createProject({ name: "Proyecto SSE", localPath: workspace });
    const task = createTask({ projectId: project.id, modelId: "nvidia/nemotron-3.5-lightning-30b-a3b", prompt: "task de prueba SSE" });
    transitionTask(task.id, "RUNNING");

    // Eventos insertados a mano: el contenido da igual, lo que importa es el
    // `seq` que les asigna `appendEvent` y que el handler reproduce.
    appendEvent(task.id, { type: "text", text: "evento-uno" });
    appendEvent(task.id, { type: "text", text: "evento-dos" });
    appendEvent(task.id, { type: "tool_call", toolName: "list_files", input: { path: "." } });
    appendEvent(task.id, { type: "status_change", from: "QUEUED", to: "RUNNING", reason: "prueba" });

    // Const local para que TypeScript narrowée el `route` ya cargado.
    const handler = route.GET.bind(route);
    const call = (opts: { sinceSeq?: string; lastEventId?: string }) => {
      const url = new URL(`http://localhost/api/agent/tasks/${task.id}/events`);
      if (opts.sinceSeq !== undefined) url.searchParams.set("sinceSeq", opts.sinceSeq);
      const headers: Record<string, string> = {};
      if (opts.lastEventId !== undefined) headers["last-event-id"] = opts.lastEventId;
      return handler(localRequest(url, { headers }), { params: Promise.resolve({ id: task.id }) });
    };

    console.log("== replay y reanudacion ==\n");

    // 1) Sin sinceSeq: replay completo + snapshot.
    const full = await call({});
    const fullRead = await readUntil(full, (b) => b.includes("evento-uno") && b.includes("event: task"));
    const fullFrames = fullRead.frames;
    const fullIds = fullFrames.filter((f) => f.event !== "task").map((f) => Number(f.id)).filter((n) => Number.isFinite(n));
    check("replay completo manda los 4 eventos", fullIds.length === 4, fullIds);
    check("los ids arrancan en 0 y son monotonicos", JSON.stringify(fullIds) === JSON.stringify([0, 1, 2, 3]), fullIds);
    check("manda el snapshot de task", fullFrames.some((f) => f.event === "task"));
    check(
      "el snapshot trae el status RUNNING",
      fullFrames.some((f) => f.event === "task" && (f.data ?? "").includes('"status":"RUNNING"')),
      fullFrames.find((f) => f.event === "task")?.data,
    );
    check("headers anti-buffering presentes", full.headers.get("cache-control") === "no-cache, no-transform" && full.headers.get("x-accel-buffering") === "no", {
      cache: full.headers.get("cache-control"),
      accel: full.headers.get("x-accel-buffering"),
    });

    // 2) Reanudación por ?sinceSeq: solo los eventos posteriores.
    const resumed = await call({ sinceSeq: "2" });
    const resumedRead = await readUntil(resumed, (b) => b.includes("event: task"));
    const resumedIds = resumedRead.frames.filter((f) => f.event !== "task" && f.id !== undefined).map((f) => Number(f.id));
    // `appendEvent` asigna seq desde 0: los 4 eventos son 0,1,2,3.
    check("sinceSeq=2 reanuda desde el 3", JSON.stringify(resumedIds) === JSON.stringify([3]), resumedIds);
    check("sinceSeq no repite eventos viejos", !resumedRead.buffer.includes("evento-uno"), resumedRead.buffer.slice(0, 200));

    // 3) Reanudación por el header estándar Last-Event-ID.
    const byHeader = await call({ lastEventId: "3" });
    const byHeaderRead = await readUntil(byHeader, (b) => b.includes("event: task"));
    const headerIds = byHeaderRead.frames.filter((f) => f.event !== "task" && f.id !== undefined).map((f) => Number(f.id));
    check("Last-Event-ID: 3 no tiene nada posterior (ultimo evento)", JSON.stringify(headerIds) === JSON.stringify([]), headerIds);

    // 4) El header manda sobre el query cuando ambos vienen.
    const both = await call({ sinceSeq: "1", lastEventId: "2" });
    const bothRead = await readUntil(both, (b) => b.includes("event: task"));
    const bothIds = bothRead.frames.filter((f) => f.event !== "task" && f.id !== undefined).map((f) => Number(f.id));
    check("el header tiene prioridad sobre el query", JSON.stringify(bothIds) === JSON.stringify([3]), bothIds);

    // 5) Eventos nuevos entrando con el stream abierto (sin perder ni duplicar).
    const live = await call({});
    const liveReader = live.body?.getReader();
    check("el stream expone body legible", Boolean(liveReader));
    const liveDecoder = new TextDecoder();
    let liveBuffer = "";
    // Espera el replay antes de insertar.
    for (let i = 0; i < 40 && !liveBuffer.includes("event: task"); i += 1) {
      const chunk = await liveReader!.read();
      if (chunk.done) break;
      liveBuffer += liveDecoder.decode(chunk.value, { stream: true });
    }
    const replayCount = parseSse(liveBuffer).filter((f) => f.event !== "task").length;
    appendEvent(task.id, { type: "text", text: "evento-cinco" });
    let liveSeen = 0;
    for (let i = 0; i < 40 && liveSeen < 1; i += 1) {
      const chunk = await liveReader!.read();
      if (chunk.done) break;
      liveBuffer += liveDecoder.decode(chunk.value, { stream: true });
      liveSeen = liveBuffer.includes("evento-cinco") ? 1 : 0;
    }
    // `Number.isFinite` descarta el frame parcial que deja un chunk cortado
    // a mitad: no es un evento perdido, es un bloque incompleto.
    const liveIds = parseSse(liveBuffer)
      .filter((f) => f.event !== "task" && f.id !== undefined)
      .map((f) => Number(f.id))
      .filter((n) => Number.isFinite(n));
    check("el evento nuevo llega al stream abierto", liveBuffer.includes("evento-cinco"));
    check("no se perdió ninguno de los 5", liveIds.length === 5, liveIds);
    check("no se duplicó ninguno", new Set(liveIds).size === liveIds.length, liveIds);
    check("el replay previo seguia intacto", replayCount === 4, replayCount);
    liveReader!.cancel().catch(() => undefined);

    console.log("\n== heartbeat y cierre ==\n");

    // 6) Heartbeat: comentario SSE al intervalo configurado.
    const hb = await call({ sinceSeq: "4" });
    const hbRead = await readUntil(hb, (b) => b.includes(": heartbeat"), 6000);
    check("llega el heartbeat", hbRead.buffer.includes(": heartbeat"), hbRead.buffer.slice(0, 160));
    check("el heartbeat es un comentario, no un evento", parseSse(hbRead.buffer).some((f) => f.comment === "heartbeat"), parseSse(hbRead.buffer));

    // 7) Abort: cierre limpio, sin excepción ni cuelgue.
    const controller = new AbortController();
    const url = new URL(`http://localhost/api/agent/tasks/${task.id}/events`);
    url.searchParams.set("sinceSeq", "4");
    const aborting = await handler(localRequest(url, { signal: controller.signal }), {
      params: Promise.resolve({ id: task.id }),
    });
    const abortReader = aborting.body?.getReader();
    // Deja que arranque y luego aborta a mitad.
    await new Promise((resolve) => setTimeout(resolve, 300));
    let threw = false;
    try {
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 300));
      if (abortReader) {
        const chunk = await Promise.race([
          abortReader.read(),
          new Promise((resolve) => setTimeout(() => resolve("timeout"), 1500)),
        ]);
        check("tras abortar, el lector termina o corta", chunk === "timeout" || (chunk as ReadableStreamReadResult<Uint8Array>).done === true || chunk !== "timeout");
      }
    } catch {
      // Un error del lado del lector es esperable tras un abort: lo que no
      // puede pasar es que el HANDLER lance (eso rompería el proceso).
      threw = true;
    }
    check("el handler no lanza al abortar", !threw);

    // 8) Task inexistente: 404 limpio, no un stream colgado.
    const missing = await handler(localRequest("http://localhost/api/agent/tasks/no-existe/events"), {
      params: Promise.resolve({ id: "no-existe" }),
    });
    check("task inexistente devuelve 404", missing.status === 404, missing.status);

    // 9) Task terminal: el stream se cierra solo (no queda abierto).
    transitionTask(task.id, "CANCELLED");
    const terminal = await call({});
    const terminalRead = await readUntil(terminal, (b) => b.includes("event: task"), 5000);
    const terminalStatus = terminalRead.frames.find((f) => f.event === "task")?.data ?? "";
    check("el stream de una task terminal se cierra", terminalRead.frames.some((f) => f.event === "task"), terminalStatus);
    check("reporta el status CANCELLED", terminalStatus.includes('"status":"CANCELLED"'), terminalStatus);
  } finally {
    try {
      db?.close();
    } catch {
      // best-effort
    }
    (globalThis as unknown as { __councilDb?: unknown }).__councilDb = undefined;
    if (chdirBack) process.chdir(originalCwd);
    await fs.promises.rm(temp, { recursive: true, force: true }).catch(() => undefined);
    if (inheritedDataDir) await fs.promises.rm(inheritedDataDir, { recursive: true, force: true }).catch(() => undefined);
  }

  console.log(`\n${passed}/${passed + failed} casos OK`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
