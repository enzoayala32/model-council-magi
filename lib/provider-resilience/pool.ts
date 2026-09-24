/**
 * Fase 5A — Credential Pool Core (ver diseño de Fase 5, rondas 1-3).
 *
 * Núcleo en memoria de la infraestructura de Multi-Key Provider Resilience.
 * Este archivo NO sabe nada de OpenRouter/NVIDIA/Google, del Model Council,
 * del Coding Agent, de `.env`, de códigos HTTP ni de fórmulas de backoff —
 * todo eso es responsabilidad de subfases posteriores (5B en adelante).
 * Acá solo vive el mecanismo genérico: qué credential entregar a
 * continuación, cómo evitar entregar la misma credential dos veces dentro
 * de una misma operación lógica, y cómo un estado `COOLDOWN` expira solo.
 *
 * Decisiones de diseño ya cerradas y aprobadas (rondas 2 y 3 del diseño):
 * - Round-robin simple, sin `inFlight` — no hay evidencia de que este
 *   proyecto necesite más que eso (ver ronda 2, sección 4).
 * - La exclusión de credentials ya usadas por una operación es una
 *   GARANTÍA ESTRUCTURAL de `OperationCursor` (su `Set` de ids usados es
 *   privado a la instancia), no una convención que el caller deba
 *   recordar mantener.
 * - `INVALID` es permanente para toda la vida del proceso — no hay
 *   ninguna transición que la saque de ese estado salvo crear un pool
 *   nuevo (reinicio del servidor). Un `release(id, "success")` sobre una
 *   credential `INVALID` no la revive (ver ronda 3, punto 5).
 * - `COOLDOWN` expira solo con el paso del tiempo — la duración exacta acá
 *   es un valor fijo simple (no la fórmula de backoff exponencial de 5B,
 *   que todavía no existe). El propósito de 5A es que el ESTADO y su
 *   caducidad funcionen correctamente; 5B reemplazará únicamente el
 *   cálculo de cuánto dura ese cooldown.
 *
 * Fase 5G agregó `generation`/`healthGeneration` (ver `InternalState` y
 * `CredentialLease`) para cerrar un hallazgo real de concurrencia: un
 * `release(id, "success")` de una operación podía pisar un
 * `cooldown`/`invalid` más reciente aplicado por otra operación
 * concurrente sobre la MISMA credential. No es `inFlight` — no rastrea
 * "quién está usando esto ahora", no agrega locks, no cambia el
 * round-robin ni la exclusión por operación: es solo una marca lógica de
 * "cuántas veces se degradó la salud de esta credential", para que un
 * `success` basado en información vieja sepa que no tiene la última
 * palabra. Ver el comentario largo en `release()` para la semántica
 * completa.
 */

/** Cooldown fijo y simple para 5A — placeholder deliberado. 5B lo
 * reemplaza por la fórmula real de backoff exponencial con jitter; acá
 * alcanza con una duración constante para poder probar que el mecanismo
 * de expiración funciona. */
const PLACEHOLDER_COOLDOWN_MS = 5_000;

export type CredentialStatus = "AVAILABLE" | "COOLDOWN" | "INVALID";

/** Snapshot de solo lectura del estado de una credential — lo que devuelve
 * `CredentialPool.snapshot()`. `cooldownUntil` ya viene normalizado: si el
 * cooldown expiró, el status reportado es `AVAILABLE` aunque el llamador
 * no haya hecho ningún `next()` todavía (ver `normalize`). */
export type CredentialState = {
  id: string;
  status: CredentialStatus;
  cooldownUntil: number | null;
  consecutiveFailures: number;
  lastUsedAt: number | null;
};

/** Lo que un `OperationCursor.next()` entrega cuando hay una credential
 * disponible. `value` es el secreto real (ej. la API key) — 5A lo trata
 * como un string opaco, nunca lo inspecciona ni lo loguea.
 *
 * `healthGeneration` (Fase 5G — fix del hallazgo de concurrencia) es la
 * "generación de salud" de la credential en el instante exacto en que se
 * entregó este lease — ver el comentario largo sobre `generation` en
 * `InternalState` más abajo para la explicación completa. El caller lo
 * conserva sin interpretarlo y se lo devuelve tal cual a `release()`. */
