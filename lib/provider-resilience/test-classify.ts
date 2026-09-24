/**
 * Prueba de aceptación de la Fase 5B — parte 2: `classify.ts`, cubriendo
 * cada fila de la tabla definitiva de clasificación, más un puñado de
 * tests de integración que combinan `classify.ts` + `cooldown.ts` +
 * `CredentialPool` (de 5A) para demostrar comportamientos que solo se ven
 * en conjunto (cooldown creciente real, éxito reseteando el contador,
 * `INVALID` permanente, y el caso central de la ronda 3: un 503 en las 3
 * credentials NO debe interpretarse como "3 credentials malas").
 *
 * Sigue sin tocar `loop.ts`, `council-run.ts` ni ningún cliente de
 * provider — todo esto es orquestación de prueba, no integración real.
 *
 * Uso: npm run provider-resilience:test-classify
 */
import { classifyProviderError, type ProviderErrorInput } from "./classify";
import { computeCooldownMs } from "./cooldown";
import { CredentialPool, type CredentialEntry } from "./pool";

let results: boolean[] = [];

function check(label: string, ok: boolean, detail?: unknown): void {
  results.push(ok);
  console.log(`${ok ? "✅" : "❌"} ${label}${ok ? "" : ` — ${JSON.stringify(detail)}`}`);
}

function pool(...ids: string[]): CredentialPool {
  const entries: CredentialEntry[] = ids.map((id) => ({ id, value: `secret-${id}` }));
  return new CredentialPool(entries);
}

