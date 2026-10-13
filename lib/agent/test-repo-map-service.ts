/**
 * Prueba de aceptación de la Fase 7D (tracker + service): caché perezoso,
 * invalidación (eventos, mutaciones, fallos, exec), carreras, single-flight,
 * cancelación, timeout interno que aborta de verdad, errores sin rutas
 * absolutas, aislamiento entre instancias y un test DIFERENCIAL contra un
 * oráculo que reconstruye todo desde cero.
 *
 * Las carreras se prueban con BARRERAS (promesas controladas) y un reloj
 * falso: ningún caso depende de temporizadores reales ni de la velocidad de
 * la máquina.
 *
 * Uso: npm run agent:test-repo-map-service
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRepoMapTracker, type MutationKind, type RepoMapTracker } from "./repo-map-tracker";
import { createRepoMapService, defaultRepoMapPipeline, UnsupportedWorkspaceError, type RepoMapPipeline, type RepoMapQueryOutcome, type RepoMapService, type RepoMapTimers } from "./repo-map-service";
import { projectRepoMap, REPO_MAP_LIMITS, type RepoMapInput, type RepoMapSnapshotData } from "./repo-map-views";
import { RepoInventoryError, type RepoInventory } from "./repo-inventory";
import type { DependencyGraph } from "./dependency-graph";
import { failedAnalysis } from "./repo-symbols";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------- utilidades de test
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
/** Cede varios turnos del event loop: deja avanzar TODAS las promesas pendientes (determinista, sin reloj). */
async function settle(turns = 4) {
  for (let i = 0; i < turns; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Reloj falso: los timers solo disparan cuando el test lo decide. */
class FakeTimers implements RepoMapTimers {
  private nextId = 1;
  private readonly timers = new Map<number, { callback: () => void; ms: number }>();
  setTimeout(callback: () => void, ms: number) {
    const id = this.nextId++;
    this.timers.set(id, { callback, ms });
    return id;
  }
  clearTimeout(handle: unknown) {
    this.timers.delete(handle as number);
  }
  get pending() {
    return this.timers.size;
  }
  pendingWith(ms: number) {
    return [...this.timers.values()].filter((timer) => timer.ms === ms).length;
  }
  fire(ms: number) {
    for (const [id, timer] of [...this.timers]) {
      if (timer.ms !== ms) continue;
      this.timers.delete(id);
      timer.callback();
    }
  }
}
/** Raíz REAL (existe en disco) para los pipelines falsos: la validación de subPath usa resolveSafePath. */
let FAKE_ROOT = "";
/** ¿El texto contiene algo que parezca una ruta absoluta del sistema? (a diferencia de un "/" común en un mensaje). */
const looksLikeAbsolutePath = (text: string) => /[A-Za-z]:\\|\/(home|Users|tmp|var|etc|private)\b/.test(text);
const BUILD_MS = 5001;
const QUIESCE_MS = 1001;

function makeData(version: number, extra: string[] = []): RepoMapSnapshotData {
  const paths = [`v${version}.ts`, ...extra];
  const inventory: RepoInventory = { files: paths.map((p) => ({ path: p, extension: ".ts", language: "typescript" as const, size: 0, tracked: true })), package: null, frameworks: [], truncated: false, stats: { files: paths.length, analyzable: paths.length, skipped: 0, deletedInWorktree: 0 } };
  const graph: DependencyGraph = { edges: [], importedBy: [], config: { file: null, aliases: [], warnings: [] }, stats: { edges: 0, internal: 0, external: 0, unresolved: 0, dynamicNonLiteral: 0 }, truncated: false };
  return { inventory, analysis: { files: [] }, graph };
}

type Build = { index: number; gate: Deferred<void>; signal: AbortSignal };
/** Pipeline falso con barreras: cada construcción queda esperando hasta que el test la libera; si se aborta, rechaza. */
function gatedPipeline() {
  const builds: Build[] = [];
  const pipeline: RepoMapPipeline = ({ signal }) => {
    const build: Build = { index: builds.length + 1, gate: deferred(), signal };
    builds.push(build);
    return new Promise<RepoMapSnapshotData>((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("abortado")), { once: true });
      void build.gate.promise.then(() => resolve(makeData(build.index)));
    });
  };
  return { pipeline, builds, get calls() { return builds.length; } };
}
/** Pipeline falso que resuelve al instante con la versión = nº de llamada. */
function instantPipeline(onBuild?: (version: number) => void) {
  let calls = 0;
  const pipeline: RepoMapPipeline = async () => {
    calls += 1;
    onBuild?.(calls);
    return makeData(calls);
  };
  return { pipeline, get calls() { return calls; } };
}

function setup(pipeline: RepoMapPipeline, extra: Partial<Parameters<typeof createRepoMapService>[0]> = {}) {
  const tracker = createRepoMapTracker();
  const timers = new FakeTimers();
  const service = createRepoMapService({ workspaceRoot: FAKE_ROOT, tracker, pipeline, timers, buildTimeoutMs: BUILD_MS, quiesceTimeoutMs: QUIESCE_MS, ...extra });
  return { tracker, timers, service };
}

