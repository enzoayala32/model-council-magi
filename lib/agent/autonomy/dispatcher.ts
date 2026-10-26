/**
 * Fase 9C — dispatcher iterativo del Autonomous Loop.
 *
 * Orquesta el ciclo PLANNING → EXECUTING → VERIFYING → decisión, usando:
 * - el contrato de estados/límites de `contract.ts` (9A),
 * - el plan y el ledger de `plan.ts`/`ledger.ts` (9B),
 * - las tools `update_plan`/`update_plan_item` (9B),
 * - el verificador real de acceptance (`verifier.ts`),
 * - el briefing phase-scoped (`briefing.ts`).
 *
 * Este módulo NO reemplaza a `runAgentLoop`: es una ruta opt-in. Sin el flag
 * `MAGI_AUTONOMOUS_LOOP=1`, `runner.ts` sigue usando el loop legacy sin
 * cambios de comportamiento.
 *
 * Invariantes de seguridad:
 * - El dispatcher nunca persiste contenido de archivos, stdout/stderr,
 *   prompts ni API keys. Los eventos usan una allowlist de metadatos y el
 *   ledger sanitiza lo que recibe.
 * - El verificador solo ejecuta `typecheck` o scripts allowlisted
 *   (`build|test|lint`); nunca un comando arbitrario del modelo.
 * - El failover de credenciales replica la regla de Step-0 del loop legacy:
 *   solo se rota si el error ocurrió antes de que terminara el primer step
 *   de ESA llamada al modelo.
 */

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { generateText, stepCountIs, type ModelMessage, type StopCondition, type ToolSet } from "ai";
import { appendEvent, type AgentEventPayload } from "../event-log";
import { createAgentTools, isWebSearchCompatible, type AgentToolEvent, type CreateAgentToolsRepoMapOptions } from "../tools";
import {
  buildErrorMessage,
  buildModelForId,
  buildProposals,
  buildSystemPrompt,
  detectAllowedScripts,
  resolveCodingModelId,
  resolveProviderName,
  sha256,
  toProviderErrorInput,
  type AgentFileProposal,
} from "../loop";
import { createContextEngine, type ContextEngine } from "../context/engine";
import { measureContext, type ContextEstimate } from "../context/estimate";
import { computeContextBudget } from "../context/budget";
import { extractProviderUsage } from "../context/provider-usage";
import {
  buildContextUsagePayload,
  type ContextSelectionSummary,
  type ContextUsagePayload,
  type GovernorUsageSummary,
} from "../context/usage";
import { createRepoMapTracker } from "../repo-map-tracker";
import type { SearchProvider } from "../search-provider";
import { getCouncilModel } from "../../models";
import { getProviderPool } from "../../provider-resilience/registry";
import { classifyProviderError } from "../../provider-resilience/classify";
import { computeCooldownMs } from "../../provider-resilience/cooldown";
import { redactSecrets } from "../../provider-resilience/redact";
import {
  isTerminalAutonomyState,
  normalizeAutonomyLimits,
  resolveTaskOutcome,
  type AutonomyBudget,
  type AutonomyLimits,
  type AutonomyState,
  type AutonomyStopReason,
  type AutonomyTaskOutcome,
  type AutonomyTerminalState,
} from "./contract";
import {
  createRun,
  getPlanVersion,
  getRun,
  getStepsForRun,
  markPlanStatus,
  recordStep,
  recordVerification,
  resetPlanItemToPending,
  savePlanVersion,
  transitionRun,
  updatePlanItem,
  updateRunProgress,
  upsertFileCheckpoint,
  type AcceptanceVerifier,
  type AgentStepAction,
  type PersistedPlan,
  type PersistedPlanItem,
  type RecordVerificationInput,
} from "./ledger";
import {
  buildFallbackPlan,
  describeCriterion,
  isMachineCheckable,
  SCRIPT_NAMES,
  type ScriptName,
} from "./plan";
import { createAutonomyPlanTools } from "./tools";
import {
  buildAutonomyBriefing,
  type BriefingPhase,
  type BriefingStep,
  type BriefingVerification,
} from "./briefing";
import { createAcceptanceVerifier, type VerifierExec } from "./verifier";

const execFileAsync = promisify(execFile);

const MAX_RECENT_STEPS = 20;
const MAX_WARNING_CHARS = 300;
const MAX_WARNINGS = 50;
const MAX_ERROR_CHARS = 1_000;
const MAX_EVENT_TEXT_CHARS = 500;

const FILE_TOOLS = new Set(["write_file", "edit_file", "delete_file"]);

/** Claves de input que sí pueden viajar a `agent_events`. Todo lo demás
 * (`content`, `oldStr`, `newStr`, `patch`, `description`, `reason`, ...)
 * se descarta: son justamente los campos que pueden contener código. */
const SAFE_INPUT_KEYS = new Set([
  "path",
  "subPath",
  "extension",
  "nameContains",
  "pattern",
  "caseSensitive",
  "maxResults",
  "startLine",
  "endLine",
  "query",
  "url",
  "name",
  "script",
  "id",
  "status",
  "sha256",
]);

/** Mismo tope que la evidencia de archivo del ledger (9B): un archivo más
 * grande no se hashea en cada paso. */
const CHECKPOINT_MAX_FILE_BYTES = 2_000_000;

const DISABLED_GOVERNOR: GovernorUsageSummary = Object.freeze({
  enabled: false,
  applied: false,
  removedMessages: 0,
  summaryChars: 0,
  version: null,
});

function disabledSelection(): ContextSelectionSummary {
  return {
    enabled: false,
    available: false,
    candidates: 0,
    included: 0,
    truncated: false,
    confidence: null,
    generation: null,
    refreshes: 0,
    error: null,
    signals: {
      explicit_path: 0,
      touched: 0,
      symbol_mention: 0,
      term_match: 0,
      graph_neighbor: 0,
      role: 0,
      test_pair: 0,
    },
  };
}

type ModelPhase = "PLANNING" | "EXECUTING" | "REPLANNING";

type ToolCallLike = { toolCallId: string; toolName: string; input?: unknown };
type ToolResultLike = { toolCallId: string; toolName: string; input?: unknown; output?: unknown };

type StepLike = {
  stepNumber?: number;
  text?: string;
  content?: Array<Record<string, unknown>>;
  toolCalls?: ToolCallLike[];
  toolResults?: ToolResultLike[];
  usage?: Record<string, unknown>;
};

type ToolChoiceOption = "auto" | "none" | "required" | { type: "tool"; toolName: string };

type AutonomyToolSet = ReturnType<typeof createAgentTools> & ReturnType<typeof createAutonomyPlanTools>;

type TerminalDecision = {
  state: AutonomyTerminalState;
  stopReason: AutonomyStopReason;
  error?: string;
};

type ModelCallResult = { ok: true } | { ok: false; terminal: TerminalDecision };

type PlanOutcome = { ok: true; plan: PersistedPlan } | { ok: false; terminal: TerminalDecision };

type ModelCallOptions = {
  phase: ModelPhase;
  system: string;
  prompt: string;
  tools: ToolSet;
  stopWhen: Array<StopCondition<ToolSet>>;
  toolChoice?: ToolChoiceOption;
};

