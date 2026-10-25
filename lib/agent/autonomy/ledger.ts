/**
 * Fase 9B — task ledger persistente del Autonomous Loop.
 *
 * Es la única capa que escribe `agent_runs`, `agent_plans`,
 * `agent_plan_items`, `agent_steps`, `agent_file_checkpoints` y
 * `agent_verifications`. No orquesta el loop (eso es 9C): solo ofrece
 * operaciones atómicas y valida los hechos que el controlador/modelo
 * declaran.
 *
 * Reglas de seguridad:
 * - Los payloads persistidos son metadatos: hashes, ids, estados, códigos,
 *   conteos y rutas no sensibles. Nunca prompts, código, contenido de
 *   archivos ni stdout/stderr.
 * - Las rutas pasan por `sensitive-paths.ts` y, para archivos reales, por
 *   `resolveSafePath` (la única puerta contra symlinks/`..`).
 * - Un item no pasa a `DONE` sin evidencia válida y sin que las
 *   acceptance machine-checkable hayan sido verificadas por el verificador
 *   inyectado. Sin verificador, el resultado es `verification_unavailable`
 *   (nunca se asume éxito).
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import { getDb } from "../../db";
import { redactSecrets } from "../../provider-resilience/redact";
import { resolveSafePath, UnsafePathError } from "../safe-path";
import { normalizePathForRules, sensitiveRuleOf } from "../context/sensitive-paths";
import {
  DEFAULT_AUTONOMY_LIMITS,
  assertAutonomyTransition,
  isTerminalAutonomyState,
  normalizeAutonomyLimits,
  type AutonomyBudget,
  type AutonomyErrorCode,
  type AutonomyLimits,
  type AutonomyRun,
  type AutonomyState,
  type AutonomyStopReason,
} from "./contract";
import {
  assertPlanItemTransition,
  canTransitionPlanItem,
  computePlanHash,
  describeCriterion,
  isMachineCheckable,
  isPlanItemStatus,
  isPlanSource,
  isPlanStatus,
  normalizePlanEvidence,
  normalizePlanReason,
  type AcceptanceCriterion,
  type NormalizedPlan,
  type NormalizedPlanItem,
  type PlanEvidence,
  type PlanItemStatus,
  type PlanSource,
  type PlanStatus,
} from "./plan";

const MAX_STEP_JSON_CHARS = 65_536;
const MAX_EVIDENCE_FILE_BYTES = 2_000_000;
const MAX_STEP_ACTIONS = 100;
const MAX_STEP_RESULTS = 100;

export const ZERO_AUTONOMY_BUDGET: AutonomyBudget = {
  steps: 0,
  wallTimeMs: 0,
  inputTokens: 0,
  outputTokens: 0,
  estimatedCostUsd: null,
};

export type AgentStepAction = {
  toolCallId: string;
  toolName: string;
  /** Hash del input; nunca el input completo. */
  inputHash: string;
  ok: boolean;
  errorCode?: string;
  /** Rutas no sensibles tocadas por la acción. */
  files?: string[];
};

export type AgentStep = {
  id: string;
  runId: string;
  stepIndex: number;
  phase: string;
  ts: number;
  actions: AgentStepAction[];
  results: unknown[];
  progress: Record<string, unknown>;
  inputTokens: number | null;
  outputTokens: number | null;
};

export type VerificationStatus = "passed" | "failed" | "skipped" | "unverified";

export type AcceptanceVerificationResult = {
  status: "passed" | "failed" | "unavailable";
  /** Metadatos: exitCode, durationMs, outputSha256, etc. Nunca output. */
  evidence?: Record<string, unknown>;
  /** Texto corto y redactado para diagnóstico; no se persiste como output. */
  detail?: string;
};

export type AcceptanceVerifier = (input: {
  criterion: AcceptanceCriterion;
  workspaceRoot: string;
  allowedScripts: string[];
  signal?: AbortSignal;
}) => Promise<AcceptanceVerificationResult>;

export type PersistedPlanItem = {
  /** Id físico en `agent_plan_items` (namespaced por versión del plan). */
  id: string;
  /** Id lógico estable que usa el modelo (`t1`, `t2`, ...). */
  logicalId: string;
  planId: string;
  seq: number;
  parentId: string | null;
  title: string;
  description: string;
  status: PlanItemStatus;
  dependsOn: string[];
  acceptance: AcceptanceCriterion[];
  paths: string[];
  evidence: PlanEvidence[];
  attempts: number;
  lastError: string | null;
  startedAt: number | null;
  finishedAt: number | null;
};

export type PersistedPlan = {
  id: string;
  taskId: string;
  version: number;
  objective: string;
  constraints: string[];
  acceptance: AcceptanceCriterion[];
  status: PlanStatus;
  source: PlanSource;
  createdAt: number;
  hash: string;
  items: PersistedPlanItem[];
};

export type VerificationRecord = {
  id: string;
  runId: string;
  itemId: string | null;
  criterion: AcceptanceCriterion;
  status: VerificationStatus;
  evidence: Record<string, unknown>;
  ts: number;
};

type RunRow = {
  id: string;
  task_id: string;
  attempt: number;
  state: string;
  stop_reason: string | null;
  resume_of_run_id: string | null;
  workspace_id: string | null;
  base_commit: string | null;
  head_commit: string | null;
  plan_version: number;
  budget_json: string;
  last_event_seq: number | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  finished_at: number | null;
};

type PlanRow = {
  id: string;
  task_id: string;
  version: number;
  objective: string;
  constraints_json: string;
  acceptance_json: string;
  status: string;
  source: string;
  created_at: number;
};

type PlanItemRow = {
  id: string;
  plan_id: string;
  seq: number;
  parent_id: string | null;
  title: string;
  description: string;
  status: string;
  depends_on_json: string;
  acceptance_json: string;
  paths_json: string;
  evidence_json: string;
  attempts: number;
  last_error: string | null;
  started_at: number | null;
  finished_at: number | null;
};

type StepRow = {
  id: string;
  run_id: string;
  step_index: number;
  phase: string;
  ts: number;
  actions_json: string;
  results_json: string;
  progress_json: string;
  input_tokens: number | null;
  output_tokens: number | null;
};

