/**
 * Fase 9A — contrato del Autonomous Loop.
 *
 * Este módulo es PURO: no toca DB, filesystem, red ni modelo. Define los
 * estados internos de una corrida autónoma, la tabla cerrada de
 * transiciones, los límites por defecto y el mapeo a los estados de
 * `CodingTask` que ya existen desde Fase 2.
 *
 * Decisiones:
 * - NO se agregan estados nuevos a `TaskStatus`: la máquina de estados de
 *   la task (QUEUED/RUNNING/READY_FOR_REVIEW/...) queda intacta para no
 *   romper UI, API ni DB. El estado autónomo vive en `agent_runs.state`.
 * - La autonomía es opt-in. Este contrato no cambia el comportamiento de
 *   `runAgentLoop`; solo describe lo que 9C/9F podrán usar.
 * - Los límites se normalizan con topes duros: un valor inválido nunca
 *   produce un límite negativo, `NaN` ni `Infinity`.
 * - El mapeo a la task preserva trabajo parcial: si el loop se estanca o
 *   agota presupuesto pero hay propuestas reales, la task va a
 *   READY_FOR_REVIEW con un `stop_reason` explícito.
 */

import type { TaskStatus } from "../task-store";

/** Versión del contrato. Subirla solo ante un cambio incompatible de
 * estados/límites/semántica, no por agregados aditivos. */
export const AUTONOMY_CONTRACT_VERSION = 1;

export const AUTONOMY_STATES = Object.freeze([
  "PLANNING",
  "EXECUTING",
  "VERIFYING",
  "REPLANNING",
  "RESUMING",
  "DONE",
  "BLOCKED",
  "STALLED",
  "BUDGET_EXHAUSTED",
  "FAILED",
  "CANCELLED",
] as const);

export type AutonomyState = (typeof AUTONOMY_STATES)[number];

export const AUTONOMY_TERMINAL_STATES = Object.freeze([
  "DONE",
  "BLOCKED",
  "STALLED",
  "BUDGET_EXHAUSTED",
  "FAILED",
  "CANCELLED",
] as const);

export type AutonomyTerminalState = (typeof AUTONOMY_TERMINAL_STATES)[number];

const TERMINAL_STATE_SET: ReadonlySet<AutonomyState> = new Set(AUTONOMY_TERMINAL_STATES);

export function isTerminalAutonomyState(state: AutonomyState): state is AutonomyTerminalState {
  return TERMINAL_STATE_SET.has(state);
}

/** Tabla CERRADA de transiciones. Un estado terminal no tiene salida.
 * `PLANNING` no puede saltar directo a `VERIFYING` (primero hay que
 * ejecutar algo); `EXECUTING` no puede volver a `PLANNING` (para eso está
 * `REPLANNING`, que tiene su propio límite). */
export const AUTONOMY_STATE_TRANSITIONS: Readonly<Record<AutonomyState, readonly AutonomyState[]>> = Object.freeze({
  PLANNING: Object.freeze(["EXECUTING", "BLOCKED", "FAILED", "CANCELLED", "BUDGET_EXHAUSTED"] as const),
  EXECUTING: Object.freeze([
    "VERIFYING",
    "REPLANNING",
    "BLOCKED",
    "STALLED",
    "FAILED",
    "CANCELLED",
    "BUDGET_EXHAUSTED",
  ] as const),
  VERIFYING: Object.freeze([
    "DONE",
    "REPLANNING",
    "BLOCKED",
    "STALLED",
    "FAILED",
    "CANCELLED",
    "BUDGET_EXHAUSTED",
  ] as const),
  REPLANNING: Object.freeze(["EXECUTING", "BLOCKED", "FAILED", "CANCELLED", "BUDGET_EXHAUSTED"] as const),
  RESUMING: Object.freeze([
    "EXECUTING",
    "VERIFYING",
    "REPLANNING",
    "BLOCKED",
    "FAILED",
    "CANCELLED",
    "BUDGET_EXHAUSTED",
  ] as const),
  DONE: Object.freeze([] as const),
  BLOCKED: Object.freeze([] as const),
  STALLED: Object.freeze([] as const),
  BUDGET_EXHAUSTED: Object.freeze([] as const),
  FAILED: Object.freeze([] as const),
  CANCELLED: Object.freeze([] as const),
});

