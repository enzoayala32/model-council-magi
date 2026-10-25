/**
 * Fase 8A — medición local de contexto.
 *
 * Sin red, sin DB, sin filesystem. Verifica que la estimación sea
 * determinista, que separe system/mensajes/tools y que NUNCA devuelva el
 * contenido medido (solo longitudes y conteos).
 *
 * Uso: npm run agent:test-context-estimate
 */
import { CHARS_PER_TOKEN_ESTIMATE, ESTIMATE_METHOD, MEDIA_CHAR_EQUIVALENT, estimateTokensFromChars, measureContext, measureMessage, measureMessages, measureTools } from "./estimate";

const results: boolean[] = [];
function check(ok: boolean, message: string, detail?: () => unknown) {
  console.log(ok ? `✅ ${message}` : `❌ ${message}${detail ? `\n   ${JSON.stringify(detail())}` : ""}`);
  results.push(ok);
}
const canon = (value: unknown) => JSON.stringify(value);
function checkEq(actual: unknown, expected: unknown, message: string) {
  check(canon(actual) === canon(expected), message, () => ({ esperado: expected, actual }));
}

function main() {
  console.log("== Fase 8A — estimación de contexto ==\n");

  console.log("--- Estimación por caracteres ---");
  checkEq(estimateTokensFromChars(0), 0, "0 caracteres → 0 tokens");
  checkEq(estimateTokensFromChars(-10), 0, "negativo → 0 tokens");
  checkEq(estimateTokensFromChars(Number.NaN), 0, "NaN → 0 tokens");
  checkEq(estimateTokensFromChars(1), 1, "1 carácter → 1 token (ceil)");
  checkEq(estimateTokensFromChars(CHARS_PER_TOKEN_ESTIMATE), 1, `${CHARS_PER_TOKEN_ESTIMATE} caracteres → 1 token`);
  checkEq(estimateTokensFromChars(CHARS_PER_TOKEN_ESTIMATE + 1), 2, `${CHARS_PER_TOKEN_ESTIMATE + 1} caracteres → 2 tokens`);
  check(ESTIMATE_METHOD === "ceil(chars/4)", "el método viaja etiquetado y es estable", () => ESTIMATE_METHOD);

  console.log("\n--- Mensajes: texto, tool-calls y tool-results ---");
  const text = measureMessage({ role: "user", content: "hola mundo" }, 3);
  check(text.role === "user" && text.index === 3 && text.chars === "user".length + "hola mundo".length, "mensaje de texto: rol + contenido, sin inventar tokens", () => text);
  const parts = measureMessage({
    role: "assistant",
    content: [
      { type: "text", text: "voy a leer" },
      { type: "tool-call", toolName: "read_file", input: { path: "a.ts" } },
      { type: "tool-call", toolName: "read_file", input: { path: "b.ts" } },
      { type: "tool-result", toolName: "read_file", output: { ok: true, content: "x".repeat(100) } },
    ],
  });
  check(parts.toolCallCount === 2 && parts.toolResultCount === 1 && parts.toolNames.length === 1 && parts.toolNames[0] === "read_file", "cuenta tool-calls/tool-results y nombres únicos", () => parts);
  check(parts.chars > 100, "el tamaño incluye el output del tool-result (para el budget), no lo ignora", () => parts);
  const media = measureMessage({ role: "user", content: [{ type: "image", image: "data:..." }] });
  checkEq(media.chars, "user".length + MEDIA_CHAR_EQUIVALENT, "contenido no textual usa un equivalente conservador, no 0");
  const malformed = measureMessage(null);
  check(malformed.role === "unknown" && malformed.chars === 0, "mensaje mal formado no lanza", () => malformed);

  const batch = measureMessages([
    { role: "system", content: "reglas" },
    { role: "user", content: "pedido" },
    { role: "tool", content: [{ type: "tool-result", toolName: "x", output: { ok: true } }] },
  ]);
  check(batch.messageCount === 3 && batch.messages.length === 3 && batch.toolResultCount === 1, "lote: cuenta mensajes y tool-results", () => batch);
  check(batch.messages[0].chars === "system".length + "reglas".length, "cada mensaje reporta su propio tamaño", () => batch.messages);

  console.log("\n--- Tools: esquema medido, nunca ejecutado ---");
  let executed = false;
  const tools = {
    demo: {
      description: "descripción de la tool",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
      execute: async () => {
        executed = true;
        return {};
      },
    },
  } as never;
  const toolsChars = measureTools(tools);
  check(toolsChars > 0 && executed === false, "mide descripción + schema sin ejecutar la tool", () => ({ toolsChars, executed }));
  checkEq(measureTools(undefined), 0, "sin tools → 0 caracteres");

  console.log("\n--- measureContext: suma y diagnóstico ---");
  const secret = "TOKEN_QUE_NO_DEBE_APARECER_123456";
  const estimate = measureContext({
    system: "sistema",
    messages: [
      { role: "user", content: secret },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "assistant", content: [{ type: "text", text: "mensaje grande ".repeat(100) }] },
    ],
    tools,
    largestMessages: 1,
  });
  check(
    estimate.chars.total === estimate.chars.system + estimate.chars.messages + estimate.chars.tools,
    "total = system + mensajes + tools",
    () => estimate.chars,
  );
  check(
    estimate.estimatedTokens.total === estimateTokensFromChars(estimate.chars.total) &&
      estimate.estimatedTokens.system === estimateTokensFromChars(estimate.chars.system) &&
      estimate.estimatedTokens.messages === estimateTokensFromChars(estimate.chars.messages) &&
      estimate.estimatedTokens.tools === estimateTokensFromChars(estimate.chars.tools),
    "cada token estimado deriva de su porción de caracteres",
    () => estimate.estimatedTokens,
  );
  check(estimate.messageCount === 3 && estimate.toolCallCount === 0 && estimate.toolResultCount === 0, "conteos del lote", () => estimate);
  check(estimate.largestMessages.length === 1 && estimate.largestMessages[0].index === 2, "largestMessages reporta el mensaje más grande (solo metadatos)", () => estimate.largestMessages);
  check(!canon(estimate).includes(secret), "la estimación NO contiene el texto medido (sin fuga de contenido)", () => canon(estimate).slice(0, 300));
  check(!canon(estimate).includes("mensaje grande"), "tampoco contiene fragmentos del contenido grande", () => "fuga");
  checkEq(measureContext({ system: "", messages: [] }), measureContext({ system: "", messages: [] }), "dos llamadas con la misma entrada son idénticas");

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} casos OK.`);
  if (passed !== results.length) process.exit(1);
}

main();
