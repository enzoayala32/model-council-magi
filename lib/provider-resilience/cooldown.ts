/**
 * Fase 5B — fórmula de cooldown/backoff y parseo de `Retry-After`.
 *
 * Puro: no sabe nada de HTTP real, `fetch`, Council ni Coding Agent — solo
 * recibe números/strings ya extraídos por el caller y devuelve números.
 * `now`/`random` son inyectables para que los tests sean deterministas sin
 * depender de sleeps reales ni de `Math.random()` real.
 */

/** Base del backoff exponencial — mismo valor que el `initialDelayInMs` por
 * default del propio Vercel AI SDK (confirmado leyendo `node_modules/ai`
 * en el análisis de Fase 5, ronda 1) — consistencia con lo que el proyecto
 * ya usa en otro lado, no un número inventado. */
export const BASE_COOLDOWN_MS = 2_000;

/** Techo del backoff — antes de aplicar el jitter (ver `computeCooldownMs`). */
export const MAX_COOLDOWN_MS = 60_000;

/** ±20%, ya aprobado en la ronda 3 del diseño. */
export const JITTER_RATIO = 0.2;

/** Umbral único para "retry mismo key" en la tabla de clasificación de
 * 5B — ya cerrado en la ronda 3 (reemplaza el "<3s" descartado de una
 * ronda anterior). Un `Retry-After` mayor a esto, o ausente, salta directo
 * a failover de credential en vez de esperar. */
export const RETRY_SAME_KEY_THRESHOLD_MS = 5_000;

/**
 * `delay = min(BASE × 2^(n-1), MAX) × factor`, con `factor` uniforme en
 * `[1-JITTER_RATIO, 1+JITTER_RATIO]` (es decir, `[0.8, 1.2]` con el ratio
 * actual) — exactamente la fórmula acordada: `D×0.8 ≤ delay ≤ D×1.2` sobre
 * `D = min(BASE × 2^(n-1), MAX)`. El jitter se aplica DESPUÉS del cap a
 * `MAX_COOLDOWN_MS` (así lo especificó la fórmula aprobada), por lo que el
 * resultado final puede superar levemente `MAX_COOLDOWN_MS` (hasta un
 * 20% más) cuando el jitter cae del lado alto — es el comportamiento
 * pedido, no un bug.
 *
 * `consecutiveFailures` se espera YA incrementado (post-`release`, no
 * pre) — el primer fallo es `n=1` → `2^0=1` → `BASE_COOLDOWN_MS` antes de
 * jitter, igual que el ejemplo de la ronda 1 del diseño.
 */
export function computeCooldownMs(consecutiveFailures: number, options?: { random?: () => number }): number {
  const n = Math.max(1, Math.floor(consecutiveFailures));
  const base = Math.min(BASE_COOLDOWN_MS * Math.pow(2, n - 1), MAX_COOLDOWN_MS);
  const random = options?.random ?? Math.random;
  const r = random();
  // r ∈ [0,1) → factor ∈ [1-JITTER_RATIO, 1+JITTER_RATIO]
  const factor = 1 - JITTER_RATIO + r * (2 * JITTER_RATIO);
  return Math.max(0, Math.round(base * factor));
}

/**
 * Interpreta un `Retry-After` en milisegundos, o `null` si no hay
 * información utilizable. Soporta las dos representaciones que define el
 * estándar HTTP para este header (RFC 9110 §10.2.3):
 * - un número de segundos (`"120"`), o ya parseado como número (algunos
 *   clientes de este proyecto, como `OpenRouterError.retryAfterSeconds`,
 *   ya lo entregan como número — ver `lib/openrouter.ts`, verificado en el
 *   análisis de Fase 5, ronda 1);
 * - una fecha HTTP absoluta (`"Wed, 21 Oct 2026 07:28:00 GMT"`), en cuyo
 *   caso se calcula la diferencia contra `now`, nunca negativa.
 *
 * Si se proveen ambos (`seconds` y `header`), `seconds` gana — es la forma
 * ya parseada y más confiable.
 */
export function parseRetryAfterMs(input: { seconds?: number | null; header?: string | null }, now: number = Date.now()): number | null {
  if (typeof input.seconds === "number" && Number.isFinite(input.seconds) && input.seconds >= 0) {
    return Math.round(input.seconds * 1000);
  }

  const header = input.header?.trim();
  if (!header) return null;

  if (/^\d+$/.test(header)) {
    return Math.round(Number(header) * 1000);
  }

  const dateMs = Date.parse(header);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - now);
  }

  return null;
}
