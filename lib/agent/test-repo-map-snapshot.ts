/**
 * Fase 8D — `RepoMapService.getSnapshot()`: la API de solo lectura que
 * comparte caché y single-flight con `repo_map`.
 *
 * Pipeline falso con barreras; sin git, sin TypeScript real. Verifica
 * snapshot congelado, invalidación por generación, join de builds, busy,
 * unstable, timeout y cancelación.
 *
 * Uso: npm run agent:test-repo-map-snapshot
 */
import { createRepoMapTracker } from "./repo-map-tracker";
import { createRepoMapService, type RepoMapPipeline } from "./repo-map-service";
import { makeSnapshot } from "./context/test-fixtures";
import type { RepoMapSnapshotData } from "./repo-map-views";

const results: boolean[] = [];
function check(ok: boolean, message: string, detail?: () => unknown) {
  console.log(ok ? `✅ ${message}` : `❌ ${message}${detail ? `\n   ${JSON.stringify(detail())}` : ""}`);
  results.push(ok);
}
const canon = (value: unknown) => JSON.stringify(value);
function checkEq(actual: unknown, expected: unknown, message: string) {
  check(canon(actual) === canon(expected), message, () => ({ esperado: expected, actual }));
}
type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };
function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const DATA: RepoMapSnapshotData = makeSnapshot(
  [{ path: "src/a.ts", symbols: [{ name: "a", exported: true }] }, { path: "src/b.ts" }],
  [["src/b.ts", "src/a.ts"]],
);

function instantPipeline(onBuild?: (call: number) => void) {
  let calls = 0;
  const pipeline: RepoMapPipeline = async () => {
    calls += 1;
    onBuild?.(calls);
    return DATA;
  };
  return { pipeline, get calls() { return calls; } };
}

function setup(pipeline: RepoMapPipeline, extra: Partial<Parameters<typeof createRepoMapService>[0]> = {}) {
  const tracker = createRepoMapTracker();
  const service = createRepoMapService({ workspaceRoot: "C:/tmp", tracker, pipeline, ...extra });
  return { tracker, service };
}

