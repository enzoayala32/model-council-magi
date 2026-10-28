/**
 * Fase 1 — política de seguridad para `/api/*`.
 *
 * Se extrae como función pura a propósito: `proxy.ts` solo traduce el
 * resultado a una respuesta HTTP y toda la matriz host/origin/token/
 * content-type se puede testear sin levantar Next.js. El proxy corre en
 * runtime Node.js en Next 16, así que `process.env` está disponible.
 */

export type ApiSecurityEnv = {
  ALLOWED_HOSTS?: string;
  ALLOWED_ORIGINS?: string;
  APP_ACCESS_TOKEN?: string;
  PORT?: string;
};

export type ApiSecurityRequest = {
  method: string;
  host: string | null;
  origin?: string | null;
  secFetchSite?: string | null;
  contentType?: string | null;
  authorization?: string | null;
  cookie?: string | null;
  /** El proxy lo calcula con Content-Length / Transfer-Encoding. */
  hasBody: boolean;
};

export type ApiSecurityReason = "host" | "token" | "origin" | "sec-fetch-site" | "content-type";

export type ApiSecurityDecision =
  | { ok: true }
  | {
      ok: false;
      status: 403;
      error: string;
      /** Para logs internos; nunca se envía al cliente. */
      reason: ApiSecurityReason;
    };

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const DEFAULT_PORT = "3000";
const TOKEN_COOKIE = "magi_access_token";

function parseList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Acepta tanto `localhost:3000` como una URL accidental
 * (`http://localhost:3000`). Devuelve el host canónico en minúsculas o
 * `null` si la entrada no sirve; una lista configurada pero inválida se
 * trata como lista vacía (fail closed, nunca fail open).
 */
function normalizeHostEntry(value: string): string | null {
  let host = value.trim().toLowerCase();
  if (!host) return null;
  if (host.includes("://")) {
    try {
      host = new URL(host).host.toLowerCase();
    } catch {
      return null;
    }
  }
  if (/[\s/]/.test(host)) return null;
  return host;
}

/**
 * Separa hostname y puerto sin romper IPv6 (`[::1]:3000`). Un punto final
 * en el hostname es válido en DNS pero irrelevante para comparar.
 */
function splitHostPort(host: string): { hostname: string; port: string | null } {
  const clean = (hostname: string) => (hostname.endsWith(".") ? hostname.slice(0, -1) : hostname);

  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end === -1) return { hostname: host, port: null };
    const hostname = host.slice(0, end + 1);
    const rest = host.slice(end + 1);
    if (rest.startsWith(":")) {
      const port = rest.slice(1);
      return { hostname: clean(hostname), port: port || null };
    }
    return { hostname: clean(hostname), port: null };
  }

  const firstColon = host.indexOf(":");
  const lastColon = host.lastIndexOf(":");
  if (firstColon !== -1 && firstColon === lastColon) {
    const port = host.slice(firstColon + 1);
    return { hostname: clean(host.slice(0, firstColon)), port: port || null };
  }
  return { hostname: clean(host), port: null };
}

function canonicalHost(host: string): string {
  const { hostname, port } = splitHostPort(host);
  return port ? `${hostname}:${port}` : hostname;
}

function hostMatches(actual: string, entry: string): boolean {
  const a = splitHostPort(actual);
  const e = splitHostPort(entry);
  if (a.hostname !== e.hostname) return false;
  // Una entrada sin puerto significa "cualquier puerto de ese host".
  if (e.port === null) return true;
  if (a.port === e.port) return true;
  // El header Host omite el puerto cuando es el default del esquema.
  return a.port === null && (e.port === "80" || e.port === "443");
}