export class InvalidAutonomyTransitionError extends Error {
  constructor(
    public readonly from: AutonomyState,
    public readonly to: AutonomyState,
  ) {
    super(`Transición autónoma inválida: ${from} → ${to} no está permitida.`);
    this.name = "InvalidAutonomyTransitionError";
  }
}

export function canTransitionAutonomyState(from: AutonomyState, to: AutonomyState): boolean {
  return AUTONOMY_STATE_TRANSITIONS[from].includes(to);
}

export function assertAutonomyTransition(from: AutonomyState, to: AutonomyState): void {
  if (!canTransitionAutonomyState(from, to)) throw new InvalidAutonomyTransitionError(from, to);
}

/** Razones de parada persistidas en `agent_runs.stop_reason` y en
 * `agent_tasks.stop_reason` cuando la corrida termina. No son estados. */
export const AUTONOMY_STOP_REASONS = Object.freeze([
  "completed",
  "blocked",
  "stalled",
  "budget_exhausted",
  "error",
  "timeout",
  "provider_error",
  "cancelled",
  "resume_exhausted",
  "retries_exhausted",
] as const);

export type AutonomyStopReason = (typeof AUTONOMY_STOP_REASONS)[number];

/** Códigos estables para diagnóstico. Nunca incluyen texto libre del
 * modelo ni contenido de archivos. */
export const AUTONOMY_ERROR_CODES = Object.freeze([
  "plan_invalid",
  "plan_cycle",
  "plan_too_large",
  "plan_item_unknown",
  "evidence_invalid",
  "verification_failed",
  "verification_unavailable",
  "workspace_drift",
  "workspace_missing",
  "base_commit_mismatch",
  "resume_exhausted",
  "budget_steps",
  "budget_time",
  "budget_tokens",
  "budget_cost",
  "repeated_action",
  "repeated_error",
  "identical_diff",
  "oscillation",
  "no_progress",
  "provider_error",
  "tool_error",
  "cancelled",
  "timeout",
  "internal_error",
] as const);

export type AutonomyErrorCode = (typeof AUTONOMY_ERROR_CODES)[number];

export type AutonomyBudget = {
  steps: number;
  wallTimeMs: number;
  inputTokens: number;
  outputTokens: number;
  /** `null` si el modelo no tiene pricing conocido: nunca se inventa un
   * costo. */
  estimatedCostUsd: number | null;
};

export type AutonomyRun = {
  id: string;
  taskId: string;
  attempt: number;
  state: AutonomyState;
  stopReason: AutonomyStopReason | null;
  resumeOfRunId: string | null;
  workspaceId: string | null;
  baseCommit: string | null;
  headCommit: string | null;
  planVersion: number;
  budget: AutonomyBudget;
  lastEventSeq: number | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
};

export type AutonomyLimits = {
  /** Pasos totales de modelo/tool en la corrida. */
  maxSteps: number;
  /** Pasos máximos de una fase EXECUTING. */
  maxStepsPerPhase: number;
  maxWallTimeMs: number;
  /** Input + output. */
  maxTokens: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  /** `null` = no enforceable (modelo sin pricing conocido). */
  maxCostUsd: number | null;
  maxReplans: number;
  maxPlanVersions: number;
  maxPlanItems: number;
  maxPlanDepth: number;
  maxPlanItemTitleChars: number;
  maxPlanItemDescriptionChars: number;
  maxConstraints: number;
  maxAcceptancePerItem: number;
  maxEvidencePerItem: number;
  maxNoProgressSteps: number;
  maxIdenticalActions: number;
  maxIdenticalDiffs: number;
  maxSameError: number;
  maxOscillations: number;
  maxInvalidPlanAttempts: number;
  maxResumeAttempts: number;
  checkpointEverySteps: number;
  cancelGraceMs: number;
  maxObservationBytes: number;
  maxFinalReportBytes: number;
};

