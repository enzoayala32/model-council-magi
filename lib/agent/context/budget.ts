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

type WindowRule = {
  id: string;
  tokens: number;
  /** De dónde salió el número. Sin fuente no se agrega la fila. */
  source: string;
  /** Fecha del relevo (ISO). */
  fetchedAt: string;
  /** Por qué este número y no otro, cuando hubo que elegir. */
  note: string;
};

/**
 * Etapa 2.2 (sub-bloque 1) — ventanas conocidas, CON FUENTE Y FECHA por fila.
 *
 * ANTES: 7 filas sacadas de la descripción en prosa del roster, ninguna de
 * las cuales es un modelo que el Coding Agent use de verdad. Los 5 modelos que
 * el sondeo en vivo (`docs/bench/modelos-agente.json`) dice que SIRVEN se
 * llaman directos a NVIDIA NIM, y el endpoint de NVIDIA **no publica** la
 * ventana de contexto (verificado el 2026-11-10: `GET /v1/models` devuelve
 * solo `{id, object, created, owned_by}`; y el `max_tokens` que acepta el
 * gateway es 1048576 para todos los modelos, que es el tope del GATEWAY, no la
 * ventana de cada modelo — se verificó pidiendo exactamente ese valor y dio
 * 200, así que no dice nada del contexto de entrada).
 *
 * DÓNDE SALEN ESTOS NÚMEROS: del catálogo público de OpenRouter
 * (`https://openrouter.ai/api/v1/models`, sin credencial), campo
 * `context_length`. Es una fuente real y fechada, NO una estimación.
 *
 * REGLA CONSERVADORA, y por qué existe: para algunos modelos OpenRouter
 * publica DOS ventanas distintas según la ruta (la gratis y la paga). Ejemplo
 * real: `nvidia/nemotron-3.5-lightning` = 262.144 tokens, pero
 * `nvidia/nemotron-3.5-lightning:free` = 1.000.000. Nuestro agente llama a NIM
 * directo, que no es ninguna de las dos rutas, así que no hay forma de saber
 * cuál aplica. Ante la duda se toma el **menor**: equivocarse por bajo
 * compacta antes de tiempo (se pierde algo de contexto viejo, molesto pero
 * recuperable volviendo a leer el archivo); equivocarse por alto deja que la
 * petición revoque y la task muera sin recuperación (`context_too_large` está
 * clasificado como PERMANENT en `provider-resilience/classify.ts`).
 *
 * `source` y `fetchedAt` viajan en el reporte para que el número sea auditable,
 * y hay un test que exige que TODA fila los traiga: una fila sin fuente es un
 * número inventado, que es exactamente lo que este archivo se niega a tener.
 */
const OPENROUTER_CATALOG_URL = "https://openrouter.ai/api/v1/models";

/** Fecha del relevo de estas ventanas. Si pasa mucho tiempo, re-verificar. */
const WINDOW_RULES_FETCHED_AT = "2026-11-10";

