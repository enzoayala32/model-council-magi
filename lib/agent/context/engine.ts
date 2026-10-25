/**
 * Fase 8D — Motor de contexto del Agent.
 *
 * Orquesta UNA carga inicial del snapshot de solo lectura y, como máximo,
 * unas pocas actualizaciones cuando el tracker avisa que el worktree cambió.
 * No crea una segunda caché: reutiliza `getSnapshot()` del mismo
 * `RepoMapService` que usa la tool `repo_map`, así que ambos ven la misma
 * generación y no se reconstruye el mapa dos veces por iteración.
 *
 * Fallback: si el mapa no está disponible (workspace sin git, busy,
 * unstable, timeout, cancelado o build_failed), el loop sigue funcionando
 * exactamente como antes, sin briefing. Un fallo del motor NUNCA debe
 * romper una task.
 */
import type { RepoMapServiceWithSnapshot } from "../repo-map-service";
import type { RepoMapTracker } from "../repo-map-tracker";
import type { RepoMapErrorCode } from "../repo-map-views";
import { buildBriefing, type Briefing, type BriefingInventory, type BriefingRecentTool } from "./briefing";
import { isSensitivePath } from "./sensitive-paths";
import { selectContext, type ContextSelection } from "./select";
import type { ContextSelectionSummary } from "./usage";

export const DEFAULT_CONTEXT_REFRESH_LIMIT = 2;
export const DEFAULT_CONTEXT_BRIEFING_CHARS = 6_000;
export const DEFAULT_CONTEXT_START_TIMEOUT_MS = 20_000;
export const DEFAULT_CONTEXT_REFRESH_TIMEOUT_MS = 8_000;

export type ContextEngineOptions = {
  task: string;
  workspaceRoot: string;
  modelId: string;
  tracker: RepoMapTracker;
  service: RepoMapServiceWithSnapshot;
  maxCandidates?: number;
  briefingMaxChars?: number;
  refreshLimit?: number;
  /** Tope de la carga inicial. Al vencer, el engine queda no disponible y
   * el loop sigue sin briefing (nunca bloquea la task 60 s). */
  startTimeoutMs?: number;
  /** Tope de cada refresco. Al vencer, se conserva el briefing anterior. */
  refreshTimeoutMs?: number;
};

export type ContextEngineStatus = {
  available: boolean;
  error: RepoMapErrorCode | null;
  generation: number | null;
  refreshes: number;
  selection: ContextSelection | null;
  briefing: Briefing | null;
};

export type ContextEngine = {
  start(signal?: AbortSignal): Promise<void>;
  needsRefresh(): boolean;
  refreshIfNeeded(signal?: AbortSignal): Promise<boolean>;
  noteTouched(paths: readonly string[]): void;
  noteRecentTool(event: BriefingRecentTool): void;
  getSystemSuffix(): string;
  getBriefing(): Briefing | null;
  getSummary(): ContextSelectionSummary;
  getStatus(): ContextEngineStatus;
};

const ZERO_SIGNALS = {
  explicit_path: 0,
  touched: 0,
  symbol_mention: 0,
  term_match: 0,
  graph_neighbor: 0,
  role: 0,
  test_pair: 0,
} as const;

