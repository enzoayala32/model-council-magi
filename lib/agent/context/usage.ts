/**
 * Fase 8A — Evento `context_usage`.
 *
 * El payload es SOLO telemetría numérica/metadatos: longitudes, conteos,
 * tokens informados por el proveedor y estado del presupuesto. Nunca
 * incluye prompts, mensajes, código, nombres de archivos ni resultados de
 * tools. Eso permite diagnosticar "por qué se fue el contexto" sin
 * convertir la base de eventos en una copia del código privado.
 */
import type { ContextEstimate } from "./estimate";
import type { ContextBudgetReport } from "./budget";
import type { ProviderUsage } from "./provider-usage";
import type { ContextConfidence, ContextSignal } from "./select";
import type { RepoMapErrorCode } from "../repo-map-views";

export type ContextSelectionSummary = {
  enabled: boolean;
  available: boolean;
  candidates: number;
  included: number;
  truncated: boolean;
  confidence: ContextConfidence | null;
  generation: number | null;
  refreshes: number;
  error: RepoMapErrorCode | null;
  signals: Record<ContextSignal, number>;
};

export type GovernorUsageSummary = {
  enabled: boolean;
  applied: boolean;
  removedMessages: number;
  summaryChars: number;
  version: number | null;
};

export type ContextUsagePayload = {
  type: "context_usage";
  step: number;
  modelId: string;
  provider: string;
  estimate: ContextEstimate;
  providerUsage: ProviderUsage | null;
  budget: ContextBudgetReport;
  selection: ContextSelectionSummary;
  governor: GovernorUsageSummary;
};

export type BuildContextUsageInput = {
  step: number;
  modelId: string;
  provider: string;
  estimate: ContextEstimate;
  providerUsage: ProviderUsage | null;
  budget: ContextBudgetReport;
  selection: ContextSelectionSummary;
  governor: GovernorUsageSummary;
};

export function buildContextUsagePayload(input: BuildContextUsageInput): ContextUsagePayload {
  return {
    type: "context_usage",
    step: Math.max(1, Math.floor(input.step)),
    modelId: input.modelId,
    provider: input.provider,
    estimate: input.estimate,
    providerUsage: input.providerUsage,
    budget: input.budget,
    selection: input.selection,
    governor: input.governor,
  };
}

function formatTokens(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "?";
  if (value < 1_000) return String(Math.max(0, Math.round(value)));
  if (value < 1_000_000) {
    const thousands = value / 1_000;
    return `${thousands >= 100 ? Math.round(thousands) : thousands.toFixed(1)}k`;
  }
  const millions = value / 1_000_000;
  return `${millions >= 10 ? Math.round(millions) : millions.toFixed(1)}M`;
}

/** Línea corta para la UI/transcript de debug. Sin contenido del proyecto. */
export function formatContextUsage(payload: ContextUsagePayload): string {
  const used = formatTokens(payload.budget.usedInputTokens);
  const source = payload.budget.usedSource === "provider" ? "proveedor" : "estimado";
  const pieces: string[] = [`📊 contexto paso ${payload.step}: ${used} ${source}`];
  const usage = payload.providerUsage;
  if (usage && (usage.inputTokens !== null || usage.outputTokens !== null)) {
    pieces.push(`in ${formatTokens(usage.inputTokens)} / out ${formatTokens(usage.outputTokens)}`);
  }
  if (payload.budget.windowTokens !== null) {
    const percent = payload.budget.hardUtilization !== null ? `, ${Math.round(payload.budget.hardUtilization * 100)}%` : "";
    pieces.push(`ventana ${formatTokens(payload.budget.windowTokens)}${percent}`);
  } else {
    pieces.push("ventana desconocida");
  }
  if (payload.budget.status === "over_limit") pieces[0] = `⚠️ ${pieces[0]}`;
  else if (payload.budget.status === "near_limit") pieces[0] = `⚠️ ${pieces[0]}`;
  return pieces.join(" · ");
}
