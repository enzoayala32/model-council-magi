/**
 * Fase 5F — Observability.
 *
 * Representación común de "algo pasó en Provider Resilience", reutilizada
 * por el Coding Agent (persistida en `agent_events` vía
 * `lib/agent/event-log.ts`) y el Model Council (en memoria vía
 * `council-log.ts`, en este mismo directorio). Módulo puramente
 * descriptivo — no decide nada, no importa `generateText`/`fetch`, y NO
 * modifica el comportamiento de `pool.ts`/`classify.ts`/`cooldown.ts`: solo
 * los interpreta para producir algo legible.
 *
 * `credentialId` es SIEMPRE el id sintético del pool (ej. "openrouter-2",
 * el mismo que ya usan `CredentialLease`/`CredentialState` de 5A) — nunca
 * el secreto. `reason` es SIEMPRE una etiqueta estable (el `reason` de
 * `classify.ts`, o uno de los `ExhaustionReason` de abajo), nunca texto
 * crudo de un proveedor — ningún campo de este archivo necesita pasar por
 * `redactSecrets()` porque ninguno contiene jamás el valor real de una
 * credential.
 */

import type { ProviderName } from "./config";
import type { CredentialState } from "./pool";

/** Qué resultó de un intento de usar (o de obtener) una credential:
 * - "rotated": una credential falló y SÍ se pasó a probar otra.
 * - "stopped": una credential falló pero NO se rotó (error no
 *   failover-eligible, o — solo en el Coding Agent — la regla de Step 0 lo
 *   impide pese a que el error sí lo permitiría en principio; ver `note`).
 * - "exhausted": no se pudo obtener NINGUNA credential para este intento
 *   (el cursor no tiene ninguna disponible ahora mismo) — no hay ninguna
 *   credential concreta que reportar, por eso `credentialId`/`poolAction`
 *   van en `null` en ese caso. */
export type ProviderResilienceOutcome = "rotated" | "stopped" | "exhausted";

export type ProviderResilienceEvent = {
  id: string;
  ts: number;
  source: "agent" | "council";
  provider: ProviderName;
  credentialId: string | null;
  reason: string;
  poolAction: "NONE" | "COOLDOWN" | "INVALID" | null;
  outcome: ProviderResilienceOutcome;
  /** Nota humana opcional, libre de secretos, para el único caso que los
   * demás campos no explican del todo por sí solos: el Coding Agent
   * bloqueando una rotación que el error sí habilitaría, por la regla de
   * Step 0 (ver `lib/agent/loop.ts`). El Council nunca la usa — no tiene
   * esa regla. */
  note?: string;
};

/** Por qué `cursor.next()` no pudo entregar ninguna credential — calculado
 * a partir del snapshot REAL del pool en ese momento (`pool.snapshot()`,
 * API ya existente de 5A, sin tocarla), nunca de la exclusión privada del
 * cursor (a la que este módulo no tiene ni debería tener acceso). Cubre
 * exactamente los casos reales que el pool puede producir:
 * - "no_credentials_configured": el pool está vacío (nunca hubo nada que
 *   descubrir en `.env`).
 * - "all_invalid": todas las credentials configuradas son INVALID.
 * - "all_cooldown": ninguna es INVALID, pero ninguna está AVAILABLE
 *   tampoco — todas en COOLDOWN.
 * - "invalid_and_cooldown": mezcla real de las dos anteriores.
 * - "operation_exhausted": el pool SÍ tiene credentials AVAILABLE ahora
 *   mismo (ej. porque el error que falló no degradó su salud —
 *   poolAction NONE), pero esta operación puntual ya las probó todas y su
 *   cursor no puede repetirlas — otra operación sí podría usarlas ya
 *   mismo. */
export type ExhaustionReason = "no_credentials_configured" | "all_invalid" | "all_cooldown" | "invalid_and_cooldown" | "operation_exhausted";

export type ExhaustionClassification = {
  reason: ExhaustionReason;
  available: number;
  cooldown: number;
  invalid: number;
};

export function classifyExhaustion(snapshot: readonly CredentialState[]): ExhaustionClassification {
  const available = snapshot.filter((s) => s.status === "AVAILABLE").length;
  const cooldown = snapshot.filter((s) => s.status === "COOLDOWN").length;
  const invalid = snapshot.filter((s) => s.status === "INVALID").length;

  if (snapshot.length === 0) return { reason: "no_credentials_configured", available, cooldown, invalid };
  if (invalid === snapshot.length) return { reason: "all_invalid", available, cooldown, invalid };
  if (available === 0 && cooldown > 0 && invalid === 0) return { reason: "all_cooldown", available, cooldown, invalid };
  if (available === 0 && cooldown > 0 && invalid > 0) return { reason: "invalid_and_cooldown", available, cooldown, invalid };
  return { reason: "operation_exhausted", available, cooldown, invalid };
}

/** Arma el mensaje humano final a partir de la clasificación de arriba —
 * separado de `classifyExhaustion` para que un test pueda verificar la
 * clasificación (el dato) y el texto (la presentación) por separado. */
export function describeExhaustion(provider: ProviderName, envPrefix: string, classified: ExhaustionClassification): string {
  const { reason, available, cooldown, invalid } = classified;
  switch (reason) {
    case "no_credentials_configured":
      return `No hay ninguna credential configurada para ${provider} (revisá ${envPrefix} en .env).`;
    case "all_invalid":
      return `Las credential(es) configuradas para ${provider} quedaron todas INVALID (revisá ${envPrefix} en .env).`;
    case "all_cooldown":
      return `Las credential(es) de ${provider} están todas en cooldown ahora mismo.`;
    case "invalid_and_cooldown":
      return `Ninguna credential de ${provider} está disponible ahora: ${invalid} INVALID, ${cooldown} en cooldown.`;
    case "operation_exhausted":
      return `No quedó ninguna credential de ${provider} sin probar en este intento (estado actual del pool: ${available} disponible(s), ${cooldown} en cooldown, ${invalid} inválida(s)).`;
  }
}