function main(): void {
  console.log("== Fase 5B — prueba de aceptación (classifyProviderError) ==\n");

  // ---------- 429 ----------
  console.log("--- 429 ---");
  {
    const c = classifyProviderError({ kind: "http", status: 429, retryAfterSeconds: 3 });
    check("429 + Retry-After 3s (≤5s): retrySameKey=true, category RETRY_SAME_KEY", c.retrySameKey && c.category === "RETRY_SAME_KEY", c);
    check("429 + Retry-After 3s: poolAction COOLDOWN, retryAfterMs=3000", c.poolAction === "COOLDOWN" && c.retryAfterMs === 3000, c);
  }
  {
    const c = classifyProviderError({ kind: "http", status: 429, retryAfterSeconds: 12 });
    check("429 + Retry-After 12s (>5s): retrySameKey=false, category FAILOVER_CREDENTIAL", !c.retrySameKey && c.category === "FAILOVER_CREDENTIAL", c);
    check("429 + Retry-After 12s: poolAction COOLDOWN igual (sí afecta salud)", c.poolAction === "COOLDOWN", c);
  }
  {
    const c = classifyProviderError({ kind: "http", status: 429 });
    check("429 sin Retry-After: retrySameKey=false, retryAfterMs=null, poolAction COOLDOWN", !c.retrySameKey && c.retryAfterMs === null && c.poolAction === "COOLDOWN", c);
  }
  check("429 (cualquier variante): allowModelFallback=true", classifyProviderError({ kind: "http", status: 429 }).allowModelFallback === true);

  // ---------- 401 ----------
  console.log("\n--- 401 ---");
  {
    const c = classifyProviderError({ kind: "http", status: 401 });
    check("401: poolAction INVALID, retrySameKey=false", c.poolAction === "INVALID" && !c.retrySameKey, c);
  }

  // ---------- 403 ----------
  console.log("\n--- 403 ---");
  {
    const c = classifyProviderError({ kind: "http", status: 403, message: "You have exceeded your current quota, please check your plan" });
    check("403 + evidencia de cuota/plan → poolAction COOLDOWN, failoverCredential=true", c.poolAction === "COOLDOWN" && c.failoverCredential, c);
  }
  {
    const c = classifyProviderError({ kind: "http", status: 403, message: "Invalid API key provided" });
    check("403 + evidencia de auth inválida → poolAction INVALID, failoverCredential=true", c.poolAction === "INVALID" && c.failoverCredential, c);
  }
  {
    const c = classifyProviderError({ kind: "http", status: 403, message: "Your request was flagged by our content_policy system" });
    check("403 + evidencia de policy/safety → PERMANENT, poolAction NONE, sin failover", c.category === "PERMANENT" && c.poolAction === "NONE" && !c.failoverCredential, c);
  }
  {
    const c = classifyProviderError({ kind: "http", status: 403, message: "Something went wrong, contact support" });
    check(
      "403 sin evidencia suficiente → PERMANENT, poolAction NONE, sin failover 'por las dudas'",
      c.category === "PERMANENT" && c.poolAction === "NONE" && !c.failoverCredential && c.reason === "403_unknown",
      c,
    );
  }
  {
    const c = classifyProviderError({ kind: "http", status: 403 }); // sin message en absoluto
    check("403 sin ningún mensaje → también 403_unknown, PERMANENT", c.reason === "403_unknown" && c.category === "PERMANENT", c);
  }

  // ---------- 5xx ----------
  console.log("\n--- 500/502/503 ---");
  for (const status of [500, 502, 503]) {
    const c = classifyProviderError({ kind: "http", status });
    check(`${status}: retrySameKey=true, failoverCredential=true, PERO poolAction NONE (nunca afecta salud)`, c.retrySameKey && c.failoverCredential && c.poolAction === "NONE", c);
  }

  // ---------- Timeout / network ----------
  console.log("\n--- Timeout / network error ---");
  {
    const c = classifyProviderError({ kind: "timeout" });
    check("timeout: retrySameKey=true, failoverCredential=true, poolAction NONE", c.retrySameKey && c.failoverCredential && c.poolAction === "NONE", c);
  }
  {
    const c = classifyProviderError({ kind: "network" });
    check("network: retrySameKey=true, failoverCredential=true, poolAction NONE", c.retrySameKey && c.failoverCredential && c.poolAction === "NONE", c);
  }

  // ---------- Otros permanentes ----------
  console.log("\n--- 400 / 404 / context / policy / unknown ---");
  {
    const c = classifyProviderError({ kind: "http", status: 400 });
    check("400 plano: PERMANENT, sin retry, sin failover, sin fallback de modelo", c.category === "PERMANENT" && !c.retrySameKey && !c.failoverCredential && !c.allowModelFallback, c);
  }
  {
    const c = classifyProviderError({ kind: "http", status: 400, message: "This model's maximum context length is 128000 tokens" });
    check("400 con indicio de contexto → reason context_too_large, mismo comportamiento permanente", c.reason === "context_too_large" && c.category === "PERMANENT", c);
  }
  {
    const c = classifyProviderError({ kind: "http", status: 400, message: "Blocked by safety policy" });
    check("400 con indicio de policy → reason policy_safety, permanente", c.reason === "policy_safety" && c.category === "PERMANENT", c);
  }
  {
    const c = classifyProviderError({ kind: "http", status: 404 });
    check("404/modelo inexistente: category FAILOVER_MODEL, allowModelFallback=true, sin tocar el pool", c.category === "FAILOVER_MODEL" && c.allowModelFallback && c.poolAction === "NONE", c);
  }
  {
    const c = classifyProviderError({ kind: "unknown" });
    check("desconocido (primer fallo): retrySameKey=true conservador, failoverCredential=false todavía, poolAction NONE", c.retrySameKey && !c.failoverCredential && c.poolAction === "NONE", c);
  }
  {
    const c = classifyProviderError({ kind: "http", status: 402 }); // código no cubierto explícitamente por la tabla
    check("status HTTP no reconocido por la tabla: tratado como conservador, sin tocar el pool", c.poolAction === "NONE" && !c.failoverCredential, c);
  }

  // ==================== Integración: classify + cooldown + pool ====================
  console.log("\n--- Integración: cooldown creciente real a través de classify()+pool.release() ---");
  {
    const p = pool("A");
    let cursor = p.beginOperation();
    let lease = cursor.next(0);
    check("setup: A disponible al arrancar", lease.status === "AVAILABLE", lease);

    // Primer 429 sobre A.
    const c1 = classifyProviderError({ kind: "http", status: 429 }, 0);
    const failuresAfterFirst = (p.snapshot(0).find((s) => s.id === "A")?.consecutiveFailures ?? 0) + 1;
    const cooldown1 = computeCooldownMs(failuresAfterFirst, { random: () => 0.5 }); // sin jitter, para comparar limpio
    p.release("A", c1.poolAction === "COOLDOWN" ? "cooldown" : "success", 0, cooldown1);
    const snap1 = p.snapshot(0).find((s) => s.id === "A")!;
    check("tras el 1er 429: consecutiveFailures=1, cooldownUntil = 0 + cooldown1", snap1.consecutiveFailures === 1 && snap1.cooldownUntil === cooldown1, { snap1, cooldown1 });

    // Segundo 429 sobre A, más tarde.
    const t2 = cooldown1 + 1; // ya expiró el primer cooldown
    const c2 = classifyProviderError({ kind: "http", status: 429 }, t2);
    const failuresAfterSecond = snap1.consecutiveFailures + 1;
    const cooldown2 = computeCooldownMs(failuresAfterSecond, { random: () => 0.5 });
    p.release("A", c2.poolAction === "COOLDOWN" ? "cooldown" : "success", t2, cooldown2);
    const snap2 = p.snapshot(t2).find((s) => s.id === "A")!;
    check(
      "tras el 2do 429: consecutiveFailures=2, cooldown2 > cooldown1 (backoff realmente crece)",
      snap2.consecutiveFailures === 2 && cooldown2 > cooldown1,
      { snap2, cooldown1, cooldown2 },
    );

    // Éxito resetea todo.
    p.release("A", "success", t2 + cooldown2 + 1);
    const snap3 = p.snapshot(t2 + cooldown2 + 1).find((s) => s.id === "A")!;
    check("success resetea consecutiveFailures a 0 y cooldownUntil a null", snap3.consecutiveFailures === 0 && snap3.cooldownUntil === null && snap3.status === "AVAILABLE", snap3);
  }

  console.log("\n--- Integración: 401 vía classify() deja la credential INVALID para siempre, ni un success la revive ---");
  {
    const p = pool("A", "B");
    const c = classifyProviderError({ kind: "http", status: 401 }, 0);
    check("classify(401).poolAction === INVALID", c.poolAction === "INVALID", c);
    p.release("A", "invalid", 0);
    p.release("A", "success", 1000); // intento posterior de revivirla — no debe funcionar
    const cursor = p.beginOperation();
    const r1 = cursor.next(1000);
    check("tras 401 clasificado + intento de success posterior, A sigue INVALID — el cursor da B directo", r1.status === "AVAILABLE" && r1.lease.id === "B", r1);
  }

  console.log("\n--- Integración: un 503 en las 3 credentials NO debe interpretarse como '3 credentials malas' ---");
  {
    const p = pool("A", "B", "C");
    const cursor = p.beginOperation();
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = cursor.next(0);
      if (r.status !== "AVAILABLE") break;
      seen.push(r.lease.id);
      const c = classifyProviderError({ kind: "http", status: 503 }, 0);
      // poolAction === "NONE" → el caller correcto NO llama a release() en absoluto.
      if (c.poolAction !== "NONE") {
        p.release(r.lease.id, "cooldown", 0);
      }
    }
    check("el cursor efectivamente recorrió las 3 credentials dentro de la misma operación (failover permitido)", JSON.stringify(seen) === JSON.stringify(["A", "B", "C"]), seen);
    const snapAfter = p.snapshot(0);
    check(
      "pero NINGUNA quedó en cooldown ni con consecutiveFailures>0 — el 503 no contamina la salud de ninguna credential",
      snapAfter.every((s) => s.status === "AVAILABLE" && s.consecutiveFailures === 0),
      snapAfter,
    );
    // Una operación siguiente, inmediatamente después, ve las 3 disponibles de entrada.
    const nextOpCursor = p.beginOperation();
    const nextPick = nextOpCursor.next(0);
    check("la siguiente operación arranca con las 3 igual de disponibles (nada heredado del incidente 503 anterior)", nextPick.status === "AVAILABLE", nextPick);
  }

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} casos OK.`);
  if (passed !== results.length) process.exit(1);
}

main();