type LoopContext = {
  taskId: string;
  task: string;
  runId: string;
  workspaceRoot: string;
  repoRoot: string;
  modelId: string;
  providerName: ReturnType<typeof resolveProviderName>;
  limits: AutonomyLimits;
  allowedScripts: string[];
  verifier: AcceptanceVerifier;
  planTools: ReturnType<typeof createAutonomyPlanTools>;
  allTools: AutonomyToolSet;
  searchEnabled: boolean;
  generateTextImpl: (options: Parameters<typeof generateText>[0]) => Promise<unknown>;
  pool: ReturnType<typeof getProviderPool>;
  signal: AbortSignal;
  externalSignal?: AbortSignal;
  onExternalAbort: () => void;
  timeoutTimer: NodeJS.Timeout;
  timedOut: boolean;
  now: () => number;
  startedAt: number;
  steps: number;
  inputTokens: number;
  outputTokens: number;
  replans: number;
  lastPlanVersion: number;
  lastTypeCheckOk: boolean | null;
  lastVerification: BriefingVerification | null;
  lastEventSeq: number | null;
  noProgressSteps: number;
  lastActionFingerprint: string | null;
  identicalActionCount: number;
  stallReason: "no_progress" | "repeated_action" | "replans_exhausted" | null;
  warnings: string[];
  warningSet: Set<string>;
  transcript: string[];
  touchedFiles: Set<string>;
  contextUsage: ContextUsagePayload[];
  contextEngine?: ContextEngine;
  setupError?: string;
};

export type RunAutonomousLoopOptions = {
  taskId: string;
  task: string;
  workspaceRoot: string;
  repoRoot: string;
  modelId?: string;
  workspaceId?: string | null;
  baseCommit?: string | null;
  abortSignal?: AbortSignal;
  limits?: Partial<AutonomyLimits>;
  /** Inyectable solo para tests: el default es `generateText` real. */
  generateTextImpl?: (options: Parameters<typeof generateText>[0]) => Promise<unknown>;
  /** Inyectable solo para tests: el default ejecuta `npx tsc`/`npm run`
   * con el mismo `execWithTreeKill` que usan las tools legacy. */
  verifierExec?: VerifierExec;
  searchProvider?: SearchProvider | null;
  webSearchCompatibleOverride?: boolean;
  /** Motor de contexto de Fase 8D. Apagado por defecto en el dispatcher:
   * `runner.ts` lo enciende para tasks reales, igual que en el loop legacy. */
  contextEngine?: {
    enabled?: boolean;
    maxCandidates?: number;
    briefingMaxChars?: number;
    refreshLimit?: number;
    startTimeoutMs?: number;
    refreshTimeoutMs?: number;
  };
  /** Solo tests: reloj inyectable para probar el presupuesto de tiempo. */
  now?: () => number;
};

export type AutonomousLoopResult = {
  runId: string;
  state: AutonomyTerminalState;
  stopReason: AutonomyStopReason;
  outcome: AutonomyTaskOutcome;
  steps: number;
  transcript: string[];
  proposals: AgentFileProposal[];
  touchedFiles: string[];
  error?: string;
  budget: AutonomyBudget;
  /** Fase 8A/9C — telemetría numérica por paso, sin contenido. */
  contextUsage: ContextUsagePayload[];
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

function hashJson(value: unknown): string {
  return sha256(stableStringify(value));
}

function safeText(value: unknown, max = MAX_EVENT_TEXT_CHARS): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = redactSecrets(value).replace(/\s+/g, " ").trim();
  return cleaned.length > 0 ? cleaned.slice(0, max) : undefined;
}

function sanitizeError(error: unknown, workspaceRoot: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  const withoutWorkspace = workspaceRoot ? raw.split(workspaceRoot).join("<workspace>") : raw;
  return redactSecrets(withoutWorkspace).slice(0, MAX_ERROR_CHARS);
}

function sanitizeToolInput(input: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(input)) return undefined;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!SAFE_INPUT_KEYS.has(key)) continue;
    if (typeof value === "string") {
      const cleaned = safeText(value, 200);
      if (cleaned) result[key] = cleaned;
    } else if (typeof value === "number" || typeof value === "boolean") {
      result[key] = value;
    } else if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
      const cleaned = value.slice(0, 10).map((entry) => safeText(entry, 200)).filter((entry): entry is string => Boolean(entry));
      if (cleaned.length > 0) result[key] = cleaned;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function filesForTool(toolName: string, input: unknown): string[] {
  if (!FILE_TOOLS.has(toolName) || !isPlainObject(input)) return [];
  const relPath = typeof input.path === "string" ? input.path.replace(/\\/g, "/") : "";
  return relPath ? [relPath] : [];
}

function isProgressAction(toolName: string, output: Record<string, unknown> | undefined): boolean {
  if (!output || output.ok !== true) return false;
  if (FILE_TOOLS.has(toolName) || toolName === "update_plan") return true;
  if (toolName === "update_plan_item") {
    const item = isPlainObject(output.item) ? output.item : undefined;
    const status = item && typeof item.status === "string" ? item.status : "";
    return status === "DONE" || status === "BLOCKED" || status === "FAILED" || status === "SKIPPED";
  }
  return false;
}

function describeToolResult(
  toolName: string,
  input: unknown,
  output: Record<string, unknown> | undefined,
  ok: boolean,
): string {
  const relPath = isPlainObject(input) && typeof input.path === "string" ? input.path.replace(/\\/g, "/").slice(0, 200) : undefined;
  if (toolName === "update_plan" && ok && typeof output?.version === "number") {
    return `update_plan → v${output.version}`;
  }
  if (toolName === "update_plan_item" && ok && isPlainObject(output?.item)) {
    const id = typeof output.item.id === "string" ? output.item.id : "?";
    const status = typeof output.item.status === "string" ? output.item.status : "?";
    return `update_plan_item ${id} → ${status}`;
  }
  if (ok) return relPath ? `${toolName} ${relPath} OK` : `${toolName} OK`;
  return relPath ? `${toolName} ${relPath} falló` : `${toolName} falló`;
}

function extractUsage(step: StepLike): { inputTokens: number; outputTokens: number } {
  const usage = isPlainObject(step.usage) ? step.usage : undefined;
  const rawInput =
    typeof usage?.inputTokens === "number" ? usage.inputTokens : typeof usage?.promptTokens === "number" ? usage.promptTokens : 0;
  const rawOutput =
    typeof usage?.outputTokens === "number" ? usage.outputTokens : typeof usage?.completionTokens === "number" ? usage.completionTokens : 0;
  return {
    inputTokens: Math.max(0, Math.round(rawInput)),
    outputTokens: Math.max(0, Math.round(rawOutput)),
  };
}