type VerificationRow = {
  id: string;
  run_id: string;
  item_id: string | null;
  criterion_json: string;
  status: string;
  evidence_json: string;
  ts: number;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function parseStringArray(raw: string): string[] {
  const value = safeJsonParse<unknown>(raw, []);
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function parseCriteria(raw: string): AcceptanceCriterion[] {
  const value = safeJsonParse<unknown>(raw, []);
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is AcceptanceCriterion => {
    if (!isPlainObject(entry)) return false;
    if (entry.kind === "typecheck") return true;
    if (entry.kind === "script") return entry.name === "build" || entry.name === "test" || entry.name === "lint";
    if (entry.kind === "file_exists") return typeof entry.path === "string";
    if (entry.kind === "file_hash") return typeof entry.path === "string" && typeof entry.sha256 === "string";
    if (entry.kind === "manual") return typeof entry.description === "string";
    return false;
  });
}

function parseEvidence(raw: string): PlanEvidence[] {
  const value = safeJsonParse<unknown>(raw, []);
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is PlanEvidence => {
    if (!isPlainObject(entry)) return false;
    if (entry.kind === "tool_result") return typeof entry.toolCallId === "string";
    if (entry.kind === "file") return typeof entry.path === "string" && typeof entry.sha256 === "string";
    if (entry.kind === "command") return typeof entry.name === "string" && typeof entry.exitCode === "number";
    if (entry.kind === "manual") return typeof entry.description === "string";
    return false;
  });
}

function parseBudget(raw: string): AutonomyBudget {
  const value = safeJsonParse<Partial<AutonomyBudget>>(raw, {});
  return {
    steps: numberOrZero(value.steps),
    wallTimeMs: numberOrZero(value.wallTimeMs),
    inputTokens: numberOrZero(value.inputTokens),
    outputTokens: numberOrZero(value.outputTokens),
    estimatedCostUsd:
      typeof value.estimatedCostUsd === "number" && Number.isFinite(value.estimatedCostUsd)
        ? value.estimatedCostUsd
        : null,
  };
}

function normalizeBudget(partial?: Partial<AutonomyBudget>): AutonomyBudget {
  const merged = { ...ZERO_AUTONOMY_BUDGET, ...partial };
  return {
    steps: Math.max(0, Math.round(numberOrZero(merged.steps))),
    wallTimeMs: Math.max(0, Math.round(numberOrZero(merged.wallTimeMs))),
    inputTokens: Math.max(0, Math.round(numberOrZero(merged.inputTokens))),
    outputTokens: Math.max(0, Math.round(numberOrZero(merged.outputTokens))),
    estimatedCostUsd:
      typeof merged.estimatedCostUsd === "number" && Number.isFinite(merged.estimatedCostUsd) && merged.estimatedCostUsd >= 0
        ? merged.estimatedCostUsd
        : null,
  };
}

