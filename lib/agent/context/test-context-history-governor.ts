/**
 * Fase 8E — governor del historial (APAGADO por defecto).
 *
 * Prueba el planificador puro: determinista, versionado, preserva usuario/
 * system/recientes, redacta errores, omite rutas sensibles y no copia
 * contenido de tools. No toca DB, red ni filesystem.
 *
 * Uso: npm run agent:test-context-history-governor
 */
import type { JSONValue, ModelMessage } from "ai";
import { DEFAULT_HISTORY_GOVERNOR_CONFIG, HISTORY_GOVERNOR_VERSION, planHistoryCompaction, type HistoryGovernorConfig } from "./history-governor";

const results: boolean[] = [];
function check(ok: boolean, message: string, detail?: () => unknown) {
  console.log(ok ? `✅ ${message}` : `❌ ${message}${detail ? `\n   ${JSON.stringify(detail())}` : ""}`);
  results.push(ok);
}
const canon = (value: unknown) => JSON.stringify(value);
function checkEq(actual: unknown, expected: unknown, message: string) {
  check(canon(actual) === canon(expected), message, () => ({ esperado: expected, actual }));
}

const user = (text: string): ModelMessage => ({ role: "user", content: text });
const assistant = (text: string): ModelMessage => ({ role: "assistant", content: [{ type: "text", text }] });
function toolGroup(id: string, output: JSONValue, input: unknown = { path: "src/a.ts" }): ModelMessage[] {
  return [
    { role: "assistant", content: [{ type: "tool-call", toolCallId: id, toolName: "read_file", input }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName: "read_file", output: { type: "json", value: output } }] },
  ];
}
function longMessages(): ModelMessage[] {
  return [
    { role: "system", content: "reglas del sistema" },
    user("OBJETIVO: arreglar el bug de facturación"),
    assistant(`análisis viejo ${"A".repeat(1_200)}`),
    ...toolGroup("call-0", { ok: true, content: "OTRO_SENTINEL" }, { path: "src/a.ts" }),
    ...toolGroup("call-1", { ok: false, error: "falló en src/a.ts: boom", content: "TOOL_CONTENT_SENTINEL" }, { path: ".env" }),
    assistant(`segundo análisis viejo ${"B".repeat(800)}`),
    user("CORRECCIÓN: no toques la base de datos"),
    assistant("trabajo reciente uno"),
    ...toolGroup("call-2", { ok: false, error: "error reciente que explica el fallo" }),
    assistant("trabajo reciente dos"),
  ];
}

function plan(messages: ModelMessage[], estimatedTokens: number, config: Partial<HistoryGovernorConfig> = {}) {
  return planHistoryCompaction({
    messages,
    estimatedTokens,
    softInputTokens: 1_000,
    config: { ...DEFAULT_HISTORY_GOVERNOR_CONFIG, ...config },
  });
}

