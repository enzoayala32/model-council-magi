/**
 * Fase 5F — prueba de aceptación pura (sin pool real, sin red) de
 * `classifyExhaustion`/`describeExhaustion` (`lib/provider-resilience/
 * events.ts`). Objetivo puntual: demostrar que el mensaje de agotamiento
 * distingue correctamente los 5 estados reales que puede devolver
 * `pool.snapshot()` — antes de este fix, un único texto genérico ("...o
 * todas las configuradas quedaron INVALID") se usaba para todos ellos por
 * igual. `lib/agent/test-provider-resilience.ts` (Casos 3/13/15) y
 * `lib/test-council-resilience.ts` (Caso 24) ya prueban esto integrado con
 * `runAgentLoop`/`withCredentialFailover` reales — este archivo cubre los
 * casos de borde que armar vía HTTP fake sería más indirecto (mezclas
 * exactas de conteos).
 *
 * Uso: npm run provider-resilience:test-events
 */
import { classifyExhaustion, describeExhaustion } from "./events";
import type { CredentialState } from "./pool";

let results: boolean[] = [];

function check(label: string, ok: boolean, detail?: unknown): void {
  results.push(ok);
  console.log(`${ok ? "✅" : "❌"} ${label}${ok ? "" : ` — ${JSON.stringify(detail)}`}`);
}

function cred(status: CredentialState["status"]): CredentialState {
  return { id: `cred-${Math.random().toString(36).slice(2, 8)}`, status, cooldownUntil: status === "COOLDOWN" ? Date.now() + 5000 : null, consecutiveFailures: status === "AVAILABLE" ? 0 : 1, lastUsedAt: Date.now() };
}

async function main(): Promise<void> {
  console.log("== Fase 5F — prueba de aceptación (classifyExhaustion / describeExhaustion) ==\n");

  console.log("--- Caso 1: pool vacío → no_credentials_configured ---");
  {
    const c = classifyExhaustion([]);
    check("reason correcto", c.reason === "no_credentials_configured", c);
    const msg = describeExhaustion("openrouter", "OPENROUTER_API_KEY", c);
    check("menciona .env y el prefijo real", msg.includes("OPENROUTER_API_KEY") && msg.includes(".env"), msg);
    check("NO menciona INVALID ni cooldown (sería engañoso)", !msg.includes("INVALID") && !msg.toLowerCase().includes("cooldown"), msg);
  }

  console.log("\n--- Caso 2: todas INVALID ---");
  {
    const snapshot = [cred("INVALID"), cred("INVALID")];
    const c = classifyExhaustion(snapshot);
    check("reason correcto", c.reason === "all_invalid", c);
    const msg = describeExhaustion("nvidia", "NVIDIA_API_KEY", c);
    check("menciona INVALID", msg.includes("INVALID"), msg);
    check("NO menciona cooldown (sería engañoso)", !msg.toLowerCase().includes("cooldown"), msg);
  }

  console.log("\n--- Caso 3: todas COOLDOWN (el caso más común en producción — ya NO cae en el mensaje de INVALID) ---");
  {
    const snapshot = [cred("COOLDOWN"), cred("COOLDOWN"), cred("COOLDOWN")];
    const c = classifyExhaustion(snapshot);
    check("reason correcto", c.reason === "all_cooldown", c);
    const msg = describeExhaustion("openrouter", "OPENROUTER_API_KEY", c);
    check("menciona cooldown", msg.toLowerCase().includes("cooldown"), msg);
    check("NO menciona INVALID (era exactamente el bug que se corrigió)", !msg.includes("INVALID"), msg);
  }

  console.log("\n--- Caso 4: mezcla real INVALID + COOLDOWN ---");
  {
    const snapshot = [cred("INVALID"), cred("COOLDOWN"), cred("COOLDOWN")];
    const c = classifyExhaustion(snapshot);
    check("reason correcto, conteos exactos (1 invalid, 2 cooldown)", c.reason === "invalid_and_cooldown" && c.invalid === 1 && c.cooldown === 2, c);
    const msg = describeExhaustion("google", "GOOGLE_AI_STUDIO_API_KEY", c);
    check("menciona ambos números", msg.includes("1") && msg.includes("2"), msg);
  }

  console.log("\n--- Caso 5: operation_exhausted — hay AVAILABLE globalmente, pero esta operación ya las probó todas ---");
  {
    const snapshot = [cred("AVAILABLE"), cred("AVAILABLE"), cred("COOLDOWN")];
    const c = classifyExhaustion(snapshot);
    check("reason correcto, conteos exactos (2 available, 1 cooldown, 0 invalid)", c.reason === "operation_exhausted" && c.available === 2 && c.cooldown === 1 && c.invalid === 0, c);
    const msg = describeExhaustion("openrouter", "OPENROUTER_API_KEY", c);
    check("el mensaje refleja que SÍ hay disponibles (para otra operación), no dice 'ninguna configurada' ni 'todas caídas'", msg.includes("2 disponible"), msg);
  }

  console.log("\n--- Caso 6: describeExhaustion nunca produce 'undefined' en el texto para ningún reason ---");
  {
    const cases: CredentialState[][] = [[], [cred("INVALID")], [cred("COOLDOWN")], [cred("INVALID"), cred("COOLDOWN")], [cred("AVAILABLE"), cred("COOLDOWN")]];
    const ok = cases.every((snapshot) => !describeExhaustion("openrouter", "OPENROUTER_API_KEY", classifyExhaustion(snapshot)).includes("undefined"));
    check("ningún mensaje contiene 'undefined'", ok);
  }

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} casos OK.`);
  if (passed !== results.length) process.exit(1);
}

main().catch((error) => {
  console.error("Error inesperado en la prueba:", error);
  process.exit(1);
});
