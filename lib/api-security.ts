/**
 * Fase 1 — política de seguridad para `/api/*`.
 *
 * Se extrae como función pura a propósito: `proxy.ts` solo traduce el
 * resultado a una respuesta HTTP y toda la matriz host/origen/token/
 * content-type se puede testear sin levantar Next.js. El proxy corre en
 * runtime Node.js en Next 16, así que `process.env` está disponible.
 *
 * Fase 3: el mismo servidor se puede exponer en la LAN (o por un túnel).
 * La regla que gobierna eso: **loopback es de confianza implícita, todo
 * lo demás exige autenticación siempre**, aunque `APP_ACCESS_TOKEN` no
 * esté definido. Sin ninguna forma de autenticar, un Host que no sea
 * loopback se rechaza con un mensaje que explica cómo habilitarla, en
 * vez de quedar abierto por default. Es fail-closed deliberado.
 */

export type ApiSecurityEnv = {
  ALLOWED_HOSTS?: string;
  ALLOWED_ORIGINS?: string;
  APP_ACCESS_TOKEN?: string;
  /** Solo se usa para elegir el puerto default de Next; ya no decide el
   *  default de hosts (loopback se acepta en cualquier puerto). */
  PORT?: string;
  /** Fase 5: `REMOTE_ACCESS=off` rechaza todo Host que no sea loopback. */
  REMOTE_ACCESS?: string;
};

export type ApiSecurityRequest = {
  method: string;
  host: string | null;
  origin?: string | null;
  secFetchSite?: string | null;
  contentType?: string | null;
  authorization?: string | null;
  cookie?: string | null;
  /** Header `x-magi-device-token` (clientes sin cookies). */
  deviceTokenHeader?: string | null;
  /** El proxy lo calcula con Content-Length / Transfer-Encoding. */
  hasBody: boolean;
  /** Rutas como el login del token: se saltan el chequeo de token (no
   *  podrían existir sin poder canjearlo) pero conservan Host, Origin y
   *  Content-Type. Lo setea el proxy, no el cliente. */
  tokenExempt?: boolean;
};

export type ApiSecurityReason =
  | "host"
  | "token"
  | "origin"
  | "sec-fetch-site"
  | "content-type"
  /** Fase 3: Host no-loopback y ninguna autenticación configurada. */
  | "remote-access-disabled";

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
const TOKEN_COOKIE = "magi_access_token";

/**
 * Nombre de la cookie del token de acceso. Se exporta porque
 * `app/api/auth/token/route.ts` la escribe y la borra, y el proxy la lee:
 * si cada uno tuviera su propia constante, un rename silencioso rompería
 * el login sin que ningún test lo note.
 */
export const APP_ACCESS_TOKEN_COOKIE = TOKEN_COOKIE;

/** Atributos de la cookie del token. `Secure` solo si la request vino por
 * HTTPS (o lo dijo `x-forwarded-proto` detrás de un túnel); en HTTP local
 * marcarla Secure haría que el navegador la descarte y el login falle. */
