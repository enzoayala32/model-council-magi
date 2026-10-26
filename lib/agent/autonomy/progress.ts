/**
 * Fase 9D — detección de no-progreso del Autonomous Loop.
 *
 * Módulo PURO: no toca DB, red, filesystem ni modelo. Recibe observaciones
 * ya calculadas por el dispatcher (hashes de acciones, resultados, errores,
 * workspace, diff y plan) y decide si la corrida está repitiendo trabajo,
 * oscilando o simplemente dejó de avanzar.
 *
 * Reglas de escalada (diseño 9D, sección 6.2):
 * 1. La PRIMERA vez que un detector alcanza su umbral se emite un warning
 *    accionable (se inyecta en el próximo briefing) y se sigue.
 * 2. Si la condición se repite después del warning, la corrida pasa a
 *    STALLED. Un detector que deja de cumplirse (por progreso real, por un
 *    diff distinto o por un plan distinto) se resetea, incluido su warning.
 *
 * Nada de lo que entra acá se persiste: solo hashes, conteos y un mensaje
 * fijo por detector. El contenido de archivos, stdout/stderr y los prompts
 * nunca salen de este módulo.
 */

import crypto from "node:crypto";
import { redactSecrets } from "../../provider-resilience/redact";

export type ProgressDetectorKind =
  | "repeated_action"
  | "repeated_error"
  | "identical_diff"
  | "oscillation"
  | "no_progress"
  | "plan_stalled";

/** Subconjunto de `AutonomyLimits` que usa el detector. No agrega límites
 * nuevos: reutiliza los aprobados en 9A. */
export type ProgressLimits = {
  maxIdenticalActions: number;
  maxSameError: number;
  maxIdenticalDiffs: number;
  maxOscillations: number;
  maxNoProgressSteps: number;
};

/** El diseño fija 2 para `plan_stalled`; no existe un límite 9A para este
 * detector, así que se usa una constante explícita en vez de inventar un
 * campo nuevo en el contrato. */
export const PLAN_STALL_THRESHOLD = 2;

const MAX_NORMALIZED_ERROR_CHARS = 500;
const MAX_DISTINCT_DIFFS = 9;

export type ProgressAction = {
  toolName: string;
  /** sha256(toolName + canonicalJSON(input)). */
  actionHash: string;
  /** sha256(toolName + ok + errorCode + outputHash). */
  resultHash: string;
  ok: boolean;
  /** sha256(toolName + error normalizado), o null si no hubo error. */
  errorHash: string | null;
};

export type ProgressObservation = {
  stepIndex: number;
  actions: ProgressAction[];
  /** Hash de archivos tocados + `git status --porcelain`, o null si el paso
   * no pudo mutar el workspace (solo lecturas/plan). */
  workspaceHash: string | null;
  /** Hash de los hashes por archivo del paso, o null si no hubo archivos. */
  diffHash: string | null;
  /** Transición terminal de un item (DONE/BLOCKED/FAILED/SKIPPED) o
   * evidencia nueva aceptada por el ledger. */
  ledgerChanged: boolean;
  /** Algún item pasó a DONE en este paso. */
  doneItem: boolean;
  /** Hash del plan activo ("" si todavía no hay plan). */
  planHash: string;
  /** Se guardó una versión nueva de plan en este paso. */
  planChanged: boolean;
};

export type ProgressVerdict =
  | { level: "ok" }
  | { level: "warning"; detector: ProgressDetectorKind; count: number; threshold: number; message: string }
  | { level: "stalled"; detector: ProgressDetectorKind; count: number; threshold: number; message: string };

export type ProgressSnapshot = {
  noProgressSteps: number;
  maxActionCount: number;
  maxErrorCount: number;
  maxDiffCount: number;
  oscillationCycles: number;
  planStallCount: number;
  warned: ProgressDetectorKind[];
};

export interface ProgressTracker {
  observe(observation: ProgressObservation): ProgressVerdict;
  snapshot(): ProgressSnapshot;
}

// ---------------------------------------------------------------------------
// Fingerprints
// ---------------------------------------------------------------------------