function defaultAllowedHosts(env: ApiSecurityEnv): string[] {
  const configuredPort = env.PORT?.trim() ?? "";
  const port = /^\d+$/.test(configuredPort) ? configuredPort : DEFAULT_PORT;
  return [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`];
}

function resolveAllowedHosts(env: ApiSecurityEnv): string[] {
  const raw = parseList(env.ALLOWED_HOSTS);
  if (raw.length === 0) return defaultAllowedHosts(env);
  return raw.map(normalizeHostEntry).filter((host): host is string => Boolean(host));
}

function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.origin === "null") return null;
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}

function resolveAllowedOrigins(env: ApiSecurityEnv, host: string): string[] {
  const raw = parseList(env.ALLOWED_ORIGINS);
  if (raw.length === 0) {
    // Mismo origen que el Host permitido, en http y https: no sabemos si
    // el usuario está detrás de TLS y ambos siguen siendo el mismo host.
    return [`http://${host}`, `https://${host}`];
  }
  return raw.map(normalizeOrigin).filter((origin): origin is string => Boolean(origin));
}

function readBearer(value: string | null): string | null {
  if (!value) return null;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match ? match[1].trim() : null;
}

function readCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    const raw = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      // Cookie mal escapada: se compara el valor crudo, nunca se rompe.
      return raw;
    }
  }
  return null;
}

/** Comparación de tiempo constante para no filtrar el token por timing. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function isJsonContentType(value: string | null): boolean {
  if (!value) return false;
  const mediaType = value.split(";")[0]?.trim().toLowerCase() ?? "";
  return mediaType === "application/json" || mediaType.endsWith("+json");
}

function isMutating(method: string): boolean {
  return MUTATING_METHODS.has(method.trim().toUpperCase());
}

/**
 * Orden deliberado: primero Host (corta DNS rebinding antes de tocar
 * nada), después token (si está configurado), y recién al final las
 * reglas de métodos que mutan. Un GET cross-origin no se bloquea por
 * Origin: no muta estado y el Host ya cerró el rebinding.
 */
export function evaluateApiRequest(
  request: ApiSecurityRequest,
  env: ApiSecurityEnv = {},
): ApiSecurityDecision {
  const method = request.method.trim().toUpperCase();
  const rawHost = request.host?.trim() ?? "";
  const normalizedHost = rawHost ? normalizeHostEntry(rawHost) : null;
  if (!normalizedHost) {
    return {
      ok: false,
      status: 403,
      error: "Falta el header Host o no es válido.",
      reason: "host",
    };
  }

  const host = canonicalHost(normalizedHost);
  const allowedHosts = resolveAllowedHosts(env);
  if (!allowedHosts.some((entry) => hostMatches(host, entry))) {
    return { ok: false, status: 403, error: "Host no permitido.", reason: "host" };
  }

  const token = env.APP_ACCESS_TOKEN?.trim() ?? "";
  if (token) {
    const bearer = readBearer(request.authorization ?? null);
    const cookie = readCookie(request.cookie ?? null, TOKEN_COOKIE);
    const bearerOk = bearer !== null && safeEqual(bearer, token);
    const cookieOk = cookie !== null && safeEqual(cookie, token);
    if (!bearerOk && !cookieOk) {
      return {
        ok: false,
        status: 403,
        error: "Token de acceso ausente o inválido.",
        reason: "token",
      };
    }
  }

  if (isMutating(method)) {
    const origin = request.origin?.trim() ?? "";
    if (origin) {
      const normalizedOrigin = origin.toLowerCase() === "null" ? null : normalizeOrigin(origin);
      const allowedOrigins = resolveAllowedOrigins(env, host);
      if (!normalizedOrigin || !allowedOrigins.includes(normalizedOrigin)) {
        return { ok: false, status: 403, error: "Origen no permitido.", reason: "origin" };
      }
    } else {
      const site = request.secFetchSite?.trim().toLowerCase() ?? "";
      // Sin Origin, un navegador cross-site manda Sec-Fetch-Site:
      // cross-site. Ausente = cliente no navegador (curl, scripts), que
      // no puede ser víctima de CSRF; se deja pasar a propósito.
      if (site === "cross-site") {
        return {
          ok: false,
          status: 403,
          error: "Solicitud cross-site bloqueada.",
          reason: "sec-fetch-site",
        };
      }
    }

    if (request.hasBody && !isJsonContentType(request.contentType ?? null)) {
      return {
        ok: false,
        status: 403,
        error: "Content-Type no soportado: se esperaba application/json.",
        reason: "content-type",
      };
    }
  }

  return { ok: true };
}
