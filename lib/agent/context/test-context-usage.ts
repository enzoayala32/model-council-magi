/**
 * Fase 8A — `usage` del proveedor y evento `context_usage`.
 *
 * Verifica lectura defensiva del usage, el payload estable y que la
 * telemetría NO transporte prompts, código ni contenido de archivos.
 *
 * Uso: npm run agent:test-context-usage
 */
import { extractProviderUsage } from "./provider-usage";
import { buildContextUsagePayload, formatContextUsage, type ContextSelectionSummary, type GovernorUsageSummary } from "./usage";
import { computeContextBudget } from "./budget";
import { measureContext } from "./estimate";

const results: boolean[] = [];
function check(ok: boolean, message: string, detail?: () => unknown) {
  console.log(ok ? `✅ ${message}` : `❌ ${message}${detail ? `\n   ${JSON.stringify(detail())}` : ""}`);
  results.push(ok);
}
const canon = (value: unknown) => JSON.stringify(value);
function checkEq(actual: unknown, expected: unknown, message: string) {
  check(canon(actual) === canon(expected), message, () => ({ esperado: expected, actual }));
}

const selection: ContextSelectionSummary = {
  enabled: true,
  available: true,
  candidates: 3,
  included: 2,
  truncated: false,
  confidence: "high",
  generation: 7,
  refreshes: 1,
  error: null,
  signals: { explicit_path: 1, touched: 0, symbol_mention: 0, term_match: 1, graph_neighbor: 1, role: 0, test_pair: 0 },
};
const governor: GovernorUsageSummary = { enabled: false, applied: false, removedMessages: 0, summaryChars: 0, version: null };

function main() {
  console.log("== Fase 8A — usage del proveedor y evento context_usage ==\n");

  console.log("--- extractProviderUsage: defensivo, nunca inventa ceros ---");
  checkEq(extractProviderUsage(undefined), null, "undefined → null");
  checkEq(extractProviderUsage(null), null, "null → null");
  checkEq(extractProviderUsage({}), null, "objeto vacío → null");
  checkEq(extractProviderUsage({ inputTokens: -5, outputTokens: Number.NaN }), null, "valores inválidos → null");
  const full = extractProviderUsage({
    inputTokens: 1200,
    outputTokens: 80,
    totalTokens: 1280,
    inputTokenDetails: { noCacheTokens: 1000, cacheReadTokens: 200, cacheWriteTokens: 0 },
    outputTokenDetails: { reasoningTokens: 30 },
  });
  checkEq(full, { inputTokens: 1200, outputTokens: 80, totalTokens: 1280, cachedInputTokens: 200, cacheWriteTokens: 0, reasoningTokens: 30 }, "mapea usage completo (incluye cache/reasoning)");
  const partial = extractProviderUsage({ inputTokens: 10, outputTokens: 5 });
  checkEq(partial?.totalTokens, 15, "si falta total, lo calcula de input+output");
  checkEq(extractProviderUsage({ outputTokens: 5 })?.inputTokens, null, "input ausente queda null, no 0");
  checkEq(extractProviderUsage({ cachedInputTokens: 7, cacheWriteTokens: 3 })?.inputTokens, null, "solo cache no inventa input");
  checkEq(extractProviderUsage({ inputTokenDetails: { cacheReadTokens: 9 } })?.cachedInputTokens, 9, "acepta cacheReadTokens anidado");
  checkEq(extractProviderUsage({ cachedInputTokens: 4 })?.cachedInputTokens, 4, "acepta cachedInputTokens plano como fallback");

  console.log("\n--- Payload estable ---");
  const estimate = measureContext({ system: "sistema", messages: [{ role: "user", content: "hola" }] });
  const providerUsage = extractProviderUsage({ inputTokens: 100, outputTokens: 20 });
  const budget = computeContextBudget({ modelId: "test/modelo-no-registrado", estimate, providerUsage });
  const payload = buildContextUsagePayload({
    step: 0,
    modelId: "test/modelo-no-registrado",
    provider: "openrouter",
    estimate,
    providerUsage,
    budget,
    selection,
    governor,
  });
  checkEq(payload.type, "context_usage", "tipo context_usage");
  checkEq(payload.step, 1, "step se normaliza a 1-based (mínimo 1)");
  checkEq(payload.provider, "openrouter", "provider viaja tal cual");
  checkEq(payload.providerUsage?.inputTokens, 100, "usage real incluido");
  checkEq(payload.budget.usedSource, "provider", "budget marca fuente provider");
  checkEq(payload.selection, selection, "resumen de selección incluido");
  checkEq(payload.governor, governor, "resumen del governor incluido");
  check(!canon(payload).includes("hola"), "el payload NO incluye el texto del mensaje", () => canon(payload));
  check(!canon(payload).includes("sistema"), "tampoco incluye el system prompt", () => canon(payload));
  check(!canon(payload).includes("content"), "no serializa contenido de mensajes", () => Object.keys(payload));
  checkEq(buildContextUsagePayload({ step: 3.9, modelId: "m", provider: "p", estimate, providerUsage: null, budget, selection, governor }).step, 3, "step decimal se trunca");

  console.log("\n--- formatContextUsage (UI/transcript) ---");
  const knownBudget = computeContextBudget({ modelId: "google/gemini-3.1-pro-preview", estimate, providerUsage: null });
  const line = formatContextUsage({ ...payload, budget: knownBudget });
  check(line.includes("contexto paso 1") && line.includes("estimado") && line.includes("ventana 2.0M"), "línea con paso, fuente y ventana conocida", () => line);
  check(line.includes("in 100 / out 20"), "incluye input/output reales cuando existen", () => line);
  const unknownLine = formatContextUsage(payload);
  check(unknownLine.includes("ventana desconocida"), "ventana desconocida se dice explícitamente", () => unknownLine);
  const near = computeContextBudget({ modelId: "test/modelo-no-registrado", estimate: measureContext({ system: "x".repeat(140_000), messages: [] }) });
  const warning = formatContextUsage({ ...payload, estimate: measureContext({ system: "x".repeat(140_000), messages: [] }), budget: near, providerUsage: null });
  check(warning.startsWith("⚠️"), "estado near_limit se marca con advertencia", () => warning);
  check(!warning.includes("x".repeat(20)), "la línea no filtra el contenido medido", () => warning);

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} casos OK.`);
  if (passed !== results.length) process.exit(1);
}

main();
