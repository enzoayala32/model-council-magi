/**
 * Prueba de aceptación de la Fase 5C — parte 2: `config.ts`. Puro
 * discovery + armado de pool + snapshot — sin red, sin Council, sin
 * Coding Agent, sin tocar `pool.ts`.
 *
 * IMPORTANTE: usa un prefijo de env var SINTÉTICO (`CFG_TEST_KEY_5C`),
 * nunca `OPENROUTER_API_KEY`/`NVIDIA_API_KEY`/`GEMINI_API_KEY` — para que
 * esta prueba jamás lea ni dependa de las credenciales reales que puedan
 * existir en el `.env`/`.env.local` de quien la corra.
 *
 * Uso: npm run provider-resilience:test-config
 */
import { resolveCredentials, createProviderPool, getProviderSnapshot } from "./config";
import { redactSecrets } from "./redact";

let results: boolean[] = [];

function check(label: string, ok: boolean, detail?: unknown): void {
  results.push(ok);
  console.log(`${ok ? "✅" : "❌"} ${label}${ok ? "" : ` — ${JSON.stringify(detail)}`}`);
}

const PREFIX = "CFG_TEST_KEY_5C";

/** Limpia el prefijo de test entre casos — nunca toca ninguna otra
 * variable de entorno real. */
function clearPrefix(prefix: string): void {
  delete process.env[prefix];
  for (const key of Object.keys(process.env)) {
    if (key.startsWith(`${prefix}_`)) delete process.env[key];
  }
}

