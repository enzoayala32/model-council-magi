/**
 * Fase 8A — Lectura defensiva del `usage` que informa el proveedor.
 *
 * Es la única fuente de consumo REAL. Un proveedor puede no informar nada
 * (varios endpoints OpenAI-compatibles devuelven `usage: undefined`): en
 * ese caso devolvemos `null` y el budget usa la estimación local,
 * etiquetada como tal. Nunca inventamos ceros.
 */
export type ProviderUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
};

function nonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function readObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

export function extractProviderUsage(raw: unknown): ProviderUsage | null {
  const usage = readObject(raw);
  if (!usage) return null;
  const inputDetails = readObject(usage.inputTokenDetails);
  const outputDetails = readObject(usage.outputTokenDetails);
  const inputTokens = nonNegative(usage.inputTokens);
  const outputTokens = nonNegative(usage.outputTokens);
  const totalTokens = nonNegative(usage.totalTokens) ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null);
  const cachedInputTokens = nonNegative(inputDetails?.cacheReadTokens) ?? nonNegative(usage.cachedInputTokens);
  const cacheWriteTokens = nonNegative(inputDetails?.cacheWriteTokens) ?? nonNegative(usage.cacheWriteTokens);
  const reasoningTokens = nonNegative(outputDetails?.reasoningTokens) ?? nonNegative(usage.reasoningTokens);
  if (inputTokens === null && outputTokens === null && totalTokens === null && cachedInputTokens === null && cacheWriteTokens === null && reasoningTokens === null) {
    return null;
  }
  return { inputTokens, outputTokens, totalTokens, cachedInputTokens, cacheWriteTokens, reasoningTokens };
}