export type CredentialLease = {
  id: string;
  value: string;
  healthGeneration: number;
};

export type AcquireResult =
  | { status: "AVAILABLE"; lease: CredentialLease }
  /** Ninguna credential no-usada-por-este-cursor está disponible AHORA,
   * pero al menos una está en `COOLDOWN` (no `INVALID`) y podría estarlo
   * más tarde. `retryAt` es el `cooldownUntil` más próximo entre esas. */
  | { status: "COOLDOWN"; retryAt: number }
  /** No hay ninguna credential elegible y ninguna va a estarlo esperando:
   * o el pool está vacío, o todas las no-usadas-por-este-cursor están
   * `INVALID`, o el cursor ya agotó todas las que existen. */
  | { status: "NO_CREDENTIALS" };

/** Resultado que el caller reporta de vuelta al pool tras usar un lease.
 * Fase 5A no clasifica errores HTTP (eso es 5B) — el caller decide cuál
 * de estos tres outcomes corresponde. */
export type ReleaseOutcome = "success" | "cooldown" | "invalid";

type InternalState = {
  id: string;
  value: string;
  status: CredentialStatus;
  cooldownUntil: number | null;
  consecutiveFailures: number;
  lastUsedAt: number | null;
  /** Fase 5G — fix del hallazgo de concurrencia (release de una operación
   * vieja pisando un health state más reciente). Cuenta cuántas veces esta
   * credential fue DEGRADADA (`cooldown` o `invalid`) desde que el pool se
   * creó — a propósito NO se incrementa en `success`, ver el porqué en
   * `release()`. Un lease conserva el valor que vio al adquirirse
   * (`CredentialLease.healthGeneration`); si al momento de hacer
   * `release(..., "success")` la generación actual ya avanzó respecto de
   * la que ese lease observó, significa que ALGUIEN MÁS degradó esta
   * credential mientras esta operación seguía en curso — y ese success,
   * basado en información vieja, no tiene autoridad para borrar una
   * degradación que todavía no conocía. No es `inFlight` (no rastrea "está
   * en uso ahora", no bloquea ninguna adquisición, no cambia el
   * round-robin) — es solo una marca de tiempo lógica sobre la SALUD. */
  generation: number;
};

/** Una credential a registrar en el pool. El id es responsabilidad de
 * quien construye el pool (en 5C será `resolveCredentials()` quien arme
 * ids como `openrouter#1`) — 5A no inventa ningún esquema de naming. */
export type CredentialEntry = {
  id: string;
  value: string;
};

/**
 * Cursor de una única operación lógica (ej. una llamada del Coding Agent,
 * o una request del Council). Nunca se crea directo — sale de
 * `CredentialPool.beginOperation()`.
 *
 * GARANTÍA ESTRUCTURAL: el `Set` de ids ya entregados por este cursor es
 * un campo privado de la instancia. No existe ninguna API para leerlo,
 * mutarlo desde afuera, ni para pedirle a `next()` que "se olvide" de un
 * id ya entregado. Por construcción, dentro de una misma operación:
 *
 *   cursor.next() → A   (A queda marcada como usada por ESTE cursor)
 *   cursor.next() → B
 *   cursor.next() → C
 *   cursor.next() → NO_CREDENTIALS   (A, B, C ya están todas excluidas)
 *
 * Esto se cumple aunque `pool.release(A, "success")` se llame entre
 * medio, y aunque el cooldown de A expire durante la misma operación: la
 * exclusión es por identidad del cursor, no por el estado de salud de la
 * credential.
 */
export interface OperationCursor {
  next(now?: number): AcquireResult;
}

class OperationCursorImpl implements OperationCursor {
  private readonly usedIds = new Set<string>();

  constructor(private readonly pool: CredentialPool) {}

  next(now: number = Date.now()): AcquireResult {
    const result = this.pool._acquireExcluding(this.usedIds, now);
    if (result.status === "AVAILABLE") {
      this.usedIds.add(result.lease.id);
    }
    return result;
  }
}

/**
 * El pool en sí. Una instancia por provider (ej. una para OpenRouter, otra
 * para NVIDIA) — 5A no asume nada sobre cuántas instancias van a existir
 * ni quién las crea; eso lo decide 5D/5E al integrar.
 */