/** JSON canónico: claves ordenadas, arrays en su orden. Determinista para
 * que el mismo input produzca siempre el mismo hash. */
export function canonicalProgressJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalProgressJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalProgressJson(record[key])}`).join(",")}}`;
}

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text, "utf-8").digest("hex");
}

export function hashProgressAction(toolName: string, input: unknown): string {
  return sha256(`${toolName}\u0000${canonicalProgressJson(input)}`);
}

/** `outputHash` lo calcula el dispatcher sobre el output completo (solo se
 * usa el hash, nunca el output). Para `read_file`/`read_file_range` el
 * propio output ya incluye el hash del archivo, así que una relectura tras
 * un cambio de contenido produce un `resultHash` distinto y NO cuenta como
 * acción repetida. */
export function hashProgressResult(
  toolName: string,
  ok: boolean,
  errorCode: string | null | undefined,
  outputHash: string,
): string {
  return sha256(`${toolName}\u0000${ok ? "1" : "0"}\u0000${errorCode ?? ""}\u0000${outputHash}`);
}

/**
 * Normaliza un error para compararlo entre pasos:
 * - reemplaza el workspace real por `<workspace>`,
 * - borra rutas absolutas Windows/POSIX y UNC,
 * - redacta secretos registrados,
 * - reemplaza números por `<n>` (líneas, puertos, códigos variables),
 * - colapsa espacios y recorta a 500 chars.
 *
 * Es determinista y nunca devuelve el texto original completo.
 */
