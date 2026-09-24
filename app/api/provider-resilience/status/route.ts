import { NextResponse } from "next/server";
import { getProviderPool } from "@/lib/provider-resilience/registry";
import { getProviderSnapshot, type ProviderName } from "@/lib/provider-resilience/config";
import { getCouncilResilienceLog } from "@/lib/provider-resilience/council-log";

/**
 * Fase 5F — snapshot de solo lectura de Provider Resilience: estado actual
 * de cada credential por provider (`AVAILABLE`/`COOLDOWN`/`INVALID`,
 * `consecutiveFailures`, `cooldownUntil`) más los eventos recientes de
 * failover del Council (el Coding Agent ya tiene los suyos en
 * `agent_events`, consultables vía `/api/agent/tasks/[id]/events` — acá NO
 * se duplican, la UI del Agent los sigue mostrando desde ahí).
 *
 * Mismo patrón que `GET /api/council/model-health` (`lib/model-health.ts`):
 * sin body, sin parámetros, snapshot en memoria del proceso — nada que
 * configurar. Sin autenticación, igual que las otras 18 rutas de `app/api/`
 * de este proyecto (self-hosted, sin ningún middleware/sesión en todo el
 * repo — confirmado antes de escribir esto, no se inventa un esquema nuevo
 * solo para este endpoint).
 *
 * Nunca expone el `value` de una credential — `getProviderSnapshot()` (5C)
 * ya lo garantiza por construcción (reusa `CredentialState` de 5A, que
 * jamás incluye el secreto), y los eventos del Council (`events.ts`) tienen
 * el mismo invariante.
 */
const PROVIDERS: readonly ProviderName[] = ["openrouter", "nvidia", "google"];

export async function GET() {
  const providers = PROVIDERS.map((provider) => getProviderSnapshot(provider, getProviderPool(provider)));
  const councilEvents = getCouncilResilienceLog();
  return NextResponse.json({ providers, councilEvents });
}
