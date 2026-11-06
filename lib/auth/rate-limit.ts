/**
 * Rate limiting con clave de peer real.
 *
 * CAMBIO DE SEGURIDAD (revisión independiente): la clave era
 * `X-Forwarded-For`, que manda el CLIENTE. Rotándolo se hacían infinitos
 * fallos sin llegar al límite. Además, los clientes sin ese header caían
 * todos en el mismo bucket "desconocido", así que un atacante podía bloquear
 * el emparejamiento legítimo de otro.
 *
 * Ahora:
 * - La clave es el peer real (`x-magi-peer-addr`, que escribe `server.ts`
 *   desde `req.socket.remoteAddress`). No lo puede elegir el cliente.
 * - `X-Forwarded-For` se usa SOLO si `TRUST_PROXY` está definido, y se toma
 *   el ÚLTIMO salto (el que agregó el proxy de confianza), no el primero:
 *   el primero lo escribe el cliente.
 * - El mapa de buckets tiene tope de tamaño: sin él, un atacante con muchas
 *   IPs falsas haría crecer la memoria sin límite.
 * - `/api/auth/token` tiene además un límite GLOBAL con retardo progresivo,
 *   independiente de la IP: si el total de fallos se dispara, se frena a
 *   todos por igual (es el último recurso contra fuerza bruta distribuida).
 */

type Bucket = { failures: number; blockedUntil: number };

/** Ventana base y tope del bloqueo progresivo. */
const BASE_WINDOW_MS = 60_000;
const MAX_BLOCK_MS = 60 * 60_000;
/** Fallos permitidos dentro de la ventana antes de bloquear. */
const DEFAULT_MAX_FAILURES = 5;
/** Tope de buckets: al llenarse se poda el más viejo. */
const MAX_BUCKETS = 5_000;
/** Fallos globales (todas las IPs) que disparan el freno global. */
const GLOBAL_MAX_FAILURES = 25;
/** Retardo del freno global; se duplica con cada nuevo exceso. */
const GLOBAL_BASE_DELAY_MS = 30_000;

const buckets = new Map<string, Bucket>();
/** Contador global por recurso. */
const globalCounters = new Map<string, { failures: number; blockedUntil: number }>();

export type RateLimitResult =
  | { allowed: true; remaining: number }
  | { allowed: false; retryAfterMs: number };

export type RateLimitOptions = {
  maxFailures?: number;
  windowMs?: number;
  now?: () => number;
};

function keyFor(identifier: string, resource: string): string {
  return `${resource}:${identifier}`;
}

/** Poda el bucket más antiguo cuando el mapa se llena. */
function pruneIfNeeded(): void {
  if (buckets.size <= MAX_BUCKETS) return;
  // `Map` preserva el orden de inserción: el primero es el más viejo.
  const oldest = buckets.keys().next();
  if (!oldest.done) buckets.delete(oldest.value);
}

export function checkRateLimit(identifier: string, resource: string, options: RateLimitOptions = {}): RateLimitResult {
  const now = options.now?.() ?? Date.now();
  if (isGlobalBlocked(resource, now)) {
    return { allowed: false, retryAfterMs: globalBlockRemaining(resource, now) };
  }
  const bucket = buckets.get(keyFor(identifier, resource));
  if (!bucket) return { allowed: true, remaining: options.maxFailures ?? DEFAULT_MAX_FAILURES };
  if (bucket.blockedUntil > now) {
    return { allowed: false, retryAfterMs: bucket.blockedUntil - now };
  }
  return { allowed: true, remaining: Math.max(0, (options.maxFailures ?? DEFAULT_MAX_FAILURES) - bucket.failures) };
}

/** Registra un fallo y devuelve el nuevo estado. */
export function recordFailure(identifier: string, resource: string, options: RateLimitOptions = {}): RateLimitResult {
  const now = options.now?.() ?? Date.now();
  const maxFailures = options.maxFailures ?? DEFAULT_MAX_FAILURES;
  const windowMs = options.windowMs ?? BASE_WINDOW_MS;

  // Freno global primero: si ya está activo, no hace falta sumar por IP.
  if (isGlobalBlocked(resource, now)) {
    return { allowed: false, retryAfterMs: globalBlockRemaining(resource, now) };
  }

  const bucket = buckets.get(keyFor(identifier, resource)) ?? { failures: 0, blockedUntil: 0 };
  bucket.failures += 1;
  const over = bucket.failures - maxFailures;
  if (over > 0) {
    // Progresivo: cada exceso duplica la penalización, con tope.
    const penalty = Math.min(over * windowMs, MAX_BLOCK_MS);
    bucket.blockedUntil = Math.max(bucket.blockedUntil, now + penalty);
  }
  buckets.set(keyFor(identifier, resource), bucket);
  pruneIfNeeded();

  // Contador global: si el total se dispara, se frena a todos.
  const global = globalCounters.get(resource) ?? { failures: 0, blockedUntil: 0 };
  global.failures += 1;
  const globalOver = global.failures - GLOBAL_MAX_FAILURES;
  if (globalOver > 0) {
    const delay = Math.min(GLOBAL_BASE_DELAY_MS * 2 ** (globalOver - 1), MAX_BLOCK_MS);
    global.blockedUntil = Math.max(global.blockedUntil, now + delay);
  }
  globalCounters.set(resource, global);

  if (isGlobalBlocked(resource, now)) {
    return { allowed: false, retryAfterMs: globalBlockRemaining(resource, now) };
  }
  if (bucket.blockedUntil > now) return { allowed: false, retryAfterMs: bucket.blockedUntil - now };
  return { allowed: true, remaining: Math.max(0, maxFailures - bucket.failures) };
}

/** Éxito: limpia el medidor de esa IP (no el global). */
export function recordSuccess(identifier: string, resource: string): void {
  buckets.delete(keyFor(identifier, resource));
}

function isGlobalBlocked(resource: string, now: number): boolean {
  return globalBlockRemaining(resource, now) > 0;
}

function globalBlockRemaining(resource: string, now: number): number {
  const global = globalCounters.get(resource);
  if (!global) return 0;
  return global.blockedUntil > now ? global.blockedUntil - now : 0;
}

/** Limpia todo. Solo para tests. */
export function __resetRateLimitsForTests(): void {
  buckets.clear();
  globalCounters.clear();
}

/** Identificador del cliente: el peer real, no un header falsificable. */
export function clientIdentifier(request: Request): string {
  const address = request.headers.get("x-magi-peer-addr")?.trim();
  if (address) return address;

  // Solo si hay un proxy de confianza declarado, y tomando el ÚLTIMO salto:
  // el primero lo escribe el cliente.
  if (process.env.TRUST_PROXY?.trim()) {
    const forwarded = request.headers.get("x-forwarded-for");
    if (forwarded) {
      const hops = forwarded.split(",").map((hop) => hop.trim()).filter(Boolean);
      const last = hops[hops.length - 1];
      if (last) return last;
    }
  }

  return "desconocido";
}

/** Tope actual del mapa, para tests. */
export function __bucketCountForTests(): number {
  return buckets.size;
}