const FILES: RepoMapInput = { detail: "files" };
function names(outcome: RepoMapQueryOutcome): string[] | string {
  const r = outcome.result;
  if (!r.ok) return `ERR:${r.code}`;
  return r.detail === "files" ? r.files.map((f) => f.path) : `detail:${r.detail}`;
}
const code = (outcome: RepoMapQueryOutcome) => (outcome.result.ok ? "ok" : outcome.result.code);

const results: boolean[] = [];
function check(ok: boolean, message: string, failDetail: () => string) {
  console.log(ok ? `✅ ${message}` : `❌ ${message}\n   Falló. ${failDetail()}`);
  results.push(ok);
}
const canon = (value: unknown) => JSON.stringify(value);
const eq = (a: unknown, b: unknown) => canon(a) === canon(b);
function checkEq(actual: unknown, expected: unknown, message: string) {
  check(eq(actual, expected), message, () => `esperado=${canon(expected)}\n   actual  =${canon(actual)}`);
}

const unhandled: unknown[] = [];
process.on("unhandledRejection", (reason) => unhandled.push(reason));

async function makeRepo(name: string, files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `consenso-ia-test7d-svc-${name}-`));
  await writeFiles(dir, { "seed.ts": "export const seed = 1;\n", ...files });
  await execFileAsync("git", ["init"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
  await execFileAsync("git", ["add", "-A"], { cwd: dir });
  await execFileAsync("git", ["commit", "-m", "inicial"], { cwd: dir });
  return dir;
}
async function writeFiles(dir: string, files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), content);
  }
}

/**
 * Guarda del arnés: si la promesa principal queda colgada (sin timers ni handles) Node sale en SILENCIO con
 * código 0. Una suite que no llegó a su resumen final NUNCA debe contar como exitosa.
 */
let completed = false;
process.on("exit", () => {
  if (completed) return;
  console.error("❌ La suite terminó sin completarse (una promesa quedó colgada o el proceso salió antes de tiempo).");
  process.exitCode = 1;
});

