/**
 * Fase 8C — presupuesto de contexto.
 *
 * Sin red/DB/filesystem. Verifica límites duros vs preferencias, ventanas
 * conocidas/desconocidas, uso real del proveedor vs estimación local, y que
 * nunca se invente un límite duro cuando no se conoce la ventana.
 *
 * Uso: npm run agent:test-context-budget
 */
import {
  CONTEXT_BUDGET_VERSION,
  DEFAULT_OUTPUT_RESERVE_TOKENS,
  DEFAULT_SAFETY_MARGIN_TOKENS,
  UNKNOWN_WINDOW_SOFT_INPUT_TOKENS,
  briefingBudgetChars,
  computeContextBudget,
  resolveContextWindow,
} from "./budget";
import { measureContext } from "./estimate";
import type { ProviderUsage } from "./provider-usage";

const results: boolean[] = [];
function check(ok: boolean, message: string, detail?: () => unknown) {
  console.log(ok ? `✅ ${message}` : `❌ ${message}${detail ? `\n   ${JSON.stringify(detail())}` : ""}`);
  results.push(ok);
}
const canon = (value: unknown) => JSON.stringify(value);
function checkEq(actual: unknown, expected: unknown, message: string) {
  check(canon(actual) === canon(expected), message, () => ({ esperado: expected, actual }));
}

function estimateWith(chars: number) {
  return measureContext({ system: "x".repeat(chars), messages: [] });
}
const usage = (inputTokens: number | null, outputTokens: number | null = null): ProviderUsage => ({
  inputTokens,
  outputTokens,
  totalTokens: inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : inputTokens,
  cachedInputTokens: null,
  cacheWriteTokens: null,
  reasoningTokens: null,
});