export function buildTokenCookie(token: string, opts: { secure: boolean }): string {
  const parts = [
    `${APP_ACCESS_TOKEN_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=86400",
  ];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

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

/**
 * Defaults: loopback en CUALQUIER puerto. Next puede arrancar en 3000, en
 * 3001 porque el 3000 está ocupado, o con `-p 8080`, y atar el default a
 * `PORT` rompía el acceso apenas el usuario cambiaba de puerto. La regla
 * `hostMatches` de arriba ya trata una entrada sin puerto como
 * "cualquier puerto de ese host".
 *
 * Esto NO afloja el Origin: el origen permitido se calcula con el host
 * REAL de la request (ver `resolveAllowedOrigins`), así que
 * `http://localhost:8080` sigue rechazándose cuando el server corre en
 * otro puerto.
 */
function defaultAllowedHosts(): string[] {
  return ["localhost", "127.0.0.1", "[::1]"];
}

/**
 * Los hosts permitidos son los configurados MÁS los de loopback.
 *
 * Por qué se suman y no se reemplazan: si configurás `ALLOWED_HOSTS` para un
 * túnel (`mi-pc.tail1234.ts.net`), antes dejabas de poder abrir la app en tu
 * propia PC con `localhost:3000`, porque el default desaparecía. Sumarlos no
 * es un agujero: desde la corrección de seguridad, el `Host` ya no autoriza
 * nada — el loopback se decide por el peer real. Ací el Host solo es la
 * defensa contra navegadores (CSRF, DNS rebinding), que es su trabajo.
 */
function resolveAllowedHosts(env: ApiSecurityEnv): string[] {
  const raw = parseList(env.ALLOWED_HOSTS);
  const configured = raw.map(normalizeHostEntry).filter((host): host is string => Boolean(host));
  return [...new Set([...configured, ...defaultAllowedHosts()])];
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

/**
 * Comparación de tiempo constante para no filtrar el token por timing.
 * Se exporta porque el endpoint de login compara lo que escribe el
 * usuario contra `APP_ACCESS_TOKEN`, y si tuviera su propia copia podría
 * divergir (p. ej. sin padding de longitud).
 */
export function constantTimeEqual(a: string, b: string): boolean {
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

/** Hostnames que significan "esta misma máquina". */
const LOOPBACK_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"];

/** Nombre de la cookie de dispositivo emparejado (Fase 4). */
const DEVICE_COOKIE = "magi_device_token";
/** Cookie de sesión de operador (id opaco, no el token maestro). */
const OPERATOR_SESSION_COOKIE = "magi_access_token";

/**
 * ¿Hay algo con lo que autenticar un acceso remoto? Se acepta
 * `APP_ACCESS_TOKEN` o una cookie de dispositivo. La validez real de la
 * cookie se comprueba en la capa de autorización de la Fase 4 (necesita
 * la DB); acá solo se responde "hay o no hay forma de autenticar", para
 * no abrir el acceso cuando no hay ninguna configurada.
 *
 * No se lee el valor de la cookie acá: la política pura no depende de
 * SQLite.
 */
function hasAnyCredential(request: ApiSecurityRequest, env: ApiSecurityEnv): boolean {
  if (env.APP_ACCESS_TOKEN?.trim()) return true;
  if (readCookie(request.cookie ?? null, TOKEN_COOKIE)) return true;
  if (readCookie(request.cookie ?? null, DEVICE_COOKIE)) return true;
  if ((request.deviceTokenHeader ?? "").trim()) return true;
  if (readCookie(request.cookie ?? null, OPERATOR_SESSION_COOKIE)) return true;
  return false;
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

  // ---------- Fase 3: loopback vs. resto del mundo ----------
  // Loopback es de confianza implícita (es esta PC). Cualquier otro Host
  // — la IP de LAN, el nombre MagicDNS de Tailscale, el hostname de un
  // túnel — equivale a control remoto y exige autenticación SIEMPRE,
  // exista APP_ACCESS_TOKEN o no.
  const isLoopback = LOOPBACK_HOSTNAMES.includes(splitHostPort(host).hostname);
  if (!isLoopback) {
    const remoteAccess = env.REMOTE_ACCESS?.trim().toLowerCase();
    if (remoteAccess === "off") {
      return {
        ok: false,
        status: 403,
        error: "Acceso remoto deshabilitado (REMOTE_ACCESS=off). Solo se acepta acceso desde esta PC.",
        reason: "remote-access-disabled",
      };
    }
    if (!hasAnyCredential(request, env)) {
      // Sin nada que verificar no se puede autorizar. El mensaje dice
      // cómo habilitarlo, en vez de un "prohibido" opaco.
      return {
        ok: false,
        status: 403,
        error:
          "Acceso desde fuera de esta PC requiere autenticación. Definí APP_ACCESS_TOKEN en .env " +
          "o emparejá un dispositivo (ver README, sección Dispositivos).",
        reason: "remote-access-disabled",
      };
    }
  }

  const token = env.APP_ACCESS_TOKEN?.trim() ?? "";
  // La cookie de dispositivo es una credencial válida por sí sola: si está
  // presente, el proxy la deja pasar y la validación real (¿existe el
  // dispositivo? ¿está revocado? ¿tiene scope?) la hace `lib/auth/authorize.ts`,
  // que es quien puede tocar la DB. Antes esto exigía APP_ACCESS_TOKEN
  // siempre, así que un teléfono emparejado no podía autenticarse NUNCA desde
  // la LAN: tenía que conocer además el token del operador.
  // El proxy no puede (ni debe) consultar la DB: si hay una cookie de
  // dispositivo o de sesión de operador, la deja pasar y la validación real
  // la hace la ruta (`lib/auth/guard.ts` / `lib/auth/operator.ts`).
  // Etapa 0.4: el token de dispositivo también puede llegar por HEADER
  // (`x-magi-device-token`), que es lo que usan los clientes sin cookies
  // (CLI, SDK, opencode como subagente). El proxy NO lo valida —no puede
  // tocar la DB—: solo lo deja pasar, igual que con la cookie. La validación
  // real la hace `lib/auth/authorize.ts` vía `readDeviceToken`.
  const deviceCookie = readCookie(request.cookie ?? null, DEVICE_COOKIE);
  const deviceHeader = (request.deviceTokenHeader ?? "").trim();
  const sessionCookie = readCookie(request.cookie ?? null, OPERATOR_SESSION_COOKIE);
  if (token && !request.tokenExempt && !deviceCookie && !deviceHeader && !sessionCookie) {
    const bearer = readBearer(request.authorization ?? null);
    const cookie = readCookie(request.cookie ?? null, TOKEN_COOKIE);
    const bearerOk = bearer !== null && constantTimeEqual(bearer, token);
    const cookieOk = cookie !== null && constantTimeEqual(cookie, token);
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
