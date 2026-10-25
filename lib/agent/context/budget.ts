/**
 * Fase 8C — Presupuesto de contexto.
 *
 * Separa explícitamente:
 * - LÍMITE DURO: ventana del modelo (solo si la conocemos) menos la reserva
 *   de salida y un margen de seguridad. Superarlo es un error operativo.
 * - PREFERENCIA: umbral blando (60% del duro) para avisar antes de llegar
 *   al límite. Es ranking/política, no una verdad del proveedor.
 * - Sin ventana conocida: NO se inventa un límite duro. Se usa una
 *   preferencia conservadora (32k) y el estado queda `unknown_limit`.
 *
 * El consumo real, cuando existe, es `providerUsage.inputTokens`. La
 * estimación local solo se usa como fallback y siempre se reporta con
 * `usedSource: "estimate"`.
 *
 * No recorta instrucciones ni el pedido del usuario: este módulo solo
 * mide y recomienda. Quien decide (8D/8E) debe hacerlo explícitamente.
 */
import { estimateTokensFromChars, type ContextEstimate } from "./estimate";
import type { ProviderUsage } from "./provider-usage";

export const CONTEXT_BUDGET_VERSION = 1;
export const DEFAULT_OUTPUT_RESERVE_TOKENS = 8_192;
export const DEFAULT_SAFETY_MARGIN_TOKENS = 1_024;
export const DEFAULT_SOFT_RATIO = 0.6;
export const UNKNOWN_WINDOW_SOFT_INPUT_TOKENS = 32_000;

type WindowRule = { id: string; tokens: number; note: string };

/**
 * Ventanas conocidas por documentación del roster (`lib/models.ts`). Es una
 * tabla conservadora: si un modelo no está, queda `unknown` en vez de
 * asumir un número. `matchedRule` viaja en el reporte para que el número
 * sea auditable.
 */
const WINDOW_RULES: readonly WindowRule[] = [
  { id: "gemini-3.1-pro", tokens: 2_000_000, note: "descripción del roster: 2M" },
  { id: "gemini-3.7-flash", tokens: 1_000_000, note: "descripción del roster: 1M" },
  { id: "gemini-3.6-flash", tokens: 1_000_000, note: "línea Gemini 3 Flash: 1M" },
  { id: "gemini-3.5-flash", tokens: 1_000_000, note: "línea Gemini 3 Flash: 1M" },
  { id: "gemini-3.5-flash-lite", tokens: 1_000_000, note: "línea Gemini 3 Flash: 1M" },
  { id: "gemini-2.5", tokens: 1_000_000, note: "línea Gemini 2.5: 1M" },
  { id: "openai/gpt-oss-20b", tokens: 131_072, note: "GPT-OSS 20B: 128k" },
  { id: "z-ai/glm-5.2", tokens: 1_000_000, note: "descripción del roster: 1M" },
];

export type ContextWindowResolution = {
  tokens: number | null;
  source: "registry" | "override" | "unknown";
  matchedRule: string | null;
  note: string | null;
};

export function resolveContextWindow(modelId: string, override?: number | null): ContextWindowResolution {
  if (override !== undefined) {
    if (override === null) return { tokens: null, source: "unknown", matchedRule: null, note: "override:null" };
    if (Number.isFinite(override) && override > 0) {
      return { tokens: Math.floor(override), source: "override", matchedRule: null, note: "override explícito" };
    }
  }
  const lower = (modelId ?? "").toLowerCase();
  for (const rule of WINDOW_RULES) {
    if (lower.includes(rule.id)) return { tokens: rule.tokens, source: "registry", matchedRule: rule.id, note: rule.note };
  }
  return { tokens: null, source: "unknown", matchedRule: null, note: null };
}

export type ContextBudgetStatus = "ok" | "near_limit" | "over_limit" | "unknown_limit";
export type ContextBudgetRecommendation = "continue" | "compact_history_or_reduce_context" | "reduce_scope_or_stop" | "no_hard_limit_known";

export type ContextBudgetReport = {
  version: typeof CONTEXT_BUDGET_VERSION;
  modelId: string;
  windowTokens: number | null;
  windowSource: ContextWindowResolution["source"];
  matchedRule: string | null;
  outputReserveTokens: number;
  safetyMarginTokens: number;
  hardInputTokens: number | null;
  softInputTokens: number;
  usedInputTokens: number;
  usedSource: "provider" | "estimate";
  /** `used / hard`, o `null` si no hay límite duro conocido. */
  hardUtilization: number | null;
  /** `used / soft`, siempre disponible. */
  softUtilization: number;
  remainingHardTokens: number | null;
  headroomForOutputTokens: number | null;
  status: ContextBudgetStatus;
  recommendation: ContextBudgetRecommendation;
  estimateMethod: ContextEstimate["method"];
  providerUsageReported: boolean;
};