function main() {
  console.log("== Fase 8E — governor del historial ==\n");

  console.log("--- Apagado por defecto ---");
  {
    const messages = longMessages();
    const disabled = plan(messages, 10_000);
    checkEq(disabled.decision, "disabled", "sin enabled:true → disabled");
    check(disabled.applied === false && disabled.summary === null, "no aplica ni genera resumen");
    check(disabled.messages === messages, "devuelve el MISMO array (no copia ni muta)");
    checkEq(disabled.beforeMessages, disabled.afterMessages, "conteos iguales");
    checkEq(disabled.trace.summarizedUnits, 0, "nada resumido");
    checkEq(DEFAULT_HISTORY_GOVERNOR_CONFIG.enabled, false, "default del governor: apagado");
  }

  console.log("\n--- Umbral de disparo y unidades mínimas ---");
  {
    const messages = longMessages();
    const below = plan(messages, 800, { enabled: true });
    checkEq(below.decision, "not_needed", "800 < 1000×0.85 → not_needed");
    const empty = plan([], 10_000, { enabled: true });
    checkEq(empty.decision, "too_few_units", "historial vacío → too_few_units");
    const few = plan([user("hola"), assistant("respuesta")], 10_000, { enabled: true });
    checkEq(few.decision, "too_few_units", "solo una unidad removible y keepRecent=6 → too_few_units");
  }

  console.log("\n--- Compactación: preserva lo que importa ---");
  const messages = longMessages();
  const beforeSnapshot = canon(messages);
  const compacted = plan(messages, 10_000, { enabled: true, keepRecentUnits: 3 });
  checkEq(compacted.decision, "compacted", "sobre el umbral y con suficientes unidades → compacted");
  check(compacted.applied === true && compacted.summary !== null, "aplica y devuelve resumen", () => compacted);
  check(compacted.afterMessages < compacted.beforeMessages, "reduce la cantidad de mensajes", () => ({ before: compacted.beforeMessages, after: compacted.afterMessages }));
  checkEq(canon(messages), beforeSnapshot, "NO muta el historial de entrada");
  const output = compacted.messages as Array<{ role: string; content: unknown }>;
  const outputText = canon(output);
  check(outputText.includes("OBJETIVO: arreglar el bug de facturación"), "conserva el objetivo del usuario textualmente");
  check(outputText.includes("CORRECCIÓN: no toques la base de datos"), "conserva la corrección del usuario textualmente");
  check(outputText.includes("reglas del sistema"), "conserva el mensaje de sistema");
  check(outputText.includes("error reciente que explica el fallo"), "conserva el error reciente (unidad reciente textual)");
  check(outputText.includes("trabajo reciente uno") && outputText.includes("trabajo reciente dos"), "conserva las unidades recientes textualmente");
  check(!outputText.includes("TOOL_CONTENT_SENTINEL"), "NO copia el contenido del tool-result viejo");
  check(!outputText.includes("A".repeat(300)), "el texto viejo completo no queda en el historial", () => outputText.slice(0, 500));
  check(compacted.summary!.includes(HISTORY_GOVERNOR_VERSION.toString()), "el resumen declara la versión del governor", () => compacted.summary);
  check(compacted.summary!.includes("falló en src/a.ts: boom"), "preserva el error viejo (redactado/recortado)");
  check(!compacted.summary!.includes(".env"), "omite por completo la ruta sensible");
  check(compacted.summary!.includes("Rutas sensibles omitidas: 1"), "declara cuántas rutas sensibles omitió");
  check(compacted.summary!.includes("src/a.ts (1)"), "lista rutas no sensibles con su conteo");
  check(compacted.summary!.includes("read_file: 2 llamadas, 1 OK, 1 fallo"), "resume hechos de tools sin contenido", () => compacted.summary);
  check(!compacted.summary!.includes("OTRO_SENTINEL"), "tampoco copia el contenido de un tool-result viejo exitoso", () => compacted.summary);
  check(compacted.summary!.includes("Dichos del asistente (NO verificados)"), "separa dichos no verificados");
  check(compacted.summary!.includes("Pendientes") && compacted.summary!.includes("No inferidos"), "no inventa pendientes");
  check(compacted.trace.keptUserMessages === 2, "traza: 2 mensajes de usuario conservados", () => compacted.trace);
  check(compacted.trace.keptSystemMessages === 1, "traza: 1 system conservado");
  check(compacted.trace.keptRecentUnits === 3, "traza: 3 unidades recientes conservadas");
  check(compacted.trace.summarizedUnits === 4, "traza: 4 unidades viejas resumidas", () => compacted.trace);
  check(compacted.trace.summarizedMessages === 6, "traza: 6 mensajes viejos resumidos", () => compacted.trace);
  check(compacted.trace.observedToolCalls === 2 && compacted.trace.observedToolResults === 2 && compacted.trace.observedFailures === 1, "traza: tool-call/result/fallo observados", () => compacted.trace);
  check(compacted.trace.omittedSensitivePaths === 1, "traza: 1 ruta sensible omitida");
  check(compacted.trace.removedChars > compacted.trace.summaryChars, "el resumen ocupa menos que lo removido", () => compacted.trace);
  checkEq(compacted.version, HISTORY_GOVERNOR_VERSION, "versión del plan");
  const summaryIndex = output.findIndex((message) => canon(message.content).includes("Historial compactado"));
  check(summaryIndex >= 0 && output[summaryIndex].role === "assistant", "el resumen es un mensaje assistant");
  check(summaryIndex === 2, "se inserta una sola vez, después del system/user inicial", () => ({ summaryIndex, roles: output.map((message) => message.role) }));

  console.log("\n--- Determinismo y no-beneficio ---");
  {
    const first = plan(longMessages(), 10_000, { enabled: true });
    const second = plan(longMessages(), 10_000, { enabled: true });
    check(canon(first) === canon(second), "dos planes con la misma entrada son idénticos", () => first);
  }
  {
    const tiny: ModelMessage[] = [user("u"), assistant("x"), ...toolGroup("c", {}), user("u2"), assistant("y"), assistant("z")];
    const notBeneficial = plan(tiny, 10_000, { enabled: true, keepRecentUnits: 1, minOldUnits: 1 });
    checkEq(notBeneficial.decision, "not_beneficial", "si el resumen no reduce, no se aplica");
    check(notBeneficial.applied === false && notBeneficial.summary === null, "devuelve el historial original");
  }
  {
    const tooLarge = plan(longMessages(), 10_000, { enabled: true, keepRecentUnits: 3, maxSummaryChars: 40 });
    checkEq(tooLarge.decision, "summary_too_large", "resumen que no entra en maxSummaryChars → summary_too_large");
    checkEq(tooLarge.applied, false, "no se aplica un resumen gigante");
  }

  console.log("\n--- Límites y disparo explícito ---");
  {
    const allOld = plan(longMessages(), 10_000, { enabled: true, keepRecentUnits: 0, minOldUnits: 1 });
    checkEq(allOld.decision, "compacted", "keepRecentUnits=0 resume todas las removibles");
    checkEq(allOld.trace.keptRecentUnits, 0, "no quedan recientes");
    checkEq(allOld.trace.summarizedUnits, 7, "7 unidades removibles resumidas");
  }
  {
    const capped = plan(longMessages(), 10_000, { enabled: true, maxErrors: 0 });
    checkEq(capped.trace.preservedErrors, 0, "maxErrors=0 no preserva errores");
  }
  {
    const ratio = plan(longMessages(), 850, { enabled: true, keepRecentUnits: 3, triggerRatio: 0.85 });
    checkEq(ratio.decision, "compacted", "850 >= 1000×0.85 dispara");
  }
  {
    const version = plan(longMessages(), 10_000, { enabled: true, keepRecentUnits: 3 });
    check(version.summary!.startsWith(`## Historial compactado (gobernador v${HISTORY_GOVERNOR_VERSION})`), "el encabezado del resumen lleva la versión", () => version.summary?.slice(0, 80));
  }

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} casos OK.`);
  if (passed !== results.length) process.exit(1);
}

main();