function main() {
  console.log("== Fase 8C — presupuesto de contexto ==\n");

  console.log("--- Resolución de ventana ---");
  checkEq(resolveContextWindow("google/gemini-3.1-pro-preview").tokens, 2_000_000, "gemini-3.1-pro → 2M (tabla del roster)");
  checkEq(resolveContextWindow("google/gemini-3.5-flash").tokens, 1_000_000, "gemini-3.5-flash → 1M");
  checkEq(resolveContextWindow("openai/gpt-oss-20b").tokens, 131_072, "gpt-oss-20b → 128k");
  const unknown = resolveContextWindow("test/modelo-no-registrado");
  check(unknown.tokens === null && unknown.source === "unknown" && unknown.matchedRule === null, "modelo fuera de la tabla → ventana desconocida (no se inventa)", () => unknown);
  checkEq(resolveContextWindow("cualquiera", 50_000), { tokens: 50_000, source: "override", matchedRule: null, note: "override explícito" }, "override explícito gana a la tabla");
  checkEq(resolveContextWindow("google/gemini-3.1-pro", null).tokens, null, "override null fuerza ventana desconocida");
  checkEq(resolveContextWindow("cualquiera", 0).tokens, null, "override inválido (0) no crea un límite de 0");

  console.log("\n--- Modelo conocido: límite duro y preferencia blanda ---");
  const known = computeContextBudget({ modelId: "google/gemini-3.1-pro-preview", estimate: estimateWith(400) });
  checkEq(known.windowTokens, 2_000_000, "ventana 2M");
  checkEq(known.outputReserveTokens, DEFAULT_OUTPUT_RESERVE_TOKENS, "reserva de salida default");
  checkEq(known.safetyMarginTokens, DEFAULT_SAFETY_MARGIN_TOKENS, "margen de seguridad default");
  checkEq(known.hardInputTokens, 2_000_000 - DEFAULT_OUTPUT_RESERVE_TOKENS - DEFAULT_SAFETY_MARGIN_TOKENS, "límite duro = ventana − salida − margen");
  checkEq(known.softInputTokens, Math.floor(known.hardInputTokens! * 0.6), "preferencia blanda = 60% del duro");
  checkEq(known.status, "ok", "muy por debajo del blando → ok");
  checkEq(known.recommendation, "continue", "recomendación continue");
  checkEq(known.usedSource, "estimate", "sin usage del proveedor → fuente estimate");
  check(known.providerUsageReported === false, "marca que el proveedor no informó usage");

  console.log("\n--- Uso real del proveedor ---");
  const provider = computeContextBudget({ modelId: "google/gemini-3.1-pro-preview", estimate: estimateWith(10), providerUsage: usage(1_500_000, 100) });
  checkEq(provider.usedInputTokens, 1_500_000, "usa inputTokens real, no la estimación");
  checkEq(provider.usedSource, "provider", "fuente provider");
  checkEq(provider.status, "near_limit", "1.5M sobre el blando (1.19M) pero bajo el duro → near_limit");
  checkEq(provider.recommendation, "compact_history_or_reduce_context", "recomendación compactar/reducir");
  checkEq(provider.remainingHardTokens, known.hardInputTokens! - 1_500_000, "remaining se calcula contra el duro");
  checkEq(provider.headroomForOutputTokens, 2_000_000 - 1_500_000, "headroom de salida = ventana − usado");

  const over = computeContextBudget({ modelId: "google/gemini-3.1-pro-preview", estimate: estimateWith(10), providerUsage: usage(known.hardInputTokens! + 1) });
  checkEq(over.status, "over_limit", "apenas por encima del duro → over_limit");
  checkEq(over.recommendation, "reduce_scope_or_stop", "recomendación reducir alcance/detener");
  checkEq(over.remainingHardTokens, 0, "remaining nunca negativo");

  console.log("\n--- Modelo sin ventana conocida ---");
  const noWindow = computeContextBudget({ modelId: "test/modelo-no-registrado", estimate: estimateWith(400) });
  check(noWindow.windowTokens === null && noWindow.hardInputTokens === null, "sin ventana → sin límite duro inventado", () => noWindow);
  checkEq(noWindow.softInputTokens, UNKNOWN_WINDOW_SOFT_INPUT_TOKENS, "preferencia conservadora 32k");
  checkEq(noWindow.status, "unknown_limit", "bajo la preferencia → unknown_limit");
  checkEq(noWindow.recommendation, "no_hard_limit_known", "recomendación explícita: no hay límite conocido");
  const noWindowNear = computeContextBudget({ modelId: "test/modelo-no-registrado", estimate: estimateWith(UNKNOWN_WINDOW_SOFT_INPUT_TOKENS * 4 + 10) });
  checkEq(noWindowNear.status, "near_limit", "sobre la preferencia sin ventana → near_limit (no over_limit)");
  checkEq(noWindowNear.hardUtilization, null, "hardUtilization null cuando no hay duro");
  checkEq(noWindowNear.remainingHardTokens, null, "remaining null cuando no hay duro");

  console.log("\n--- Overrides y reservas ---");
  const small = computeContextBudget({ modelId: "cualquiera", estimate: estimateWith(100), windowTokens: 10_000 });
  checkEq(small.outputReserveTokens, 2_000, "reserva de salida se acota al 20% de una ventana chica");
  checkEq(small.hardInputTokens, 10_000 - 2_000 - DEFAULT_SAFETY_MARGIN_TOKENS, "duro con ventana chica");
  checkEq(small.softInputTokens, Math.floor(small.hardInputTokens! * 0.6), "blando con ventana chica");
  const custom = computeContextBudget({ modelId: "cualquiera", estimate: estimateWith(100), windowTokens: 10_000, maxOutputTokens: 1_000, safetyMarginTokens: 500, softRatio: 0.8 });
  checkEq(custom.hardInputTokens, 10_000 - 1_000 - 500, "respeta maxOutputTokens/margen explícitos");
  checkEq(custom.softInputTokens, Math.floor(custom.hardInputTokens! * 0.8), "respeta softRatio explícito");
  const clamped = computeContextBudget({ modelId: "cualquiera", estimate: estimateWith(100), windowTokens: 10_000, softRatio: 5 });
  checkEq(clamped.softInputTokens, Math.floor(clamped.hardInputTokens! * 0.95), "softRatio se acota a 0.95");
  const tiny = computeContextBudget({ modelId: "cualquiera", estimate: estimateWith(100), windowTokens: 500 });
  check(tiny.hardInputTokens === 0 && tiny.status === "over_limit", "ventana mínima no produce un duro negativo", () => tiny);

  console.log("\n--- briefingBudgetChars ---");
  const budgetChars = briefingBudgetChars(known, 10_000, 6_000);
  check(budgetChars >= 400 && budgetChars <= 6_000, "briefing chars queda en [400, max]", () => budgetChars);
  checkEq(briefingBudgetChars(noWindow, 1_000_000, 6_000), 400, "sin espacio disponible → piso 400 (nunca negativo)");
  checkEq(briefingBudgetChars(known, 0, 1_000), 1_000, "tope explícito respetado");
  checkEq(known.version, CONTEXT_BUDGET_VERSION, "versión del reporte");

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} casos OK.`);
  if (passed !== results.length) process.exit(1);
}

main();