function resolveInsideWorkspace(workspaceRoot: string, relPath: string): string | null {
  const root = path.resolve(workspaceRoot);
  const absolute = path.resolve(root, relPath);
  const relative = path.relative(root, absolute);
  if (relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return absolute;
}

/** Fase 9C (diseño 5.3.4) — checkpoint best-effort del archivo REAL que
 * acaba de escribir/editar una tool. No persiste contenido: solo hash,
 * tamaño y mtime. Un archivo borrado no se toca acá; 9E detecta el drift
 * comparando el checkpoint contra el filesystem. */
function checkpointFile(ctx: LoopContext, relPath: string): void {
  const absolute = resolveInsideWorkspace(ctx.workspaceRoot, relPath);
  if (!absolute) return;
  try {
    const stat = fs.statSync(absolute);
    if (!stat.isFile() || stat.size > CHECKPOINT_MAX_FILE_BYTES) return;
    const buffer = fs.readFileSync(absolute);
    const digest = crypto.createHash("sha256").update(buffer).digest("hex");
    upsertFileCheckpoint({
      runId: ctx.runId,
      path: relPath,
      sha256: digest,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    });
  } catch {
    // El checkpoint es auxiliar: nunca rompe el paso ni el loop.
  }
}

function shouldCheckpoint(ctx: LoopContext, stepIndex: number): boolean {
  const every = ctx.limits.checkpointEverySteps;
  if (every <= 1) return true;
  return (stepIndex + 1) % every === 0;
}

function recordContextUsage(
  ctx: LoopContext,
  options: ModelCallOptions,
  step: StepLike,
  callSteps: number,
  measurements: Map<number, ContextEstimate>,
): void {
  try {
    const stepNumber = typeof step.stepNumber === "number" ? step.stepNumber : Math.max(0, callSteps - 1);
    const providerUsage = extractProviderUsage(step.usage);
    const estimate =
      measurements.get(stepNumber) ??
      measureContext({ system: options.system, messages: [] as ModelMessage[], tools: options.tools });
    const budget = computeContextBudget({ modelId: ctx.modelId, estimate, providerUsage });
    const payload = buildContextUsagePayload({
      step: stepNumber + 1,
      modelId: ctx.modelId,
      provider: ctx.providerName,
      estimate,
      providerUsage,
      budget,
      selection: ctx.contextEngine?.getSummary() ?? disabledSelection(),
      governor: DISABLED_GOVERNOR,
    });
    ctx.contextUsage.push(payload);
    appendEventSafe(ctx, payload);
  } catch {
    // La telemetría nunca debe romper un paso.
  }
}

function summarizePlan(plan: PersistedPlan) {
  let done = 0;
  let skipped = 0;
  let blocked = 0;
  let failed = 0;
  let pending = 0;
  let inProgress = 0;
  for (const item of plan.items) {
    switch (item.status) {
      case "DONE":
        done += 1;
        break;
      case "SKIPPED":
        skipped += 1;
        break;
      case "BLOCKED":
        blocked += 1;
        break;
      case "FAILED":
        failed += 1;
        break;
      case "PENDING":
        pending += 1;
        break;
      case "IN_PROGRESS":
        inProgress += 1;
        break;
    }
  }
  return {
    done,
    skipped,
    blocked,
    failed,
    pending,
    inProgress,
    allDone: plan.items.length > 0 && done + skipped === plan.items.length,
    allTerminal: pending === 0 && inProgress === 0,
  };
}

function currentPlan(ctx: LoopContext): PersistedPlan | null {
  // Importante: NO se usa `getPlanForRun` acá. Esa función cae al plan
  // ACTIVE de la task cuando `plan_version` es 0, lo cual es correcto para
  // una reanudación (9E) pero peligroso para una corrida nueva: reutilizaría
  // el plan de una corrida anterior sin que el modelo lo haya decidido.
  const run = getRun(ctx.runId);
  if (!run || run.planVersion <= 0) return null;
  return getPlanVersion(ctx.taskId, run.planVersion);
}

function snapshotBudget(ctx: LoopContext): AutonomyBudget {
  return {
    steps: ctx.steps,
    wallTimeMs: Math.max(0, ctx.now() - ctx.startedAt),
    inputTokens: ctx.inputTokens,
    outputTokens: ctx.outputTokens,
    estimatedCostUsd: null,
  };
}

function checkBudget(ctx: LoopContext): TerminalDecision | null {
  if (ctx.steps >= ctx.limits.maxSteps) {
    return {
      state: "BUDGET_EXHAUSTED",
      stopReason: "budget_exhausted",
      error: `Se agotaron los ${ctx.limits.maxSteps} pasos de la corrida.`,
    };
  }
  if (ctx.now() - ctx.startedAt >= ctx.limits.maxWallTimeMs) {
    return {
      state: "BUDGET_EXHAUSTED",
      stopReason: "timeout",
      error: "Se agotó el tiempo máximo de la corrida.",
    };
  }
  if (
    ctx.inputTokens >= ctx.limits.maxInputTokens ||
    ctx.outputTokens >= ctx.limits.maxOutputTokens ||
    ctx.inputTokens + ctx.outputTokens >= ctx.limits.maxTokens
  ) {
    return {
      state: "BUDGET_EXHAUSTED",
      stopReason: "budget_exhausted",
      error: "Se agotó el presupuesto de tokens de la corrida.",
    };
  }
  return null;
}

function abortDecision(ctx: LoopContext): TerminalDecision {
  if (ctx.externalSignal?.aborted) {
    return { state: "CANCELLED", stopReason: "cancelled", error: "Cancelada por el usuario." };
  }
  if (ctx.timedOut) {
    return { state: "BUDGET_EXHAUSTED", stopReason: "timeout", error: "Se agotó el tiempo máximo de la corrida." };
  }
  return { state: "CANCELLED", stopReason: "cancelled", error: "Cancelada." };
}

function warn(ctx: LoopContext, message: string): void {
  const clean = safeText(message, MAX_WARNING_CHARS) ?? "warning";
  if (ctx.warningSet.has(clean)) return;
  ctx.warningSet.add(clean);
  ctx.warnings.push(clean);
  if (ctx.warnings.length > MAX_WARNINGS) {
    const removed = ctx.warnings.shift();
    if (removed) ctx.warningSet.delete(removed);
  }
}

function appendEventSafe(ctx: LoopContext, payload: AgentEventPayload): void {
  try {
    const event = appendEvent(ctx.taskId, payload);
    ctx.lastEventSeq = event.seq;
  } catch {
    warn(ctx, "No se pudo persistir un evento de la corrida.");
  }
}

function recordVerificationSafe(ctx: LoopContext, input: Omit<RecordVerificationInput, "runId">): void {
  try {
    recordVerification({ runId: ctx.runId, ...input });
  } catch {
    warn(ctx, "No se pudo persistir una verificación.");
  }
}

function updateBudget(ctx: LoopContext): void {
  try {
    updateRunProgress(ctx.runId, { budget: snapshotBudget(ctx), lastEventSeq: ctx.lastEventSeq });
  } catch {
    warn(ctx, "No se pudo actualizar el presupuesto de la corrida.");
  }
}

function recentSteps(ctx: LoopContext): BriefingStep[] {
  return getStepsForRun(ctx.runId, 1_000)
    .slice(-MAX_RECENT_STEPS)
    .map((step) => ({
      stepIndex: step.stepIndex,
      phase: step.phase,
      actions: step.actions.map((action) => ({
        toolCallId: action.toolCallId,
        toolName: action.toolName,
        ok: action.ok,
        ...(action.files && action.files.length > 0 ? { files: action.files } : {}),
      })),
    }));
}

function briefingBudget(ctx: LoopContext) {
  return {
    stepsUsed: ctx.steps,
    maxSteps: ctx.limits.maxSteps,
    tokensUsed: ctx.inputTokens + ctx.outputTokens,
    maxTokens: ctx.limits.maxTokens,
    wallTimeMs: ctx.now() - ctx.startedAt,
    maxWallTimeMs: ctx.limits.maxWallTimeMs,
    replansUsed: ctx.replans,
    maxReplans: ctx.limits.maxReplans,
  };
}

function buildBriefing(ctx: LoopContext, phase: BriefingPhase, plan: PersistedPlan | null, extraWarnings: string[] = []): string {
  return buildAutonomyBriefing({
    task: ctx.task,
    phase,
    plan,
    recentSteps: recentSteps(ctx),
    warnings: [...ctx.warnings, ...extraWarnings],
    lastVerification: ctx.lastVerification,
    budget: briefingBudget(ctx),
  });
}

function buildPlanningSystemPrompt(briefing: string): string {
  return [
    "Sos el planificador de un agente de programación autónomo dentro de un workspace git aislado.",
    "En esta fase SOLO podés llamar la tool `update_plan`. No edites archivos ni ejecutes comandos.",
    "El plan debe tener un objetivo claro, items pequeños y, cuando sea posible, acceptance verificable por máquina (typecheck, script build/test/lint, file_exists, file_hash). Usá `manual` solo si de verdad no hay forma de verificarlo.",
    "Los ids de los items deben ser estables y cortos (t1, t2, ...). No inventes evidencia ni acceptance que no puedas cumplir.",
    briefing,
  ].join("\n\n");
}

function buildReplanningSystemPrompt(briefing: string): string {
  return [
    "Sos el planificador de un agente autónomo. La verificación falló o el plan necesita cambios.",
    "En esta fase SOLO podés llamar `update_plan`. Creá una versión nueva y corregida del plan.",
    "Conservá los items que ya están DONE; no repitas trabajo hecho. Cambiá solo lo necesario y explicá el cambio en el objetivo o en los títulos.",
    "No inventes evidencia ni acceptance que no puedas verificar.",
    briefing,
  ].join("\n\n");
}

function buildExecutingSystemPrompt(ctx: LoopContext, briefing: string): string {
  const base = buildSystemPrompt(ctx.allowedScripts, ctx.searchEnabled);
  const autonomy = [
    "Modo autónomo (Fase 9C):",
    "- Tenés además `update_plan` y `update_plan_item`. Marcá el item IN_PROGRESS antes de trabajarlo y DONE solo cuando esté realmente terminado.",
    "- Para DONE necesitás evidencia real de ESTA corrida: un `toolCallId` de un paso YA CERRADO (no el de la misma respuesta), un archivo con su hash actual, o un comando typecheck/script que el controlador ya haya verificado. No inventes ids, hashes ni comandos.",
    "- Si el item tiene acceptance verificable, el controlador la corre al marcar DONE; si falla, el item no cambia y recibís el motivo.",
    "- Si te bloqueás, marcá BLOCKED con un motivo concreto. Si necesitás cambiar el plan, llamá `update_plan` (crea una versión nueva).",
    "- No repitas la misma acción idéntica: si un intento no funcionó, cambiá de estrategia.",
    "- No incluyas secretos, API keys ni contenido de archivos en tus mensajes de estado.",
  ].join("\n");
  return `${base}\n\n${autonomy}\n\n${briefing}`;
}

function handleModelStep(ctx: LoopContext, phase: ModelPhase, step: StepLike): void {
  const stepIndex = ctx.steps;
  const content = Array.isArray(step.content) ? step.content : [];
  const calls: ToolCallLike[] = Array.isArray(step.toolCalls)
    ? step.toolCalls
    : content
        .filter((part) => part.type === "tool-call")
        .map((part) => ({
          toolCallId: typeof part.toolCallId === "string" ? part.toolCallId : "",
          toolName: typeof part.toolName === "string" ? part.toolName : "",
          input: part.input,
        }))
        .filter((call) => call.toolCallId.length > 0 && call.toolName.length > 0);
  const results: ToolResultLike[] = Array.isArray(step.toolResults)
    ? step.toolResults
    : content
        .filter((part) => part.type === "tool-result")
        .map((part) => ({
          toolCallId: typeof part.toolCallId === "string" ? part.toolCallId : "",
          toolName: typeof part.toolName === "string" ? part.toolName : "",
          input: part.input,
          output: part.output,
        }))
        .filter((result) => result.toolCallId.length > 0 && result.toolName.length > 0);
  const callById = new Map(calls.map((call) => [call.toolCallId, call]));

  for (const call of calls) {
    appendEventSafe(ctx, { type: "tool_call", toolName: call.toolName, input: sanitizeToolInput(call.input) });
  }

  const actions: AgentStepAction[] = [];
  const resultMetas: Array<Record<string, unknown>> = [];
  const checkpointPaths = new Set<string>();
  let stepProgress = false;

  for (const result of results) {
    const output = isPlainObject(result.output) ? result.output : undefined;
    const ok = output?.ok !== false;
    const call = callById.get(result.toolCallId);
    const input = call?.input ?? result.input;
    const files = ok ? filesForTool(result.toolName, input) : [];
    const code =
      typeof output?.code === "string" ? output.code : typeof output?.errorCode === "string" ? output.errorCode : undefined;
    const errorText = safeText(output?.error, MAX_EVENT_TEXT_CHARS);

    actions.push({
      toolCallId: result.toolCallId,
      toolName: result.toolName,
      inputHash: hashJson(input ?? null),
      ok,
      ...(code ? { errorCode: code } : {}),
      ...(files.length > 0 ? { files } : {}),
    });
    resultMetas.push({
      ok,
      toolCallId: result.toolCallId,
      ...(code ? { code } : {}),
      ...(errorText ? { summary: errorText } : {}),
    });

    const summary = describeToolResult(result.toolName, input, output, ok);
    ctx.transcript.push(`${ok ? "🔧" : "❌"} ${summary}${!ok && errorText ? `: ${errorText}` : ""}`);
    if (ok) {
      appendEventSafe(ctx, { type: "tool_result", toolName: result.toolName, ok: true, summary });
    } else {
      appendEventSafe(ctx, {
        type: "tool_result",
        toolName: result.toolName,
        ok: false,
        error: errorText ?? "sin detalle",
        summary,
      });
    }

    // `run_typecheck`/`run_script` devuelven `ok:true` aunque el comando
    // falle; `success` es la señal real. Se registra una verificación para
    // que la evidencia `command` del ledger pueda referenciarla sin que el
    // modelo tenga que inventar un exit code.
    if (result.toolName === "run_typecheck" && typeof output?.success === "boolean") {
      const success = output.success;
      ctx.lastTypeCheckOk = success;
      ctx.lastVerification = { criterion: "typecheck", status: success ? "passed" : "failed" };
      recordVerificationSafe(ctx, {
        criterion: { kind: "typecheck" },
        status: success ? "passed" : "failed",
        evidence: { exitCode: success ? 0 : 1, source: "tool" },
      });
      // Sin `outputExcerpt`: el stdout de tsc puede contener código del
      // proyecto y este evento se persiste.
      appendEventSafe(ctx, { type: "typecheck_result", success });
    }

    if (result.toolName === "run_script") {
      const name = typeof output?.name === "string" ? output.name : "";
      if (name && (SCRIPT_NAMES as readonly string[]).includes(name) && typeof output?.success === "boolean") {
        const success = output.success;
        const scriptName = name as ScriptName;
        ctx.lastVerification = { criterion: `script:${name}`, status: success ? "passed" : "failed" };
        recordVerificationSafe(ctx, {
          criterion: { kind: "script", name: scriptName },
          status: success ? "passed" : "failed",
          evidence: { exitCode: success ? 0 : 1, source: "tool" },
        });
        appendEventSafe(ctx, { type: "run_script_result", name, success });
      }
    }

    if (isProgressAction(result.toolName, output)) stepProgress = true;
    if (ok && FILE_TOOLS.has(result.toolName)) {
      if (result.toolName === "write_file" || result.toolName === "edit_file") {
        for (const file of files) checkpointPaths.add(file);
      }
      const fingerprint = `${result.toolName}:${hashJson(input ?? null)}`;
      if (fingerprint === ctx.lastActionFingerprint) ctx.identicalActionCount += 1;
      else {
        ctx.lastActionFingerprint = fingerprint;
        ctx.identicalActionCount = 1;
      }
    }
  }

  if (checkpointPaths.size > 0 && shouldCheckpoint(ctx, stepIndex)) {
    for (const file of checkpointPaths) checkpointFile(ctx, file);
  }

  const usage = extractUsage(step);
  try {
    recordStep({
      runId: ctx.runId,
      stepIndex,
      phase,
      actions,
      results: resultMetas,
      progress: {
        toolCalls: calls.length,
        toolResults: results.length,
        planVersion: ctx.lastPlanVersion,
        noProgressSteps: stepProgress ? 0 : ctx.noProgressSteps + 1,
        replans: ctx.replans,
      },
      inputTokens: usage.inputTokens > 0 ? usage.inputTokens : null,
      outputTokens: usage.outputTokens > 0 ? usage.outputTokens : null,
    });
  } catch {
    warn(ctx, "No se pudo persistir el paso en el ledger.");
  }

  ctx.steps += 1;
  ctx.inputTokens += usage.inputTokens;
  ctx.outputTokens += usage.outputTokens;
  if (stepProgress) ctx.noProgressSteps = 0;
  else ctx.noProgressSteps += 1;

  const plan = currentPlan(ctx);
  if (plan && plan.version > ctx.lastPlanVersion) {
    if (phase === "EXECUTING" && ctx.lastPlanVersion > 0) {
      ctx.replans += 1;
      ctx.transcript.push(`🔁 El modelo replanificó (v${plan.version}, ${ctx.replans}/${ctx.limits.maxReplans}).`);
    }
    ctx.lastPlanVersion = plan.version;
  }

  if (ctx.noProgressSteps >= ctx.limits.maxNoProgressSteps) ctx.stallReason = "no_progress";
  if (ctx.identicalActionCount >= ctx.limits.maxIdenticalActions) ctx.stallReason = "repeated_action";
  if (ctx.replans > ctx.limits.maxReplans) ctx.stallReason = "replans_exhausted";

  updateBudget(ctx);
}

async function callModel(ctx: LoopContext, options: ModelCallOptions): Promise<ModelCallResult> {
  let callSteps = 0;
  const stepMeasurements = new Map<number, ContextEstimate>();
  // Fase 9C: un cursor por LLAMADA, no por corrida. `OperationCursor`
  // excluye para siempre las credentials que ya entregó, así que reusar
  // el de la fase anterior dejaba sin credentials a toda llamada
  // posterior. Dentro de esta llamada el cursor sigue garantizando que
  // un reintento por Step-0 use una credential distinta.
  const cursor = ctx.pool.beginOperation();

  while (true) {
    if (ctx.signal.aborted) return { ok: false, terminal: abortDecision(ctx) };

    const acquireResult = cursor.next();
    if (acquireResult.status !== "AVAILABLE") {
      appendEventSafe(ctx, {
        type: "credential_failover",
        provider: ctx.providerName,
        credentialId: null,
        reason: "no_credentials",
        poolAction: null,
        outcome: "exhausted",
      });
      const retry =
        acquireResult.status === "COOLDOWN"
          ? ` La próxima estará disponible en ${new Date(acquireResult.retryAt).toISOString()}.`
          : "";
      return {
        ok: false,
        terminal: {
          state: "FAILED",
          stopReason: "provider_error",
          error: `No hay credentials disponibles para ${ctx.providerName}.${retry}`,
        },
      };
    }

    const { id: credentialId, value: apiKey, healthGeneration } = acquireResult.lease;
    const model = buildModelForId(ctx.providerName, ctx.modelId, apiKey);

    try {
      await ctx.generateTextImpl({
        model,
        system: options.system,
        prompt: options.prompt,
        tools: options.tools,
        abortSignal: ctx.signal,
        stopWhen: options.stopWhen,
        prepareStep: async ({ messages, stepNumber }: { messages: ModelMessage[]; stepNumber: number }) => {
          // Fase 8D/9C: como máximo `refreshLimit` refrescos por corrida;
          // el engine tiene su propio timeout y conserva el briefing
          // anterior si vence. Nunca rompe el paso.
          if (ctx.contextEngine) {
            try {
              await ctx.contextEngine.refreshIfNeeded(ctx.signal);
            } catch {
              // Fallback intencional.
            }
          }
          const system = options.system + (ctx.contextEngine?.getSystemSuffix() ?? "");
          try {
            stepMeasurements.set(stepNumber, measureContext({ system, messages, tools: options.tools }));
          } catch {
            // La medición es auxiliar.
          }
          return { system };
        },
        onStepFinish: (step: unknown) => {
          callSteps += 1;
          try {
            handleModelStep(ctx, options.phase, step as StepLike);
          } catch {
            warn(ctx, "No se pudo procesar un paso del modelo.");
          }
          recordContextUsage(ctx, options, step as StepLike, callSteps, stepMeasurements);
        },
        ...(options.toolChoice ? { toolChoice: options.toolChoice } : {}),
      } as Parameters<typeof generateText>[0]);
      ctx.pool.release(credentialId, "success", Date.now(), undefined, healthGeneration);
      return { ok: true };
    } catch (error) {
      if (ctx.signal.aborted) return { ok: false, terminal: abortDecision(ctx) };

      const classified = classifyProviderError(toProviderErrorInput(error));
      if (classified.poolAction === "COOLDOWN") {
        const currentState = ctx.pool.snapshot().find((state) => state.id === credentialId);
        const nextFailures = (currentState?.consecutiveFailures ?? 0) + 1;
        ctx.pool.release(credentialId, "cooldown", Date.now(), computeCooldownMs(nextFailures));
      } else if (classified.poolAction === "INVALID") {
        ctx.pool.release(credentialId, "invalid");
      }
      // `NONE` (500/502/503/timeout/network): no se libera la credential;
      // el cursor ya la excluyó para ESTA operación.

      // Regla de Step-0, idéntica al loop legacy: solo se puede reiniciar
      // la llamada completa con otra credential si NINGÚN step de esta
      // llamada terminó. Un step terminado implica que sus tools ya
      // pudieron haber tocado archivos reales.
      const willRotate = classified.failoverCredential && callSteps === 0;
      appendEventSafe(ctx, {
        type: "credential_failover",
        provider: ctx.providerName,
        credentialId,
        reason: classified.reason,
        poolAction: classified.poolAction,
        outcome: willRotate ? "rotated" : "stopped",
        ...(classified.failoverCredential && !willRotate
          ? { note: "no se rotó: ya se ejecutaron pasos en este intento (regla de Step 0)" }
          : {}),
      });

      if (willRotate) continue;

      return {
        ok: false,
        terminal: {
          state: "FAILED",
          stopReason: "provider_error",
          error: sanitizeError(buildErrorMessage(error), ctx.workspaceRoot),
        },
      };
    }
  }
}

async function ensurePlan(ctx: LoopContext): Promise<PlanOutcome> {
  let plan = currentPlan(ctx);
  if (plan && plan.items.length > 0) return { ok: true, plan };

  let lastErrors: string[] = [];
  for (let attempt = 1; attempt <= ctx.limits.maxInvalidPlanAttempts; attempt += 1) {
    if (ctx.signal.aborted) return { ok: false, terminal: abortDecision(ctx) };
    const budget = checkBudget(ctx);
    if (budget) return { ok: false, terminal: budget };

    const beforeVersion = currentPlan(ctx)?.version ?? 0;
    const briefing = buildBriefing(ctx, "PLANNING", null, lastErrors);
    const result = await callModel(ctx, {
      phase: "PLANNING",
      system: buildPlanningSystemPrompt(briefing),
      prompt: ctx.task,
      tools: { update_plan: ctx.planTools.update_plan },
      toolChoice: { type: "tool", toolName: "update_plan" },
      stopWhen: [stepCountIs(1)],
    });
    if (!result.ok) return result;

    plan = currentPlan(ctx);
    if (plan && plan.version > beforeVersion && plan.items.length > 0) {
      ctx.lastPlanVersion = plan.version;
      ctx.transcript.push(`🧭 Plan v${plan.version} (${plan.items.length} items, source=${plan.source})`);
      return { ok: true, plan };
    }

    lastErrors = ["El plan no se guardó. Llamá `update_plan` con un plan válido y no vacío."];
    warn(ctx, `plan_attempt_${attempt}_failed`);
    ctx.transcript.push(`⚠️ Intento de plan ${attempt}/${ctx.limits.maxInvalidPlanAttempts} sin plan válido.`);
  }

  const fallback = buildFallbackPlan(
    ctx.task,
    ctx.limits,
    "El modelo no produjo un plan válido; revisar el resultado manualmente.",
  );
  try {
    plan = savePlanVersion({
      taskId: ctx.taskId,
      runId: ctx.runId,
      plan: fallback,
      source: "fallback",
      maxVersions: ctx.limits.maxPlanVersions,
    });
  } catch (error) {
    return {
      ok: false,
      terminal: { state: "FAILED", stopReason: "error", error: sanitizeError(error, ctx.workspaceRoot) },
    };
  }

  warn(ctx, "plan_fallback");
  ctx.transcript.push(`🧭 Plan fallback v${plan.version} (1 item)`);
  ctx.lastPlanVersion = plan.version;
  return { ok: true, plan };
}

async function carryOverCompletedItems(
  ctx: LoopContext,
  oldPlan: PersistedPlan | null,
  newPlan: PersistedPlan,
): Promise<void> {
  if (!oldPlan || oldPlan.id === newPlan.id) return;

  let preserved = 0;
  let stale = 0;
  for (const oldItem of oldPlan.items) {
    if (oldItem.status !== "DONE" && oldItem.status !== "SKIPPED") continue;
    const newItem = newPlan.items.find((candidate) => candidate.logicalId === oldItem.logicalId);
    if (!newItem || newItem.status !== "PENDING") continue;

    if (oldItem.status === "SKIPPED") {
      const reason = oldItem.lastError ?? "Conservado de la versión anterior del plan.";
      let result = await updatePlanItem({
        runId: ctx.runId,
        itemId: newItem.logicalId,
        status: "SKIPPED",
        reason,
        evidence: oldItem.evidence,
        limits: ctx.limits,
        workspaceRoot: ctx.workspaceRoot,
        allowedScripts: ctx.allowedScripts,
        verifier: ctx.verifier,
        signal: ctx.signal,
      });
      if (!result.ok) {
        // La evidencia vieja pudo quedar obsoleta; un SKIPPED no la
        // necesita para seguir siendo válido.
        result = await updatePlanItem({
          runId: ctx.runId,
          itemId: newItem.logicalId,
          status: "SKIPPED",
          reason,
          limits: ctx.limits,
          workspaceRoot: ctx.workspaceRoot,
          allowedScripts: ctx.allowedScripts,
          verifier: ctx.verifier,
          signal: ctx.signal,
        });
      }
      if (result.ok) preserved += 1;
      else stale += 1;
      continue;
    }

    const started = await updatePlanItem({
      runId: ctx.runId,
      itemId: newItem.logicalId,
      status: "IN_PROGRESS",
      limits: ctx.limits,
      workspaceRoot: ctx.workspaceRoot,
      allowedScripts: ctx.allowedScripts,
      verifier: ctx.verifier,
      signal: ctx.signal,
    });
    if (!started.ok) {
      stale += 1;
      continue;
    }

    const done = await updatePlanItem({
      runId: ctx.runId,
      itemId: newItem.logicalId,
      status: "DONE",
      evidence: oldItem.evidence,
      limits: ctx.limits,
      workspaceRoot: ctx.workspaceRoot,
      allowedScripts: ctx.allowedScripts,
      verifier: ctx.verifier,
      signal: ctx.signal,
    });
    if (done.ok) {
      preserved += 1;
      continue;
    }

    stale += 1;
    try {
      resetPlanItemToPending(newItem.id, "La evidencia de la versión anterior ya no es válida; hay que rehacerlo.");
    } catch {
      warn(ctx, "No se pudo resetear un item obsoleto tras replanificar.");
    }
  }

  if (preserved > 0) warn(ctx, `replan_preserved_${preserved}`);
  if (stale > 0) warn(ctx, `replan_stale_${stale}`);
}

async function executePhase(ctx: LoopContext): Promise<ModelCallResult> {
  const plan = currentPlan(ctx);
  if (!plan) {
    return {
      ok: false,
      terminal: { state: "FAILED", stopReason: "error", error: "No hay un plan activo para la corrida." },
    };
  }

  const remainingGlobal = ctx.limits.maxSteps - ctx.steps;
  if (remainingGlobal <= 0) {
    return {
      ok: false,
      terminal: {
        state: "BUDGET_EXHAUSTED",
        stopReason: "budget_exhausted",
        error: `Se agotaron los ${ctx.limits.maxSteps} pasos de la corrida.`,
      },
    };
  }

  const remainingPhase = Math.min(ctx.limits.maxStepsPerPhase, remainingGlobal);
  const planBefore = plan;
  const briefing = buildBriefing(ctx, "EXECUTING", plan);
  const result = await callModel(ctx, {
    phase: "EXECUTING",
    system: buildExecutingSystemPrompt(ctx, briefing),
    prompt: ctx.task,
    tools: ctx.allTools,
    stopWhen: [
      stepCountIs(remainingPhase),
      () => checkBudget(ctx) !== null,
      () => ctx.stallReason !== null || ctx.replans > ctx.limits.maxReplans,
      () => ctx.signal.aborted,
    ],
  });
  if (!result.ok) return result;

  const planAfter = currentPlan(ctx);
  if (planAfter && planAfter.id !== planBefore.id) {
    try {
      await carryOverCompletedItems(ctx, planBefore, planAfter);
    } catch {
      warn(ctx, "No se pudieron conservar items completados tras replanificar.");
    }
  }

  if (ctx.stallReason) {
    return {
      ok: false,
      terminal: {
        state: "STALLED",
        stopReason: "stalled",
        error:
          ctx.stallReason === "repeated_action"
            ? "La corrida se estancó repitiendo la misma acción."
            : ctx.stallReason === "replans_exhausted"
              ? "Se agotaron las replanificaciones."
              : "La corrida se estancó sin progreso.",
      },
    };
  }

  return { ok: true };
}

async function runReplanning(ctx: LoopContext, oldPlan: PersistedPlan, reason: string): Promise<ModelCallResult> {
  if (ctx.replans >= ctx.limits.maxReplans) {
    return {
      ok: false,
      terminal: { state: "STALLED", stopReason: "stalled", error: "Se agotaron las replanificaciones." },
    };
  }
  const budget = checkBudget(ctx);
  if (budget) return { ok: false, terminal: budget };

  ctx.replans += 1;
  try {
    transitionRun(ctx.runId, "REPLANNING");
  } catch (error) {
    return { ok: false, terminal: { state: "FAILED", stopReason: "error", error: sanitizeError(error, ctx.workspaceRoot) } };
  }

  const briefing = buildBriefing(ctx, "REPLANNING", oldPlan, [reason]);
  const result = await callModel(ctx, {
    phase: "REPLANNING",
    system: buildReplanningSystemPrompt(briefing),
    prompt: ctx.task,
    tools: { update_plan: ctx.planTools.update_plan },
    toolChoice: { type: "tool", toolName: "update_plan" },
    stopWhen: [stepCountIs(1)],
  });
  if (!result.ok) return result;

  const newPlan = currentPlan(ctx);
  if (!newPlan) {
    return {
      ok: false,
      terminal: { state: "FAILED", stopReason: "error", error: "La versión nueva del plan no está disponible." },
    };
  }

  if (newPlan.version <= oldPlan.version) {
    warn(ctx, "replan_no_new_plan");
    ctx.transcript.push("⚠️ La replanificación no produjo un plan nuevo.");
    try {
      transitionRun(ctx.runId, "EXECUTING");
    } catch (error) {
      return { ok: false, terminal: { state: "FAILED", stopReason: "error", error: sanitizeError(error, ctx.workspaceRoot) } };
    }
    return { ok: true };
  }

  try {
    await carryOverCompletedItems(ctx, oldPlan, newPlan);
  } catch {
    warn(ctx, "No se pudieron conservar items completados tras replanificar.");
  }

  try {
    transitionRun(ctx.runId, "EXECUTING");
  } catch (error) {
    return { ok: false, terminal: { state: "FAILED", stopReason: "error", error: sanitizeError(error, ctx.workspaceRoot) } };
  }

  ctx.transcript.push(`🔁 Replanificación ${ctx.replans}/${ctx.limits.maxReplans}: plan v${newPlan.version}`);
  return { ok: true };
}

async function verifyGlobal(ctx: LoopContext, plan: PersistedPlan): Promise<{ ok: true } | { ok: false; reason: string }> {
  const failures: string[] = [];

  for (const criterion of plan.acceptance) {
    if (ctx.signal.aborted) return { ok: false, reason: "Cancelada durante la verificación." };

    let result: Awaited<ReturnType<AcceptanceVerifier>>;
    try {
      result = await ctx.verifier({
        criterion,
        workspaceRoot: ctx.workspaceRoot,
        allowedScripts: ctx.allowedScripts,
        signal: ctx.signal,
      });
    } catch {
      result = { status: "unavailable", evidence: { reason: "verifier_error" }, detail: "El verificador falló." };
    }

    ctx.lastVerification = { criterion: describeCriterion(criterion), status: result.status };
    if (criterion.kind === "typecheck") ctx.lastTypeCheckOk = result.status === "passed";
    recordVerificationSafe(ctx, {
      criterion,
      status: result.status === "passed" ? "passed" : result.status === "failed" ? "failed" : "unverified",
      evidence: result.evidence ?? {},
    });

    if (result.status === "passed") continue;
    if (!isMachineCheckable(criterion)) {
      // `manual` es aceptable como justificación, pero queda marcado como
      // no verificado por máquina en las advertencias y en el ledger.
      warn(ctx, "manual_acceptance_unverified");
      continue;
    }
    failures.push(`${describeCriterion(criterion)}: ${result.status}`);
  }

  if (failures.length > 0) {
    return { ok: false, reason: `La acceptance global no pasó (${failures.join(", ")}).` };
  }
  return { ok: true };
}

async function collectProposals(ctx: LoopContext): Promise<AgentFileProposal[]> {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: ctx.workspaceRoot,
      maxBuffer: 8 * 1024 * 1024,
    });
    return await buildProposals(stdout, ctx.workspaceRoot, ctx.lastTypeCheckOk);
  } catch {
    warn(ctx, "No se pudo calcular el diff final del workspace.");
    return [];
  }
}

