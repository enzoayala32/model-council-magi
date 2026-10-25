/**
 * Fase 8D — motor de contexto (sin loop todavía).
 *
 * Service falso: prueba carga única, refrescos acotados, single-flight,
 * timeout de arranque, fallback seguro y briefing con inventario/frameworks.
 * Sin DB, sin red, sin filesystem.
 *
 * Uso: npm run agent:test-context-engine
 */
import { createRepoMapTracker } from "../repo-map-tracker";
import type { RepoMapServiceWithSnapshot, RepoMapSnapshotOutcome } from "../repo-map-service";
import { createContextEngine, DEFAULT_CONTEXT_REFRESH_LIMIT } from "./engine";
import { makeSnapshot, type FixtureFile } from "./test-fixtures";

const results: boolean[] = [];
function check(ok: boolean, message: string, detail?: () => unknown) {
  console.log(ok ? `✅ ${message}` : `❌ ${message}${detail ? `\n   ${JSON.stringify(detail())}` : ""}`);
  results.push(ok);
}
const canon = (value: unknown) => JSON.stringify(value);
function checkEq(actual: unknown, expected: unknown, message: string) {
  check(canon(actual) === canon(expected), message, () => ({ esperado: expected, actual }));
}

type Handler = (options: { signal?: AbortSignal }) => Promise<RepoMapSnapshotOutcome>;
type FakeService = RepoMapServiceWithSnapshot & { calls: number; queries: number };

function fakeService(handler: Handler): FakeService {
  const service = {
    calls: 0,
    queries: 0,
    async query() {
      service.queries += 1;
      throw new Error("query no se usa en este test");
    },
    async getSnapshot(options: { signal?: AbortSignal } = {}) {
      service.calls += 1;
      return handler(options);
    },
  };
  return service as unknown as FakeService;
}

const files: FixtureFile[] = [
  { path: "lib/a.ts", symbols: [{ name: "runTask", exported: true }] },
  { path: "lib/b.ts" },
  { path: "lib/a.test.ts" },
  { path: ".env" },
];

function success(service: FakeService, tracker: ReturnType<typeof createRepoMapTracker>, extra: { truncated?: boolean } = {}): RepoMapSnapshotOutcome {
  return {
    ok: true,
    data: makeSnapshot(files, [["lib/b.ts", "lib/a.ts"]], {
      truncated: extra.truncated,
      frameworks: [{ name: "next", version: "16.2.4", evidence: ["dependency:next"] }],
    }),
    generation: tracker.generation,
    cache: "rebuilt",
    attempts: 1,
  };
}