export type AutonomyLimitBounds = {
  min: number;
  max: number;
  integer: boolean;
};

const bounds = (min: number, max: number, integer = true): AutonomyLimitBounds => Object.freeze({ min, max, integer });

/** Topes duros de normalización. Un valor fuera de rango se recorta; un
 * valor no numérico cae al default. */
export const AUTONOMY_LIMIT_BOUNDS: Readonly<Record<Exclude<keyof AutonomyLimits, "maxCostUsd">, AutonomyLimitBounds>> = Object.freeze({
  maxSteps: bounds(1, 200),
  maxStepsPerPhase: bounds(1, 200),
  maxWallTimeMs: bounds(1_000, 24 * 60 * 60_000),
  maxTokens: bounds(1_000, 100_000_000),
  maxInputTokens: bounds(0, 100_000_000),
  maxOutputTokens: bounds(0, 100_000_000),
  maxReplans: bounds(0, 20),
  maxPlanVersions: bounds(1, 100),
  maxPlanItems: bounds(1, 200),
  maxPlanDepth: bounds(1, 3),
  maxPlanItemTitleChars: bounds(1, 2_000),
  maxPlanItemDescriptionChars: bounds(0, 20_000),
  maxConstraints: bounds(0, 100),
  maxAcceptancePerItem: bounds(0, 50),
  maxEvidencePerItem: bounds(0, 50),
  maxNoProgressSteps: bounds(1, 100),
  maxIdenticalActions: bounds(2, 20),
  maxIdenticalDiffs: bounds(1, 20),
  maxSameError: bounds(2, 20),
  maxOscillations: bounds(1, 20),
  maxInvalidPlanAttempts: bounds(1, 10),
  maxResumeAttempts: bounds(0, 10),
  checkpointEverySteps: bounds(1, 50),
  cancelGraceMs: bounds(0, 60_000),
  maxObservationBytes: bounds(1_024, 10_000_000),
  maxFinalReportBytes: bounds(1_024, 10_000_000),
});

export const AUTONOMY_MAX_COST_USD = 1_000_000;

export const DEFAULT_AUTONOMY_LIMITS: AutonomyLimits = Object.freeze({
  maxSteps: 40,
  maxStepsPerPhase: 20,
  maxWallTimeMs: 15 * 60_000,
  maxTokens: 1_500_000,
  maxInputTokens: 1_200_000,
  maxOutputTokens: 150_000,
  maxCostUsd: null,
  maxReplans: 3,
  maxPlanVersions: 10,
  maxPlanItems: 30,
  maxPlanDepth: 2,
  maxPlanItemTitleChars: 200,
  maxPlanItemDescriptionChars: 2_000,
  maxConstraints: 20,
  maxAcceptancePerItem: 10,
  maxEvidencePerItem: 10,
  maxNoProgressSteps: 8,
  maxIdenticalActions: 3,
  maxIdenticalDiffs: 2,
  maxSameError: 3,
  maxOscillations: 2,
  maxInvalidPlanAttempts: 3,
  maxResumeAttempts: 2,
  checkpointEverySteps: 1,
  cancelGraceMs: 5_000,
  maxObservationBytes: 65_536,
  maxFinalReportBytes: 32_768,
});

/**
 * Normaliza límites parciales:
 * - merge con defaults,
 * - descarta/recorta valores no finitos o fuera de rango,
 * - redondea los límites enteros,
 * - mantiene coherencia entre límites relacionados,
 * - devuelve un objeto congelado.
 *
 * No lanza: la configuración de producción no debe romper el arranque por
 * una variable de entorno mal escrita.
 */