async function finalize(
  ctx: LoopContext,
  state: AutonomyTerminalState,
  stopReason: AutonomyStopReason,
  error?: string,
): Promise<AutonomousLoopResult> {
  const current = getRun(ctx.runId);
  let finalState = state;

  if (current && isTerminalAutonomyState(current.state)) {
    finalState = current.state;
  } else if (current) {
    try {
      transitionRun(ctx.runId, state, { stopReason, error: error ?? null, budget: snapshotBudget(ctx) });
    } catch {
      const after = getRun(ctx.runId);
      if (after && isTerminalAutonomyState(after.state)) finalState = after.state;
      else warn(ctx, "No se pudo cerrar la corrida autónoma.");
    }
  }

  // Un FAILED/CANCELLED no propone cambios parciales: el usuario no debe
  // revisar un diff a medias de una corrida que no llegó a un estado
  // estable. BLOCKED/STALLED/BUDGET_EXHAUSTED sí pueden tener trabajo útil.
  let proposals: AgentFileProposal[] = [];
  if (finalState !== "FAILED" && finalState !== "CANCELLED") {
    proposals = await collectProposals(ctx);
  }

  if (finalState === "DONE") {
    const plan = currentPlan(ctx);
    if (plan) {
      try {
        markPlanStatus(plan.id, "COMPLETED");
      } catch {
        warn(ctx, "No se pudo marcar el plan como COMPLETED.");
      }
    }
  }

  ctx.transcript.push(`⛔ ${finalState}${error ? `: ${error}` : ""}`);
  const outcome = resolveTaskOutcome(finalState, proposals.length > 0, stopReason);

  return {
    runId: ctx.runId,
    state: finalState,
    stopReason: outcome.stopReason,
    outcome,
    steps: ctx.steps,
    transcript: ctx.transcript,
    proposals,
    touchedFiles: Array.from(ctx.touchedFiles),
    error,
    budget: snapshotBudget(ctx),
    contextUsage: ctx.contextUsage,
  };
}

