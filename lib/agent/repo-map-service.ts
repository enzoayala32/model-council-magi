/**
 * Fase 7D — Service del Repository Map: construye el snapshot completo
 * (7A inventario + 7B análisis + config + 7C grafo), lo cachea EN MEMORIA y lo
 * sirve a las consultas de `repo_map`.
 *
 * Es el módulo PESADO (arrastra TypeScript vía 7B/7C): `tools.ts` lo carga con
 * `import()` recién cuando se invoca `repo_map`. El estado pertenece a la
 * instancia (una por `createAgentTools`): no hay caché global ni snapshots
 * compartidos entre tasks.
 *
 * Reglas de consistencia (ver también `repo-map-tracker.ts`):
 * - Un snapshot es válido solo para la `generation` del tracker en la que se
 *   construyó. Cualquier mutación (inicio, fin, evento) la cambia: la próxima
 *   consulta reconstruye. Lazy: nunca se reconstruye "por las dudas".
 * - Una reconstrucción solo se PUBLICA si la generación no cambió durante la
 *   construcción y no quedó ninguna mutación en vuelo; si no, se descarta y se
 *   reintenta (máx. `maxAttempts`), y si no se estabiliza se devuelve
 *   `unstable`. Jamás se sirve un snapshot construido sobre una generación
 *   inestable.
 * - Mientras una mutación `exec` (run_script / run_typecheck) está en vuelo se
 *   responde `busy` al instante; ante mutaciones de archivo (cortas) se espera
 *   a que terminen, hasta `quiesceTimeoutMs`, y si no, `busy`.
 * - Las mutaciones nunca esperan a las consultas.
 * - Consultas simultáneas de la misma generación comparten UNA reconstrucción.
 *   Cancelar una consulta no aborta la reconstrucción mientras otra la
 *   necesite; si ya no la necesita nadie, se aborta de verdad (`AbortSignal`).
 * - El timeout interno también aborta el trabajo subyacente con `AbortSignal`
 *   (7A/7B/7C lo respetan), no solo deja de esperar.
 * - La promesa de reconstrucción NUNCA rechaza: siempre resuelve con un
 *   resultado explícito, así no puede quedar un rechazo sin gestionar.
 * - Los errores devueltos son mensajes fijos: nunca incluyen texto de las
 *   excepciones (que podría traer rutas absolutas del sistema).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { buildRepoInventory, RepoInventoryError } from "./repo-inventory";
import { analyzeRepoInventory } from "./repo-analysis";
import { loadResolutionConfig } from "./resolution-config";
import { buildDependencyGraph } from "./dependency-graph";
import { resolveSafePath, UnsafePathError } from "./safe-path";
import type { RepoMapTracker } from "./repo-map-tracker";
import { normalizeRelativeInput, projectRepoMap, repoMapError, REPO_MAP_DETAILS, REPO_MAP_LIMITS, type RepoMapErrorCode, type RepoMapInput, type RepoMapResult, type RepoMapSnapshotData } from "./repo-map-views";

/** El workspace no tiene `.git` (modo copia): 7A necesita Git y no se modifica. */
export class UnsupportedWorkspaceError extends Error {
  constructor() {
    super("workspace sin git");
    this.name = "UnsupportedWorkspaceError";
  }
}

export type RepoMapPipeline = (context: { workspaceRoot: string; signal: AbortSignal }) => Promise<RepoMapSnapshotData>;

