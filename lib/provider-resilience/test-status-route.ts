/**
 * Fase 5F — prueba de contrato del endpoint `GET
 * /api/provider-resilience/status`. Llama al route handler de Next.js
 * DIRECTAMENTE (mismo patrón que `lib/agent/test-agent-routes.ts` — es una
 * función `() => Response` normal, sin necesitar un server real). No es una
 * suite E2E: solo confirma que el shape es el esperado y que nunca se
 * filtra un secreto.
 *
 * Uso: npm run provider-resilience:test-status-route
 */
import { GET as statusRoute } from "../../app/api/provider-resilience/status/route";
import { __resetProviderPoolsForTests } from "./registry";
import { recordCouncilResilienceEvent, __clearCouncilResilienceLogForTests } from "./council-log";

let results: boolean[] = [];

function check(label: string, ok: boolean, detail?: unknown): void {
  results.push(ok);
  console.log(`${ok ? "✅" : "❌"} ${label}${ok ? "" : ` — ${JSON.stringify(detail)}`}`);
}

function setOpenRouterCredentials(...values: string[]): void {
  const prefix = "OPENROUTER_API_KEY";
  delete process.env[prefix];
  for (const key of Object.keys(process.env)) {
    if (key.startsWith(`${prefix}_`)) delete process.env[key];
  }
  values.forEach((value, index) => {
    if (index === 0) process.env[prefix] = value;
    else process.env[`${prefix}_${index + 1}`] = value;
  });
}

async function main(): Promise<void> {
  console.log("== Fase 5F — prueba de contrato (GET /api/provider-resilience/status) ==\n");

  __resetProviderPoolsForTests();
  __clearCouncilResilienceLogForTests();
  setOpenRouterCredentials("SECRET-QUE-NUNCA-DEBE-APARECER-EN-LA-RESPUESTA");
  recordCouncilResilienceEvent({ id: "ev-1", ts: Date.now(), source: "council", provider: "openrouter", credentialId: "openrouter-1", reason: "429_no_retry_after", poolAction: "COOLDOWN", outcome: "rotated" });

  const response = await statusRoute();
  check("responde 200", response.status === 200, response.status);

  const body = (await response.json()) as { providers: unknown[]; councilEvents: unknown[] };
  check("trae los 3 providers (openrouter/nvidia/google)", Array.isArray(body.providers) && body.providers.length === 3, body.providers);
  check("trae los eventos del Council", Array.isArray(body.councilEvents) && body.councilEvents.length === 1, body.councilEvents);

  const raw = JSON.stringify(body);
  check("la credential seteada (aunque sea la real) NUNCA aparece en el JSON de respuesta", !raw.includes("SECRET-QUE-NUNCA-DEBE-APARECER"), raw);

  const openrouter = body.providers.find((p) => (p as { provider: string }).provider === "openrouter") as { credentials: { id: string; status: string }[] } | undefined;
  check("el provider openrouter trae al menos 1 credential con id+status (nunca el value)", !!openrouter && openrouter.credentials.length >= 1 && !!openrouter.credentials[0].id && !!openrouter.credentials[0].status, openrouter);

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} casos OK.`);
  if (passed !== results.length) process.exit(1);
}

main().catch((error) => {
  console.error("Error inesperado en la prueba:", error);
  process.exit(1);
});