export class CredentialPool {
  /** Orden estable de ids — define el orden de recorrido del round-robin.
   * Nunca cambia después de construido (5A no soporta agregar/quitar
   * credentials en caliente — "sin hot reload", ya decidido en la ronda 3). */
  private readonly order: readonly string[];
  private readonly states: Map<string, InternalState>;

  /** Puntero compartido por TODAS las operaciones — es lo que hace que el
   * round-robin sea global (`operación 1 → A, operación 2 → B, ...`) y no
   * un round-robin privado de cada cursor. Se avanza únicamente cuando
   * `next()` efectivamente entrega una credential `AVAILABLE`. */
  private sharedIndex = 0;

  constructor(entries: readonly CredentialEntry[]) {
    const ids = new Set<string>();
    for (const entry of entries) {
      if (ids.has(entry.id)) {
        throw new Error(`CredentialPool: id duplicado "${entry.id}"`);
      }
      ids.add(entry.id);
    }
    this.order = entries.map((e) => e.id);
    this.states = new Map(
      entries.map((e) => [
        e.id,
        {
          id: e.id,
          value: e.value,
          status: "AVAILABLE" as CredentialStatus,
          cooldownUntil: null,
          consecutiveFailures: 0,
          lastUsedAt: null,
          generation: 0,
        },
      ]),
    );
  }

  /** Arranca una nueva operación lógica con su propio `usedIds` privado. */
  beginOperation(): OperationCursor {
    return new OperationCursorImpl(this);
  }

  /** Reporta el resultado de haber usado un lease. `success` limpia por
   * completo el historial de fallos (reset total, no decae gradual — ya
   * decidido en la ronda 2). `invalid` es permanente: ninguna llamada
   * posterior a `release` con cualquier outcome puede sacar a una
   * credential de `INVALID` (ver la garantía en el bloque de arriba del
   * archivo). `cooldown` usa `cooldownMs` si se provee (Fase 5B pasa acá
   * el resultado de `computeCooldownMs()`, la fórmula real de backoff); si
   * se omite, sigue usando el placeholder fijo de 5A — este parámetro es
   * la ÚNICA extensión que 5B necesitó sobre la API de 5A: es opcional,
   * agregado al final, y ninguna llamada existente de 5A (que nunca lo
   * pasa) cambia de comportamiento. Los 20/20 tests de 5A siguen pasando
   * sin modificarse.
   *
   * Importante: para un error que NO debe afectar la salud de la
   * credential (5B — 500/502/503/timeout/network/errores permanentes), el
   * caller simplemente NO llama a `release()` en absoluto — no existe un
   * cuarto `ReleaseOutcome` para "sin efecto" porque no hace falta: la
   * ausencia de la llamada ya es "sin efecto", sin necesidad de ensanchar
   * este tipo.
   *
   * `expectedGeneration` (Fase 5G, opcional — quinto parámetro, mismo
   * patrón de extensión no disruptiva que ya usó `cooldownMs` en 5B): el
   * `healthGeneration` que el lease tenía al adquirirse. SOLO se usa para
   * el outcome `"success"`: si se pasa y ya no coincide con la generación
   * ACTUAL de la credential, este `release` es tratado como información
   * vieja — no aplica nada — porque significa que otra operación ya
   * degradó esta credential (`cooldown`/`invalid`) DESPUÉS de que este
   * lease se entregó, y un éxito basado en datos de antes de eso no puede
   * tener la última palabra sobre su salud. Si se omite (como hacen todas
   * las llamadas de 5A-5F que nunca pasan este parámetro), el
   * comportamiento es EXACTAMENTE el de antes — success siempre aplica.
   * `cooldown`/`invalid` ignoran este parámetro por completo: un fallo
   * real nunca se descarta por esta razón, sea cual sea su generación (ver
   * el porqué en el comentario de `generation` en `InternalState` — dos
   * fallos concurrentes ya se acumulan correctamente hoy, mutando el mismo
   * objeto en vivo, sin ninguna carrera; acá no hay nada que arreglar). */
  release(id: string, outcome: ReleaseOutcome, now: number = Date.now(), cooldownMs?: number, expectedGeneration?: number): void {
    const state = this.states.get(id);
    if (!state) return; // id desconocido — no-op defensivo, no hay nada que actualizar
    if (state.status === "INVALID") return; // permanente: ni "success" la revive

    if (outcome === "success" && expectedGeneration !== undefined && expectedGeneration !== state.generation) {
      // Alguien degradó esta credential (cooldown/invalid) DESPUÉS de que
      // este lease se adquirió — este success quedó desactualizado. No
      // tocar nada: la degradación más reciente prevalece.
      return;
    }

    state.lastUsedAt = now;
    if (outcome === "success") {
      state.status = "AVAILABLE";
      state.cooldownUntil = null;
      state.consecutiveFailures = 0;
      // OJO: `generation` NO se incrementa acá a propósito. Ver Caso 1 del
      // informe de 5G — dos éxitos concurrentes sobre la misma credential
      // deben poder aplicar los dos sin bloquearse entre sí (ninguno
      // "degrada" nada), y `generation` representa específicamente
      // degradaciones, no cualquier release.
    } else if (outcome === "invalid") {
      state.status = "INVALID";
      state.cooldownUntil = null;
      state.generation += 1;
    } else {
      state.status = "COOLDOWN";
      state.consecutiveFailures += 1;
      state.cooldownUntil = now + (cooldownMs ?? PLACEHOLDER_COOLDOWN_MS);
      state.generation += 1;
    }
  }