/** Seam de tests: permite controlar los timeouts sin depender del reloj. */
export type RepoMapTimers = {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export type RepoMapQueryInfo = {
  /** `hit`: snapshot vigente; `rebuilt`: esta consulta lo reconstruyó; `joined`: compartió una reconstrucción en curso; `none`: ni siquiera hizo falta (error de entrada, busy, etc.). */
  cache: "hit" | "rebuilt" | "joined" | "none";
  generation: number;
  /** Intentos de construcción usados por esta consulta. */
  attempts: number;
};
export type RepoMapQueryOutcome = { result: RepoMapResult; info: RepoMapQueryInfo };

export type RepoMapServiceOptions = {
  workspaceRoot: string;
  tracker: RepoMapTracker;
  /** Presupuesto de salida (se acota a `REPO_MAP_LIMITS.minOutputChars` como mínimo). */
  maxOutputChars?: number;
  buildTimeoutMs?: number;
  quiesceTimeoutMs?: number;
  maxAttempts?: number;
  /** SOLO tests: reemplaza la construcción real (7A+7B+config+7C). */
  pipeline?: RepoMapPipeline;
  /** SOLO tests. */
  timers?: RepoMapTimers;
};

export interface RepoMapService {
  /** Nunca lanza: todo problema vuelve como `{ ok: false, code, error }`. */
  query(input: RepoMapInput, options?: { signal?: AbortSignal }): Promise<RepoMapQueryOutcome>;
}

/**
 * Fase 8D — Lectura del snapshot CRUDO para el Context Engine.
 *
 * Es una API SEPARADA de `query()` a propósito: `query` proyecta una vista
 * con presupuesto de salida para el modelo, mientras que el motor necesita
 * los datos completos para puntuar señales. Comparten la MISMA caché y la
 * MISMA reconstrucción en vuelo, así que pedir el snapshot no duplica el
 * trabajo de `repo_map` (ni al revés).
 *
 * `data` se publica CONGELADO en profundidad: es de solo lectura por
 * contrato y ningún consumidor puede mutar la caché compartida.
 */
export type RepoMapSnapshotOutcome =
  | {
      ok: true;
      data: RepoMapSnapshotData;
      generation: number;
      cache: "hit" | "rebuilt" | "joined";
      attempts: number;
    }
  | {
      ok: false;
      code: RepoMapErrorCode;
      error: string;
      generation: number;
      attempts: number;
    };

export type RepoMapSnapshotOptions = { signal?: AbortSignal };

/** Intersección aditiva: quien solo conoce `RepoMapService` sigue compilando. */
export type RepoMapServiceWithSnapshot = RepoMapService & {
  /** Nunca lanza: todo problema vuelve como `{ ok: false, code, error }`. */
  getSnapshot(options?: RepoMapSnapshotOptions): Promise<RepoMapSnapshotOutcome>;
};

/** Construcción real: 7A → 7B → configuración → 7C, todo con el mismo `AbortSignal`. */
export const defaultRepoMapPipeline: RepoMapPipeline = async ({ workspaceRoot, signal }) => {
  try {
    await fs.lstat(path.join(workspaceRoot, ".git"));
  } catch {
    throw new UnsupportedWorkspaceError();
  }
  const inventory = await buildRepoInventory(workspaceRoot, { signal });
  const analysis = await analyzeRepoInventory(workspaceRoot, inventory, { signal });
  const config = await loadResolutionConfig(workspaceRoot, inventory, { signal });
  const graph = await buildDependencyGraph(inventory, analysis, config, { signal });
  return { inventory, analysis, graph };
};

const realTimers: RepoMapTimers = {
  setTimeout(callback, ms) {
    // NO se hace `unref()`: este timer es la garantía de que un build
    // colgado termina en `build_timeout` (y de que el proceso que espera
    // ese resultado no muera antes). Se limpia en el `finally` del build,
    // así que nunca queda vivo de más.
    return globalThis.setTimeout(callback, ms);
  },
  clearTimeout(handle) {
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
  },
};

type BuildOutcome =
  | { kind: "ok"; data: RepoMapSnapshotData }
  /** La generación cambió (o quedó una mutación en vuelo) durante la construcción, o fue reemplazada por otra: no se publica. */
  | { kind: "torn" }
  | { kind: "failed"; code: RepoMapErrorCode; error: string };

type Build = {
  generation: number;
  controller: AbortController;
  promise: Promise<BuildOutcome>;
  waiters: number;
  settled: boolean;
  timedOut: boolean;
  superseded: boolean;
};

const MESSAGES = {
  unsupported: "repo_map necesita un workspace con git; este workspace está en modo copia (sin .git). Usá list_files y search_files.",
  buildFailed: "No se pudo construir el mapa del proyecto.",
  inventoryFailed: "No se pudo listar los archivos del workspace con git.",
  timeout: "La construcción del mapa superó el tiempo máximo. Usá list_files / search_files para explorar este proyecto.",
  cancelled: "repo_map fue cancelado.",
  busyExec: "Hay un run_script o run_typecheck en ejecución que puede modificar archivos: el mapa no sería consistente. Reintentá cuando termine.",
  busyFiles: "Hay modificaciones de archivos en curso y no terminaron a tiempo. Reintentá en un momento.",
  unstable: "El worktree siguió cambiando mientras se construía el mapa. Reintentá cuando terminen las ediciones.",
  unsafePath: "subPath no es una ruta segura dentro del proyecto.",
  subPathUnverifiable: "No se pudo verificar subPath dentro del workspace.",
} as const;

function classifyFailure(error: unknown): { code: RepoMapErrorCode; error: string } {
  if (error instanceof UnsupportedWorkspaceError) return { code: "unsupported_workspace", error: MESSAGES.unsupported };
  if (error instanceof RepoInventoryError) return { code: "build_failed", error: MESSAGES.inventoryFailed };
  // Mensaje fijo: el texto de una excepción desconocida puede traer rutas absolutas.
  return { code: "build_failed", error: MESSAGES.buildFailed };
}

/**
 * Congela en profundidad el snapshot publicado. Es idempotente y tolera
 * ciclos (no debería haberlos, pero un pipeline inyectado en tests podría
 * construirlos). Se congelan arrays y objetos planos; los valores primitivos
 * no se tocan. No usa `structuredClone` para no duplicar el mapa en memoria.
 */
export function freezeSnapshotData<T>(value: T): T {
  const seen = new WeakSet<object>();
  const walk = (current: unknown): void => {
    if (current === null || typeof current !== "object") return;
    if (seen.has(current)) return;
    seen.add(current);
    Object.freeze(current);
    if (Array.isArray(current)) {
      for (const item of current) walk(item);
      return;
    }
    for (const item of Object.values(current)) walk(item);
  };
  walk(value);
  return value;
}

export function createRepoMapService(options: RepoMapServiceOptions): RepoMapServiceWithSnapshot {
  const { workspaceRoot, tracker } = options;
  const pipeline = options.pipeline ?? defaultRepoMapPipeline;
  const timers = options.timers ?? realTimers;
  const buildTimeoutMs = options.buildTimeoutMs ?? REPO_MAP_LIMITS.buildTimeoutMs;
  const quiesceTimeoutMs = options.quiesceTimeoutMs ?? REPO_MAP_LIMITS.quiesceTimeoutMs;
  const maxAttempts = options.maxAttempts ?? REPO_MAP_LIMITS.maxAttempts;

  let snapshot: { generation: number; data: RepoMapSnapshotData } | null = null;
  let building: Build | null = null;

  function failure(code: RepoMapErrorCode, message: string, attempts: number, cache: RepoMapQueryInfo["cache"] = "none"): RepoMapQueryOutcome {
    return { result: repoMapError(code, message), info: { cache, generation: tracker.generation, attempts } };
  }

  function snapshotFailure(code: RepoMapErrorCode, message: string, attempts: number): RepoMapSnapshotOutcome {
    return { ok: false, code, error: message, generation: tracker.generation, attempts };
  }

  function outcomeOfAbort(build: Build): BuildOutcome {
    if (build.timedOut) return { kind: "failed", code: "build_timeout", error: MESSAGES.timeout };
    if (build.superseded) return { kind: "torn" };
    return { kind: "failed", code: "cancelled", error: MESSAGES.cancelled };
  }

  /** Corre la construcción y decide si el resultado es publicable. NUNCA rechaza. */
  async function runBuild(build: Build): Promise<BuildOutcome> {
    try {
      const data = await pipeline({ workspaceRoot, signal: build.controller.signal });
      if (build.controller.signal.aborted) return outcomeOfAbort(build);
      // Validación de estabilidad: nada pudo mutar el worktree durante la construcción.
      if (build.superseded || tracker.generation !== build.generation || tracker.inFlight > 0) return { kind: "torn" };
      const frozen = freezeSnapshotData(data);
      snapshot = { generation: build.generation, data: frozen };
      return { kind: "ok", data: frozen };
    } catch (error) {
      if (build.controller.signal.aborted) return outcomeOfAbort(build);
      return { kind: "failed", ...classifyFailure(error) };
    }
  }

  function startBuild(generation: number): Build {
    if (building) {
      // La construcción anterior es de una generación vieja: nadie puede usarla. Se aborta de verdad.
      building.superseded = true;
      building.controller.abort();
    }
    const controller = new AbortController();
    const build: Build = { generation, controller, promise: Promise.resolve({ kind: "torn" } as BuildOutcome), waiters: 0, settled: false, timedOut: false, superseded: false };
    // Timeout interno: aborta el trabajo subyacente (el pipeline recibe el signal), no solo deja de esperar.
    const timeoutHandle = timers.setTimeout(() => {
      build.timedOut = true;
      controller.abort();
    }, buildTimeoutMs);
    build.promise = runBuild(build).finally(() => {
      timers.clearTimeout(timeoutHandle);
      build.settled = true;
      if (building === build) building = null;
    });
    building = build;
    return build;
  }

  /** Espera la construcción compartida; cancelar ESTE llamador solo aborta la construcción si ya no la necesita nadie. */
  function waitForBuild(build: Build, signal: AbortSignal | undefined): Promise<BuildOutcome | { kind: "cancelled" }> {
    return new Promise((resolve) => {
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        build.waiters -= 1;
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        release();
        if (build.waiters === 0 && !build.settled) build.controller.abort();
        resolve({ kind: "cancelled" });
      };
      build.waiters += 1;
      signal?.addEventListener("abort", onAbort, { once: true });
      void build.promise.then((outcome) => {
        if (released) return;
        release();
        resolve(outcome);
      });
    });
  }

  function waitForQuiet(signal: AbortSignal | undefined): Promise<"quiet" | "timeout" | "aborted"> {
    return new Promise((resolve) => {
      let finished = false;
      let handle: unknown;
      let unsubscribe: (() => void) | undefined;
      const finish = (result: "quiet" | "timeout" | "aborted") => {
        if (finished) return;
        finished = true;
        if (handle !== undefined) timers.clearTimeout(handle);
        unsubscribe?.();
        signal?.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const onAbort = () => finish("aborted");
      if (signal?.aborted) {
        finish("aborted");
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      handle = timers.setTimeout(() => finish("timeout"), quiesceTimeoutMs);
      unsubscribe = tracker.onQuiet(() => finish("quiet"));
    });
  }

  async function query(input: RepoMapInput, queryOptions: { signal?: AbortSignal } = {}): Promise<RepoMapQueryOutcome> {
    const signal = queryOptions.signal;

    // 1) Validación de entrada: antes de construir nada.
    const detail = input.detail ?? "overview";
    if (!REPO_MAP_DETAILS.includes(detail)) return failure("invalid_input", `detail debe ser uno de: ${REPO_MAP_DETAILS.join(", ")}.`, 0);
    const subPath = normalizeRelativeInput(input.subPath, "subPath", true);
    if (!subPath.ok) return failure(subPath.code, subPath.error, 0);
    const after = normalizeRelativeInput(input.after, "after", false);
    if (!after.ok) return failure(after.code, after.error, 0);
    if (subPath.value !== null) {
      try {
        await resolveSafePath(workspaceRoot, subPath.value);
      } catch (error) {
        // Un symlink que sale del workspace es culpa de la entrada (unsafe_path); que NO se pueda verificar
        // (p. ej. el workspace ya no existe) es un problema del entorno, no del modelo.
        return error instanceof UnsafePathError ? failure("unsafe_path", MESSAGES.unsafePath, 0) : failure("build_failed", MESSAGES.subPathUnverifiable, 0);
      }
    }

    // 2) Obtener un snapshot estable (hasta `maxAttempts` intentos).
    let attempts = 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      attempts = attempt;
      if (signal?.aborted) return failure("cancelled", MESSAGES.cancelled, attempt - 1);
      if (tracker.execInFlight > 0) return failure("busy", MESSAGES.busyExec, attempt - 1);
      if (tracker.inFlight > 0) {
        const waited = await waitForQuiet(signal);
        if (waited === "aborted") return failure("cancelled", MESSAGES.cancelled, attempt - 1);
        if (waited === "timeout") return failure("busy", MESSAGES.busyFiles, attempt - 1);
        if (tracker.inFlight > 0) continue; // otra mutación arrancó justo después del aviso
      }

      const generation = tracker.generation;
      if (snapshot && snapshot.generation === generation) {
        return { result: projectRepoMap(snapshot.data, input, { maxChars: options.maxOutputChars }), info: { cache: "hit", generation, attempts: attempt - 1 } };
      }

      const reusable = building && building.generation === generation && !building.superseded && !building.controller.signal.aborted ? building : null;
      const build = reusable ?? startBuild(generation);
      const outcome = await waitForBuild(build, signal);
      if (outcome.kind === "cancelled") return failure("cancelled", MESSAGES.cancelled, attempt);
      if (outcome.kind === "torn") continue;
      if (outcome.kind === "failed") return failure(outcome.code, outcome.error, attempt, reusable ? "joined" : "rebuilt");
      return { result: projectRepoMap(outcome.data, input, { maxChars: options.maxOutputChars }), info: { cache: reusable ? "joined" : "rebuilt", generation, attempts: attempt } };
    }
    return failure("unstable", MESSAGES.unstable, attempts);
  }

  async function getSnapshot(snapshotOptions: RepoMapSnapshotOptions = {}): Promise<RepoMapSnapshotOutcome> {
    const signal = snapshotOptions.signal;
    let attempts = 0;

    // Misma política de estabilidad que `query()`: nunca se construye sobre
    // un worktree a medio escribir. El motor de contexto no debe bloquear la
    // task por esto: recibe `busy` y sigue sin briefing.
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      attempts = attempt;
      if (signal?.aborted) return snapshotFailure("cancelled", MESSAGES.cancelled, attempt - 1);
      if (tracker.execInFlight > 0) return snapshotFailure("busy", MESSAGES.busyExec, attempt - 1);
      if (tracker.inFlight > 0) {
        const waited = await waitForQuiet(signal);
        if (waited === "aborted") return snapshotFailure("cancelled", MESSAGES.cancelled, attempt - 1);
        if (waited === "timeout") return snapshotFailure("busy", MESSAGES.busyFiles, attempt - 1);
        if (tracker.inFlight > 0) continue;
      }

      const generation = tracker.generation;
      if (snapshot && snapshot.generation === generation) {
        return { ok: true, data: snapshot.data, generation, cache: "hit", attempts: attempt - 1 };
      }

      const reusable = building && building.generation === generation && !building.superseded && !building.controller.signal.aborted ? building : null;
      const build = reusable ?? startBuild(generation);
      const outcome = await waitForBuild(build, signal);
      if (outcome.kind === "cancelled") return snapshotFailure("cancelled", MESSAGES.cancelled, attempt);
      if (outcome.kind === "torn") continue;
      if (outcome.kind === "failed") return snapshotFailure(outcome.code, outcome.error, attempt);
      // `runBuild` solo publica si la generación no cambió: el snapshot
      // corresponde exactamente a `build.generation`.
      return { ok: true, data: outcome.data, generation: build.generation, cache: reusable ? "joined" : "rebuilt", attempts: attempt };
    }
    return snapshotFailure("unstable", MESSAGES.unstable, attempts);
  }

  return {
    async query(input, queryOptions) {
      try {
        return await query(input, queryOptions);
      } catch {
        // Defensa en profundidad: ninguna excepción (ni su texto) llega al tool.
        return failure("build_failed", MESSAGES.buildFailed, 0);
      }
    },
    async getSnapshot(snapshotOptions) {
      try {
        return await getSnapshot(snapshotOptions);
      } catch {
        return snapshotFailure("build_failed", MESSAGES.buildFailed, 0);
      }
    },
  };
}