function rowToRun(row: RunRow): AutonomyRun {
  return {
    id: row.id,
    taskId: row.task_id,
    attempt: row.attempt,
    state: row.state as AutonomyState,
    stopReason: row.stop_reason as AutonomyStopReason | null,
    resumeOfRunId: row.resume_of_run_id,
    workspaceId: row.workspace_id,
    baseCommit: row.base_commit,
    headCommit: row.head_commit,
    planVersion: row.plan_version,
    budget: parseBudget(row.budget_json),
    lastEventSeq: row.last_event_seq,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

function logicalIdOf(planId: string, physicalId: string): string {
  const prefix = `${planId}:`;
  return physicalId.startsWith(prefix) ? physicalId.slice(prefix.length) : physicalId;
}

function rowToPlanItem(row: PlanItemRow): PersistedPlanItem {
  return {
    id: row.id,
    logicalId: logicalIdOf(row.plan_id, row.id),
    planId: row.plan_id,
    seq: row.seq,
    parentId: row.parent_id ? logicalIdOf(row.plan_id, row.parent_id) : null,
    title: row.title,
    description: row.description,
    status: (isPlanItemStatus(row.status) ? row.status : "PENDING") as PlanItemStatus,
    dependsOn: parseStringArray(row.depends_on_json),
    acceptance: parseCriteria(row.acceptance_json),
    paths: parseStringArray(row.paths_json),
    evidence: parseEvidence(row.evidence_json),
    attempts: row.attempts,
    lastError: row.last_error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function rowToPlan(row: PlanRow, itemRows: PlanItemRow[]): PersistedPlan {
  const items = itemRows.map(rowToPlanItem);
  const constraints = parseStringArray(row.constraints_json);
  const acceptance = parseCriteria(row.acceptance_json);
  const normalizedItems: NormalizedPlanItem[] = items.map((item) => ({
    logicalId: item.logicalId,
    seq: item.seq,
    parentId: item.parentId,
    title: item.title,
    description: item.description,
    dependsOn: item.dependsOn,
    acceptance: item.acceptance,
    paths: item.paths,
  }));
  return {
    id: row.id,
    taskId: row.task_id,
    version: row.version,
    objective: row.objective,
    constraints,
    acceptance,
    status: (isPlanStatus(row.status) ? row.status : "ABANDONED") as PlanStatus,
    source: (isPlanSource(row.source) ? row.source : "model") as PlanSource,
    createdAt: row.created_at,
    hash: computePlanHash({ objective: row.objective, constraints, acceptance, items: normalizedItems }),
    items,
  };
}

function rowToStep(row: StepRow): AgentStep {
  const actions = safeJsonParse<unknown>(row.actions_json, []);
  const results = safeJsonParse<unknown>(row.results_json, []);
  const progress = safeJsonParse<unknown>(row.progress_json, {});
  return {
    id: row.id,
    runId: row.run_id,
    stepIndex: row.step_index,
    phase: row.phase,
    ts: row.ts,
    actions: Array.isArray(actions) ? (actions.filter(isPlainObject) as unknown as AgentStepAction[]) : [],
    results: Array.isArray(results) ? results : [],
    progress: isPlainObject(progress) ? progress : {},
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
  };
}

function rowToVerification(row: VerificationRow): VerificationRecord {
  const criterion = parseCriteria(`[${row.criterion_json}]`)[0];
  return {
    id: row.id,
    runId: row.run_id,
    itemId: row.item_id,
    criterion: criterion ?? { kind: "manual", description: "criterio desconocido" },
    status: (row.status === "passed" || row.status === "failed" || row.status === "skipped" || row.status === "unverified"
      ? row.status
      : "unverified") as VerificationStatus,
    evidence: safeJsonParse<Record<string, unknown>>(row.evidence_json, {}),
    ts: row.ts,
  };
}

function defaultStopReasonForState(state: AutonomyState): AutonomyStopReason {
  switch (state) {
    case "DONE":
      return "completed";
    case "BLOCKED":
      return "blocked";
    case "STALLED":
      return "stalled";
    case "BUDGET_EXHAUSTED":
      return "budget_exhausted";
    case "CANCELLED":
      return "cancelled";
    default:
      return "error";
  }
}

function clampInt(value: number, min: number, max: number): number {
  const rounded = Number.isFinite(value) ? Math.round(value) : min;
  return Math.min(max, Math.max(min, rounded));
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export type CreateRunInput = {
  taskId: string;
  attempt?: number;
  state?: AutonomyState;
  workspaceId?: string | null;
  baseCommit?: string | null;
  budget?: Partial<AutonomyBudget>;
  resumeOfRunId?: string | null;
};

export function createRun(input: CreateRunInput): AutonomyRun {
  const db = getDb();
  const now = Date.now();
  const attemptRow = db.prepare("SELECT COUNT(*) AS c FROM agent_runs WHERE task_id = ?").get(input.taskId) as { c: number };
  const attempt = input.attempt ?? attemptRow.c + 1;
  const state = input.state ?? "PLANNING";
  const budget = normalizeBudget(input.budget);
  const run: AutonomyRun = {
    id: crypto.randomUUID(),
    taskId: input.taskId,
    attempt,
    state,
    stopReason: null,
    resumeOfRunId: input.resumeOfRunId ?? null,
    workspaceId: input.workspaceId ?? null,
    baseCommit: input.baseCommit ?? null,
    headCommit: null,
    planVersion: 0,
    budget,
    lastEventSeq: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    finishedAt: isTerminalAutonomyState(state) ? now : null,
  };

  try {
    db.prepare(
      `INSERT INTO agent_runs
       (id, task_id, attempt, state, stop_reason, resume_of_run_id, workspace_id, base_commit, head_commit,
        plan_version, budget_json, last_event_seq, error, created_at, updated_at, finished_at)
       VALUES (@id, @taskId, @attempt, @state, @stopReason, @resumeOfRunId, @workspaceId, @baseCommit, @headCommit,
               @planVersion, @budgetJson, @lastEventSeq, @error, @createdAt, @updatedAt, @finishedAt)`,
    ).run({
      id: run.id,
      taskId: run.taskId,
      attempt: run.attempt,
      state: run.state,
      stopReason: run.stopReason,
      resumeOfRunId: run.resumeOfRunId,
      workspaceId: run.workspaceId,
      baseCommit: run.baseCommit,
      headCommit: run.headCommit,
      planVersion: run.planVersion,
      budgetJson: JSON.stringify(run.budget),
      lastEventSeq: run.lastEventSeq,
      error: run.error,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      finishedAt: run.finishedAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("UNIQUE constraint failed")) {
      throw new Error(`Ya existe una corrida activa para la task ${input.taskId}.`);
    }
    throw error;
  }

  return run;
}

export function getRun(id: string): AutonomyRun | null {
  const row = getDb().prepare("SELECT * FROM agent_runs WHERE id = ?").get(id) as RunRow | undefined;
  return row ? rowToRun(row) : null;
}

export function getActiveRunForTask(taskId: string): AutonomyRun | null {
  const row = getDb()
    .prepare("SELECT * FROM agent_runs WHERE task_id = ? AND finished_at IS NULL ORDER BY created_at DESC LIMIT 1")
    .get(taskId) as RunRow | undefined;
  return row ? rowToRun(row) : null;
}

export function listRunsForTask(taskId: string): AutonomyRun[] {
  const rows = getDb()
    .prepare("SELECT * FROM agent_runs WHERE task_id = ? ORDER BY created_at ASC")
    .all(taskId) as RunRow[];
  return rows.map(rowToRun);
}

export type RunPatch = {
  stopReason?: AutonomyStopReason | null;
  workspaceId?: string | null;
  baseCommit?: string | null;
  headCommit?: string | null;
  planVersion?: number;
  budget?: Partial<AutonomyBudget>;
  lastEventSeq?: number | null;
  error?: string | null;
};

/** Transición atómica de estado de la corrida. Un estado terminal no tiene
 * salida (lo garantiza el contrato). Si dos llamadas compiten, la segunda
 * falla en vez de pisar el estado de la primera. */
export function transitionRun(id: string, to: AutonomyState, patch: RunPatch = {}): AutonomyRun {
  const run = getRun(id);
  if (!run) throw new Error(`No existe la corrida ${id}.`);
  assertAutonomyTransition(run.state, to);

  const now = Date.now();
  const terminal = isTerminalAutonomyState(to);
  const nextBudget = patch.budget ? normalizeBudget({ ...run.budget, ...patch.budget }) : run.budget;
  const next: AutonomyRun = {
    ...run,
    state: to,
    stopReason: patch.stopReason !== undefined ? patch.stopReason : terminal ? defaultStopReasonForState(to) : null,
    workspaceId: patch.workspaceId !== undefined ? patch.workspaceId : run.workspaceId,
    baseCommit: patch.baseCommit !== undefined ? patch.baseCommit : run.baseCommit,
    headCommit: patch.headCommit !== undefined ? patch.headCommit : run.headCommit,
    planVersion: patch.planVersion !== undefined ? patch.planVersion : run.planVersion,
    budget: nextBudget,
    lastEventSeq: patch.lastEventSeq !== undefined ? patch.lastEventSeq : run.lastEventSeq,
    error: patch.error !== undefined ? patch.error : run.error,
    updatedAt: now,
    finishedAt: terminal ? now : null,
  };

  const result = getDb()
    .prepare(
      `UPDATE agent_runs
       SET state = @state, stop_reason = @stopReason, workspace_id = @workspaceId, base_commit = @baseCommit,
           head_commit = @headCommit, plan_version = @planVersion, budget_json = @budgetJson,
           last_event_seq = @lastEventSeq, error = @error, updated_at = @updatedAt, finished_at = @finishedAt
       WHERE id = @id AND state = @fromState AND finished_at IS NULL`,
    )
    .run({
      id: next.id,
      state: next.state,
      stopReason: next.stopReason,
      workspaceId: next.workspaceId,
      baseCommit: next.baseCommit,
      headCommit: next.headCommit,
      planVersion: next.planVersion,
      budgetJson: JSON.stringify(next.budget),
      lastEventSeq: next.lastEventSeq,
      error: next.error,
      updatedAt: next.updatedAt,
      finishedAt: next.finishedAt,
      fromState: run.state,
    });

  if (result.changes === 0) {
    throw new Error(`La corrida ${id} cambió de estado concurrentemente; no se aplicó ${run.state} → ${to}.`);
  }
  return next;
}

/** Actualiza metadatos SIN cambiar el estado. No se permite sobre una
 * corrida terminada. */
export function updateRunProgress(id: string, patch: RunPatch): AutonomyRun {
  const run = getRun(id);
  if (!run) throw new Error(`No existe la corrida ${id}.`);
  if (isTerminalAutonomyState(run.state)) {
    throw new Error(`No se puede actualizar una corrida terminal (${run.state}).`);
  }

  const now = Date.now();
  const nextBudget = patch.budget ? normalizeBudget({ ...run.budget, ...patch.budget }) : run.budget;
  const next: AutonomyRun = {
    ...run,
    stopReason: patch.stopReason !== undefined ? patch.stopReason : run.stopReason,
    workspaceId: patch.workspaceId !== undefined ? patch.workspaceId : run.workspaceId,
    baseCommit: patch.baseCommit !== undefined ? patch.baseCommit : run.baseCommit,
    headCommit: patch.headCommit !== undefined ? patch.headCommit : run.headCommit,
    planVersion: patch.planVersion !== undefined ? patch.planVersion : run.planVersion,
    budget: nextBudget,
    lastEventSeq: patch.lastEventSeq !== undefined ? patch.lastEventSeq : run.lastEventSeq,
    error: patch.error !== undefined ? patch.error : run.error,
    updatedAt: now,
  };

  const result = getDb()
    .prepare(
      `UPDATE agent_runs
       SET stop_reason = @stopReason, workspace_id = @workspaceId, base_commit = @baseCommit,
           head_commit = @headCommit, plan_version = @planVersion, budget_json = @budgetJson,
           last_event_seq = @lastEventSeq, error = @error, updated_at = @updatedAt
       WHERE id = @id AND finished_at IS NULL`,
    )
    .run({
      id: next.id,
      stopReason: next.stopReason,
      workspaceId: next.workspaceId,
      baseCommit: next.baseCommit,
      headCommit: next.headCommit,
      planVersion: next.planVersion,
      budgetJson: JSON.stringify(next.budget),
      lastEventSeq: next.lastEventSeq,
      error: next.error,
      updatedAt: next.updatedAt,
    });

  if (result.changes === 0) {
    throw new Error(`La corrida ${id} terminó concurrentemente; no se actualizó.`);
  }
  return next;
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

export type SavePlanVersionInput = {
  taskId: string;
  runId?: string;
  plan: NormalizedPlan;
  source: PlanSource;
  maxVersions?: number;
};

function getPlanItemRows(planId: string): PlanItemRow[] {
  return getDb()
    .prepare("SELECT * FROM agent_plan_items WHERE plan_id = ? ORDER BY seq ASC")
    .all(planId) as PlanItemRow[];
}

export function getPlanById(planId: string): PersistedPlan | null {
  const row = getDb().prepare("SELECT * FROM agent_plans WHERE id = ?").get(planId) as PlanRow | undefined;
  return row ? rowToPlan(row, getPlanItemRows(planId)) : null;
}

export function getPlanVersion(taskId: string, version: number): PersistedPlan | null {
  const row = getDb()
    .prepare("SELECT * FROM agent_plans WHERE task_id = ? AND version = ?")
    .get(taskId, version) as PlanRow | undefined;
  return row ? rowToPlan(row, getPlanItemRows(row.id)) : null;
}

export function getActivePlan(taskId: string): PersistedPlan | null {
  const row = getDb()
    .prepare("SELECT * FROM agent_plans WHERE task_id = ? AND status = 'ACTIVE' ORDER BY version DESC LIMIT 1")
    .get(taskId) as PlanRow | undefined;
  return row ? rowToPlan(row, getPlanItemRows(row.id)) : null;
}

export function getPlanForRun(runId: string): PersistedPlan | null {
  const run = getRun(runId);
  if (!run) return null;
  if (run.planVersion > 0) {
    // Sin fallback al plan activo: si esta versión se podó, el plan de esta
    // corrida ya no existe y devolver otro sería engañoso.
    return getPlanVersion(run.taskId, run.planVersion);
  }
  return getActivePlan(run.taskId);
}

export function listPlanVersions(taskId: string): Array<Pick<PersistedPlan, "id" | "taskId" | "version" | "status" | "source" | "createdAt">> {
  const rows = getDb()
    .prepare("SELECT * FROM agent_plans WHERE task_id = ? ORDER BY version DESC")
    .all(taskId) as PlanRow[];
  return rows.map((row) => ({
    id: row.id,
    taskId: row.task_id,
    version: row.version,
    status: (isPlanStatus(row.status) ? row.status : "ABANDONED") as PlanStatus,
    source: (isPlanSource(row.source) ? row.source : "model") as PlanSource,
    createdAt: row.created_at,
  }));
}

export function prunePlanVersions(taskId: string, keep: number): number {
  const keepCount = clampInt(keep, 1, 100);
  const db = getDb();
  const stale = db
    .prepare("SELECT id FROM agent_plans WHERE task_id = ? ORDER BY version DESC LIMIT -1 OFFSET ?")
    .all(taskId, keepCount) as Array<{ id: string }>;
  if (stale.length === 0) return 0;

  const placeholders = stale.map(() => "?").join(",");
  const ids = stale.map((row) => row.id);
  const remove = db.transaction(() => {
    db.prepare(`DELETE FROM agent_plan_items WHERE plan_id IN (${placeholders})`).run(...ids);
    db.prepare(`DELETE FROM agent_plans WHERE id IN (${placeholders})`).run(...ids);
  });
  remove();
  return stale.length;
}

/**
 * Persiste una versión nueva del plan. La versión anterior ACTIVE pasa a
 * ABANDONED; se podan las versiones viejas conservando las últimas
 * `maxVersions`. Todo ocurre en una transacción.
 */
export function savePlanVersion(input: SavePlanVersionInput): PersistedPlan {
  if (!isPlanSource(input.source)) throw new Error(`Fuente de plan inválida: ${String(input.source)}.`);
  if (input.runId) {
    const run = getRun(input.runId);
    if (!run) throw new Error(`No existe la corrida ${input.runId}.`);
    if (run.taskId !== input.taskId) throw new Error("La corrida no pertenece a la task del plan.");
    if (isTerminalAutonomyState(run.state)) throw new Error(`La corrida ya terminó (${run.state}).`);
  }
  const db = getDb();
  const now = Date.now();
  const planId = crypto.randomUUID();
  const maxVersions = clampInt(input.maxVersions ?? DEFAULT_AUTONOMY_LIMITS.maxPlanVersions, 1, 100);

  const tx = db.transaction(() => {
    const versionRow = db
      .prepare("SELECT COALESCE(MAX(version), 0) AS v FROM agent_plans WHERE task_id = ?")
      .get(input.taskId) as { v: number };
    const version = versionRow.v + 1;

    db.prepare("UPDATE agent_plans SET status = 'ABANDONED' WHERE task_id = ? AND status = 'ACTIVE'").run(input.taskId);

    db.prepare(
      `INSERT INTO agent_plans
       (id, task_id, version, objective, constraints_json, acceptance_json, status, source, created_at)
       VALUES (@id, @taskId, @version, @objective, @constraintsJson, @acceptanceJson, 'ACTIVE', @source, @createdAt)`,
    ).run({
      id: planId,
      taskId: input.taskId,
      version,
      objective: input.plan.objective,
      constraintsJson: JSON.stringify(input.plan.constraints),
      acceptanceJson: JSON.stringify(input.plan.acceptance),
      source: input.source,
      createdAt: now,
    });

    const insertItem = db.prepare(
      `INSERT INTO agent_plan_items
       (id, plan_id, seq, parent_id, title, description, status, depends_on_json, acceptance_json,
        paths_json, evidence_json, attempts, last_error, started_at, finished_at)
       VALUES (@id, @planId, @seq, @parentId, @title, @description, 'PENDING', @dependsOnJson, @acceptanceJson,
               @pathsJson, '[]', 0, NULL, NULL, NULL)`,
    );
    for (const item of input.plan.items) {
      insertItem.run({
        id: `${planId}:${item.logicalId}`,
        planId,
        seq: item.seq,
        parentId: item.parentId ? `${planId}:${item.parentId}` : null,
        title: item.title,
        description: item.description,
        dependsOnJson: JSON.stringify(item.dependsOn),
        acceptanceJson: JSON.stringify(item.acceptance),
        pathsJson: JSON.stringify(item.paths),
      });
    }

    if (input.runId) {
      db.prepare("UPDATE agent_runs SET plan_version = ?, updated_at = ? WHERE id = ? AND finished_at IS NULL").run(
        version,
        now,
        input.runId,
      );
    }

    const stale = db
      .prepare("SELECT id FROM agent_plans WHERE task_id = ? ORDER BY version DESC LIMIT -1 OFFSET ?")
      .all(input.taskId, maxVersions) as Array<{ id: string }>;
    if (stale.length > 0) {
      const placeholders = stale.map(() => "?").join(",");
      const staleIds = stale.map((row) => row.id);
      db.prepare(`DELETE FROM agent_plan_items WHERE plan_id IN (${placeholders})`).run(...staleIds);
      db.prepare(`DELETE FROM agent_plans WHERE id IN (${placeholders})`).run(...staleIds);
    }
  });

  tx();
  const persisted = getPlanById(planId);
  if (!persisted) throw new Error("El plan se insertó pero no se pudo releer.");
  // El hash se recalcula al leer desde las filas persistidas; la fila es la
  // fuente de verdad, no el objeto que pasó el caller.
  return persisted;
}

export function markPlanStatus(planId: string, status: PlanStatus): PersistedPlan | null {
  if (!isPlanStatus(status)) throw new Error(`Estado de plan inválido: ${String(status)}.`);
  getDb().prepare("UPDATE agent_plans SET status = ? WHERE id = ?").run(status, planId);
  return getPlanById(planId);
}

// ---------------------------------------------------------------------------
// Plan items
// ---------------------------------------------------------------------------

export function getPlanItemById(itemId: string): PersistedPlanItem | null {
  const row = getDb().prepare("SELECT * FROM agent_plan_items WHERE id = ?").get(itemId) as PlanItemRow | undefined;
  return row ? rowToPlanItem(row) : null;
}

/** Invalida un item para una replanificación: vuelve a PENDING, borra la
 * evidencia y deja el motivo en `last_error`. Solo lo usa el controlador
 * (9C), no el modelo. */
export function resetPlanItemToPending(itemId: string, reason?: string): PersistedPlanItem {
  const item = getPlanItemById(itemId);
  if (!item) throw new Error(`No existe el item ${itemId}.`);
  assertPlanItemTransition(item.status, "PENDING");
  getDb()
    .prepare(
      "UPDATE agent_plan_items SET status = 'PENDING', evidence_json = '[]', last_error = ?, started_at = NULL, finished_at = NULL WHERE id = ?",
    )
    .run(reason ?? null, itemId);
  const updated = getPlanItemById(itemId);
  if (!updated) throw new Error("El item se actualizó pero no se pudo releer.");
  return updated;
}

export type UpdatePlanItemInput = {
  runId: string;
  itemId: string;
  status: PlanItemStatus;
  reason?: string;
  evidence?: unknown;
  limits?: AutonomyLimits;
  workspaceRoot?: string;
  allowedScripts?: string[];
  verifier?: AcceptanceVerifier;
  signal?: AbortSignal;
};

export type UpdatePlanItemResult =
  | { ok: true; item: PersistedPlanItem; warnings: string[] }
  | { ok: false; code: AutonomyErrorCode; error: string; item?: PersistedPlanItem };

type EvidenceReferenceContext = {
  runId: string;
  itemStatus: Exclude<PlanItemStatus, "PENDING">;
  workspaceRoot?: string;
  allowedScripts: string[];
};

async function validateEvidenceReferences(
  evidence: PlanEvidence[],
  context: EvidenceReferenceContext,
): Promise<{ ok: true; warnings: string[] } | { ok: false; code: AutonomyErrorCode; error: string }> {
  const warnings: string[] = [];

  for (const entry of evidence) {
    if (entry.kind === "tool_result") {
      if (!toolCallIdExists(context.runId, entry.toolCallId)) {
        return {
          ok: false,
          code: "evidence_invalid",
          error: "La evidencia tool_result referencia un toolCallId que no pertenece a esta corrida.",
        };
      }
    } else if (entry.kind === "file") {
      if (!context.workspaceRoot) {
        return { ok: false, code: "evidence_invalid", error: "No hay workspace para validar la evidencia de archivo." };
      }
      const sensitive = sensitiveRuleOf(entry.path);
      if (sensitive) {
        return { ok: false, code: "evidence_invalid", error: `Ruta sensible no permitida (${sensitive}).` };
      }
      try {
        const absPath = await resolveSafePath(context.workspaceRoot, entry.path);
        const stat = await fs.stat(absPath);
        if (!stat.isFile()) {
          return { ok: false, code: "evidence_invalid", error: "La evidencia de archivo apunta a algo que no es un archivo." };
        }
        if (stat.size > MAX_EVIDENCE_FILE_BYTES) {
          return {
            ok: false,
            code: "evidence_invalid",
            error: `El archivo de evidencia supera el máximo de ${MAX_EVIDENCE_FILE_BYTES} bytes.`,
          };
        }
        const buffer = await fs.readFile(absPath);
        const actual = crypto.createHash("sha256").update(buffer).digest("hex");
        if (actual !== entry.sha256) {
          return { ok: false, code: "evidence_invalid", error: "El hash actual del archivo no coincide con la evidencia." };
        }
      } catch (error) {
        return {
          ok: false,
          code: "evidence_invalid",
          // Solo los errores de ruta (que usan la ruta relativa) son seguros;
          // los de fs pueden incluir la ruta absoluta del workspace.
          error:
            error instanceof UnsafePathError
              ? error.message
              : "No se pudo validar la evidencia de archivo (¿existe y es legible?).",
        };
      }
    } else if (entry.kind === "command") {
      if (!(context.allowedScripts as readonly string[]).includes(entry.name) && entry.name !== "typecheck") {
        return {
          ok: false,
          code: "evidence_invalid",
          error: `El comando ${entry.name} no está allowlisted en este workspace.`,
        };
      }
      if (context.itemStatus === "DONE" && entry.exitCode !== 0) {
        return { ok: false, code: "evidence_invalid", error: "DONE no puede apoyarse en un comando con exitCode distinto de 0." };
      }
      if (!findCommandVerification(context.runId, entry.name, entry.exitCode)) {
        return {
          ok: false,
          code: "evidence_invalid",
          error: `No hay una verificación registrada de ${entry.name} con exitCode ${entry.exitCode}.`,
        };
      }
    } else if (entry.kind === "manual") {
      warnings.push("manual_evidence_unverified");
    }
  }

  return { ok: true, warnings: [...new Set(warnings)] };
}

/**
 * Actualiza un item del plan activo. Las reglas duras viven acá, no en la
 * tool: `DONE` exige dependencias resueltas, evidencia válida y
 * acceptance machine-checkable verificada. Un rechazo no muta el item.
 */
export async function updatePlanItem(input: UpdatePlanItemInput): Promise<UpdatePlanItemResult> {
  const limits = normalizeAutonomyLimits(input.limits);
  const run = getRun(input.runId);
  if (!run) return { ok: false, code: "internal_error", error: `No existe la corrida ${input.runId}.` };
  if (isTerminalAutonomyState(run.state)) {
    return { ok: false, code: "internal_error", error: `La corrida ${input.runId} ya está en ${run.state}.` };
  }

  const plan = getPlanForRun(run.id);
  if (!plan) return { ok: false, code: "plan_item_unknown", error: "No hay un plan activo para esta corrida." };

  const item = plan.items.find((candidate) => candidate.logicalId === input.itemId);
  if (!item) return { ok: false, code: "plan_item_unknown", error: `No existe el item ${input.itemId} en el plan activo.` };

  if (!isPlanItemStatus(input.status) || input.status === "PENDING") {
    return { ok: false, code: "plan_invalid", error: `Estado de item inválido: ${String(input.status)}.`, item };
  }
  if (!canTransitionPlanItem(item.status, input.status)) {
    return {
      ok: false,
      code: "plan_invalid",
      error: `Transición de item inválida: ${item.status} → ${input.status}.`,
      item,
    };
  }

  const requiresReason = input.status === "BLOCKED" || input.status === "FAILED" || input.status === "SKIPPED";
  const reasonResult = normalizePlanReason(input.reason, requiresReason);
  if (!reasonResult.ok) {
    return { ok: false, code: reasonResult.error.code, error: reasonResult.error.message, item };
  }

  const evidenceResult = normalizePlanEvidence(input.evidence, limits);
  if (!evidenceResult.ok) {
    return {
      ok: false,
      code: "evidence_invalid",
      error: evidenceResult.errors.map((error) => error.message).join(" "),
      item,
    };
  }
  const evidence = evidenceResult.evidence;
  const warnings = [...evidenceResult.warnings];

  if (input.status === "DONE") {
    if (evidence.length === 0) {
      return { ok: false, code: "evidence_invalid", error: "DONE requiere al menos una evidencia.", item };
    }

    for (const dependencyId of item.dependsOn) {
      const dependency = plan.items.find((candidate) => candidate.logicalId === dependencyId);
      if (!dependency || (dependency.status !== "DONE" && dependency.status !== "SKIPPED")) {
        return {
          ok: false,
          code: "plan_invalid",
          error: `La dependencia ${dependencyId} todavía no está DONE/SKIPPED.`,
          item,
        };
      }
    }

    const machineCriteria = item.acceptance.filter(isMachineCheckable);
    if (machineCriteria.length > 0) {
      if (!input.verifier) {
        return {
          ok: false,
          code: "verification_unavailable",
          error: "El item tiene acceptance verificable y no hay verificador disponible.",
          item,
        };
      }
      if (!input.workspaceRoot) {
        return {
          ok: false,
          code: "verification_unavailable",
          error: "El item tiene acceptance verificable y no hay workspace para verificarla.",
          item,
        };
      }
      for (const criterion of machineCriteria) {
        let result: AcceptanceVerificationResult;
        try {
          result = await input.verifier({
            criterion,
            workspaceRoot: input.workspaceRoot,
            allowedScripts: input.allowedScripts ?? [],
            signal: input.signal,
          });
        } catch (error) {
          result = {
            status: "unavailable",
            detail: error instanceof Error ? error.message : "verificador falló",
          };
        }
        recordVerification({
          runId: input.runId,
          itemId: item.id,
          criterion,
          status: result.status === "passed" ? "passed" : result.status === "failed" ? "failed" : "unverified",
          evidence: result.evidence ?? {},
        });
        if (result.status !== "passed") {
          return {
            ok: false,
            code: result.status === "failed" ? "verification_failed" : "verification_unavailable",
            error: `La verificación ${describeCriterion(criterion)} no pasó.`,
            item,
          };
        }
      }
    }
  }

  const referenceResult = await validateEvidenceReferences(evidence, {
    runId: input.runId,
    itemStatus: input.status,
    workspaceRoot: input.workspaceRoot,
    allowedScripts: input.allowedScripts ?? [],
  });
  if (!referenceResult.ok) {
    return { ok: false, code: referenceResult.code, error: referenceResult.error, item };
  }
  warnings.push(...referenceResult.warnings);

  const now = Date.now();
  const terminalItem = input.status === "DONE" || input.status === "FAILED" || input.status === "SKIPPED";
  const startedAt = item.startedAt ?? now;
  const finishedAt = terminalItem ? now : null;
  const lastError =
    input.status === "BLOCKED" || input.status === "FAILED" || input.status === "SKIPPED"
      ? reasonResult.reason
      : null;

  const result = getDb()
    .prepare(
      `UPDATE agent_plan_items
       SET status = @status, evidence_json = @evidenceJson, attempts = @attempts, last_error = @lastError,
           started_at = @startedAt, finished_at = @finishedAt
       WHERE id = @id AND plan_id = @planId`,
    )
    .run({
      status: input.status,
      evidenceJson: JSON.stringify(evidence),
      attempts: item.attempts + 1,
      lastError,
      startedAt,
      finishedAt,
      id: item.id,
      planId: item.planId,
    });

  if (result.changes === 0) {
    return { ok: false, code: "internal_error", error: "El item cambió concurrentemente; no se actualizó.", item };
  }

  const updated = getPlanItemById(item.id);
  if (!updated) return { ok: false, code: "internal_error", error: "El item se actualizó pero no se pudo releer." };
  return { ok: true, item: updated, warnings: [...new Set(warnings)] };
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

export type RecordStepInput = {
  runId: string;
  stepIndex: number;
  phase: string;
  actions: AgentStepAction[];
  /** Metadatos de resultados, no outputs. Solo se persisten las claves
   * allowlisted de `sanitizeResults` (ok, summary, exitCode, ...); el
   * contenido de archivos/stdout queda afuera por construcción. */
  results?: unknown[];
  progress?: Record<string, unknown>;
  inputTokens?: number | null;
  outputTokens?: number | null;
  ts?: number;
};

const MAX_RESULT_SUMMARY_CHARS = 500;
const RESULT_KEYS = new Set(["ok", "errorCode", "code", "summary", "exitCode", "durationMs", "toolCallId", "count", "files"]);

/** Convierte resultados arbitrarios en metadatos allowlisted. Cualquier
 * clave desconocida (típicamente `content`, `stdout`, `output`) se descarta
 * y se cuenta en `omitted`; los strings se redactan y recortan. */
function sanitizeResults(results: unknown[]): { results: Array<Record<string, unknown>>; omitted: number } {
  const out: Array<Record<string, unknown>> = [];
  let omitted = 0;
  for (const entry of results.slice(0, MAX_STEP_RESULTS)) {
    if (!isPlainObject(entry)) {
      omitted += 1;
      continue;
    }
    const clean: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(entry)) {
      if (!RESULT_KEYS.has(key)) {
        omitted += 1;
        continue;
      }
      if (key === "ok" && typeof value === "boolean") {
        clean.ok = value;
      } else if ((key === "errorCode" || key === "code" || key === "toolCallId") && typeof value === "string") {
        clean[key] = redactSecrets(value).slice(0, 200);
      } else if (key === "summary" && typeof value === "string") {
        clean.summary = redactSecrets(value).slice(0, MAX_RESULT_SUMMARY_CHARS);
      } else if (key === "exitCode" && typeof value === "number" && Number.isInteger(value)) {
        clean.exitCode = value;
      } else if ((key === "durationMs" || key === "count") && typeof value === "number" && Number.isFinite(value)) {
        clean[key] = value;
      } else if (key === "files") {
        const files = sanitizeFiles(value);
        clean.files = files.files;
        omitted += files.omitted;
      } else {
        omitted += 1;
      }
    }
    out.push(clean);
  }
  return { results: out, omitted };
}

function sanitizeFiles(files: unknown): { files: string[]; omitted: number } {
  if (!Array.isArray(files)) return { files: [], omitted: 0 };
  const allowed: string[] = [];
  let omitted = 0;
  for (const entry of files) {
    if (typeof entry !== "string") continue;
    const normalized = normalizePathForRules(entry);
    if (!normalized.ok || sensitiveRuleOf(normalized.segments.join("/"))) {
      omitted += 1;
      continue;
    }
    const rel = normalized.segments.join("/");
    if (!allowed.includes(rel)) allowed.push(rel);
  }
  return { files: allowed, omitted };
}

function sanitizeActions(actions: AgentStepAction[]): { actions: AgentStepAction[]; omittedFiles: number } {
  const result: AgentStepAction[] = [];
  let omittedFiles = 0;
  for (const action of actions.slice(0, MAX_STEP_ACTIONS)) {
    if (!action || typeof action.toolCallId !== "string" || typeof action.toolName !== "string") continue;
    const toolCallId = action.toolCallId.trim().slice(0, 200);
    const toolName = action.toolName.trim().slice(0, 100);
    const inputHash = typeof action.inputHash === "string" ? action.inputHash.trim().slice(0, 128) : "";
    if (!toolCallId || !toolName || !inputHash) continue;
    const files = sanitizeFiles(action.files);
    omittedFiles += files.omitted;
    result.push({
      toolCallId,
      toolName,
      inputHash,
      ok: action.ok === true,
      ...(typeof action.errorCode === "string" && action.errorCode ? { errorCode: action.errorCode.slice(0, 100) } : {}),
      ...(files.files.length > 0 ? { files: files.files } : {}),
    });
  }
  return { actions: result, omittedFiles };
}

/** Persiste un paso de forma idempotente por `(runId, stepIndex)`: reintentar
 * el mismo checkpoint actualiza la fila, no duplica. */
export function recordStep(input: RecordStepInput): AgentStep {
  if (!Number.isInteger(input.stepIndex) || input.stepIndex < 0) throw new Error("stepIndex debe ser un entero >= 0.");
  const phase = typeof input.phase === "string" ? input.phase.trim().slice(0, 50) : "";
  if (!phase) throw new Error("phase no puede estar vacío.");

  const sanitized = sanitizeActions(Array.isArray(input.actions) ? input.actions : []);
  const sanitizedResults = sanitizeResults(Array.isArray(input.results) ? input.results : []);
  const results = sanitizedResults.results;
  const progress: Record<string, unknown> = isPlainObject(input.progress) ? { ...input.progress } : {};
  if (sanitized.omittedFiles > 0) progress.sensitiveFilesOmitted = sanitized.omittedFiles;
  if (sanitizedResults.omitted > 0) progress.omittedResultKeys = sanitizedResults.omitted;

  const actionsJson = JSON.stringify(sanitized.actions);
  const resultsJson = JSON.stringify(results);
  const progressJson = JSON.stringify(progress);
  if (actionsJson.length + resultsJson.length + progressJson.length > MAX_STEP_JSON_CHARS) {
    throw new Error(`El paso supera el máximo de ${MAX_STEP_JSON_CHARS} caracteres de metadatos.`);
  }

  const now = input.ts ?? Date.now();
  getDb()
    .prepare(
      `INSERT INTO agent_steps
       (id, run_id, step_index, phase, ts, actions_json, results_json, progress_json, input_tokens, output_tokens)
       VALUES (@id, @runId, @stepIndex, @phase, @ts, @actionsJson, @resultsJson, @progressJson, @inputTokens, @outputTokens)
       ON CONFLICT(run_id, step_index) DO UPDATE SET
         phase = excluded.phase,
         ts = excluded.ts,
         actions_json = excluded.actions_json,
         results_json = excluded.results_json,
         progress_json = excluded.progress_json,
         input_tokens = excluded.input_tokens,
         output_tokens = excluded.output_tokens`,
    )
    .run({
      id: crypto.randomUUID(),
      runId: input.runId,
      stepIndex: input.stepIndex,
      phase,
      ts: now,
      actionsJson,
      resultsJson,
      progressJson,
      inputTokens: typeof input.inputTokens === "number" ? input.inputTokens : null,
      outputTokens: typeof input.outputTokens === "number" ? input.outputTokens : null,
    });

  const persisted = getStepByIndex(input.runId, input.stepIndex);
  if (!persisted) throw new Error("El paso se insertó pero no se pudo releer.");
  return persisted;
}

export function getStepByIndex(runId: string, stepIndex: number): AgentStep | null {
  const row = getDb()
    .prepare("SELECT * FROM agent_steps WHERE run_id = ? AND step_index = ?")
    .get(runId, stepIndex) as StepRow | undefined;
  return row ? rowToStep(row) : null;
}

export function getStepsForRun(runId: string, limit = 200): AgentStep[] {
  const safeLimit = clampInt(limit, 1, 1_000);
  const rows = getDb()
    .prepare("SELECT * FROM agent_steps WHERE run_id = ? ORDER BY step_index ASC LIMIT ?")
    .all(runId, safeLimit) as StepRow[];
  return rows.map(rowToStep);
}

export function toolCallIdExists(runId: string, toolCallId: string): boolean {
  const rows = getDb()
    .prepare("SELECT actions_json FROM agent_steps WHERE run_id = ?")
    .all(runId) as Array<{ actions_json: string }>;
  return rows.some((row) => {
    const actions = safeJsonParse<unknown>(row.actions_json, []);
    return Array.isArray(actions) && actions.some((action) => isPlainObject(action) && action.toolCallId === toolCallId);
  });
}

// ---------------------------------------------------------------------------
// File checkpoints
// ---------------------------------------------------------------------------

export type FileCheckpointInput = {
  runId: string;
  path: string;
  sha256: string;
  size: number;
  mtimeMs: number;
  updatedAt?: number;
};

export function upsertFileCheckpoint(input: FileCheckpointInput): void {
  const normalized = normalizePathForRules(input.path);
  if (!normalized.ok) throw new Error(`Ruta de checkpoint inválida (${normalized.rule}).`);
  const relPath = normalized.segments.join("/");
  const sensitive = sensitiveRuleOf(relPath);
  if (sensitive) throw new Error(`Ruta de checkpoint sensible no permitida (${sensitive}).`);
  if (!/^[a-f0-9]{64}$/.test(input.sha256)) throw new Error("sha256 de checkpoint inválido.");
  if (!Number.isFinite(input.size) || input.size < 0) throw new Error("size de checkpoint inválido.");
  if (!Number.isFinite(input.mtimeMs) || input.mtimeMs < 0) throw new Error("mtimeMs de checkpoint inválido.");

  getDb()
    .prepare(
      `INSERT INTO agent_file_checkpoints (run_id, path, sha256, size, mtime_ms, updated_at)
       VALUES (@runId, @path, @sha256, @size, @mtimeMs, @updatedAt)
       ON CONFLICT(run_id, path) DO UPDATE SET
         sha256 = excluded.sha256,
         size = excluded.size,
         mtime_ms = excluded.mtime_ms,
         updated_at = excluded.updated_at`,
    )
    .run({
      runId: input.runId,
      path: relPath,
      sha256: input.sha256,
      size: Math.round(input.size),
      mtimeMs: Math.round(input.mtimeMs),
      updatedAt: input.updatedAt ?? Date.now(),
    });
}

export type FileCheckpoint = {
  runId: string;
  path: string;
  sha256: string;
  size: number;
  mtimeMs: number;
  updatedAt: number;
};

export function getFileCheckpoints(runId: string): FileCheckpoint[] {
  const rows = getDb()
    .prepare("SELECT * FROM agent_file_checkpoints WHERE run_id = ? ORDER BY path ASC")
    .all(runId) as Array<{
    run_id: string;
    path: string;
    sha256: string;
    size: number;
    mtime_ms: number;
    updated_at: number;
  }>;
  return rows.map((row) => ({
    runId: row.run_id,
    path: row.path,
    sha256: row.sha256,
    size: row.size,
    mtimeMs: row.mtime_ms,
    updatedAt: row.updated_at,
  }));
}

// ---------------------------------------------------------------------------
// Verifications
// ---------------------------------------------------------------------------

export type RecordVerificationInput = {
  runId: string;
  itemId?: string | null;
  criterion: AcceptanceCriterion;
  status: VerificationStatus;
  evidence?: Record<string, unknown>;
  ts?: number;
};

export function recordVerification(input: RecordVerificationInput): VerificationRecord {
  const evidenceJson = JSON.stringify(input.evidence ?? {});
  if (evidenceJson.length > MAX_STEP_JSON_CHARS) {
    throw new Error(`La verificación supera el máximo de ${MAX_STEP_JSON_CHARS} caracteres de metadatos.`);
  }
  const record: VerificationRecord = {
    id: crypto.randomUUID(),
    runId: input.runId,
    itemId: input.itemId ?? null,
    criterion: input.criterion,
    status: input.status,
    evidence: input.evidence ?? {},
    ts: input.ts ?? Date.now(),
  };

  getDb()
    .prepare(
      `INSERT INTO agent_verifications (id, run_id, item_id, criterion_json, status, evidence_json, ts)
       VALUES (@id, @runId, @itemId, @criterionJson, @status, @evidenceJson, @ts)`,
    )
    .run({
      id: record.id,
      runId: record.runId,
      itemId: record.itemId,
      criterionJson: JSON.stringify(record.criterion),
      status: record.status,
      evidenceJson,
      ts: record.ts,
    });

  return record;
}

export function getVerificationsForRun(runId: string): VerificationRecord[] {
  const rows = getDb()
    .prepare("SELECT * FROM agent_verifications WHERE run_id = ? ORDER BY ts ASC")
    .all(runId) as VerificationRow[];
  return rows.map(rowToVerification);
}

/** Busca una verificación real de `typecheck`/script con el exit code
 * declarado. La usa la evidencia `command` para no aceptar comandos que el
 * controlador nunca corrió. */
export function findCommandVerification(
  runId: string,
  name: string,
  exitCode: number,
): VerificationRecord | null {
  for (const verification of getVerificationsForRun(runId)) {
    const criterion = verification.criterion;
    const matchesName =
      (criterion.kind === "typecheck" && name === "typecheck") ||
      (criterion.kind === "script" && criterion.name === name);
    if (!matchesName) continue;
    const recordedExit = verification.evidence.exitCode;
    if (recordedExit === exitCode) return verification;
  }
  return null;
}