async function main() {
  console.log("== Fase 8D — motor de contexto ==\n");

  console.log("--- Carga inicial única y briefing ---");
  {
    const tracker = createRepoMapTracker();
    let service!: FakeService;
    service = fakeService(async () => success(service, tracker));
    const engine = createContextEngine({ task: "editá lib/a.ts", workspaceRoot: "C:/tmp", modelId: "test/model", tracker, service });
    checkEq(engine.getSystemSuffix(), "", "antes de start no hay briefing");
    await engine.start();
    await engine.start();
    checkEq(service.calls, 1, "start es idempotente: una sola carga");
    checkEq(service.queries, 0, "nunca llama a query() (no duplica la proyección de repo_map)");
    const status = engine.getStatus();
    check(status.available === true && status.error === null && status.generation === 0, "estado disponible con generación", () => status);
    const suffix = engine.getSystemSuffix();
    check(suffix.startsWith("\n\n") && suffix.includes("Contexto automático del proyecto"), "el briefing se agrega al system prompt", () => suffix.slice(0, 200));
    check(suffix.includes("Mapa: 4 archivos (4 analizables, 0 omitidos)"), "incluye inventario real", () => suffix);
    check(suffix.includes("Frameworks detectados: next"), "incluye frameworks detectados", () => suffix);
    check(suffix.includes("lib/a.ts") && suffix.includes("explicit_path:100"), "incluye candidatos con razón y peso", () => suffix);
    const summary = engine.getSummary();
    check(summary.enabled && summary.available && summary.candidates > 0 && summary.included > 0, "resumen de selección completo", () => summary);
    checkEq(summary.generation, 0, "generación del snapshot");
    checkEq(summary.error, null, "sin error");
    checkEq(summary.signals.explicit_path, 1, "señal explícita contada");
    checkEq(engine.getBriefing()?.version, 1, "briefing versionado");
  }

  console.log("\n--- Fallback: mapa no disponible ---");
  {
    const tracker = createRepoMapTracker();
    const service = fakeService(async () => ({ ok: false, code: "busy", error: "ocupado", generation: tracker.generation, attempts: 0 }));
    const engine = createContextEngine({ task: "lib/a.ts", workspaceRoot: "C:/tmp", modelId: "m", tracker, service });
    await engine.start();
    const status = engine.getStatus();
    check(status.available === false && status.error === "busy" && status.selection === null, "busy → no disponible, sin selección", () => status);
    const suffix = engine.getSystemSuffix();
    check(suffix.includes("no disponible (busy)") && suffix.includes("list_files/search_files/repo_map"), "el briefing explica el fallback y sugiere herramientas", () => suffix);
    const summary = engine.getSummary();
    check(summary.enabled && !summary.available && summary.error === "busy" && summary.included === 0, "el resumen reporta el error sin inventar candidatos", () => summary);
    checkEq(summary.signals.explicit_path, 0, "señales en cero");
  }
  {
    const tracker = createRepoMapTracker();
    const service = fakeService(async () => {
      throw new Error("boom con ruta C:\\secreta");
    });
    const engine = createContextEngine({ task: "lib/a.ts", workspaceRoot: "C:/tmp", modelId: "m", tracker, service });
    await engine.start();
    check(engine.getStatus().error === "build_failed", "una excepción del service se clasifica como build_failed");
    check(!engine.getSystemSuffix().includes("C:\\secreta"), "el texto de la excepción NO se filtra al briefing");
  }

  console.log("\n--- Timeout de arranque: no bloquea la task ---");
  {
    const tracker = createRepoMapTracker();
    const service = fakeService(
      ({ signal }) =>
        new Promise<RepoMapSnapshotOutcome>((resolve) => {
          if (signal?.aborted) {
            resolve({ ok: false, code: "cancelled", error: "cancelado", generation: tracker.generation, attempts: 0 });
            return;
          }
          signal?.addEventListener("abort", () => resolve({ ok: false, code: "cancelled", error: "cancelado", generation: tracker.generation, attempts: 0 }), { once: true });
        }),
    );
    const engine = createContextEngine({ task: "lib/a.ts", workspaceRoot: "C:/tmp", modelId: "m", tracker, service, startTimeoutMs: 20 });
    const started = Date.now();
    await engine.start();
    const elapsed = Date.now() - started;
    check(elapsed < 1_000, `start resuelve al vencer el timeout (${elapsed} ms)`, () => elapsed);
    check(engine.getStatus().available === false && engine.getStatus().error === "cancelled", "timeout → engine no disponible, task sigue", () => engine.getStatus());
  }

  console.log("\n--- Refrescos acotados y single-flight ---");
  {
    const tracker = createRepoMapTracker();
    let service!: FakeService;
    service = fakeService(async () => success(service, tracker));
    const engine = createContextEngine({ task: "lib/a.ts", workspaceRoot: "C:/tmp", modelId: "m", tracker, service, refreshLimit: 2 });
    await engine.start();
    checkEq(engine.needsRefresh(), false, "sin cambios no necesita refresh");
    tracker.noteEvent({ type: "file_written", relPath: "lib/a.ts" });
    checkEq(engine.needsRefresh(), true, "una mutación cambia la generación y pide refresh");
    await engine.refreshIfNeeded();
    checkEq(service.calls, 2, "refresh carga un snapshot nuevo");
    checkEq(engine.getSummary().refreshes, 1, "refreshes contados");
    checkEq(engine.needsRefresh(), false, "tras refrescar, la generación quedó al día");
    tracker.noteEvent({ type: "file_written", relPath: "lib/b.ts" });
    await engine.refreshIfNeeded();
    checkEq(engine.getSummary().refreshes, 2, "segundo refresh permitido");
    tracker.noteEvent({ type: "file_written", relPath: "lib/b.ts" });
    checkEq(engine.needsRefresh(), false, "alcanzado el límite, no pide más");
    checkEq(await engine.refreshIfNeeded(), false, "refreshIfNeeded no hace nada pasado el límite");
    checkEq(service.calls, 3, "no hay una tercera reconstrucción");
  }
  {
    const tracker = createRepoMapTracker();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let gateActive = false;
    let service!: FakeService;
    service = fakeService(async () => {
      if (gateActive) await gate;
      return success(service, tracker);
    });
    const engine = createContextEngine({ task: "lib/a.ts", workspaceRoot: "C:/tmp", modelId: "m", tracker, service, refreshLimit: 5 });
    await engine.start();
    gateActive = true;
    tracker.noteEvent({ type: "file_written", relPath: "lib/a.ts" });
    const first = engine.refreshIfNeeded();
    const second = engine.refreshIfNeeded();
    release();
    const [a, b] = await Promise.all([first, second]);
    check(a === true && b === true, "dos refresh concurrentes comparten el mismo resultado", () => ({ a, b }));
    checkEq(service.calls, 2, "single-flight: una sola reconstrucción para dos llamadas");
  }

  console.log("\n--- Un refresh fallido conserva el briefing anterior ---");
  {
    const tracker = createRepoMapTracker();
    let fail = false;
    let service!: FakeService;
    service = fakeService(async () => (fail ? { ok: false, code: "unstable", error: "inestable", generation: tracker.generation, attempts: 3 } : success(service, tracker)));
    const engine = createContextEngine({ task: "lib/a.ts", workspaceRoot: "C:/tmp", modelId: "m", tracker, service, refreshLimit: 1 });
    await engine.start();
    const before = engine.getSystemSuffix();
    tracker.noteEvent({ type: "file_written", relPath: "lib/a.ts" });
    fail = true;
    await engine.refreshIfNeeded();
    const after = engine.getSystemSuffix();
    checkEq(after, before, "el texto del briefing no se reemplaza por uno vacío");
    checkEq(engine.getSummary().error, "unstable", "el error se reporta en telemetría");
    checkEq(engine.getSummary().available, true, "la selección previa sigue marcada disponible");
    checkEq(engine.getSummary().refreshes, 1, "el intento fallido cuenta como refresh");
  }

  console.log("\n--- Actividad reciente y rutas sensibles ---");
  {
    const tracker = createRepoMapTracker();
    let service!: FakeService;
    service = fakeService(async () => success(service, tracker));
    const engine = createContextEngine({ task: "lib/a.ts", workspaceRoot: "C:/tmp", modelId: "m", tracker, service });
    await engine.start();
    engine.noteTouched(["src\\b.ts", ".env"]);
    let suffix = engine.getSystemSuffix();
    check(suffix.includes("Archivos ya tocados en esta corrida: src/b.ts"), "ruta tocada normalizada y visible", () => suffix);
    check(!suffix.includes(".env"), "ruta sensible tocada NO aparece en el briefing");
    engine.noteRecentTool({ toolName: "read_file", ok: false, path: "src/b.ts" });
    engine.noteRecentTool({ toolName: "read_file", ok: true, path: ".env" });
    suffix = engine.getSystemSuffix();
    check(suffix.includes("read_file: FALLÓ — src/b.ts"), "actividad reciente con estado y ruta", () => suffix);
    check((suffix.match(/read_file:/g) ?? []).length === 1, "la entrada con ruta sensible se omite por completo");
    checkEq(engine.getSummary().available, true, "notas no rompen el estado");
  }

  console.log("\n--- Presupuesto de briefing ---");
  {
    const tracker = createRepoMapTracker();
    let service!: FakeService;
    service = fakeService(async () => success(service, tracker));
    const engine = createContextEngine({ task: "lib/a.ts", workspaceRoot: "C:/tmp", modelId: "m", tracker, service, briefingMaxChars: 120 });
    await engine.start();
    const briefing = engine.getBriefing();
    check(briefing !== null && briefing.chars <= 120 && briefing.truncated === true, "briefing respeta maxChars y marca truncado", () => briefing);
    check((engine.getSystemSuffix().length - 2) <= 120, "el sufijo no excede el presupuesto");
  }

  console.log("\n--- Límites y defaults ---");
  checkEq(DEFAULT_CONTEXT_REFRESH_LIMIT, 2, "default de refrescos = 2");
  {
    const tracker = createRepoMapTracker();
    let service!: FakeService;
    service = fakeService(async () => success(service, tracker, { truncated: true }));
    const engine = createContextEngine({ task: "lib/a.ts", workspaceRoot: "C:/tmp", modelId: "m", tracker, service });
    await engine.start();
    checkEq(engine.getSummary().truncated, false, "la selección no está truncada por candidatos");
    check(engine.getBriefing()?.text.includes("inventario truncado") === true, "el inventario truncado se declara", () => engine.getBriefing());
  }

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} casos OK.`);
  if (passed !== results.length) process.exit(1);
}

main().catch((error) => {
  console.error("Error inesperado en la prueba:", error);
  process.exit(1);
});