async function main() {
  console.log("== Fase 8D — getSnapshot() del RepoMapService ==\n");

  console.log("--- Caché compartida con repo_map ---");
  {
    const pipeline = instantPipeline();
    const { tracker, service } = setup(pipeline.pipeline);
    const first = await service.getSnapshot();
    check(first.ok === true && first.cache === "rebuilt" && first.generation === 0 && first.attempts === 1, "primer snapshot: rebuilt, generación 0, 1 intento", () => first);
    if (!first.ok) throw new Error("snapshot inesperadamente fallido");
    checkEq(first.data.inventory.stats.files, 2, "datos del pipeline");
    const second = await service.getSnapshot();
    check(second.ok === true && second.cache === "hit" && second.attempts === 0, "segundo snapshot: hit, sin reconstruir", () => second);
    checkEq(pipeline.calls, 1, "una sola construcción para dos getSnapshot");
    const query = await service.query({});
    check(query.result.ok === true && query.info.cache === "hit", "repo_map después de getSnapshot usa la MISMA caché", () => query.info);
    checkEq(pipeline.calls, 1, "query no reconstruye el mapa");
  }
  {
    const pipeline = instantPipeline();
    const { service } = setup(pipeline.pipeline);
    const query = await service.query({ detail: "files" });
    check(query.result.ok === true && query.info.cache === "rebuilt", "query primero: rebuilt", () => query.info);
    const snapshot = await service.getSnapshot();
    check(snapshot.ok === true && snapshot.cache === "hit", "getSnapshot después de query: hit", () => snapshot);
    checkEq(pipeline.calls, 1, "una sola construcción compartida");
  }

  console.log("\n--- Snapshot congelado en profundidad ---");
  {
    const pipeline = instantPipeline();
    const { service } = setup(pipeline.pipeline);
    const outcome = await service.getSnapshot();
    if (!outcome.ok) throw new Error("snapshot inesperadamente fallido");
    const data = outcome.data;
    check(Object.isFrozen(data) && Object.isFrozen(data.inventory) && Object.isFrozen(data.inventory.files) && Object.isFrozen(data.inventory.files[0]), "data, inventory y files congelados", () => "frozen");
    check(Object.isFrozen(data.graph) && Object.isFrozen(data.graph.edges) && Object.isFrozen(data.analysis.files), "graph/edges/analysis congelados", () => "frozen");
    let threw = false;
    try {
      (data.inventory.files[0] as { path: string }).path = "hack.ts";
    } catch {
      threw = true;
    }
    check(threw, "mutar una entrada congelada lanza en modo estricto");
    checkEq(data.inventory.files[0].path, "src/a.ts", "el snapshot compartido no cambió");
    const again = await service.getSnapshot();
    check(again.ok === true && again.data === data, "el hit devuelve exactamente el mismo objeto congelado");
  }

  console.log("\n--- Invalidación por generación ---");
  {
    const pipeline = instantPipeline();
    const { tracker, service } = setup(pipeline.pipeline);
    await service.getSnapshot();
    tracker.noteEvent({ type: "file_written", relPath: "src/a.ts" });
    const after = await service.getSnapshot();
    check(after.ok === true && after.cache === "rebuilt" && after.generation === 1, "un evento sube la generación y reconstruye", () => after);
    checkEq(pipeline.calls, 2, "dos construcciones");
    await service.getSnapshot();
    checkEq(pipeline.calls, 2, "sin cambios posteriores, hit");
  }

  console.log("\n--- Single-flight y join ---");
  {
    const gate = deferred<void>();
    let calls = 0;
    const pipeline: RepoMapPipeline = async () => {
      calls += 1;
      await gate.promise;
      return DATA;
    };
    const { service } = setup(pipeline);
    const first = service.getSnapshot();
    const second = service.getSnapshot();
    gate.resolve();
    const [a, b] = await Promise.all([first, second]);
    check(a.ok && b.ok, "ambos getSnapshot resuelven", () => ({ a, b }));
    check(a.ok && b.ok && (a.cache === "rebuilt" || a.cache === "joined") && (b.cache === "rebuilt" || b.cache === "joined"), "los cache modes son rebuilt/joined", () => [a.ok && a.cache, b.ok && b.cache]);
    checkEq(calls, 1, "single-flight: una sola construcción");
  }
  {
    const gate = deferred<void>();
    let calls = 0;
    const pipeline: RepoMapPipeline = async () => {
      calls += 1;
      await gate.promise;
      return DATA;
    };
    const { service } = setup(pipeline);
    const query = service.query({});
    const snapshot = service.getSnapshot();
    gate.resolve();
    const [queryResult, snapshotResult] = await Promise.all([query, snapshot]);
    check(queryResult.result.ok && snapshotResult.ok, "query y getSnapshot concurrentes resuelven", () => ({ queryResult, snapshotResult }));
    checkEq(calls, 1, "query y getSnapshot comparten la misma reconstrucción en vuelo");
  }

  console.log("\n--- Busy, unstable, timeout y cancelación ---");
  {
    const pipeline = instantPipeline();
    const { tracker, service } = setup(pipeline.pipeline);
    const gate = deferred<void>();
    const mutation = tracker.trackMutation("exec", async () => {
      await gate.promise;
    });
    const busy = await service.getSnapshot();
    check(busy.ok === false && busy.code === "busy", "mutación exec en vuelo → busy, sin construir", () => busy);
    checkEq(pipeline.calls, 0, "no se construyó nada");
    gate.resolve();
    await mutation;
    const after = await service.getSnapshot();
    check(after.ok === true, "al terminar la mutación, el snapshot se puede construir", () => after);
  }
  {
    let calls = 0;
    const tracker = createRepoMapTracker();
    const pipeline: RepoMapPipeline = async () => {
      calls += 1;
      tracker.noteEvent({ type: "file_written", relPath: `src/${calls}.ts` });
      return DATA;
    };
    const service = createRepoMapService({ workspaceRoot: "C:/tmp", tracker, pipeline, maxAttempts: 3 });
    const unstable = await service.getSnapshot();
    check(unstable.ok === false && unstable.code === "unstable" && unstable.attempts === 3, "generación cambiando durante el build → unstable tras 3 intentos", () => unstable);
    checkEq(calls, 3, "3 construcciones descartadas");
  }
  {
    let calls = 0;
    const pipeline: RepoMapPipeline = ({ signal }: { signal: AbortSignal }) =>
      new Promise<RepoMapSnapshotData>((resolve, reject) => {
        calls += 1;
        signal.addEventListener("abort", () => reject(new Error("abortado")), { once: true });
      });
    const { service } = setup(pipeline, { buildTimeoutMs: 20 });
    const timeout = await service.getSnapshot();
    check(timeout.ok === false && timeout.code === "build_timeout", "build que no termina → build_timeout", () => timeout);
    checkEq(calls, 1, "se abortó el trabajo real, no se dejó corriendo");
  }
  {
    const pipeline = instantPipeline();
    const { service } = setup(pipeline.pipeline);
    const controller = new AbortController();
    controller.abort();
    const cancelled = await service.getSnapshot({ signal: controller.signal });
    check(cancelled.ok === false && cancelled.code === "cancelled", "señal ya abortada → cancelled", () => cancelled);
    checkEq(pipeline.calls, 0, "no se construyó");
  }
  {
    const pipeline: RepoMapPipeline = async () => {
      throw new Error("falló con C:\\ruta\\privada");
    };
    const { service } = setup(pipeline);
    const failed = await service.getSnapshot();
    check(failed.ok === false && failed.code === "build_failed", "pipeline que lanza → build_failed", () => failed);
    check(!canon(failed).includes("C:\\ruta\\privada"), "el error no filtra rutas/texto de la excepción", () => failed);
  }

  console.log("\n--- query() sigue funcionando sobre datos congelados ---");
  {
    const pipeline = instantPipeline();
    const { service } = setup(pipeline.pipeline);
    await service.getSnapshot();
    const overview = await service.query({ detail: "overview" });
    check(overview.result.ok === true, "la proyección overview funciona con el snapshot congelado", () => overview);
    const files = await service.query({ detail: "files" });
    check(files.result.ok === true && files.result.detail === "files" && files.result.files.length === 2, "la proyección files lista los 2 archivos", () => files.result);
    checkEq(pipeline.calls, 1, "las proyecciones no reconstruyen");
  }

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} casos OK.`);
  if (passed !== results.length) process.exit(1);
}

main().catch((error) => {
  console.error("Error inesperado en la prueba:", error);
  process.exit(1);
});
