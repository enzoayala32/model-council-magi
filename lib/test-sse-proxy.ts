/**
 * Fase 5.4 — SSE detrás de un proxy HTTP real (buffering + latencia).
 *
 * El test de corte/reanudación (`lib/test-agent-sse.ts`) llama al handler
 * directo. Acá se arma la cadena COMPLETA, con dos servidores HTTP reales:
 *
 *   cliente (fetch, loopback real)
 *     -> proxy de prueba (agrega latencia de conexión y buffering: no
 *        reenvía los chunks al recibirlos, los acumula)
 *     -> server de origen (envuelve el handler de la ruta SSE)
 *
 * Lo que se verifica, que es justo lo que un túnel o un proxy corporativo
 * pueden romper:
 *
 *  - los eventos llegan EN ORDEN y completos (el buffering no los troza ni
 *    los reordena; cada `data` sigue siendo JSON válido);
 *  - el heartbeat mantiene viva la conexión aunque el proxy acumule bytes;
 *  - al cortar la conexión y reconectar con `?sinceSeq=` (o con
 *    `Last-Event-ID`, que es lo que reenvía `EventSource` solo) no se pierde
 *    ni se duplica ningún evento;
 *  - los headers anti-buffering sobreviven el proxy;
 *  - el stream se cierra cuando la task queda en estado terminal.
 *
 * Corre contra una DB aislada (respeta `MAGI_DATA_DIR` si el runner ya la
 * fijó; si no, usa un directorio temporal).
 *
 * Uso: MAGI_SSE_HEARTBEAT_MS=250 npm run security:test-sse-proxy
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { appendEvent } from "./agent/event-log";
import { createProject } from "./agent/project-store";
import { createTask, transitionTask } from "./agent/task-store";

type Handler = (request: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

type RouteModule = { GET: Handler };

/** Un único evento del stream ya parseado. */
type SseFrame = { id?: string; event?: string; data?: string; comment?: string };

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passed += 1;
    console.log("+ " + label);
    return;
  }
  failed += 1;
  const suffix = detail === undefined ? "" : " - " + JSON.stringify(detail);
  console.log("x " + label + suffix);
}

/**
 * Parsea SSE. Solo cuenta los bloques COMPLETOS (terminados en "\n\n"): un
 * chunk cortado a la mitad deja un bloque incompleto, y tratarlo como evento
 * sería inventar uno truncado. El último elemento del split se descarta
 * siempre: si el buffer termina en "\n\n" es el string vacío, y si no, es el
 * bloque a medias.
 */
function parseSse(buffer: string): SseFrame[] {
  const blocks = buffer.split("\n\n");
  blocks.pop();
  const frames: SseFrame[] = [];
  for (const block of blocks) {
    if (!block.trim()) continue;
    const frame: SseFrame = {};
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) {
        frame.comment = line.slice(1).trim();
        continue;
      }
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

/** Ids de evento (sin el snapshot `task`) en orden de llegada. */
function eventIds(frames: SseFrame[]): number[] {
  return frames
    .filter((frame) => frame.event !== "task" && frame.id !== undefined)
    .map((frame) => Number(frame.id))
    .filter((id) => Number.isFinite(id));
}

type ReadResult = { frames: SseFrame[]; buffer: string; done: boolean };

/** Acumulador por conexion: si se descartara, cada lectura perderia lo que
 *  ya entro y pareceria que faltan eventos cuando en realidad ya se leyeron. */
type Sink = { buffer: string };

function newSink(): Sink {
  return { buffer: "" };
}

/**
 * Lee del stream hasta que se cumple `hasta` (recibiendo los frames ya
 * completos), se acaba el tiempo, o el stream se cierra. Lo ya leido en
 * lecturas anteriores de la MISMA conexion sigue en `sink`, asi que los
 * frames devueltos son todos los de la conexion, no solo los nuevos.
 */
async function readFrames(
  reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
  sink: Sink,
  hasta: (frames: SseFrame[]) => boolean = () => false,
  timeoutMs = 6000,
): Promise<ReadResult> {
  if (!reader) return { frames: parseSse(sink.buffer), buffer: sink.buffer, done: true };
  const decoder = new TextDecoder();
  let done = false;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const frames = parseSse(sink.buffer);
    if (hasta(frames)) return { frames, buffer: sink.buffer, done };
    if (Date.now() > deadline) return { frames: parseSse(sink.buffer), buffer: sink.buffer, done };
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch {
      // Conexion cortada: lo que se leyo hasta aca es el resultado.
      return { frames: parseSse(sink.buffer), buffer: sink.buffer, done: true };
    }
    if (chunk.done) {
      done = true;
      return { frames: parseSse(sink.buffer), buffer: sink.buffer, done };
    }
    sink.buffer += decoder.decode(chunk.value, { stream: true });
  }
}

