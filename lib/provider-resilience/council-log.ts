/**
 * Fase 5F — log en memoria, acotado, de eventos de Provider Resilience para
 * el Model Council. El Council no tiene un equivalente a `agent_events`
 * (`lib/agent/event-log.ts`) — nunca tuvo persistencia por-run — así que
 * esto es puramente proceso-local, se reinicia con el server, mismo patrón
 * ya establecido en este proyecto para el mismo problema (estado
 * observable sin DB): ver `lib/model-health.ts`.
 *
 * Seguro ante concurrencia SIN ningún locking explícito: `record`/`getAll`
 * son síncronos de punta a punta (sin ningún `await` en el medio), y Node
 * es single-threaded — aunque `council-run.ts` dispare muchos
 * `withCredentialFailover` en paralelo vía `Promise.all` (drafts, rondas de
 * debate, votos), cada llamada a `recordCouncilResilienceEvent` corre hasta
 * el final antes de que la siguiente pueda empezar. Mismo razonamiento que
 * ya vale para `CredentialPool` (5A) y que motivó explícitamente descartar
 * `inFlight`/locking en el diseño de Fase 5.
 */

import type { ProviderResilienceEvent } from "./events";

/** Acotado a propósito — esto es un log operacional de "qué pasó
 * recientemente", no un histórico. 50 entradas alcanza para cubrir varios
 * runs consecutivos con failovers sin crecer sin límite. */
const MAX_ENTRIES = 50;

const log: ProviderResilienceEvent[] = [];

export function recordCouncilResilienceEvent(event: ProviderResilienceEvent): void {
  log.push(event);
  if (log.length > MAX_ENTRIES) log.shift();
}

/** Copia — mutar el array devuelto nunca afecta el log real. Orden: más
 * antiguo primero (mismo orden de inserción), igual que `agent_events`. */
export function getCouncilResilienceLog(): ProviderResilienceEvent[] {
  return [...log];
}

/** Solo para tests — nunca se llama fuera de uno. */
export function __clearCouncilResilienceLogForTests(): void {
  log.length = 0;
}