async function finalizeUnexpected(ctx: LoopContext, error: unknown): Promise<AutonomousLoopResult> {
  if (ctx.signal.aborted) {
    const decision = abortDecision(ctx);
    return finalize(ctx, decision.state, decision.stopReason, decision.error);
  }
  return finalize(ctx, "FAILED", "error", sanitizeError(error, ctx.workspaceRoot));
}

async function createLoopContext(options: RunAutonomousLoopOptions): Promise<LoopContext> {
  const limits = normalizeAutonomyLimits(options.limits);
  const modelId = options.modelId ?? resolveCodingModelId().modelId;
  const providerName = resolveProviderName(modelId);
  const pool = getProviderPool(providerName);
  const now = options.now ?? (() => Date.now());
  const startedAt = now();

  const run = createRun({
    taskId: options.taskId,
    workspaceId: options.workspaceId ?? null,
    baseCommit: options.baseCommit ?? null,
    budget: { steps: 0, wallTimeMs: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: null },
  });

  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  if (options.abortSignal?.aborted) controller.abort();
  else options.abortSignal?.addEventListener("abort", onExternalAbort, { once: true });

  const timeoutTimer = setTimeout(() => {
    ctx.timedOut = true;
    controller.abort();
  }, limits.maxWallTimeMs);
  timeoutTimer.unref?.();

  const allowedScripts = await detectAllowedScripts(options.workspaceRoot);
  const verifier = createAcceptanceVerifier({ allowedScripts, exec: options.verifierExec });
  const planTools = createAutonomyPlanTools({
    taskId: options.taskId,
    runId: run.id,
    limits,
    workspaceRoot: options.workspaceRoot,
    allowedScripts,
    verifier,
  });

  let contextEngine: ContextEngine | undefined;
  let repoMapOptions: CreateAgentToolsRepoMapOptions | undefined;
  if (options.contextEngine?.enabled === true) {
    try {
      const { createRepoMapService } = await import("../repo-map-service");
      const tracker = createRepoMapTracker();
      const service = createRepoMapService({ workspaceRoot: options.workspaceRoot, tracker });
      contextEngine = createContextEngine({
        task: options.task,
        workspaceRoot: options.workspaceRoot,
        modelId,
        tracker,
        service,
        maxCandidates: options.contextEngine.maxCandidates,
        briefingMaxChars: options.contextEngine.briefingMaxChars,
        refreshLimit: options.contextEngine.refreshLimit,
        startTimeoutMs: options.contextEngine.startTimeoutMs,
        refreshTimeoutMs: options.contextEngine.refreshTimeoutMs,
      });
      repoMapOptions = { tracker, service };
    } catch {
      contextEngine = undefined;
      repoMapOptions = undefined;
    }
  }

  const transcript: string[] = [];
  const touchedFiles = new Set<string>();
  const onEvent = (event: AgentToolEvent) => {
    touchedFiles.add(event.relPath);
    contextEngine?.noteTouched([event.relPath]);
    transcript.push(
      event.type === "file_written"
        ? `✏️ Escribió ${event.relPath}`
        : event.type === "file_deleted"
          ? `🗑️ Borró ${event.relPath}`
          : `✏️ Editó ${event.relPath}`,
    );
  };

  const codingAgentCapabilities =
    options.webSearchCompatibleOverride !== undefined
      ? { webSearchCompatible: options.webSearchCompatibleOverride }
      : getCouncilModel(modelId)?.codingAgent;
  const searchProviderForTools: SearchProvider | null | undefined =
    options.searchProvider ?? (isWebSearchCompatible(codingAgentCapabilities) ? undefined : null);

  const ctx: LoopContext = {
    taskId: options.taskId,
    task: options.task,
    runId: run.id,
    workspaceRoot: options.workspaceRoot,
    repoRoot: options.repoRoot,
    modelId,
    providerName,
    limits,
    allowedScripts,
    verifier,
    planTools,
    allTools: {} as AutonomyToolSet,
    searchEnabled: false,
    generateTextImpl: options.generateTextImpl ?? generateText,
    pool,
    signal: controller.signal,
    externalSignal: options.abortSignal,
    onExternalAbort,
    timeoutTimer,
    timedOut: false,
    now,
    startedAt,
    steps: 0,
    inputTokens: 0,
    outputTokens: 0,
    replans: 0,
    lastPlanVersion: 0,
    lastTypeCheckOk: null,
    lastVerification: null,
    lastEventSeq: null,
    noProgressSteps: 0,
    lastActionFingerprint: null,
    identicalActionCount: 0,
    stallReason: null,
    warnings: [],
    warningSet: new Set(),
    transcript,
    touchedFiles,
    contextUsage: [],
    contextEngine,
  };

  try {
    const legacyTools = createAgentTools(
      options.workspaceRoot,
      onEvent,
      allowedScripts,
      searchProviderForTools,
      repoMapOptions,
    );
    ctx.searchEnabled = "web_search" in legacyTools;
    ctx.allTools = { ...legacyTools, ...planTools };
  } catch (error) {
    ctx.setupError = sanitizeError(error, options.workspaceRoot);
  }

  if (limits.maxCostUsd !== null) {
    // No hay pricing por modelo en el roster actual: el límite de costo no
    // es enforceable y NO se inventa un costo. Se deja constancia.
    warn(ctx, "cost_limit_not_enforceable");
  }

  return ctx;
}