export type ComputeContextBudgetInput = {
  modelId: string;
  estimate: ContextEstimate;
  providerUsage?: ProviderUsage | null;
  windowTokens?: number | null;
  maxOutputTokens?: number;
  safetyMarginTokens?: number;
  softRatio?: number;
};

export function computeContextBudget(input: ComputeContextBudgetInput): ContextBudgetReport {
  const windowResolution = resolveContextWindow(input.modelId, input.windowTokens);
  const windowTokens = windowResolution.tokens;
  const requestedOutput = input.maxOutputTokens ?? DEFAULT_OUTPUT_RESERVE_TOKENS;
  const outputReserveTokens = windowTokens === null ? Math.max(1, Math.floor(requestedOutput)) : Math.max(1, Math.min(Math.floor(requestedOutput), Math.floor(windowTokens * 0.2)));
  const safetyMarginTokens = input.safetyMarginTokens ?? DEFAULT_SAFETY_MARGIN_TOKENS;
  const softRatio = Math.min(0.95, Math.max(0.1, input.softRatio ?? DEFAULT_SOFT_RATIO));

  const hardInputTokens = windowTokens === null ? null : Math.max(0, windowTokens - outputReserveTokens - Math.max(0, safetyMarginTokens));
  const softInputTokens = hardInputTokens === null ? UNKNOWN_WINDOW_SOFT_INPUT_TOKENS : Math.max(1, Math.floor(hardInputTokens * softRatio));

  const providerInput = input.providerUsage?.inputTokens ?? null;
  const usedSource: "provider" | "estimate" = providerInput !== null ? "provider" : "estimate";
  const usedInputTokens = providerInput !== null ? providerInput : input.estimate.estimatedTokens.total;

  const hardUtilization = hardInputTokens !== null && hardInputTokens > 0 ? usedInputTokens / hardInputTokens : null;
  const softUtilization = softInputTokens > 0 ? usedInputTokens / softInputTokens : 0;

  let status: ContextBudgetStatus;
  let recommendation: ContextBudgetRecommendation;
  if (hardInputTokens === null) {
    if (usedInputTokens > softInputTokens) {
      status = "near_limit";
      recommendation = "compact_history_or_reduce_context";
    } else {
      status = "unknown_limit";
      recommendation = "no_hard_limit_known";
    }
  } else if (usedInputTokens > hardInputTokens) {
    status = "over_limit";
    recommendation = "reduce_scope_or_stop";
  } else if (usedInputTokens > softInputTokens) {
    status = "near_limit";
    recommendation = "compact_history_or_reduce_context";
  } else {
    status = "ok";
    recommendation = "continue";
  }

  return {
    version: CONTEXT_BUDGET_VERSION,
    modelId: input.modelId,
    windowTokens,
    windowSource: windowResolution.source,
    matchedRule: windowResolution.matchedRule,
    outputReserveTokens,
    safetyMarginTokens: Math.max(0, safetyMarginTokens),
    hardInputTokens,
    softInputTokens,
    usedInputTokens,
    usedSource,
    hardUtilization,
    softUtilization,
    remainingHardTokens: hardInputTokens === null ? null : Math.max(0, hardInputTokens - usedInputTokens),
    headroomForOutputTokens: windowTokens === null ? null : Math.max(0, windowTokens - usedInputTokens),
    status,
    recommendation,
    estimateMethod: input.estimate.method,
    providerUsageReported: input.providerUsage !== null && input.providerUsage !== undefined,
  };
}

/** Caracteres que el briefing puede usar sin comerse la ventana blanda.
 * Se calcula sobre la PREFERENCIA (no el límite duro) y se acota para que
 * un modelo de 2M no genere un briefing gigante. */
export function briefingBudgetChars(report: ContextBudgetReport, fixedTokens: number, maxChars = 8_000): number {
  const availableTokens = Math.max(0, report.softInputTokens - fixedTokens - estimateTokensFromChars(maxChars));
  return Math.max(400, Math.min(maxChars, availableTokens * 4));
}