export function createContextEngine(options: ContextEngineOptions): ContextEngine {
  const refreshLimit = Math.max(0, options.refreshLimit ?? DEFAULT_CONTEXT_REFRESH_LIMIT);
  const briefingMaxChars = Math.max(0, options.briefingMaxChars ?? DEFAULT_CONTEXT_BRIEFING_CHARS);
  const startTimeoutMs = Math.max(1, options.startTimeoutMs ?? DEFAULT_CONTEXT_START_TIMEOUT_MS);
  const refreshTimeoutMs = Math.max(1, options.refreshTimeoutMs ?? DEFAULT_CONTEXT_REFRESH_TIMEOUT_MS);
  const touched = new Set<string>();
  const recentTools: BriefingRecentTool[] = [];
  let selection: ContextSelection | null = null;
  let briefing: Briefing | null = null;
  let inventory: BriefingInventory | null = null;
  let frameworks: string[] = [];
  let available = false;
  let error: RepoMapErrorCode | null = null;
  let generation: number | null = null;
  let lastAttemptGeneration: number | null = null;
  let refreshes = 0;
  let started = false;
  let inFlight: Promise<boolean> | null = null;

  function safeTouched(): string[] {
    return [...touched].filter((path) => !isSensitivePath(path)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  function safeRecent(): BriefingRecentTool[] {
    return recentTools
      .filter((entry) => !entry.path || !isSensitivePath(entry.path))
      .slice(-20)
      .map((entry) => ({ ...entry, ...(entry.path ? { path: entry.path.replace(/\\/g, "/") } : {}) }));
  }

  function rebuildBriefing(engineError: RepoMapErrorCode | null): void {
    briefing = buildBriefing({
      selection,
      inventory,
      frameworks,
      touchedPaths: safeTouched(),
      recentTools: safeRecent(),
      engineError,
      maxChars: briefingMaxChars,
    });
  }

  /** Combina la señal externa con un timeout propio. La señal resultante
   * aborta el trabajo real del service, no solo la espera. */
  function scopedSignal(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    // NO se hace `unref()`: este timeout es la garantía de que `start()`
    // resuelve aunque el service se cuelgue y no haya otra tarea viva. Un
    // timer "unref" deja que Node salga del event loop antes de disparar y
    // la task quedaría esperando para siempre.
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return {
      signal: controller.signal,
      cleanup: () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      },
    };
  }

  async function load(signal: AbortSignal | undefined, isRefresh: boolean): Promise<boolean> {
    const attemptedGeneration = options.tracker.generation;
    lastAttemptGeneration = attemptedGeneration;
    if (isRefresh) refreshes += 1;
    try {
      const outcome = await options.service.getSnapshot({ signal });
      if (!outcome.ok) {
        error = outcome.code;
        // Si ya había un briefing válido, no lo reemplazamos por uno vacío:
        // el contexto previo sigue siendo útil y el error se reporta en el
        // evento de uso. En la primera carga sí mostramos el fallback.
        if (!selection) {
          available = false;
          inventory = null;
          frameworks = [];
          rebuildBriefing(outcome.code);
        }
        return false;
      }
      const nextSelection = selectContext({
        task: options.task,
        snapshot: outcome.data,
        touchedPaths: safeTouched(),
        maxCandidates: options.maxCandidates,
      });
      selection = nextSelection;
      generation = outcome.generation;
      inventory = {
        files: outcome.data.inventory.stats.files,
        analyzable: outcome.data.inventory.stats.analyzable,
        skipped: outcome.data.inventory.stats.skipped,
        truncated: outcome.data.inventory.truncated,
      };
      frameworks = outcome.data.inventory.frameworks.map((framework) => framework.name);
      available = true;
      error = null;
      rebuildBriefing(null);
      return true;
    } catch {
      error = "build_failed";
      if (!selection) {
        available = false;
        inventory = null;
        frameworks = [];
        rebuildBriefing("build_failed");
      }
      return false;
    }
  }

  return {
    async start(signal) {
      if (started) return;
      started = true;
      const scoped = scopedSignal(signal, startTimeoutMs);
      try {
        await load(scoped.signal, false);
      } finally {
        scoped.cleanup();
      }
    },

    needsRefresh() {
      if (!started || refreshes >= refreshLimit) return false;
      return lastAttemptGeneration === null || options.tracker.generation !== lastAttemptGeneration;
    },

    async refreshIfNeeded(signal) {
      // Single-flight ANTES de `needsRefresh`: `load` ya actualizó
      // `lastAttemptGeneration` al arrancar, así que una segunda llamada
      // concurrente vería "no hace falta" y devolvería false en vez de
      // unirse al refresco que está en curso.
      if (inFlight) return inFlight;
      if (!this.needsRefresh()) return false;
      const scoped = scopedSignal(signal, refreshTimeoutMs);
      inFlight = load(scoped.signal, true).finally(() => {
        scoped.cleanup();
        inFlight = null;
      });
      return inFlight;
    },

    noteTouched(paths) {
      let changed = false;
      for (const path of paths) {
        const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
        if (normalized && !touched.has(normalized)) {
          touched.add(normalized);
          changed = true;
        }
      }
      if (changed) rebuildBriefing(error);
    },

    noteRecentTool(event) {
      recentTools.push({ ...event });
      if (recentTools.length > 50) recentTools.splice(0, recentTools.length - 50);
      rebuildBriefing(error);
    },

    getSystemSuffix() {
      return briefing && briefing.text ? `\n\n${briefing.text}` : "";
    },

    getBriefing() {
      return briefing;
    },

    getSummary(): ContextSelectionSummary {
      return {
        enabled: true,
        available,
        candidates: selection?.stats.candidatesBeforeCap ?? 0,
        included: selection?.candidates.length ?? 0,
        truncated: selection?.stats.truncated ?? false,
        confidence: selection?.confidence ?? null,
        generation,
        refreshes,
        error,
        signals: selection?.stats.signalsFired ?? { ...ZERO_SIGNALS },
      };
    },

    getStatus() {
      return { available, error, generation, refreshes, selection, briefing };
    },
  };
}