export function normalizeAutonomyLimits(partial: Partial<AutonomyLimits> = {}): AutonomyLimits {
  const merged = { ...DEFAULT_AUTONOMY_LIMITS, ...partial };
  const normalized = {} as AutonomyLimits;

  for (const key of Object.keys(DEFAULT_AUTONOMY_LIMITS) as Array<keyof AutonomyLimits>) {
    if (key === "maxCostUsd") {
      const value = merged.maxCostUsd;
      normalized.maxCostUsd =
        typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(value, AUTONOMY_MAX_COST_USD) : null;
      continue;
    }

    const limitBounds = AUTONOMY_LIMIT_BOUNDS[key];
    const raw = merged[key];
    const candidate = typeof raw === "number" && Number.isFinite(raw) ? raw : DEFAULT_AUTONOMY_LIMITS[key];
    const value = limitBounds.integer ? Math.round(candidate) : candidate;
    normalized[key] = Math.min(limitBounds.max, Math.max(limitBounds.min, value));
  }

  // Coherencia: una fase nunca puede tener más pasos que la corrida
  // entera; los límites separados de tokens nunca superan el total.
  normalized.maxStepsPerPhase = Math.min(normalized.maxStepsPerPhase, normalized.maxSteps);
  normalized.maxInputTokens = Math.min(normalized.maxInputTokens, normalized.maxTokens);
  normalized.maxOutputTokens = Math.min(normalized.maxOutputTokens, normalized.maxTokens);

  return Object.freeze(normalized);
}

export type AutonomyTaskOutcome = {
  status: Extract<TaskStatus, "READY_FOR_REVIEW" | "NO_CHANGES" | "FAILED" | "CANCELLED">;
  stopReason: AutonomyStopReason;
};

export class InvalidAutonomyOutcomeError extends Error {
  constructor(public readonly state: AutonomyState) {
    super(`No se puede resolver el resultado de una task desde el estado no terminal ${state}.`);
    this.name = "InvalidAutonomyOutcomeError";
  }
}

/**
 * Mapea el estado terminal de la corrida autónoma al estado REAL de la
 * task, sin agregar estados nuevos.
 *
 * Regla de preservación de trabajo parcial (aprobada): si el loop se
 * estanca, bloquea o agota presupuesto pero hay propuestas reales, la
 * task va a READY_FOR_REVIEW para que el usuario revise; si no hay
 * propuestas, va a FAILED. Un timeout/error de proveedor no se disfraza
 * de NO_CHANGES.
 */
export function resolveTaskOutcome(
  state: AutonomyTerminalState,
  hasProposals: boolean,
  failedStopReason?: AutonomyStopReason,
): AutonomyTaskOutcome {
  switch (state) {
    case "DONE":
      return hasProposals
        ? { status: "READY_FOR_REVIEW", stopReason: "completed" }
        : { status: "NO_CHANGES", stopReason: "completed" };
    case "BLOCKED":
      return hasProposals
        ? { status: "READY_FOR_REVIEW", stopReason: "blocked" }
        : { status: "FAILED", stopReason: "blocked" };
    case "STALLED":
      return hasProposals
        ? { status: "READY_FOR_REVIEW", stopReason: "stalled" }
        : { status: "FAILED", stopReason: "stalled" };
    case "BUDGET_EXHAUSTED":
      return hasProposals
        ? { status: "READY_FOR_REVIEW", stopReason: "budget_exhausted" }
        : { status: "FAILED", stopReason: "budget_exhausted" };
    case "FAILED":
      return { status: "FAILED", stopReason: failedStopReason ?? "error" };
    case "CANCELLED":
      return { status: "CANCELLED", stopReason: "cancelled" };
    default:
      throw new InvalidAutonomyOutcomeError(state);
  }
}
