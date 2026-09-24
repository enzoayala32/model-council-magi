/**
 * Fase 5E — registry compartido de pools singleton, extraído mecánicamente
 * de `lib/agent/loop.ts` (donde vivía desde 5D). Este archivo es el ÚNICO
 * dueño de los 3 pools por provider — Coding Agent y Model Council importan
 * de acá, así que comparten la MISMA instancia de cada `CredentialPool`
 * (Node cachea el módulo una sola vez por proceso). Antes de esta
 * extracción, `loop.ts` tenía su propio `providerPools` privado y Council
 * no tenía forma de alcanzarlo — exactamente la contradicción reportada en
 * el diseño de 5E, ronda de auditoría, sección 15.
 *
 * Extracción puramente mecánica: ni la lógica de `getProviderPool` ni el
 * comportamiento de `CredentialPool`/`config.ts` cambiaron un solo
 * carácter — solo cambió EN QUÉ ARCHIVO vive el `Map` module-level.
 */

import { createProviderPool, type ProviderName } from "./config";
import { CredentialPool } from "./pool";

export const ENV_PREFIX_BY_PROVIDER: Record<ProviderName, string> = {
  openrouter: "OPENROUTER_API_KEY",
  nvidia: "NVIDIA_API_KEY",
  google: "GEMINI_API_KEY",
};

/** Un pool por provider, creado UNA SOLA VEZ por proceso — nunca por
 * request/task/operación. Esto es lo que hace que el estado de
 * COOLDOWN/INVALID realmente persista entre distintas corridas (tasks del
 * Agent, runs del Council, ambos indistintamente) — si se creara un pool
 * nuevo cada vez, cada corrida arrancaría con todas las credentials
 * "sanas" de nuevo y el failover/cooldown no serviría de nada más allá de
 * esa única corrida individual. */
const providerPools = new Map<ProviderName, CredentialPool>();

export function getProviderPool(provider: ProviderName): CredentialPool {
  const existing = providerPools.get(provider);
  if (existing) return existing;
  const pool = createProviderPool(provider, ENV_PREFIX_BY_PROVIDER[provider]);
  providerPools.set(provider, pool);
  return pool;
}

/** Solo para tests — limpia los pools singleton para que cada caso pueda
 * arrancar con credentials y estado limpio, controlando `process.env` a
 * mano antes de correr un `runAgentLoop`/`withCredentialFailover`. Mismo
 * patrón ya establecido en este proyecto para el mismo problema
 * (singletons de proceso durante tests) — ver `__resetDispatcherForTests`
 * en `lib/agent/dispatcher.ts`. Nunca se llama fuera de un test. */
export function __resetProviderPoolsForTests(): void {
  providerPools.clear();
}

/** Solo para tests — expone el pool singleton de un provider para poder
 * inspeccionar su `snapshot()` después de una corrida (confirmar
 * INVALID/COOLDOWN/AVAILABLE por credential). Nunca se usa fuera de un
 * test. */
export function __getProviderPoolForTests(provider: ProviderName): CredentialPool {
  return getProviderPool(provider);
}