/**
 * Server de origen: envuelve el handler de la ruta SSE en un HTTP server de
 * verdad. Escribe el peer verificado (sería loopback: el proxy corre en la
 * misma máquina) y propaga el corte del cliente al stream del handler.
 */
async function startOrigin(handler: Handler): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === "string") headers.set(key, value);
        else if (Array.isArray(value)) headers.set(key, value.join(", "));
      }
      headers.set("x-magi-peer", "loopback");
      headers.set("x-magi-peer-addr", "127.0.0.1");
      // El id es el segmento anterior a "events": la ruta es
      // /api/agent/tasks/<id>/events. Tomar el último daría "events".
      const segments = url.pathname.split("/").filter(Boolean);
      const taskId = segments[segments.indexOf("events") - 1] ?? "";
      const webRequest = new Request(url, { method: req.method ?? "GET", headers });
      const response = await handler(webRequest, { params: Promise.resolve({ id: taskId }) });

      res.statusCode = response.status;
      response.headers.forEach((value, key) => res.setHeader(key, value));

      const body = response.body;
      if (!body) {
        res.end(Buffer.from(await response.arrayBuffer()));
        return;
      }
      const reader = body.getReader();
      res.on("close", () => {
        void reader.cancel().catch(() => undefined);
      });
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        try {
          res.write(Buffer.from(chunk.value));
        } catch {
          return; // el cliente cortó: el listener de "close" limpia el handler
        }
      }
      res.end();
    })().catch(() => {
      try {
        if (!res.headersSent) res.statusCode = 500;
        res.end("error en el origen");
      } catch {
        /* el cliente ya se fue */
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

type ProxyOptions = { latencyMs: number; bufferMs: number; bufferBytes: number };

/**
 * Proxy de prueba: suma latencia de conexión y hace buffering. El punto del
 * buffering es que NO reenvía cada chunk al llegar: los junta y los manda
 * cuando se acumula `bufferBytes` o pasa `bufferMs`. Es exactamente lo que
 * hace un proxy corporativo o un túnel mal configurado con un SSE.
 */
async function startProxy(originPort: number, options: ProxyOptions): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((clientReq, clientRes) => {
    const forward = () => {
      const upstream = http.request(
        {
          host: "127.0.0.1",
          port: originPort,
          path: clientReq.url,
          method: clientReq.method ?? "GET",
          headers: clientReq.headers,
        },
        (upstreamRes) => {
          clientRes.writeHead(upstreamRes.statusCode ?? 200, upstreamRes.headers);

          let queue: Buffer[] = [];
          let queuedBytes = 0;
          let timer: ReturnType<typeof setTimeout> | null = null;

          const flush = (): void => {
            if (timer) {
              clearTimeout(timer);
              timer = null;
            }
            if (queue.length === 0) return;
            const payload = Buffer.concat(queue);
            queue = [];
            queuedBytes = 0;
            try {
              clientRes.write(payload);
            } catch {
              /* cliente cortado */
            }
          };

          upstreamRes.on("data", (chunk: Buffer) => {
            queue.push(chunk);
            queuedBytes += chunk.length;
            if (!timer) timer = setTimeout(flush, options.bufferMs);
            if (queuedBytes >= options.bufferBytes) flush();
          });
          upstreamRes.on("end", () => {
            flush();
            try {
              clientRes.end();
            } catch {
              /* cliente cortado */
            }
          });
          upstreamRes.on("error", () => clientRes.destroy());
        },
      );
      upstream.on("error", () => clientRes.destroy());
      upstream.end();
    };
    if (options.latencyMs > 0) setTimeout(forward, options.latencyMs);
    else forward();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** Abre el stream por el proxy, con o sin `sinceSeq`/`Last-Event-ID`. */
async function openStream(
  proxyPort: number,
  taskId: string,
  opts: { sinceSeq?: string; lastEventId?: string } = {},
): Promise<{ response: Response; reader: ReadableStreamDefaultReader<Uint8Array> | undefined; abort: () => void }> {
  const url = new URL("http://127.0.0.1:" + proxyPort + "/api/agent/tasks/" + taskId + "/events");
  if (opts.sinceSeq !== undefined) url.searchParams.set("sinceSeq", opts.sinceSeq);
  const headers: Record<string, string> = {};
  if (opts.lastEventId !== undefined) headers["last-event-id"] = opts.lastEventId;
  const controller = new AbortController();
  const response = await fetch(url, { headers, signal: controller.signal });
  return { response, reader: response.body?.getReader(), abort: () => controller.abort() };
}

/** Espera corta, para dar tiempo a que el handler haga su poll. */
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type SqliteLike = { exec(sql: string): void; close(): void };

// El handler lee esta variable cuando se IMPORTA, no en cada llamada: hay que
// fijarla antes del import dinámico.
process.env.MAGI_SSE_HEARTBEAT_MS = process.env.MAGI_SSE_HEARTBEAT_MS ?? "250";

async function main(): Promise<void> {
  const inheritedDataDir = process.env.MAGI_DATA_DIR?.trim();
  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "magi-sse-proxy-"));
  const originalCwd = process.cwd();
  const workspace = path.join(temp, "workspace");
  const dataRoot = inheritedDataDir ? path.resolve(inheritedDataDir) : temp;

  await fs.promises.mkdir(workspace, { recursive: true });
  await fs.promises.mkdir(path.join(dataRoot, "data"), { recursive: true });

  const chdirBack = !inheritedDataDir;
  if (chdirBack) process.chdir(temp);

  let db: SqliteLike | null = null;
  let origin: { port: number; close: () => Promise<void> } | null = null;
  let proxy: { port: number; close: () => Promise<void> } | null = null;

  try {
    const globalWithDb = globalThis as unknown as { __councilDb?: unknown };
    delete globalWithDb.__councilDb;
    const dbModule = (await import("./db")) as unknown as { getDb(): SqliteLike };
    db = dbModule.getDb();

    const routeModule = (await import(
      pathToFileURL(path.join(originalCwd, "app", "api", "agent", "tasks", "[id]", "events", "route.ts")).href
    )) as unknown as RouteModule;

    const project = await createProject({ name: "Proyecto SSE proxy", localPath: workspace });
    const task = createTask({ projectId: project.id, modelId: "nvidia/nemotron-3.5-lightning-30b-a3b", prompt: "task de prueba SSE con proxy" });
    transitionTask(task.id, "RUNNING");
    appendEvent(task.id, { type: "text", text: "evento-uno" });
    appendEvent(task.id, { type: "text", text: "evento-dos" });

    origin = await startOrigin(routeModule.GET.bind(routeModule));
    proxy = await startProxy(origin.port, { latencyMs: 120, bufferMs: 300, bufferBytes: 4096 });

    console.log("== el proxy con buffering no rompe el orden ni los frames ==\n");

    // 1) Replay completo por el proxy.
    const first = await openStream(proxy.port, task.id);
    const firstSink = newSink();
    const firstRead = await readFrames(first.reader, firstSink, (frames) => frames.some((f) => f.event === "task"), 8000);
    const firstIds = eventIds(firstRead.frames);
    check("el replay llega por el proxy", firstIds.length === 2, firstIds);
    check("los eventos llegan en orden", JSON.stringify(firstIds) === JSON.stringify([0, 1]), firstIds);
    check(
      "cada data sigue siendo JSON valido (el buffering no troza frames)",
      firstRead.frames.every((frame) => frame.data === undefined || isValidJson(frame.data)),
      firstRead.frames.filter((frame) => frame.data !== undefined && !isValidJson(frame.data)).map((f) => f.data),
    );
    check("el snapshot de task llega por el proxy", firstRead.frames.some((frame) => frame.event === "task"));
    check(
      "los headers anti-buffering sobreviven el proxy",
      first.response.headers.get("content-type") === "text/event-stream" &&
        first.response.headers.get("x-accel-buffering") === "no" &&
        first.response.headers.get("cache-control") === "no-cache, no-transform",
      {
        type: first.response.headers.get("content-type"),
        accel: first.response.headers.get("x-accel-buffering"),
        cache: first.response.headers.get("cache-control"),
      },
    );
    check("no hubo error de framing (bloques huerfanos)", !firstRead.buffer.includes("\n\n\n\n"), firstRead.buffer.slice(0, 80));
    first.abort();

    console.log("\n== heartbeat con el proxy acumulando bytes ==\n");

    // 2) Eventos nuevos con el stream abierto, por el proxy.
    const live = await openStream(proxy.port, task.id);
    const liveReader = live.reader;
    const liveSink = newSink();
    await readFrames(liveReader, liveSink, (frames) => frames.some((f) => f.event === "task"), 8000);
    appendEvent(task.id, { type: "text", text: "evento-tres" });
    const liveRead = await readFrames(liveReader, liveSink, (frames) => eventIds(frames).includes(3), 8000);
    const liveIds = eventIds(liveRead.frames);
    check("el evento nuevo llega por el proxy", liveRead.buffer.includes("evento-tres"));
    check("siguen en orden y sin duplicados", isStrictlyIncreasing(liveIds), liveIds);
    check("no se perdio el replay previo", liveIds.length === 3, liveIds);
    check(
      "el buffering no corrompio ningun frame",
      liveRead.frames.every((frame) => frame.data === undefined || isValidJson(frame.data)),
    );

    // 3) Heartbeat: el comentario llega aunque el proxy acumule, y el stream
    //    sigue abierto después (siguen entrando eventos).
    const heartbeatRead = await readFrames(liveReader, liveSink, (frames) => frames.some((f) => f.comment === "heartbeat"), 8000);
    check("el heartbeat pasa el proxy", heartbeatRead.buffer.includes(": heartbeat"), heartbeatRead.buffer.slice(0, 120));
    check("el heartbeat es comentario, no evento", heartbeatRead.frames.some((frame) => frame.comment === "heartbeat"));
    appendEvent(task.id, { type: "text", text: "evento-cuatro" });
    const afterHeartbeat = await readFrames(liveReader, liveSink, (frames) => eventIds(frames).includes(4), 8000);
    check("el stream sigue vivo despues del heartbeat", afterHeartbeat.buffer.includes("evento-cuatro"));
    // Los eventos son 0,1,2,3 en este punto (uno, dos, tres, cuatro).
    check("el evento posterior al heartbeat tiene el id correcto", eventIds(afterHeartbeat.frames).includes(3), eventIds(afterHeartbeat.frames));
    live.abort();

    console.log("\n== corte y reanudacion: sin perdida ni duplicacion ==\n");

    // 4) Se corta a mitad del replay y se reanuda con `?sinceSeq=`.
    const cut = await openStream(proxy.port, task.id);
    const cutReader = cut.reader;
    const cutSink = newSink();
    await readFrames(cutReader, cutSink, (frames) => eventIds(frames).length >= 2, 8000);
    const partial = await readFrames(cutReader, cutSink, (frames) => eventIds(frames).length === 2, 3000);
    const seenIds = eventIds(partial.frames);
    // El corte puede caer tras haber leido mas de 2 (la lectura avanza por
    // chunk, no por evento): lo que importa es que sea un prefijo ordenado.
    check("antes del corte se vio un prefijo de eventos", seenIds.length >= 2 && isStrictlyIncreasing(seenIds), seenIds);
    const lastSeen = seenIds[seenIds.length - 1];
    cut.abort();
    await pause(300);

    // Eventos emitidos MIENTRAS el cliente estaba desconectado: si la
    // reanudación perdiera algo, estos no aparecerían.
    appendEvent(task.id, { type: "text", text: "evento-cinco" });
    appendEvent(task.id, { type: "text", text: "evento-seis" });
    appendEvent(task.id, { type: "text", text: "evento-siete" });

    const resumed = await openStream(proxy.port, task.id, { sinceSeq: String(lastSeen) });
    const resumedSink = newSink();
    const resumedRead = await readFrames(resumed.reader, resumedSink, (frames) => eventIds(frames).includes(6), 8000);
    const resumedIds = eventIds(resumedRead.frames);
    check("la reanudacion arranca justo despues del ultimo visto", resumedIds[0] === lastSeen + 1, { lastSeen, primero: resumedIds[0] });
    check(
      "la reanudacion trae los 3 eventos emitidos durante el corte",
      JSON.stringify(resumedIds) === JSON.stringify([lastSeen + 1, lastSeen + 2, lastSeen + 3]),
      resumedIds,
    );
    check("no repite eventos ya vistos", !resumedRead.buffer.includes("evento-uno") && !resumedRead.buffer.includes("evento-dos"));
    const union = [...seenIds, ...resumedIds];
    // La union tiene que ser una secuencia continua desde 0, sin huecos.
    const expectedUnion: number[] = [];
    for (let i = 0; i <= lastSeen + 3; i += 1) expectedUnion.push(i);
    check(
      "la union de las dos lecturas no tiene huecos ni duplicados",
      JSON.stringify(union) === JSON.stringify(expectedUnion),
      union,
    );
    check("el corte no dejo el stream del servidor colgado", union.length === lastSeen + 4, union.length);
    resumed.abort();

    console.log("\n== reconexion automatica por Last-Event-ID ==\n");

    // 5) Lo mismo por el header estándar: es lo que reenvía `EventSource`
    //    del navegador tras un corte de red, sin que el cliente haga nada.
    const auto = await openStream(proxy.port, task.id, { lastEventId: "3" });
    const autoSink = newSink();
    const autoRead = await readFrames(auto.reader, autoSink, (frames) => eventIds(frames).length >= 3, 8000);
    const autoIds = eventIds(autoRead.frames);
    check("Last-Event-ID reanuda desde el siguiente", JSON.stringify(autoIds) === JSON.stringify([4, 5, 6]), autoIds);
    check("no repite los anteriores", !autoRead.buffer.includes("evento-tres"));
    auto.abort();

    console.log("\n== el stream se cierra con la task terminal ==\n");

    // 6) Con la task en estado terminal, el stream se cierra solo aunque el
    //    proxy quiera mantenerlo abierto.
    transitionTask(task.id, "CANCELLED");
    const terminal = await openStream(proxy.port, task.id);
    const terminalRead = await readFrames(terminal.reader, newSink(), () => false, 8000);
    check("el stream se cierra", terminalRead.done);
    check("manda el snapshot final antes de cerrar", terminalRead.frames.some((frame) => frame.event === "task"));
    const terminalSnapshot = terminalRead.frames.find((frame) => frame.event === "task")?.data ?? "";
    check("reporta el status CANCELLED", terminalSnapshot.includes('"status":"CANCELLED"'), terminalSnapshot);
    check(
      "los frames finales tambien estan completos",
      terminalRead.frames.every((frame) => frame.data === undefined || isValidJson(frame.data)),
    );
  } finally {
    await proxy?.close().catch(() => undefined);
    await origin?.close().catch(() => undefined);
    try {
      db?.close();
    } catch {
      /* best-effort */
    }
    (globalThis as unknown as { __councilDb?: unknown }).__councilDb = undefined;
    if (chdirBack) process.chdir(originalCwd);
    await fs.promises.rm(temp, { recursive: true, force: true }).catch(() => undefined);
    if (inheritedDataDir) await fs.promises.rm(inheritedDataDir, { recursive: true, force: true }).catch(() => undefined);
  }

  console.log(`\n${passed}/${passed + failed} casos OK`);
  if (failed > 0) process.exit(1);
}

function isValidJson(value: string): boolean {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function isStrictlyIncreasing(values: number[]): boolean {
  for (let i = 1; i < values.length; i += 1) {
    if (values[i] <= values[i - 1]) return false;
  }
  return true;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
