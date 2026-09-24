/**
 * Prueba de aceptación de la Fase 5C — parte 1: `redact.ts`. Puro, sin
 * red, sin pool, sin config. Cada caso usa un secreto ÚNICO (nunca
 * reusado entre casos) porque `registeredSecrets` es un registro que vive
 * para todo el proceso de este archivo — evita que un caso contamine al
 * siguiente.
 *
 * Uso: npm run provider-resilience:test-redact
 */
import { registerSecret, redactSecrets, redactError } from "./redact";

let results: boolean[] = [];

function check(label: string, ok: boolean, detail?: unknown): void {
  results.push(ok);
  console.log(`${ok ? "✅" : "❌"} ${label}${ok ? "" : ` — ${JSON.stringify(detail)}`}`);
}

function main(): void {
  console.log("== Fase 5C — prueba de aceptación (redact.ts) ==\n");

  // --- Posición del secreto dentro del texto ---
  console.log("--- Posición: principio / medio / final ---");
  {
    registerSecret("SECRET-POS-001");
    check("al principio", redactSecrets("SECRET-POS-001 resto del texto") === "[REDACTED] resto del texto");
    check("en el medio", redactSecrets("antes SECRET-POS-001 despues") === "antes [REDACTED] despues");
    check("al final", redactSecrets("texto antes de SECRET-POS-001") === "texto antes de [REDACTED]");
  }

  // --- Múltiples ocurrencias del mismo secreto ---
  console.log("\n--- Múltiples ocurrencias ---");
  {
    registerSecret("SECRET-MULTI-002");
    const text = "a SECRET-MULTI-002 b SECRET-MULTI-002 c SECRET-MULTI-002 d";
    check("las 3 ocurrencias se reemplazan", redactSecrets(text) === "a [REDACTED] b [REDACTED] c [REDACTED] d");
  }

  // --- Secreto no registrado: nunca se toca ---
  console.log("\n--- Secreto no registrado ---");
  {
    const text = "esto tiene SECRET-NEVER-REGISTERED-003 adentro";
    check("un secreto nunca registrado queda intacto", redactSecrets(text) === text);
  }

  // --- Error.message ---
  console.log("\n--- Error.message ---");
  {
    registerSecret("SECRET-ERRMSG-004");
    const original = new Error("Fallo con la key SECRET-ERRMSG-004 incluida");
    const redacted = redactError(original);
    check("el message del error devuelto está redactado", redacted.message === "Fallo con la key [REDACTED] incluida", redacted.message);
    check("el error ORIGINAL nunca se modifica", original.message === "Fallo con la key SECRET-ERRMSG-004 incluida");
    check("el resultado sigue siendo una instancia de Error", redacted instanceof Error);
  }

  // --- Error.stack ---
  console.log("\n--- Error.stack ---");
  {
    registerSecret("SECRET-STACK-005");
    const original = new Error("mensaje limpio, sin secretos");
    original.stack = "Error: mensaje limpio, sin secretos\n    at SECRET-STACK-005 (file.ts:1:1)";
    const redacted = redactError(original);
    check(
      "el stack del error devuelto está redactado",
      typeof redacted.stack === "string" && !redacted.stack.includes("SECRET-STACK-005") && redacted.stack.includes("[REDACTED]"),
      redacted.stack,
    );
    check("el stack ORIGINAL nunca se modifica", original.stack.includes("SECRET-STACK-005"));
  }

  // --- message Y stack contienen el MISMO secreto ---
  console.log("\n--- message + stack con el mismo secreto ---");
  {
    registerSecret("SECRET-BOTH-006");
    const original = new Error("Error con SECRET-BOTH-006 en el mensaje");
    original.stack = "Error: Error con SECRET-BOTH-006 en el mensaje\n    at foo (bar.ts:1:1)";
    const redacted = redactError(original);
    check(
      "redactado en las dos superficies a la vez",
      !redacted.message.includes("SECRET-BOTH-006") && typeof redacted.stack === "string" && !redacted.stack.includes("SECRET-BOTH-006"),
      { message: redacted.message, stack: redacted.stack },
    );
  }

  // --- error que NO es una instancia de Error ---
  console.log("\n--- Errores que no son instancias de Error ---");
  {
    const fromString = redactError("plain string error");
    check("un string se envuelve en un Error real", fromString instanceof Error);
    check("el string se preserva tal cual como message (sin comillas de JSON)", fromString.message === "plain string error");

    registerSecret("SECRET-NONERROR-007");
    const fromObj = redactError({ weird: "object", withSecret: "SECRET-NONERROR-007" });
    check(
      "un objeto plano también redacta lo que encuentre en su representación en texto",
      fromObj instanceof Error && !fromObj.message.includes("SECRET-NONERROR-007") && fromObj.message.includes("[REDACTED]"),
      fromObj.message,
    );

    const fromNull = redactError(null);
    check("null no rompe nada — devuelve un Error real", fromNull instanceof Error);

    const fromUndefined = redactError(undefined);
    check("undefined tampoco rompe nada", fromUndefined instanceof Error);
  }

  // --- Decisión explícita: no se preservan propiedades arbitrarias ---
  console.log("\n--- Decisión explícita: propiedades custom del error original NO se preservan ---");
  {
    class CustomError extends Error {
      status = 429;
      retryAfterSeconds = 12;
    }
    registerSecret("SECRET-EXTRA-008");
    const original = new CustomError("con SECRET-EXTRA-008 adentro");
    const redacted = redactError(original);
    check(
      "solo sobreviven name/message/stack (ya redactados) — .status/.retryAfterSeconds se pierden a propósito",
      !("status" in redacted) && !("retryAfterSeconds" in redacted) && !redacted.message.includes("SECRET-EXTRA-008"),
      Object.keys(redacted),
    );
  }

  // --- Un secreto que es substring de otro no debe dejar un resto visible ---
  console.log("\n--- Secretos donde uno es substring de otro (orden más-largo-primero) ---");
  {
    registerSecret("sk-abc");
    registerSecret("sk-abcdef");
    const result = redactSecrets("la key real es sk-abcdef y nada más.");
    check(
      "el secreto más largo se redacta entero — no queda ningún resto visible del substring más corto",
      result === "la key real es [REDACTED] y nada más." && !result.includes("def") && !result.includes("abc"),
      result,
    );
  }

  // --- registerSecret ignora valores vacíos/whitespace ---
  console.log("\n--- registerSecret con valores vacíos ---");
  {
    registerSecret("");
    registerSecret("   ");
    const text = "texto normal, sin nada que redactar acá";
    check("registrar '' o solo-espacios nunca convierte el texto normal en basura redactada", redactSecrets(text) === text);
  }

  // --- Objetos serializados como JSON ---
  console.log("\n--- Objeto serializado como JSON con un secreto anidado ---");
  {
    registerSecret("SECRET-JSON-009");
    const obj = { nested: { apiKey: "SECRET-JSON-009", other: "sin problema" } };
    const json = JSON.stringify(obj);
    const redactedJson = redactSecrets(json);
    check(
      "el secreto anidado se redacta del texto JSON completo (redactSecrets opera sobre texto, no recorre el objeto)",
      !redactedJson.includes("SECRET-JSON-009") && redactedJson.includes("[REDACTED]") && redactedJson.includes("sin problema"),
      redactedJson,
    );
  }

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} casos OK.`);
  if (passed !== results.length) process.exit(1);
}

main();