function cleanup(ctx: LoopContext): void {
  clearTimeout(ctx.timeoutTimer);
  ctx.externalSignal?.removeEventListener("abort", ctx.onExternalAbort);
}

async function runWithContext(ctx: LoopContext): Promise<AutonomousLoopResult> {
  if (ctx.setupError) return finalize(ctx, "FAILED", "error", ctx.setupError);
  if (ctx.signal.aborted) {
    const decision = abortDecision(ctx);
    return finalize(ctx, decision.state, decision.stopReason, decision.error);
  }

  try {
    await fsPromises.access(ctx.workspaceRoot);
  } catch {
    return finalize(ctx, "FAILED", "error", "El workspace no existe o no es accesible (workspace_missing).");
  }

  if (ctx.contextEngine) {
    try {
      await ctx.contextEngine.start(ctx.signal);
    } catch {
      // El motor es opcional: si no arranca, el dispatcher sigue con su
      // propio briefing phase-scoped.
    }
  }

  const planResult = await ensurePlan(ctx);
  if (!planResult.ok) return finalize(ctx, planResult.terminal.state, planResult.terminal.stopReason, planResult.terminal.error);

  try {
    transitionRun(ctx.runId, "EXECUTING");
  } catch (error) {
    return finalizeUnexpected(ctx, error);
  }

  while (true) {
    if (ctx.signal.aborted) {
      const decision = abortDecision(ctx);
      return finalize(ctx, decision.state, decision.stopReason, decision.error);
    }
    if (ctx.stallReason) {
      return finalize(
        ctx,
        "STALLED",
        "stalled",
        ctx.stallReason === "repeated_action"
          ? "La corrida se estancó repitiendo la misma acción."
          : ctx.stallReason === "replans_exhausted"
            ? "Se agotaron las replanificaciones."
            : "La corrida se estancó sin progreso.",
      );
    }

    const budget = checkBudget(ctx);
    if (budget) return finalize(ctx, budget.state, budget.stopReason, budget.error);

    const plan = currentPlan(ctx);
    if (!plan) return finalize(ctx, "FAILED", "error", "No hay un plan activo para la corrida.");

    const summary = summarizePlan(plan);
    if (summary.allDone) {
      try {
        transitionRun(ctx.runId, "VERIFYING");
      } catch (error) {
        return finalizeUnexpected(ctx, error);
      }

      const verification = await verifyGlobal(ctx, plan);
      if (verification.ok) {
        return finalize(ctx, "DONE", "completed");
      }

      if (ctx.signal.aborted) {
        const decision = abortDecision(ctx);
        return finalize(ctx, decision.state, decision.stopReason, decision.error);
      }
      if (ctx.replans >= ctx.limits.maxReplans) {
        return finalize(ctx, "STALLED", "stalled", verification.reason);
      }

      const replan = await runReplanning(ctx, plan, verification.reason);
      if (!replan.ok) return finalize(ctx, replan.terminal.state, replan.terminal.stopReason, replan.terminal.error);
      continue;
    }

    if (summary.allTerminal) {
      if (summary.failed > 0) {
        return finalize(ctx, "FAILED", "error", "Todos los items del plan fallaron.");
      }
      return finalize(ctx, "BLOCKED", "blocked", "El plan quedó bloqueado sin items pendientes.");
    }

    const phase = await executePhase(ctx);
    if (!phase.ok) return finalize(ctx, phase.terminal.state, phase.terminal.stopReason, phase.terminal.error);
  }
}

/**
 * Punto de entrada del loop autónomo opt-in. Crea una corrida nueva en
 * `agent_runs` (9E se encargará de reanudar), ejecuta el ciclo y siempre
 * deja la corrida en un estado terminal antes de volver — salvo que ni
 * siquiera se haya podido crear la corrida (por ejemplo, porque ya hay una
 * activa para la misma task), en cuyo caso el error se propaga.
 */
export async function runAutonomousLoop(options: RunAutonomousLoopOptions): Promise<AutonomousLoopResult> {
  let ctx: LoopContext | null = null;
  try {
    ctx = await createLoopContext(options);
    return await runWithContext(ctx);
  } catch (error) {
    if (ctx) return finalizeUnexpected(ctx, error);
    throw error;
  } finally {
    if (ctx) cleanup(ctx);
  }
}