const WINDOW_RULES: readonly WindowRule[] = [
  // Gemini (nuestro propio roster; el valor se corrobora con el catálogo público).
  { id: "gemini-3.1-pro", tokens: 2_000_000, source: OPENROUTER_CATALOG_URL, fetchedAt: WINDOW_RULES_FETCHED_AT, note: "roster + catálogo" },
  { id: "gemini-3.7-flash", tokens: 1_000_000, source: OPENROUTER_CATALOG_URL, fetchedAt: WINDOW_RULES_FETCHED_AT, note: "roster + catálogo" },
  { id: "gemini-3.6-flash", tokens: 1_000_000, source: OPENROUTER_CATALOG_URL, fetchedAt: WINDOW_RULES_FETCHED_AT, note: "roster + catálogo" },
  { id: "gemini-3.5-flash", tokens: 1_000_000, source: OPENROUTER_CATALOG_URL, fetchedAt: WINDOW_RULES_FETCHED_AT, note: "roster + catálogo" },
  { id: "gemini-3.5-flash-lite", tokens: 1_000_000, source: OPENROUTER_CATALOG_URL, fetchedAt: WINDOW_RULES_FETCHED_AT, note: "roster + catálogo" },
  { id: "gemini-2.5", tokens: 1_000_000, source: OPENROUTER_CATALOG_URL, fetchedAt: WINDOW_RULES_FETCHED_AT, note: "roster + catálogo" },
  { id: "openai/gpt-oss-20b", tokens: 131_072, source: OPENROUTER_CATALOG_URL, fetchedAt: WINDOW_RULES_FETCHED_AT, note: "catálogo: 131.072" },
  { id: "z-ai/glm-5.2", tokens: 1_000_000, source: OPENROUTER_CATALOG_URL, fetchedAt: WINDOW_RULES_FETCHED_AT, note: "catálogo" },

  // --- Roster real del Coding Agent (los 5 que SIRVEN en el sondeo en vivo).
  // Todos se llaman directos a NVIDIA NIM, que NO publica ventana: el número
  // sale del catálogo de OpenRouter para el mismo modelo.
  { id: "stepfun-ai/step-5-preview", tokens: 1_000_000, source: OPENROUTER_CATALOG_URL, fetchedAt: WINDOW_RULES_FETCHED_AT, note: "OpenRouter `stepfun/step-5-preview`: 1.000.000" },
  { id: "minimaxai/minimax-m3.1-flash", tokens: 1_048_576, source: OPENROUTER_CATALOG_URL, fetchedAt: WINDOW_RULES_FETCHED_AT, note: "OpenRouter `minimax/minimax-m3.1-flash`: 1.048.576" },
  { id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning", tokens: 256_000, source: OPENROUTER_CATALOG_URL, fetchedAt: WINDOW_RULES_FETCHED_AT, note: "OpenRouter `...:reasoning:free`: 256.000 (el hermano `-30b-a3b` pago da 262.144; se toma el menor)" },
  { id: "nvidia/nemotron-3.5-lightning-30b-a3b", tokens: 262_144, source: OPENROUTER_CATALOG_URL, fetchedAt: WINDOW_RULES_FETCHED_AT, note: "OpenRouter paga 262.144 vs `:free` 1.000.000: se toma el menor" },

  // --- Candidatos relevados por el mismo sondeo.
  { id: "deepseek-ai/deepseek-v4.1-flash", tokens: 1_048_576, source: OPENROUTER_CATALOG_URL, fetchedAt: WINDOW_RULES_FETCHED_AT, note: "OpenRouter `deepseek/deepseek-v4.1-flash`: 1.048.576" },
  { id: "nvidia/nemotron-3-ultra-550b-a55b", tokens: 262_144, source: OPENROUTER_CATALOG_URL, fetchedAt: WINDOW_RULES_FETCHED_AT, note: "OpenRouter paga 262.144 vs `:free` 1.000.000: se toma el menor" },
  { id: "nvidia/nemotron-3-super-120b-a12b", tokens: 1_048_576, source: OPENROUTER_CATALOG_URL, fetchedAt: WINDOW_RULES_FETCHED_AT, note: "OpenRouter: 1.048.576" },
  { id: "z-ai/glm-5.3-flash", tokens: 1_048_576, source: OPENROUTER_CATALOG_URL, fetchedAt: WINDOW_RULES_FETCHED_AT, note: "OpenRouter: 1.048.576" },
  { id: "moonshotai/kimi-k2.6", tokens: 262_144, source: OPENROUTER_CATALOG_URL, fetchedAt: WINDOW_RULES_FETCHED_AT, note: "OpenRouter: 262.144" },
];

export type ContextWindowResolution = {
  tokens: number | null;
  source: "registry" | "override" | "unknown";
  /** URL de donde salió el número, para poder re-verificarlo. */
  sourceUrl: string | null;
  /** Fecha del relevo (ISO), para saber si está viejo. */
  fetchedAt: string | null;
  matchedRule: string | null;
  note: string | null;
};

export function resolveContextWindow(modelId: string, override?: number | null): ContextWindowResolution {
  if (override !== undefined) {
    if (override === null) return { tokens: null, source: "unknown", sourceUrl: null, fetchedAt: null, matchedRule: null, note: "override:null" };
    if (Number.isFinite(override) && override > 0) {
      return { tokens: Math.floor(override), source: "override", sourceUrl: null, fetchedAt: null, matchedRule: null, note: "override explícito" };
    }
  }
  const lower = (modelId ?? "").toLowerCase();
  for (const rule of WINDOW_RULES) {
    if (lower.includes(rule.id)) {
      return {
        tokens: rule.tokens,
        source: "registry",
        sourceUrl: rule.source,
        fetchedAt: rule.fetchedAt,
        matchedRule: rule.id,
        note: rule.note,
      };
    }
  }
  return { tokens: null, source: "unknown", sourceUrl: null, fetchedAt: null, matchedRule: null, note: null };
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
