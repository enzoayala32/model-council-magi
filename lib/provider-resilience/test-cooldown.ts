/**
 * Prueba de aceptación de la Fase 5B — parte 1: `cooldown.ts`.
 * Puro, sin red, sin pool, sin providers. RNG y `now` inyectados para que
 * los límites del jitter sean demostrables exactamente, sin sleeps reales.
 *
 * Uso: npm run provider-resilience:test-cooldown
 */
import { computeCooldownMs, parseRetryAfterMs, BASE_COOLDOWN_MS, MAX_COOLDOWN_MS } from "./cooldown";

let results: boolean[] = [];

function check(label: string, ok: boolean, detail?: unknown): void {
  results.push(ok);
  console.log(`${ok ? "✅" : "❌"} ${label}${ok ? "" : ` — ${JSON.stringify(detail)}`}`);
}

function main(): void {
  console.log("== Fase 5B — prueba de aceptación (cooldown/backoff) ==\n");

  // --- Backoff: crecimiento exponencial, sin jitter (random fijo en el centro → factor 1.0) ---
  {
    console.log("--- Backoff exponencial (jitter neutralizado en el centro, random()=0.5 → factor 1.0) ---");
    const center = () => 0.5;
    const n1 = computeCooldownMs(1, { random: center });
    const n2 = computeCooldownMs(2, { random: center });
    const n3 = computeCooldownMs(3, { random: center });
    check("n=1 → BASE_COOLDOWN_MS (2000ms) exacto", n1 === BASE_COOLDOWN_MS, n1);
    check("n=2 → 2×BASE (4000ms) exacto", n2 === BASE_COOLDOWN_MS * 2, n2);
    check("n=3 → 4×BASE (8000ms) exacto", n3 === BASE_COOLDOWN_MS * 4, n3);
  }

  // --- Cooldown máximo de 60s antes de jitter ---
  {
    console.log("\n--- Cooldown máximo (60s) antes de jitter ---");
    const center = () => 0.5; // factor 1.0, así el resultado ES la base cruda
    const nGrande = computeCooldownMs(10, { random: center }); // 2000×2^9 = 1,024,000 >> 60000
    check(`n=10 con factor neutro cae exactamente en MAX_COOLDOWN_MS (${MAX_COOLDOWN_MS}ms), confirmando el cap`, nGrande === MAX_COOLDOWN_MS, nGrande);
  }

  // --- Jitter: límites exactos con RNG determinista ---
  {
    console.log("\n--- Jitter: random=mínimo → 80%, random=centro → 100%, random=máximo → 120% ---");
    const n = 1; // base = 2000ms exactos, fácil de verificar los porcentajes
    const atMin = computeCooldownMs(n, { random: () => 0 });
    const atCenter = computeCooldownMs(n, { random: () => 0.5 });
    const atMax = computeCooldownMs(n, { random: () => 1 });
    check("random=0 → 80% de la base (1600ms)", atMin === Math.round(BASE_COOLDOWN_MS * 0.8), atMin);
    check("random=0.5 → 100% de la base (2000ms)", atCenter === BASE_COOLDOWN_MS, atCenter);
    check("random=1 → 120% de la base (2400ms)", atMax === Math.round(BASE_COOLDOWN_MS * 1.2), atMax);
  }

  // --- El jitter aplicado al cap SÍ puede superar levemente MAX_COOLDOWN_MS (comportamiento pedido, no bug) ---
  {
    console.log("\n--- El jitter se aplica DESPUÉS del cap: con random=1 sobre n grande, el resultado supera MAX_COOLDOWN_MS en hasta un 20% ---");
    const nGrande = computeCooldownMs(10, { random: () => 1 });
    check(
      `n=10, random=1 → ${MAX_COOLDOWN_MS}×1.2 = ${Math.round(MAX_COOLDOWN_MS * 1.2)}ms exactos (supera el cap a propósito, según la fórmula aprobada)`,
      nGrande === Math.round(MAX_COOLDOWN_MS * 1.2),
      nGrande,
    );
  }

  // --- Nunca negativo ---
  {
    console.log("\n--- El resultado nunca es negativo ---");
    const r = computeCooldownMs(0, { random: () => 0 }); // consecutiveFailures<1 se trata como 1 (Math.max interno)
    check("consecutiveFailures=0 no produce un resultado negativo ni NaN", r >= 0 && Number.isFinite(r), r);
  }

  // --- parseRetryAfterMs: segundos ya parseados ---
  {
    console.log("\n--- parseRetryAfterMs: número de segundos ya parseado (ej. OpenRouterError.retryAfterSeconds) ---");
    const ms = parseRetryAfterMs({ seconds: 3 }, 0);
    check("seconds:3 → 3000ms", ms === 3000, ms);
    const zero = parseRetryAfterMs({ seconds: 0 }, 0);
    check("seconds:0 → 0ms (válido, no se confunde con 'ausente')", zero === 0, zero);
  }

  // --- parseRetryAfterMs: header crudo, formato segundos ---
  {
    console.log("\n--- parseRetryAfterMs: header crudo formato 'segundos enteros' (RFC 9110) ---");
    const ms = parseRetryAfterMs({ header: "120" }, 0);
    check("header:'120' → 120000ms", ms === 120000, ms);
    const withSpaces = parseRetryAfterMs({ header: "  45  " }, 0);
    check("header con espacios alrededor se recorta igual", withSpaces === 45000, withSpaces);
  }

  // --- parseRetryAfterMs: header crudo, formato fecha HTTP ---
  {
    console.log("\n--- parseRetryAfterMs: header crudo formato fecha HTTP (RFC 9110) ---");
    const now = Date.parse("Wed, 21 Oct 2026 07:28:00 GMT");
    const future = "Wed, 21 Oct 2026 07:28:05 GMT"; // 5s después
    const ms = parseRetryAfterMs({ header: future }, now);
    check("fecha HTTP 5s en el futuro → ~5000ms", ms === 5000, ms);
    const past = "Wed, 21 Oct 2026 07:27:00 GMT"; // 60s antes de `now`
    const msPast = parseRetryAfterMs({ header: past }, now);
    check("fecha HTTP ya pasada → 0ms, nunca negativo", msPast === 0, msPast);
  }

  // --- parseRetryAfterMs: ausencia / basura ---
  {
    console.log("\n--- parseRetryAfterMs: sin información utilizable → null ---");
    const none = parseRetryAfterMs({});
    check("sin seconds ni header → null", none === null, none);
    const garbage = parseRetryAfterMs({ header: "no-soy-una-fecha-ni-un-numero" });
    check("header no parseable → null", garbage === null, garbage);
    const empty = parseRetryAfterMs({ header: "   " });
    check("header vacío/solo espacios → null", empty === null, empty);
  }

  // --- seconds gana sobre header si ambos están presentes ---
  {
    console.log("\n--- Si vienen ambos, seconds (ya parseado) gana sobre header (crudo) ---");
    const ms = parseRetryAfterMs({ seconds: 2, header: "999" }, 0);
    check("seconds:2 gana sobre header:'999'", ms === 2000, ms);
  }

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} casos OK.`);
  if (passed !== results.length) process.exit(1);
}

main();