export function normalizeProgressError(
  raw: string,
  options: { workspaceRoot?: string; maxChars?: number } = {},
): string {
  let text = typeof raw === "string" ? raw : String(raw ?? "");
  if (options.workspaceRoot) text = text.split(options.workspaceRoot).join("<workspace>");
  // Windows drive (evita comerse el `s:` de `https://`).
  text = text.replace(/(^|[\s"'(=])[A-Za-z]:[\\/][^\s"'<>|]+/g, "$1<path>");
  // UNC.
  text = text.replace(/\\\\[^\s"'<>|]+/g, "<path>");
  // POSIX absoluto (no matchea `://` porque el `/` viene precedido de `:`).
  text = text.replace(/(^|[\s"'(=])\/[^\s"'<>|)]+/g, "$1<path>");
  text = redactSecrets(text);
  text = text.replace(/\d+/g, "<n>");
  text = text.replace(/\s+/g, " ").trim();
  const max = Number.isFinite(options.maxChars) && (options.maxChars ?? 0) > 0
    ? Math.floor(options.maxChars as number)
    : MAX_NORMALIZED_ERROR_CHARS;
  return text.slice(0, max);
}

export function hashProgressError(
  toolName: string,
  message: string,
  options: { workspaceRoot?: string; maxChars?: number } = {},
): string {
  return sha256(`${toolName}\u0000${normalizeProgressError(message, options)}`);
}

// ---------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------

type InternalState = {
  actionCounts: Map<string, number>;
  errorCounts: Map<string, number>;
  diffCounts: Map<string, number>;
  /** Últimos diffs distintos (consecutivos repetidos colapsados). */
  distinctDiffs: string[];
  noProgress: number;
  planStall: number;
  lastPlanHash: string | null;
  lastWorkspaceHash: string | null;
  oscillationCycles: number;
  ledgerProgressSincePlan: boolean;
  warned: Set<ProgressDetectorKind>;
};

function maxCount(map: Map<string, number>): number {
  let max = 0;
  for (const value of map.values()) if (value > max) max = value;
  return max;
}

/** Ciclos A→B→A en la cola de la secuencia de diffs distintos. */
function countOscillationCycles(sequence: string[]): number {
  if (sequence.length < 3) return 0;
  let run = 1;
  for (let index = sequence.length - 1; index > 0; index -= 1) {
    if (sequence[index] === sequence[index - 1]) break;
    run += 1;
  }
  return Math.floor((run - 1) / 2);
}

function messageFor(detector: ProgressDetectorKind, count: number, threshold: number): string {
  switch (detector) {
    case "repeated_action":
      return `Estás repitiendo la misma acción con el mismo resultado (${count}/${threshold}). Cambiá de estrategia, releé el estado real o declarate BLOCKED.`;
    case "repeated_error":
      return `El mismo error se repitió ${count} veces (umbral ${threshold}). No reintentes lo mismo: diagnosticá la causa o declarate BLOCKED.`;
    case "identical_diff":
      return `Estás produciendo el mismo diff sin completar ningún item (${count}/${threshold}). Revisá si el cambio ya está aplicado o replanteá el plan.`;
    case "oscillation":
      return `Los cambios oscilan entre los mismos estados (${count}/${threshold} ciclos A→B→A). Elegí una dirección, verificá el resultado y no vuelvas atrás sin evidencia.`;
    case "no_progress":
      return `No hubo avance de ledger ni cambios en el workspace en ${count} pasos (umbral ${threshold}). Releé el estado, cambiá de enfoque o declarate BLOCKED.`;
    case "plan_stalled":
      return `Replanificaste al mismo plan ${count} veces sin avanzar (umbral ${threshold}). Cambiá el plan o ejecutá el que ya existe.`;
  }
}

function warningFor(detector: ProgressDetectorKind, count: number, threshold: number): ProgressVerdict {
  return { level: "warning", detector, count, threshold, message: messageFor(detector, count, threshold) };
}

function stalledFor(detector: ProgressDetectorKind, count: number, threshold: number): ProgressVerdict {
  return { level: "stalled", detector, count, threshold, message: messageFor(detector, count, threshold) };
}

class ProgressTrackerImpl implements ProgressTracker {
  private readonly state: InternalState = {
    actionCounts: new Map(),
    errorCounts: new Map(),
    diffCounts: new Map(),
    distinctDiffs: [],
    noProgress: 0,
    planStall: 0,
    lastPlanHash: null,
    lastWorkspaceHash: null,
    oscillationCycles: 0,
    ledgerProgressSincePlan: false,
    warned: new Set(),
  };

  constructor(private readonly limits: ProgressLimits) {}

  observe(observation: ProgressObservation): ProgressVerdict {
    const state = this.state;

    // 1) ¿Cambió el workspace real en este paso?
    const workspaceChanged =
      observation.workspaceHash !== null && observation.workspaceHash !== state.lastWorkspaceHash;
    if (observation.workspaceHash !== null) state.lastWorkspaceHash = observation.workspaceHash;

    // Un replan también cuenta como avance para no_progress: es un cambio de
    // estrategia real, no una acción repetida. `plan_stalled` se encarga de
    // que replanificar al mismo plan no sirva para esquivar el detector.
    const progress = observation.ledgerChanged || workspaceChanged || observation.planChanged;

    if (progress) {
      state.actionCounts.clear();
      state.errorCounts.clear();
      state.noProgress = 0;
      state.warned.delete("repeated_action");
      state.warned.delete("repeated_error");
      state.warned.delete("no_progress");
    } else {
      state.noProgress += 1;
    }

    // 2) Acciones y errores repetidos.
    let actionIncrement = 0;
    let errorIncrement = 0;
    for (const action of observation.actions) {
      // El error normalizado forma parte de la identidad del resultado: la
      // misma tool con el mismo errorCode pero un mensaje distinto NO es una
      // acción repetida (para eso está repeated_error, que compara errores).
      const actionKey = `${action.actionHash}:${action.resultHash}:${action.errorHash ?? ""}`;
      const actionCount = (state.actionCounts.get(actionKey) ?? 0) + 1;
      state.actionCounts.set(actionKey, actionCount);
      if (actionCount > actionIncrement) actionIncrement = actionCount;

      if (action.errorHash) {
        const errorCount = (state.errorCounts.get(action.errorHash) ?? 0) + 1;
        state.errorCounts.set(action.errorHash, errorCount);
        if (errorCount > errorIncrement) errorIncrement = errorCount;
      }
    }

    // 3) Diffs idénticos y oscilación.
    let diffIncrement = 0;
    if (observation.diffHash) {
      diffIncrement = (state.diffCounts.get(observation.diffHash) ?? 0) + 1;
      state.diffCounts.set(observation.diffHash, diffIncrement);
      if (state.distinctDiffs[state.distinctDiffs.length - 1] !== observation.diffHash) {
        state.distinctDiffs.push(observation.diffHash);
        if (state.distinctDiffs.length > MAX_DISTINCT_DIFFS) state.distinctDiffs.shift();
      }
    }
    const cycles = countOscillationCycles(state.distinctDiffs);
    const oscillationIncrement = cycles > state.oscillationCycles ? cycles : 0;
    state.oscillationCycles = cycles;
    if (cycles < this.limits.maxOscillations) state.warned.delete("oscillation");

    if (observation.doneItem) {
      state.diffCounts.clear();
      state.distinctDiffs = [];
      state.oscillationCycles = 0;
      state.warned.delete("identical_diff");
      state.warned.delete("oscillation");
    }

    // 4) Replanificar al mismo plan sin avance de ledger.
    if (observation.ledgerChanged) {
      state.planStall = 0;
      state.ledgerProgressSincePlan = true;
      state.warned.delete("plan_stalled");
    }
    let planStallIncrement = 0;
    if (observation.planChanged) {
      if (
        state.lastPlanHash !== null &&
        state.lastPlanHash === observation.planHash &&
        !state.ledgerProgressSincePlan
      ) {
        state.planStall = Math.max(1, state.planStall) + 1;
      } else {
        state.planStall = 1;
        state.warned.delete("plan_stalled");
      }
      state.lastPlanHash = observation.planHash;
      state.ledgerProgressSincePlan = false;
      if (state.planStall >= PLAN_STALL_THRESHOLD) planStallIncrement = state.planStall;
    }

    // 5) Elegir el detector que se incrementó en ESTE paso y alcanzó su
    // umbral. Orden determinista: el más específico primero.
    type Candidate = { detector: ProgressDetectorKind; count: number; threshold: number; fired: boolean };
    const candidates: Candidate[] = [
      {
        detector: "repeated_error",
        count: errorIncrement,
        threshold: this.limits.maxSameError,
        fired: errorIncrement >= this.limits.maxSameError,
      },
      {
        detector: "repeated_action",
        count: actionIncrement,
        threshold: this.limits.maxIdenticalActions,
        fired: actionIncrement >= this.limits.maxIdenticalActions,
      },
      {
        detector: "oscillation",
        count: cycles,
        threshold: this.limits.maxOscillations,
        fired: oscillationIncrement >= this.limits.maxOscillations,
      },
      {
        detector: "identical_diff",
        count: diffIncrement,
        threshold: this.limits.maxIdenticalDiffs,
        fired: diffIncrement >= this.limits.maxIdenticalDiffs,
      },
      {
        detector: "plan_stalled",
        count: state.planStall,
        threshold: PLAN_STALL_THRESHOLD,
        fired: planStallIncrement >= PLAN_STALL_THRESHOLD,
      },
      {
        detector: "no_progress",
        count: state.noProgress,
        threshold: this.limits.maxNoProgressSteps,
        fired: !progress && state.noProgress >= this.limits.maxNoProgressSteps,
      },
    ];

    const fired = candidates.find((candidate) => candidate.fired);
    if (!fired) return { level: "ok" };

    if (state.warned.has(fired.detector)) return stalledFor(fired.detector, fired.count, fired.threshold);
    state.warned.add(fired.detector);
    return warningFor(fired.detector, fired.count, fired.threshold);
  }

  snapshot(): ProgressSnapshot {
    return {
      noProgressSteps: this.state.noProgress,
      maxActionCount: maxCount(this.state.actionCounts),
      maxErrorCount: maxCount(this.state.errorCounts),
      maxDiffCount: maxCount(this.state.diffCounts),
      oscillationCycles: this.state.oscillationCycles,
      planStallCount: this.state.planStall,
      warned: Array.from(this.state.warned).sort(),
    };
  }
}

export function createProgressTracker(limits: ProgressLimits): ProgressTracker {
  return new ProgressTrackerImpl(limits);
}