function arrayEquals(a: string[], b: string[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function main(): void {
  console.log("== Fase 5C — prueba de aceptación (config.ts) ==\n");

  console.log("--- Discovery: una sola credential (solo base) ---");
  {
    clearPrefix(PREFIX);
    process.env[PREFIX] = "alpha-secret-1";
    const result = resolveCredentials(PREFIX);
    check("una sola credential", arrayEquals(result, ["alpha-secret-1"]), result);
  }

  console.log("\n--- Discovery: múltiples credentials contiguas ---");
  {
    clearPrefix(PREFIX);
    process.env[PREFIX] = "b1";
    process.env[`${PREFIX}_2`] = "b2";
    process.env[`${PREFIX}_3`] = "b3";
    const result = resolveCredentials(PREFIX);
    check("3 credentials en orden", arrayEquals(result, ["b1", "b2", "b3"]), result);
  }

  console.log("\n--- Discovery: gaps en la numeración (_2 y _5, sin _3/_4) ---");
  {
    clearPrefix(PREFIX);
    process.env[`${PREFIX}_2`] = "g2";
    process.env[`${PREFIX}_5`] = "g5";
    const result = resolveCredentials(PREFIX);
    check("descubre _2 y _5 igual, sin perder _5 por el hueco", arrayEquals(result, ["g2", "g5"]), result);
  }

  console.log("\n--- Discovery: variable vacía se descarta sin romper la numeración ---");
  {
    clearPrefix(PREFIX);
    process.env[PREFIX] = "";
    process.env[`${PREFIX}_2`] = "real-value";
    const result = resolveCredentials(PREFIX);
    check("la base vacía se descarta, _2 se descubre igual", arrayEquals(result, ["real-value"]), result);
  }

  console.log("\n--- Discovery: whitespace se recorta ---");
  {
    clearPrefix(PREFIX);
    process.env[PREFIX] = "   trimmed-value   ";
    const result = resolveCredentials(PREFIX);
    check("el valor queda trimeado", arrayEquals(result, ["trimmed-value"]), result);
  }

  console.log("\n--- Discovery: duplicados por valor — una sola credential, se queda con la primera aparición ---");
  {
    clearPrefix(PREFIX);
    process.env[PREFIX] = "dup-value";
    process.env[`${PREFIX}_2`] = "dup-value";
    process.env[`${PREFIX}_3`] = "unique-value";
    const result = resolveCredentials(PREFIX);
    check("dup-value aparece una sola vez, en la posición de la base", arrayEquals(result, ["dup-value", "unique-value"]), result);
  }

  console.log("\n--- Discovery: ausencia total ---");
  {
    clearPrefix(PREFIX);
    const result = resolveCredentials(PREFIX);
    check("sin ninguna variable configurada, devuelve []", arrayEquals(result, []), result);
  }

  console.log("\n--- Discovery: formato arbitrario, sin validación ---");
  {
    clearPrefix(PREFIX);
    process.env[PREFIX] = "no-se-parece-en-nada-a-una-key-real!!##...";
    const result = resolveCredentials(PREFIX);
    check("se acepta cualquier formato, sin validar nada", arrayEquals(result, ["no-se-parece-en-nada-a-una-key-real!!##..."]), result);
  }

  console.log("\n--- IDs y prioridad: deterministas, en orden, independientes del contenido ---");
  {
    clearPrefix(PREFIX);
    process.env[PREFIX] = "content-v1";
    process.env[`${PREFIX}_2`] = "content-v2";
    process.env[`${PREFIX}_3`] = "content-v3";
    const pool = createProviderPool("openrouter", PREFIX);
    const snap = getProviderSnapshot("openrouter", pool);

    check("3 credentials en el snapshot", snap.credentials.length === 3, snap);
    check(
      "ids deterministas: openrouter-1, openrouter-2, openrouter-3, en ese orden",
      snap.credentials.map((c) => c.id).join(",") === "openrouter-1,openrouter-2,openrouter-3",
      snap.credentials.map((c) => c.id),
    );
    check(
      "priority = posición (1,2,3), coincide con el número del id",
      snap.credentials.map((c) => c.priority).join(",") === "1,2,3",
      snap.credentials.map((c) => c.priority),
    );
    check("provider correcto en cada fila", snap.credentials.every((c) => c.provider === "openrouter"));
    check("estado inicial AVAILABLE para las 3", snap.credentials.every((c) => c.status === "AVAILABLE"));

    // Mismo prefijo/orden, contenido de las keys completamente distinto → mismos ids.
    clearPrefix(PREFIX);
    process.env[PREFIX] = "totalmente-otro-valor-1";
    process.env[`${PREFIX}_2`] = "totalmente-otro-valor-2";
    process.env[`${PREFIX}_3`] = "totalmente-otro-valor-3";
    const pool2 = createProviderPool("openrouter", PREFIX);
    const snap2 = getProviderSnapshot("openrouter", pool2);
    check(
      "los ids NO dependen del contenido de la key — mismos ids con valores completamente distintos",
      snap.credentials.map((c) => c.id).join(",") === snap2.credentials.map((c) => c.id).join(","),
      { antes: snap.credentials.map((c) => c.id), despues: snap2.credentials.map((c) => c.id) },
    );
  }

  console.log("\n--- Snapshot seguro: ningún valor real de credential aparece en el JSON ---");
  {
    clearPrefix(PREFIX);
    process.env[PREFIX] = "super-secreto-no-debe-aparecer-nunca";
    process.env[`${PREFIX}_2`] = "otro-secreto-tampoco-debe-aparecer";
    const pool = createProviderPool("google", PREFIX);
    const snap = getProviderSnapshot("google", pool);
    const json = JSON.stringify(snap);

    check("el JSON no contiene el primer secreto real", !json.includes("super-secreto-no-debe-aparecer-nunca"), json);
    check("el JSON no contiene el segundo secreto real", !json.includes("otro-secreto-tampoco-debe-aparecer"), json);
    check("el JSON no tiene ningún campo 'value'/'apiKey'", !json.includes('"value"') && !json.includes('"apiKey"'), json);
    check(
      "pasar el JSON del snapshot por redactSecrets no cambia nada — no había nada que redactar",
      redactSecrets(json) === json,
      json,
    );
  }

  console.log("\n--- createProviderPool registra las credentials en redact.ts ANTES de devolver el pool ---");
  {
    clearPrefix(PREFIX);
    const uniqueSecret = "SECRET-REGISTERED-VIA-CONFIG-XYZ";
    process.env[PREFIX] = uniqueSecret;
    createProviderPool("nvidia", PREFIX);
    // Si createProviderPool de verdad registró el secreto, redactSecrets ya debería taparlo.
    const text = `la key usada fue ${uniqueSecret} en esta llamada`;
    check("el secreto quedó registrado en redact.ts como efecto de crear el pool", redactSecrets(text) === "la key usada fue [REDACTED] en esta llamada", redactSecrets(text));
  }

  clearPrefix(PREFIX); // no dejar el proceso con variables de test colgando

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} casos OK.`);
  if (passed !== results.length) process.exit(1);
}

main();
