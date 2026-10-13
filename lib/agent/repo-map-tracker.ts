/**
 * Fase 7D — Seguimiento de mutaciones del worktree para `repo_map`.
 *
 * Módulo LIVIANO a propósito: no importa TypeScript ni nada de 7A/7B/7C. Se
 * carga de forma estática junto con `tools.ts` (tiene que estar activo desde
 * la PRIMERA mutación), mientras que el service pesado se carga con
 * `import()` recién cuando se invoca `repo_map`.
 *
 * Qué registra, por instancia de `createAgentTools` (nunca estado global):
 * - `generation`: contador monótono. Sube cuando una mutación EMPIEZA, cuando
 *   TERMINA (también si falla o aborta) y cuando llega un `AgentToolEvent`.
 *   El service lo usa como identificador de snapshot: un snapshot solo es
 *   válido para la generación en la que se construyó.
 * - `inFlight` / `execInFlight`: mutaciones en vuelo. Mientras haya alguna,
 *   el worktree puede estar a medio escribir y NO se puede construir un mapa.
 *
 * Las mutaciones NUNCA esperan a las consultas: `trackMutation` solo hace
 * contabilidad síncrona alrededor de la operación real.
 *
 * Por qué no alcanza con los eventos: `AgentToolEvent` se emite DESPUÉS de una
 * escritura exitosa; no cubre una escritura que falla a medias, una operación
 * abortada (el wrapper de `tool-policy` devuelve el error al instante pero la
 * operación de disco sigue corriendo), ni `run_script` / `run_typecheck` (que
 * no emiten eventos, y agregarles uno interferiría con la detección de
 * progreso de `loop.ts`). El evento sigue siendo la señal semántica
 * ("esto cambió, con éxito") y `trackMutation` aporta el estado en vuelo.
 */

/** `file`: write_file / edit_file / delete_file (cortas). `exec`: run_script / run_typecheck (largas, pueden tocar cualquier archivo). */
export type MutationKind = "file" | "exec";

/** Forma mínima de `AgentToolEvent` (estructural, para no importar `tools.ts`). */
export type TrackedEvent = { type: string; relPath?: string };

export interface RepoMapTracker {
  /** Identificador monótono del estado del worktree (ver arriba). */
  readonly generation: number;
  /** Mutaciones en vuelo de cualquier tipo. */
  readonly inFlight: number;
  /** Mutaciones `exec` en vuelo (subconjunto de `inFlight`). */
  readonly execInFlight: number;
  /** Último evento recibido (diagnóstico / tests). */
  readonly lastEvent: TrackedEvent | null;
  /** Conecta un `AgentToolEvent` real: invalida el snapshot. */
  noteEvent(event: TrackedEvent): void;
  /**
   * Registra una mutación DESDE SU INICIO (síncrono: apenas se llama ya
   * cuenta como en vuelo) y la cierra siempre — éxito, error o aborto — en un
   * `finally`. Devuelve exactamente lo que devuelve `run` y relanza sus errores.
   */
  trackMutation<T>(kind: MutationKind, run: () => Promise<T>): Promise<T>;
  /**
   * Avisa UNA vez cuando no haya mutaciones en vuelo (inmediatamente, de forma
   * síncrona, si ya no hay). Devuelve la función para cancelar la suscripción.
   */
  onQuiet(listener: () => void): () => void;
}

export function createRepoMapTracker(): RepoMapTracker {
  let generation = 0;
  let inFlight = 0;
  let execInFlight = 0;
  let lastEvent: TrackedEvent | null = null;
  let quietListeners: Array<() => void> = [];

  function notifyIfQuiet() {
    if (inFlight > 0 || quietListeners.length === 0) return;
    const listeners = quietListeners;
    quietListeners = [];
    for (const listener of listeners) listener();
  }

  return {
    get generation() {
      return generation;
    },
    get inFlight() {
      return inFlight;
    },
    get execInFlight() {
      return execInFlight;
    },
    get lastEvent() {
      return lastEvent;
    },
    noteEvent(event) {
      lastEvent = event;
      generation += 1;
    },
    async trackMutation<T>(kind: MutationKind, run: () => Promise<T>): Promise<T> {
      // Todo lo de acá hasta el primer `await` es síncrono: la mutación queda
      // registrada en el mismo turno en que se invoca el tool.
      inFlight += 1;
      if (kind === "exec") execInFlight += 1;
      generation += 1;
      try {
        return await run();
      } finally {
        inFlight -= 1;
        if (kind === "exec") execInFlight -= 1;
        generation += 1;
        notifyIfQuiet();
      }
    },
    onQuiet(listener) {
      if (inFlight === 0) {
        listener();
        return () => undefined;
      }
      quietListeners.push(listener);
      return () => {
        quietListeners = quietListeners.filter((registered) => registered !== listener);
      };
    },
  };
}