async function main() {
  FAKE_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "consenso-ia-test7d-raiz-falsa-"));
  console.log("== Fase 7D — prueba de aceptación (tracker + service del Repository Map) ==\n");

  // ================================================================ tracker
  console.log("--- Tracker: contabilidad de mutaciones ---");
  {
    const t = createRepoMapTracker();
    const g0 = t.generation;
    const gate = deferred<string>();
    const pending = t.trackMutation("file", () => gate.promise);
    // Sin ningún `await` todavía: la mutación YA cuenta como en vuelo y la generación ya cambió.
    check(t.inFlight === 1 && t.execInFlight === 0 && t.generation > g0, "una mutación queda registrada desde su INICIO (de forma síncrona, antes de que termine)", () => canon({ inFlight: t.inFlight, gen: t.generation }));
    const gMid = t.generation;
    gate.resolve("listo");
    check((await pending) === "listo" && t.inFlight === 0 && t.generation > gMid, "al terminar devuelve lo mismo que la operación y vuelve a subir la generación", () => canon({ inFlight: t.inFlight }));
    const g1 = t.generation;
    const failure = await t.trackMutation("file", async () => {
      throw new Error("boom");
    }).then(() => null, (error: Error) => error.message);
    check(failure === "boom" && t.inFlight === 0 && t.generation > g1, "si la operación falla se relanza el error Y la mutación se cierra e invalida igual", () => canon({ failure, inFlight: t.inFlight }));
    const g2 = t.generation;
    t.noteEvent({ type: "file_edited", relPath: "x.ts" });
    check(t.generation === g2 + 1 && t.lastEvent?.type === "file_edited" && t.lastEvent.relPath === "x.ts", "noteEvent (AgentToolEvent) invalida y recuerda el último evento", () => canon({ gen: t.generation, last: t.lastEvent }));
    const exec = deferred<void>();
    const running = t.trackMutation("exec", () => exec.promise);
    check(t.execInFlight === 1 && t.inFlight === 1, "las mutaciones exec se cuentan aparte (execInFlight)", () => canon({ exec: t.execInFlight }));
    exec.resolve();
    await running;
    check(t.execInFlight === 0 && t.inFlight === 0, "execInFlight vuelve a 0 al terminar", () => canon({ exec: t.execInFlight }));
  }
  {
    const t = createRepoMapTracker();
    let immediate = 0;
    t.onQuiet(() => (immediate += 1));
    check(immediate === 1, "onQuiet avisa de inmediato (síncrono) cuando ya no hay mutaciones", () => String(immediate));
    const g1 = deferred();
    const g2 = deferred();
    const m1 = t.trackMutation("file", () => g1.promise);
    const m2 = t.trackMutation("file", () => g2.promise);
    let notified = 0;
    t.onQuiet(() => (notified += 1));
    const cancelled = t.onQuiet(() => (notified += 100));
    cancelled();
    g1.resolve();
    await m1;
    check(notified === 0, "con dos mutaciones solapadas, onQuiet espera a que terminen AMBAS", () => String(notified));
    g2.resolve();
    await m2;
    check(notified === 1, "onQuiet avisa una sola vez al quedar en silencio y respeta la cancelación de la suscripción", () => String(notified));
  }

  // ================================================================ caché e invalidación
  console.log("\n--- Caché: hit/miss e invalidación ---");
  {
    const p = instantPipeline();
    const { service, timers } = setup(p.pipeline);
    const a = await service.query(FILES);
    const b = await service.query(FILES);
    const c = await service.query({ detail: "overview" });
    const d = await service.query({ detail: "symbols", subPath: "v1.ts" });
    check(p.calls === 1 && a.info.cache === "rebuilt" && b.info.cache === "hit" && c.info.cache === "hit" && d.info.cache === "hit" && eq(names(a), ["v1.ts"]) && eq(names(b), ["v1.ts"]), "una sola construcción sirve todas las consultas: otro detail o subPath es solo una proyección (hit)", () => canon({ calls: p.calls, caches: [a.info.cache, b.info.cache, c.info.cache, d.info.cache] }));
    check(timers.pending === 0, "no queda ningún timer pendiente después de las consultas (el timeout interno se cancela al terminar)", () => String(timers.pending));
  }
  for (const type of ["file_written", "file_edited", "file_deleted"]) {
    const p = instantPipeline();
    const { service, tracker } = setup(p.pipeline);
    await service.query(FILES);
    tracker.noteEvent({ type, relPath: "x.ts" });
    const after = await service.query(FILES);
    check(p.calls === 2 && after.info.cache === "rebuilt" && eq(names(after), ["v2.ts"]), `AgentToolEvent ${type} invalida el snapshot: la próxima consulta reconstruye y ve el estado nuevo`, () => canon({ calls: p.calls, names: names(after) }));
  }
  {
    const p = instantPipeline();
    const { service, tracker } = setup(p.pipeline);
    await service.query(FILES);
    await tracker.trackMutation("file", async () => undefined);
    const afterOk = await service.query(FILES);
    await tracker.trackMutation("file", async () => {
      throw new Error("falló a medias");
    }).catch(() => undefined);
    const afterFail = await service.query(FILES);
    await tracker.trackMutation("exec", async () => undefined);
    const afterExec = await service.query(FILES);
    checkEq([p.calls, names(afterOk), names(afterFail), names(afterExec)], [4, ["v2.ts"], ["v3.ts"], ["v4.ts"]], "una mutación SIN evento, una que FALLA y un exec invalidan igual (cada una fuerza una reconstrucción)");
    const calm = await service.query(FILES);
    check(p.calls === 4 && calm.info.cache === "hit", "sin mutaciones nuevas el snapshot vigente se reutiliza", () => canon({ calls: p.calls, cache: calm.info.cache }));
  }

  // ================================================================ carreras
  console.log("\n--- Carreras entre mutaciones y consultas (barreras) ---");
  {
    const m = deferred();
    const p = instantPipeline();
    const { service, tracker, timers } = setup(p.pipeline);
    const mutation = tracker.trackMutation("file", () => m.promise); // en vuelo ANTES de la consulta
    const query = service.query(FILES);
    await settle();
    check(p.calls === 0 && timers.pendingWith(QUIESCE_MS) === 1, "mutación de archivo en vuelo al llegar la consulta: espera (no construye todavía) con su espera acotada", () => canon({ calls: p.calls, timers: timers.pending }));
    m.resolve();
    await mutation;
    const outcome = await query;
    check(p.calls === 1 && eq(names(outcome), ["v1.ts"]) && timers.pending === 0, "al terminar la mutación la consulta construye UNA vez y el timer de espera se cancela", () => canon({ calls: p.calls, names: names(outcome), timers: timers.pending }));
  }
  {
    const g = gatedPipeline();
    const { service, tracker } = setup(g.pipeline);
    const query = service.query(FILES);
    await settle();
    let mutationDone = false;
    await tracker.trackMutation("file", async () => undefined).then(() => (mutationDone = true)); // NO espera a la construcción
    check(g.calls === 1 && mutationDone, "las mutaciones nunca esperan a las consultas: terminó mientras la construcción seguía bloqueada", () => canon({ calls: g.calls, mutationDone }));
    g.builds[0].gate.resolve(); // la 1ª construcción termina sobre una generación vieja: se descarta
    await settle();
    check(g.calls === 2, "una reconstrucción solapada con una mutación se DESCARTA y se reintenta (segunda construcción)", () => String(g.calls));
    g.builds[1].gate.resolve();
    const outcome = await query;
    check(eq(names(outcome), ["v2.ts"]) && outcome.info.attempts === 2 && outcome.info.cache === "rebuilt", "se sirve la construcción estable (v2), nunca la descartada (v1); attempts = 2", () => canon({ names: names(outcome), info: outcome.info }));
    const again = await service.query(FILES);
    check(again.info.cache === "hit" && eq(names(again), ["v2.ts"]), "solo la construcción estable quedó publicada en el caché", () => canon(again.info));
  }
  {
    const g = gatedPipeline();
    const { service, tracker } = setup(g.pipeline);
    const q1 = service.query(FILES);
    await settle();
    await tracker.trackMutation("file", async () => undefined);
    const q2 = service.query(FILES); // generación nueva: arranca otra construcción y la vieja se aborta
    await settle();
    check(g.calls === 2 && g.builds[0].signal.aborted && !g.builds[1].signal.aborted, "una consulta de una generación nueva REEMPLAZA la construcción vieja y la aborta de verdad (sin construcciones huérfanas)", () => canon({ calls: g.calls, aborted: g.builds.map((b) => b.signal.aborted) }));
    g.builds[1].gate.resolve();
    const [o1, o2] = await Promise.all([q1, q2]);
    check(g.calls === 2 && eq(names(o1), ["v2.ts"]) && eq(names(o2), ["v2.ts"]), "las dos consultas terminan con la construcción estable (la que se reemplazó se reintenta unida a la nueva)", () => canon({ calls: g.calls, o1: names(o1), o2: names(o2) }));
  }
  {
    const g = gatedPipeline();
    const { service } = setup(g.pipeline);
    const q1 = service.query(FILES);
    const q2 = service.query({ detail: "overview" });
    await settle();
    check(g.calls === 1, "consultas simultáneas de la misma generación comparten UNA reconstrucción", () => String(g.calls));
    g.builds[0].gate.resolve();
    const [o1, o2] = await Promise.all([q1, q2]);
    check([o1.info.cache, o2.info.cache].sort().join() === "joined,rebuilt" && o1.result.ok && o2.result.ok, "una consulta la reconstruyó y la otra se unió (joined)", () => canon([o1.info, o2.info]));
  }
  {
    // Churn: cada construcción termina con el worktree cambiado → 3 intentos → unstable.
    const { tracker } = setup(instantPipeline().pipeline);
    let calls = 0;
    let churn = true;
    const pipeline: RepoMapPipeline = async () => {
      calls += 1;
      if (churn) tracker.noteEvent({ type: "file_edited", relPath: "x" });
      return makeData(calls);
    };
    const service = createRepoMapService({ workspaceRoot: FAKE_ROOT, tracker, pipeline, timers: new FakeTimers() });
    const outcome = await service.query(FILES);
    check(code(outcome) === "unstable" && calls === 3 && outcome.info.attempts === 3, "si el worktree no se estabiliza en 3 intentos → unstable (y nunca datos posiblemente inconsistentes)", () => canon({ calls, outcome: outcome.result }));
    churn = false;
    const later = await service.query(FILES);
    check(later.result.ok && later.info.cache === "rebuilt" && eq(names(later), ["v4.ts"]), "lo descartado no quedó publicado: la consulta siguiente (ya estable) reconstruye y funciona", () => canon({ calls, names: names(later) }));
    // maxAttempts configurable: con 2 intentos y un worktree que nunca se estabiliza → unstable tras exactamente 2 construcciones.
    let customCalls = 0;
    const customTracker = createRepoMapTracker();
    const custom = createRepoMapService({
      workspaceRoot: FAKE_ROOT,
      tracker: customTracker,
      timers: new FakeTimers(),
      maxAttempts: 2,
      pipeline: async () => {
        customCalls += 1;
        customTracker.noteEvent({ type: "file_edited", relPath: "x" });
        return makeData(customCalls);
      },
    });
    const customOutcome = await custom.query(FILES);
    check(code(customOutcome) === "unstable" && customCalls === 2 && customOutcome.info.attempts === 2, "maxAttempts es configurable (2 intentos → 2 construcciones y unstable)", () => canon({ customCalls, info: customOutcome.info }));
  }
  {
    const p = instantPipeline();
    const { service, tracker, timers } = setup(p.pipeline);
    const exec = deferred();
    const running = tracker.trackMutation("exec", () => exec.promise);
    const busy = await service.query(FILES);
    check(code(busy) === "busy" && p.calls === 0 && timers.pending === 0 && !looksLikeAbsolutePath(JSON.stringify(busy.result)), "run_script/run_typecheck en vuelo → busy AL INSTANTE (sin esperar, sin timers, sin construir)", () => canon({ busy: busy.result, calls: p.calls }));
    exec.resolve();
    await running;
    const ok = await service.query(FILES);
    check(ok.result.ok && p.calls === 1, "al terminar el exec la consulta funciona y reconstruye (el exec invalidó)", () => canon(ok.result));
  }
  {
    const p = instantPipeline();
    const { service, tracker, timers } = setup(p.pipeline);
    const m = deferred();
    const running = tracker.trackMutation("file", () => m.promise);
    const query = service.query(FILES);
    await settle();
    timers.fire(QUIESCE_MS); // vence la espera acotada, sin reloj real
    const busy = await query;
    check(code(busy) === "busy" && p.calls === 0 && timers.pending === 0, "una mutación de archivo que no termina a tiempo → busy (la espera acotada vence) sin construir", () => canon({ busy: busy.result, calls: p.calls }));
    m.resolve();
    await running;
    check((await service.query(FILES)).result.ok, "después de que termina la mutación la consulta funciona", () => "falló");
  }

  // ================================================================ cancelación y timeout
  console.log("\n--- Cancelación y timeout interno ---");
  {
    const g = gatedPipeline();
    const { service } = setup(g.pipeline);
    const controller = new AbortController();
    controller.abort();
    const outcome = await service.query(FILES, { signal: controller.signal });
    check(code(outcome) === "cancelled" && g.calls === 0, "signal ya abortado → cancelled sin construir", () => canon(outcome.result));
  }
  {
    const g = gatedPipeline();
    const { service, timers } = setup(g.pipeline);
    const controller = new AbortController();
    const query = service.query(FILES, { signal: controller.signal });
    await settle();
    controller.abort();
    const outcome = await query;
    check(code(outcome) === "cancelled" && g.builds[0].signal.aborted, "una consulta que era la ÚNICA interesada se cancela y la construcción se aborta de verdad (el AbortSignal llega al pipeline)", () => canon({ code: code(outcome), aborted: g.builds[0].signal.aborted }));
    await settle();
    check(timers.pending === 0, "al abortarse se cancela el timer del timeout interno", () => String(timers.pending));
    const next = service.query(FILES);
    await settle();
    g.builds[1]?.gate.resolve();
    const ok = await next;
    check(g.calls === 2 && ok.result.ok && eq(names(ok), ["v2.ts"]), "tras cancelar, la consulta siguiente reconstruye normalmente", () => canon({ calls: g.calls, names: names(ok) }));
  }
  {
    const g = gatedPipeline();
    const { service } = setup(g.pipeline);
    const quitter = new AbortController();
    const q1 = service.query(FILES, { signal: quitter.signal });
    const q2 = service.query({ detail: "overview" });
    await settle();
    quitter.abort();
    const o1 = await q1;
    check(code(o1) === "cancelled" && !g.builds[0].signal.aborted, "cancelar UNA consulta no aborta la reconstrucción que otra todavía necesita", () => canon({ code: code(o1), aborted: g.builds[0].signal.aborted }));
    g.builds[0].gate.resolve();
    const o2 = await q2;
    check(o2.result.ok && g.calls === 1, "la otra consulta recibe su resultado de la misma (única) construcción", () => canon({ ok: o2.result.ok, calls: g.calls }));
  }
  {
    const baseline = unhandled.length;
    const g = gatedPipeline();
    const { service, timers } = setup(g.pipeline);
    const a = new AbortController();
    const b = new AbortController();
    const q1 = service.query(FILES, { signal: a.signal });
    const q2 = service.query(FILES, { signal: b.signal });
    await settle();
    a.abort();
    check(!g.builds[0].signal.aborted, "con una consulta restante la construcción sigue", () => "se abortó antes de tiempo");
    b.abort();
    const [o1, o2] = await Promise.all([q1, q2]);
    await settle();
    check(code(o1) === "cancelled" && code(o2) === "cancelled" && g.builds[0].signal.aborted && timers.pending === 0 && unhandled.length === baseline, "cuando se cancelan TODAS las consultas la construcción se aborta; sin timers colgados ni promesas rechazadas sin gestionar", () => canon({ unhandled: unhandled.length - baseline, timers: timers.pending }));
  }
  {
    const p = instantPipeline();
    const { service, tracker, timers } = setup(p.pipeline);
    const m = deferred();
    const running = tracker.trackMutation("file", () => m.promise);
    const controller = new AbortController();
    const query = service.query(FILES, { signal: controller.signal });
    await settle();
    controller.abort();
    const outcome = await query;
    check(code(outcome) === "cancelled" && timers.pending === 0 && p.calls === 0, "cancelar mientras se espera a una mutación → cancelled y se limpia el timer de espera", () => canon({ code: code(outcome), timers: timers.pending }));
    m.resolve();
    await running;
  }
  {
    const baseline = unhandled.length;
    const g = gatedPipeline();
    const { service, timers } = setup(g.pipeline);
    const query = service.query(FILES);
    await settle();
    check(timers.pendingWith(BUILD_MS) === 1, "mientras construye hay un timer de timeout interno armado", () => String(timers.pending));
    timers.fire(BUILD_MS); // vence el timeout interno
    const outcome = await query;
    await settle();
    check(code(outcome) === "build_timeout" && g.builds[0].signal.aborted && !looksLikeAbsolutePath(JSON.stringify(outcome.result)), "el timeout interno ABORTA el trabajo subyacente (signal.aborted en el pipeline) y devuelve build_timeout", () => canon({ code: code(outcome), aborted: g.builds[0].signal.aborted }));
    const retry = service.query(FILES);
    await settle();
    g.builds[1].gate.resolve();
    const ok = await retry;
    check(ok.result.ok && g.calls === 2 && timers.pending === 0 && unhandled.length === baseline, "después de un timeout la consulta siguiente reconstruye; sin timers ni rechazos colgados", () => canon({ calls: g.calls, timers: timers.pending }));
  }

  // ================================================================ errores
  console.log("\n--- Errores (mensajes fijos, sin rutas absolutas) ---");
  {
    const failures: Array<[string, unknown]> = [
      ["unsupported_workspace", new UnsupportedWorkspaceError()],
      ["build_failed", new RepoInventoryError("git falló en C:\\Users\\secreto\\proyecto")],
      ["build_failed", new Error("ENOENT: /home/secreto/proyecto/archivo")],
    ];
    const seen: string[] = [];
    for (const [expected, error] of failures) {
      const { service } = setup(async () => {
        throw error;
      });
      const outcome = await service.query(FILES);
      seen.push(code(outcome));
      check(code(outcome) === expected && !JSON.stringify(outcome.result).includes("secreto") && !/[A-Za-z]:\\|\/home|\/Users/.test(JSON.stringify(outcome.result)), `un pipeline que falla con ${error instanceof Error ? error.name : "?"} → ${expected}, con mensaje fijo (el texto de la excepción no se filtra)`, () => canon(outcome.result));
    }
    let calls = 0;
    const flaky: RepoMapPipeline = async () => {
      calls += 1;
      if (calls === 1) throw new Error("falla transitoria");
      return makeData(calls);
    };
    const { service } = setup(flaky);
    const first = await service.query(FILES);
    const second = await service.query(FILES);
    check(code(first) === "build_failed" && second.result.ok && calls === 2, "tras un build_failed no queda nada publicado ni colgado: la consulta siguiente reintenta", () => canon({ first: code(first), calls }));
  }
  {
    const p = instantPipeline();
    const { service } = setup(p.pipeline);
    const outcomes = await Promise.all([service.query({ subPath: "a\u0000b" }), service.query({ subPath: "../fuera" }), service.query({ subPath: "/etc" }), service.query({ after: "x\u0000" }), service.query({ detail: "nada" as never })]);
    checkEq(outcomes.map(code), ["invalid_input", "unsafe_path", "unsafe_path", "invalid_input", "invalid_input"], "entradas inválidas o inseguras se rechazan ANTES de construir");
    check(p.calls === 0, "una entrada inválida nunca dispara una construcción", () => String(p.calls));
    const missing = await service.query({ subPath: "no/existe" });
    check(code(missing) === "path_not_in_map" && p.calls === 1, "subPath válido pero sin archivos → path_not_in_map (esto sí requiere el mapa)", () => canon(missing.result));
  }
  {
    // Un archivo con análisis fallido NO tumba el mapa.
    const base = makeData(1, ["rota.ts"]);
    const data: RepoMapSnapshotData = { ...base, analysis: { files: [failedAnalysis("rota.ts", "typescript", "changed_since_inventory", "ENOENT")] } };
    const { service } = setup(async () => data);
    const files = await service.query(FILES);
    const overview = await service.query({});
    const entry = files.result.ok && files.result.detail === "files" ? files.result.files.find((f) => f.path === "rota.ts") : undefined;
    check(files.result.ok && entry?.parse === "failed" && overview.result.ok && overview.result.detail === "overview" && overview.result.workspace.analysisIssues.failed === 1, "un archivo con análisis fallido aparece como parse:'failed' y el mapa sigue siendo válido", () => canon(entry));
  }
  {
    const p = instantPipeline();
    const { service } = setup(p.pipeline, { maxOutputChars: 2500 });
    const outcome = await service.query({ detail: "overview" });
    check(outcome.result.ok && JSON.stringify(outcome.result).length <= 2500 && outcome.result.budget.maxChars === 2500, "maxOutputChars del service se aplica al resultado", () => canon(outcome.result.ok && outcome.result.budget));
  }

  // ================================================================ aislamiento
  console.log("\n--- Aislamiento entre instancias ---");
  {
    const pa = instantPipeline();
    const pb = instantPipeline();
    const A = setup(pa.pipeline);
    const B = setup(pb.pipeline);
    await A.service.query(FILES);
    await B.service.query(FILES);
    A.tracker.noteEvent({ type: "file_written", relPath: "x.ts" });
    A.tracker.trackMutation("file", async () => undefined);
    const a2 = await A.service.query(FILES);
    const b2 = await B.service.query(FILES);
    check(pa.calls === 2 && pb.calls === 1 && a2.info.cache === "rebuilt" && b2.info.cache === "hit", "una mutación en la instancia A invalida SOLO a A (B sigue en hit, sin reconstruir)", () => canon({ pa: pa.calls, pb: pb.calls }));
    const live = createRepoMapService({ workspaceRoot: "/otro", tracker: createRepoMapTracker(), pipeline: instantPipeline().pipeline, timers: new FakeTimers() });
    check((await live.query(FILES)).info.cache === "rebuilt", "una instancia nueva arranca sin caché (no hay estado global ni compartido)", () => "heredó un snapshot");
  }

  // ================================================================ repos reales
  console.log("\n--- Pipeline real sobre repos git temporales ---");
  {
    const dir = await makeRepo("real", { "src/a.ts": "export const a = 1;\n", "tsconfig.json": '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["./*"]}}}' });
    const tracker = createRepoMapTracker();
    let builds = 0;
    const counting: RepoMapPipeline = (ctx) => {
      builds += 1;
      return defaultRepoMapPipeline(ctx);
    };
    const service = createRepoMapService({ workspaceRoot: dir, tracker, pipeline: counting });
    const list = async () => {
      const o = await service.query({ detail: "files" });
      return o.result.ok && o.result.detail === "files" ? o.result.files.map((f) => f.path) : [`ERR:${code(o)}`];
    };
    const edit = (kind: MutationKind, fn: () => Promise<void>, event?: { type: string; relPath: string }) =>
      tracker.trackMutation(kind, async () => {
        await fn();
        if (event) tracker.noteEvent(event);
      });
    check(eq(await list(), ["seed.ts", "src/a.ts", "tsconfig.json"]) && builds === 1, "construcción real: inventario del repo git", () => canon({ builds }));
    check(eq(await list(), ["seed.ts", "src/a.ts", "tsconfig.json"]) && builds === 1, "segunda consulta: caché (no reconstruye)", () => String(builds));
    await edit("file", () => fs.writeFile(path.join(dir, "src/b.ts"), 'import { a } from "@/src/a";\nexport const b = a;\n'), { type: "file_written", relPath: "src/b.ts" });
    const afterCreate = await list();
    check(afterCreate.includes("src/b.ts") && builds === 2, "CREACIÓN: el archivo nuevo (sin trackear) aparece en la próxima consulta", () => canon(afterCreate));
    const symbolsOf = async (p: string) => {
      const o = await service.query({ detail: "symbols", subPath: p });
      return o.result.ok && o.result.detail === "symbols" ? o.result.files[0] : undefined;
    };
    check(eq((await symbolsOf("src/b.ts"))?.imports?.internal, ["src/a.ts"]), "el alias @/ resuelve (importa src/a.ts)", () => canon(symbolsOf("src/b.ts")));
    await edit("file", () => fs.appendFile(path.join(dir, "src/b.ts"), "export function nueva() {}\n"), { type: "file_edited", relPath: "src/b.ts" });
    check((await symbolsOf("src/b.ts"))?.symbols.some((s) => s.name === "nueva") === true && builds === 3, "EDICIÓN: un símbolo nuevo se ve en la próxima consulta", () => String(builds));
    await edit("file", () => fs.rm(path.join(dir, "src/b.ts")), { type: "file_deleted", relPath: "src/b.ts" });
    const afterDelete = await list();
    check(!afterDelete.includes("src/b.ts") && builds === 4, "BORRADO: el archivo desaparece del mapa", () => canon(afterDelete));
    await edit("file", () => fs.rename(path.join(dir, "src/a.ts"), path.join(dir, "src/renombrado.ts")), { type: "file_deleted", relPath: "src/a.ts" });
    const afterRename = await list();
    check(afterRename.includes("src/renombrado.ts") && !afterRename.includes("src/a.ts"), "RENAME (borrar + escribir): el nombre viejo desaparece y el nuevo aparece", () => canon(afterRename));
    await edit("file", () => fs.writeFile(path.join(dir, "src/c.ts"), 'import "@/src/renombrado";\n'), { type: "file_written", relPath: "src/c.ts" });
    check(eq((await symbolsOf("src/c.ts"))?.imports?.internal, ["src/renombrado.ts"]), "antes de cambiar la config, el alias @/ resuelve", () => "alias");
    await edit("file", () => fs.writeFile(path.join(dir, "tsconfig.json"), '{"compilerOptions":{}}'), { type: "file_written", relPath: "tsconfig.json" });
    const noAlias = await symbolsOf("src/c.ts");
    check(noAlias?.imports?.internal === undefined && eq(noAlias?.imports?.unresolved, [{ source: "@/src/renombrado", reason: "unmapped_alias" }]), "CAMBIO DE tsconfig: sin el alias, el mismo import pasa a unmapped_alias (la reconstrucción relee la config)", () => canon(noAlias?.imports));
    await edit("file", () => fs.rm(path.join(dir, "tsconfig.json")), { type: "file_deleted", relPath: "tsconfig.json" });
    await edit("file", () => fs.writeFile(path.join(dir, "jsconfig.json"), '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["./*"]}}}'), { type: "file_written", relPath: "jsconfig.json" });
    check(eq((await symbolsOf("src/c.ts"))?.imports?.internal, ["src/renombrado.ts"]), "jsconfig.json (respaldo) también invalida y se aplica", () => "jsconfig");
    const before = builds;
    await edit("exec", () => fs.writeFile(path.join(dir, "generado.ts"), "export const g = 1;\n")); // como un `npm run build` que genera archivos: sin evento
    const afterExec = await list();
    check(afterExec.includes("generado.ts") && builds === before + 1, "EXEC: un script que crea archivos (sin ningún evento) invalida igual al terminar", () => canon(afterExec));
  }
  {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "consenso-ia-test7d-fuera-"));
    const dir = await makeRepo("symlink", {});
    let linked = true;
    try {
      await fs.symlink(outside, path.join(dir, "enlace"), "junction"); // "junction": en Windows no requiere privilegios (en POSIX se ignora)
    } catch {
      linked = false;
      console.log("⚠️  No se pudieron crear symlinks en este entorno — se omite el caso de subPath con symlink.");
    }
    if (linked) {
      const service = createRepoMapService({ workspaceRoot: dir, tracker: createRepoMapTracker() });
      const outcome = await service.query({ subPath: "enlace/secreto" });
      check(code(outcome) === "unsafe_path" && !JSON.stringify(outcome.result).includes(outside), "subPath que atraviesa un symlink hacia afuera → unsafe_path (sin filtrar la ruta real)", () => canon(outcome.result));
    }
    const bare = await fs.mkdtemp(path.join(os.tmpdir(), "consenso-ia-test7d-nogit-"));
    const nogit = await createRepoMapService({ workspaceRoot: bare, tracker: createRepoMapTracker() }).query({});
    check(code(nogit) === "unsupported_workspace" && !JSON.stringify(nogit.result).includes(bare), "workspace SIN .git (modo copia) → unsupported_workspace con un mensaje claro, sin tocar 7A", () => canon(nogit.result));
    const broken = await fs.mkdtemp(path.join(os.tmpdir(), "consenso-ia-test7d-gitroto-"));
    await fs.writeFile(path.join(broken, ".git"), "esto no es un gitfile válido\n");
    const brokenOutcome = await createRepoMapService({ workspaceRoot: broken, tracker: createRepoMapTracker() }).query({});
    check(code(brokenOutcome) === "build_failed" && !JSON.stringify(brokenOutcome.result).includes(broken), "un .git inválido → build_failed (git falla) sin filtrar rutas absolutas", () => canon(brokenOutcome.result));
  }

  // ================================================================ diferencial
  console.log("\n--- Test diferencial: el servicio vs. un oráculo que reconstruye desde cero ---");
  {
    function prng(seed: number) {
      let state = seed >>> 0;
      return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }
    const rand = prng(7);
    const pick = <T>(items: T[]): T => items[Math.floor(rand() * items.length)];
    const dir = await makeRepo("diferencial", { "a/f0.ts": "export const v0 = 0;\n", "b/c/f1.ts": "export const v1 = 1;\n" });
    const tracker = createRepoMapTracker();
    const service = createRepoMapService({ workspaceRoot: dir, tracker });
    const existing = new Set(["a/f0.ts", "b/c/f1.ts"]);
    let hasTsconfig = false;
    const dirs = ["a/", "b/", "b/c/", ""];
    const content = () => {
      const lines: string[] = [];
      for (let i = 0; i < Math.floor(rand() * 4); i++) lines.push(rand() < 0.5 ? `import "@/${pick(dirs)}f${Math.floor(rand() * 10)}";` : `import "./f${Math.floor(rand() * 10)}";`);
      lines.push(`export const v${Math.floor(rand() * 100)} = ${Math.floor(rand() * 100)};`);
      if (rand() < 0.5) lines.push(`export function g${Math.floor(rand() * 100)}() {}`);
      return `${lines.join("\n")}\n`;
    };
    const oracle = async (input: RepoMapInput) => projectRepoMap(await defaultRepoMapPipeline({ workspaceRoot: dir, signal: new AbortController().signal }), input);
    let queries = 0;
    let mismatches = 0;
    let firstMismatch = "";
    const ops: string[] = [];
    for (let step = 0; step < 90; step++) {
      const roll = rand();
      if (roll < 0.22) {
        const file = `${pick(dirs)}f${Math.floor(rand() * 10)}.ts`;
        ops.push(`write ${file}`);
        await tracker.trackMutation("file", async () => {
          await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
          await fs.writeFile(path.join(dir, file), content());
          tracker.noteEvent({ type: existing.has(file) ? "file_edited" : "file_written", relPath: file });
        });
        existing.add(file);
      } else if (roll < 0.34 && existing.size > 0) {
        const file = pick([...existing].sort());
        ops.push(`delete ${file}`);
        await tracker.trackMutation("file", async () => {
          await fs.rm(path.join(dir, file));
          tracker.noteEvent({ type: "file_deleted", relPath: file });
        });
        existing.delete(file);
      } else if (roll < 0.42) {
        ops.push(hasTsconfig ? "tsconfig off" : "tsconfig on");
        await tracker.trackMutation("file", async () => {
          if (hasTsconfig) await fs.rm(path.join(dir, "tsconfig.json"));
          else await fs.writeFile(path.join(dir, "tsconfig.json"), '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["./*"]}}}');
          tracker.noteEvent({ type: hasTsconfig ? "file_deleted" : "file_written", relPath: "tsconfig.json" });
        });
        hasTsconfig = !hasTsconfig;
      } else if (roll < 0.48) {
        const file = `${pick(dirs)}x${Math.floor(rand() * 4)}.ts`;
        ops.push(`exec ${file}`);
        await tracker.trackMutation("exec", async () => {
          await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
          await fs.writeFile(path.join(dir, file), content()); // sin evento: como un script
        });
        existing.add(file);
      } else {
        const detail = pick(["overview", "files", "symbols"] as const);
        const input: RepoMapInput = { detail };
        if (rand() < 0.4) input.subPath = pick(["a", "b", "b/c", "a/f1.ts", ""]);
        if (detail !== "overview" && rand() < 0.3) input.after = pick(["a/f1.ts", "b", "b/c/f1.ts"]);
        ops.push(`query ${canon(input)}`);
        const served = await service.query(input);
        const expected = await oracle(input);
        queries += 1;
        if (canon(served.result) !== canon(expected)) {
          mismatches += 1;
          if (!firstMismatch) firstMismatch = `paso ${step} tras [${ops.slice(-6).join(" | ")}]: servido=${canon(served.result).slice(0, 300)} esperado=${canon(expected).slice(0, 300)}`;
        }
      }
    }
    check(queries >= 20 && mismatches === 0, `${queries} consultas intercaladas con ${90 - queries} mutaciones (crear/editar/borrar/tsconfig/exec): el servicio devuelve SIEMPRE lo mismo que una reconstrucción desde cero (0 snapshots obsoletos)`, () => `${mismatches} diferencias — ${firstMismatch}`);
  }

  await settle();
  check(unhandled.length === 0, "ningún caso dejó una promesa rechazada sin gestionar", () => String(unhandled.length));
  completed = true;
  console.log(`\n${results.filter(Boolean).length}/${results.length} casos OK.`);
  if (results.some((r) => !r)) process.exit(1);
}

main().catch((error) => {
  console.error("Error inesperado en la prueba:", error);
  process.exit(1);
});
