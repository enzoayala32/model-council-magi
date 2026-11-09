/**
 * Fase 7 (pendiente) — transporte HTTP para clientes MCP.
 *
 * Un servidor MCP puede estar en otro proceso (stdio) o detrás de una URL
 * (http/https). Este módulo valida esa URL con las mismas reglas que
 * `lib/push/endpoint.ts`, porque el riesgo es el mismo: que el server mande un
 * request —con credenciales en los headers— a donde no debe.
 *
 * Reglas:
 * - **HTTPS siempre**, salvo loopback con `allowInsecureLocal: true` explícito
 *   en la config (para un servidor local de prueba).
 * - **Sin redirects** (`redirect: "error"`): un 302 a una IP privada sería el
 *   SSRF por otra puerta.
 * - **Sin credenciales en la URL** (`user:pass@`): quedarían en logs.
 * - **IPs literales privadas/link-local/metadata rechazadas**, y los hostnames
 *   que resuelvan a ellas (la resolución es INYECTABLE, como en push).
 * - **Timeout** y **tope de tamaño de respuesta**.
 * - Se **revalida en cada conexión**: un registro viejo no queda confiado para
 *   siempre.
 *
 * Los headers salen por REFERENCIA a variables de entorno (`${NOMBRE}`), nunca
 * como valores en el archivo de config.
 */

import dns from "node:dns/promises";

export type HttpTransportRejection =
  | "malformed"
  | "protocol"
  | "credentials"
  | "literal-ip"
  | "private-address"
  | "dns";

export type HttpTransportCheck = { ok: true; url: URL } | { ok: false; reason: HttpTransportRejection };

/** IPs que jamás se tocan: además de las privadas, el rango de metadata de
 *  nube (169.254.169.254), que es el premio mayor de un SSRF. */
const BLOCKED_V4 = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^0\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^192\.0\.0\./,
  /^192\.0\.2\./,
  /^198\.(1[8-9]|51\.100)\./,
  /^203\.0\.113\./,
  /^224\./,
  /^240\./,
  /^255\./,
];

const BLOCKED_V6 = [/^::$/, /^::1$/, /^fc/, /^fd/, /^fe80:/, /^ff/, /^64:ff9b:/];

function isLoopbackHost(host: string): boolean {
  const clean = host.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  return clean === "localhost" || clean === "::1" || /^127\./.test(clean);
}

export function isLiteralIp(host: string): boolean {
  const clean = host.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(clean)) return true;
  return clean.includes(":") && /^[0-9a-fA-F:]+$/.test(clean);
}

/**
 * Valida direcciones YA resueltas (sin tocar DNS).
 *
 * Existe para que `resolveAndPin` resuelva UNA sola vez: si la validación
 * volviera a llamar al resolvedor, entre las dos llamadas cabría un rebinding.
 */
export function anyBlockedAddress(addresses: readonly string[]): boolean {
  return addresses.some((ip) => isBlockedAddress(ip));
}

/** ¿La IP es privada, de loopback, link-local o de metadata? */
export function isBlockedAddress(ip: string): boolean {
  const clean = ip.trim().replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  if (BLOCKED_V4.some((rule) => rule.test(clean))) return true;
  if (BLOCKED_V6.some((rule) => rule.test(clean))) return true;
  // IPv4 mapeada en IPv6 (::ffff:127.0.0.1).
  const mapped = /^::ffff:(\d{1,3}(\.\d{1,3}){3})$/.exec(clean);
  if (mapped) return isBlockedAddress(mapped[1]);
  return false;
}

export type HttpTransportOptions = {
  /** Solo para un server local de prueba, marcado a mano en la config. */
  allowInsecureLocal?: boolean;
  /** Resolución inyectable (tests). */
  resolve?: (host: string) => Promise<string[]>;
  /**
   * Saltea la validación por DNS. Lo usa `resolveAndPin`, que resuelve UNA vez
   * y valida esas direcciones: si la validación resolviera también, habría dos
   * llamadas al resolvedor y volvería la ventana de rebinding.
   */
  skipDns?: boolean;
};

/**
 * Valida la URL de un servidor MCP http. Orden: lo determinista primero, el
 * DNS al final (por eso es async).
 */
export async function validateHttpTransport(rawUrl: string, options: HttpTransportOptions = {}): Promise<HttpTransportCheck> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "malformed" };
  }

  if (url.username !== "" || url.password !== "") return { ok: false, reason: "credentials" };

  const host = url.hostname.replace(/^\[/, "").replace(/\]$/, "");
  const loopback = isLoopbackHost(host);

  if (url.protocol !== "https:") {
    // HTTP solo para loopback, y solo si la config lo marcó a mano.
    if (url.protocol !== "http:" || !loopback || options.allowInsecureLocal !== true) {
      return { ok: false, reason: "protocol" };
    }
  }
  if (url.hash !== "") return { ok: false, reason: "malformed" };

  if (isLiteralIp(host)) {
    // Una IP literal: se clasifica directo. 127.0.0.1 con allowInsecureLocal
    // se acepta (es local por definición); cualquier otro raro, no.
    const blocked = isBlockedAddress(host);
    if (blocked && !(options.allowInsecureLocal === true && loopback)) {
      return { ok: false, reason: loopback ? "protocol" : "private-address" };
    }
    return { ok: true, url };
  }

  if (options.skipDns) return { ok: true, url };

  if (options.resolve) {
    let addresses: string[];
    try {
      addresses = await options.resolve(host);
    } catch {
      return { ok: false, reason: "dns" };
    }
    if (addresses.length === 0) return { ok: false, reason: "dns" };
    if (addresses.some((address) => isBlockedAddress(address))) return { ok: false, reason: "private-address" };
    return { ok: true, url };
  }

  // Loopback no necesita DNS: ya se sabe a dónde apunta.
  if (loopback) return { ok: true, url };

  const out: string[] = [];
  try {
    await Promise.allSettled([
      dns.resolve4(host).then((rows) => out.push(...rows)),
      dns.resolve6(host).then((rows) => out.push(...rows)),
    ]);
  } catch {
    return { ok: false, reason: "dns" };
  }
  if (out.length === 0) return { ok: false, reason: "dns" };
  if (out.some((address) => isBlockedAddress(address))) return { ok: false, reason: "private-address" };
  return { ok: true, url };
}

/**
 * Reemplaza `${NOMBRE}` por el valor de la variable de entorno. Si la variable
 * no existe, devuelve null: el header se omite (nunca el texto literal).
 *
 * Así la config guarda REFERENCIAS, no valores: `{"Authorization": "${MI_TOKEN}"}`.
 */
export function resolveHeaderTemplates(
  headers: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env,
): { headers: Record<string, string>; missing: string[] } {
  const out: Record<string, string> = {};
  const missing: string[] = [];
  for (const [key, value] of Object.entries(headers)) {
    const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value.trim());
    if (!match) {
      out[key] = value;
      continue;
    }
    const name = match[1];
    const resolved = env[name];
    if (typeof resolved !== "string" || resolved === "") {
      missing.push(name);
      continue;
    }
    out[key] = resolved;
  }
  return { headers: out, missing };
}