  /** Snapshot de solo lectura de todas las credentials, ya normalizado
   * (un `COOLDOWN` cuyo `cooldownUntil` ya pasó se reporta como
   * `AVAILABLE`, sin que nadie haya tenido que llamar a `next()` para
   * "despertarlo"). Copias — mutar el resultado no afecta al pool. */
  snapshot(now: number = Date.now()): CredentialState[] {
    return this.order.map((id) => {
      const state = this.states.get(id)!;
      this.normalize(state, now);
      return {
        id: state.id,
        status: state.status,
        cooldownUntil: state.cooldownUntil,
        consecutiveFailures: state.consecutiveFailures,
        lastUsedAt: state.lastUsedAt,
      };
    });
  }

  /** Si un `COOLDOWN` ya venció, lo pasa a `AVAILABLE` in-place. `INVALID`
   * nunca se toca acá — es la única transición que jamás ocurre sola. */
  private normalize(state: InternalState, now: number): void {
    if (state.status === "COOLDOWN" && state.cooldownUntil !== null && now >= state.cooldownUntil) {
      state.status = "AVAILABLE";
      state.cooldownUntil = null;
    }
  }

  /** Usado solo por `OperationCursorImpl.next()` — no es API pública del
   * pool a propósito: la única forma de pedir una credential "hacia
   * afuera" es a través de un `OperationCursor`, nunca directo del pool,
   * para que la exclusión por operación sea imposible de saltear. */
  _acquireExcluding(excluded: ReadonlySet<string>, now: number): AcquireResult {
    if (this.order.length === 0) return { status: "NO_CREDENTIALS" };

    let earliestCooldownRetryAt: number | null = null;
    let sawAnyEligibleCandidate = false; // no-INVALID y no-excluida, aunque esté en cooldown

    for (let step = 0; step < this.order.length; step++) {
      const idx = (this.sharedIndex + step) % this.order.length;
      const id = this.order[idx];
      if (excluded.has(id)) continue;

      const state = this.states.get(id)!;
      this.normalize(state, now);

      if (state.status === "INVALID") continue;

      sawAnyEligibleCandidate = true;

      if (state.status === "AVAILABLE") {
        this.sharedIndex = (idx + 1) % this.order.length;
        return { status: "AVAILABLE", lease: { id: state.id, value: state.value, healthGeneration: state.generation } };
      }

      // status === "COOLDOWN" acá (ya normalizado arriba)
      if (state.cooldownUntil !== null && (earliestCooldownRetryAt === null || state.cooldownUntil < earliestCooldownRetryAt)) {
        earliestCooldownRetryAt = state.cooldownUntil;
      }
    }

    if (sawAnyEligibleCandidate && earliestCooldownRetryAt !== null) {
      return { status: "COOLDOWN", retryAt: earliestCooldownRetryAt };
    }
    return { status: "NO_CREDENTIALS" };
  }
}
