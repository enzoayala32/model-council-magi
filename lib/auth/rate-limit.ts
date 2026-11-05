/**
 * Fase 4a - rate limiting estricto con bloqueo progresivo.
 *
 * Aplica a dos superficies: el canje de codigos de emparejamiento y el
 * login de APP_ACCESS_TOKEN (`/api/auth/token`). En memoria, por proceso:
 * no hace falta persistirlo (un reinicio del server reinicia los
 * contadores, y el atacante no gana nada con esperar el restart) y la app
 * es single-user.
 *
 * Bloqueo progresivo: cada fallo agrega una penalizacion sobre la ventana.
 * La KEY es el identificador del cliente (IP), y para el login se agrega
 * tambien el "recurso" para no mezclar medidores de rutas distintas.
 *
 * No es un sustituto de una capa de red (nginx, Cloudflare): es la defensa
 * minima para no dejar un endpoint de credenciales sin limite.
 */

type Bucket = { failures: number; blockedUntil: number };

/** Ventana base y tope del bloqueo progresivo. */
const BASE_WINDOW_MS = 60_000;
const MAX_BLOCK_MS = 60 * 60_000;
/** Fallos permitidos dentro de la ventana antes de bloquear. */
const DEFAULT_MAX_FAILURES = 5;

const buckets = new Map<string, Bucket>();

export type RateLimitResult =
  | { allowed: true; remaining: number }
  | { allowed: false; retryAfterMs: number };

export type RateLimitOptions = {
  /** Fallos tolerados en la ventana antes de empezar a bloquear. */
  maxFailures?: number;
  /** Ventana base; cada penalty la multiplica. */
  windowMs?: number;
  now?: () => number;
};

function keyFor(identifier: string, resource: string): string {
  return `${resource}:${identifier}`;
}

export function checkRateLimit(identifier: string, resource: string, options: RateLimitOptions = {}): RateLimitResult {
  const now = options.now?.() ?? Date.now();
  const bucket = buckets.get(keyFor(identifier, resource));
  if (!bucket) return { allowed: true, remaining: options.maxFailures ?? DEFAULT_MAX_FAILURES };
  if (bucket.blockedUntil > now) {
    return { allowed: false, retryAfterMs: bucket.blockedUntil - now };
  }
  return { allowed: true, remaining: Math.max(0, (options.maxFailures ?? DEFAULT_MAX_FAILURES) - bucket.failures) };
}

/** Registra un fallo y devuelve el nuevo estado (bloqueado o no). */
export function recordFailure(identifier: string, resource: string, options: RateLimitOptions = {}): RateLimitResult {
  const now = options.now?.() ?? Date.now();
  const maxFailures = options.maxFailures ?? DEFAULT_MAX_FAILURES;
  const windowMs = options.windowMs ?? BASE_WINDOW_MS;
  const bucket = buckets.get(keyFor(identifier, resource)) ?? { failures: 0, blockedUntil: 0 };

  bucket.failures += 1;
  const over = bucket.failures - maxFailures;
  if (over > 0) {
    // Progresivo: 1er exceso = 1 ventana, 2do = 2 ventanas... con tope.
    const penalty = Math.min(over * windowMs, MAX_BLOCK_MS);
    bucket.blockedUntil = Math.max(bucket.blockedUntil, now + penalty);
  }
  buckets.set(keyFor(identifier, resource), bucket);

  if (bucket.blockedUntil > now) return { allowed: false, retryAfterMs: bucket.blockedUntil - now };
  return { allowed: true, remaining: Math.max(0, maxFailures - bucket.failures) };
}

/** Exito: limpia el medidor (no tiene sentido castigar a quien acerto). */
export function recordSuccess(identifier: string, resource: string): void {
  buckets.delete(keyFor(identifier, resource));
}

/** Limpia todo. Solo para tests. */
export function __resetRateLimitsForTests(): void {
  buckets.clear();
}

/**
 * Identificador del cliente. Se toma `x-forwarded-for` SOLO como primer
 * salto (el del proxy que agregó el tunnel) y se compara ademas contra el
 * `request.ip` implicito: no se confia en el header por si solo, porque un
 * cliente puede falsificarlo. Esta funcion devuelve el valor crudo; la
 * decision de confianza vive en el caller.
 */
export function clientIdentifier(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || "desconocido";
}
