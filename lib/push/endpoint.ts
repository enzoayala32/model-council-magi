/**
 * Fase 6 (corrección de la revisión) — validación de endpoints de push.
 *
 * El bug que fija: la ruta de suscripción solo exigía `https:`. Con eso,
 * cualquiera con una credencial de operador podía hacer que el server mandara
 * un POST cifrado a `https://127.0.0.1:1/x`, `https://localhost:9/x`,
 * `https://10.0.0.5/x` o a la propia app — un SSRF con las credenciales de la
 * petición (el JWT VAPID viaja en el header Authorization).
 *
 * Ahora el endpoint tiene que ser de un servicio de push conocido:
 *   - `fcm.googleapis.com` (Android/FCM)
 *   - `*.push.services.mozilla.com` (Firefox/Mozilla)
 *   - `*.notify.windows.com` (Windows/Edge)
 *   - `web.push.apple.com` (Safari 16+/iOS)
 * Ampliable SOLO por el operador, con `PUSH_ALLOWED_HOSTS` (lista separada por
 * comas). El cliente nunca puede ampliarla.
 *
 * Además se rechaza: IPs literales, hosts que resuelvan a loopback/privadas/
 * link-local, puerto distinto de 443, y credenciales en la URL.
 *
 * La resolución DNS es INYECTABLE: la función es pura salvo por ella, así los
 * tests prueban "un hostname que apunta a una IP privada" sin tocar la red.
 */

import dns from "node:dns/promises";

function fromBase64Url(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export type EndpointRejection =
  | "malformed"
  | "protocol"
  | "credentials"
  | "port"
  | "literal-ip"
  | "host-not-allowed"
  | "private-address"
  | "dns";

export type EndpointCheck = { ok: true; url: URL } | { ok: false; reason: EndpointRejection };

/** Hosts por defecto. Los que empiezan con punto son sufijo (subdominios). */
export const DEFAULT_PUSH_HOSTS: readonly string[] = [
  "fcm.googleapis.com",
  ".push.services.mozilla.com",
  ".notify.windows.com",
  "web.push.apple.com",
];

/** Allowlist efectiva: los defaults + lo que agregue el operador por entorno. */
export function pushHostAllowlist(env: NodeJS.ProcessEnv = process.env): string[] {
  const out = [...DEFAULT_PUSH_HOSTS];
  const extra = (env.PUSH_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  for (const host of extra) if (!out.includes(host)) out.push(host);
  return out;
}

/** ¿El host está en la allowlist? Coincidencia exacta o por sufijo. */
export function isAllowedPushHost(host: string, allowlist: readonly string[] = pushHostAllowlist()): boolean {
  const clean = host.trim().toLowerCase().replace(/\.$/, "");
  if (!clean) return false;
  return allowlist.some((entry) => {
    const pattern = entry.toLowerCase().replace(/\.$/, "");
    if (pattern.startsWith(".")) return clean.endsWith(pattern) || clean === pattern.slice(1);
    return clean === pattern;
  });
}

/** IPv4 o IPv6 literal, con o sin corchetes. */
export function isLiteralIp(host: string): boolean {
  const clean = host.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(clean)) return true;
  // IPv6: al menos dos separadores y solo hex/dos puntos.
  if (clean.includes(":") && /^[0-9a-fA-F:]+$/.test(clean)) return true;
  return false;
}

export type AddressClass = "loopback" | "private" | "link-local" | "public";

/** Clasifica una IP ya resuelta. */
export function classifyAddress(ip: string): AddressClass {
  const clean = ip.trim().replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  if (clean === "::1" || clean.startsWith("127.")) return "loopback";
  if (/^10\./.test(clean)) return "private";
  if (/^192\.168\./.test(clean)) return "private";
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(clean)) return "private";
  if (/^169\.254\./.test(clean)) return "link-local";
  if (clean.startsWith("fe80:")) return "link-local";
  if (clean === "::" || clean.startsWith("fc") || clean.startsWith("fd")) return "private";
  return "public";
}

/** ¿Alguna de las IPs resueltas es no pública? */
export function anyNonPublic(addresses: readonly string[]): boolean {
  return addresses.some((address) => classifyAddress(address) !== "public");
}

export type PushEndpointOptions = {
  allowlist?: readonly string[];
  /** Resuelve un hostname a IPs. Inyectable para los tests. */
  resolve?: (host: string) => Promise<string[]>;
  /** Si se pasa, se acepta aunque no resuelva (para tests con hosts inventados). */
  skipDns?: boolean;
};

/**
 * Valida un endpoint completo. Es `async` solo por la resolución DNS.
 *
 * Orden a propósito: primero lo barato y determinista (formato, esquema,
 * credenciales, puerto, IP literal), y recién al final la allowlist y el DNS.
 */
export async function validatePushEndpoint(endpoint: string, options: PushEndpointOptions = {}): Promise<EndpointCheck> {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return { ok: false, reason: "malformed" };
  }

  if (url.protocol !== "https:") return { ok: false, reason: "protocol" };
  // Credenciales en la URL: se mandarían al servicio y quedarían en los logs.
  if (url.username !== "" || url.password !== "") return { ok: false, reason: "credentials" };
  // Fragmento: sobra y puede filtrar datos en el referer.
  if (url.hash !== "") return { ok: false, reason: "malformed" };

  // La IP literal se rechaza ANTES del puerto: es el problema más de fondo
  // (una IP en el endpoint ya no es un servicio de push), y así el motivo que
  // se reporta es el que hay que arreglar.
  const host = url.hostname.replace(/^\[/, "").replace(/\]$/, "");
  if (isLiteralIp(host)) return { ok: false, reason: "literal-ip" };

  const allowlist = options.allowlist ?? pushHostAllowlist();
  if (!isAllowedPushHost(host, allowlist)) return { ok: false, reason: "host-not-allowed" };
  if (url.port !== "" && url.port !== "443") return { ok: false, reason: "port" };

  if (options.skipDns) return { ok: true, url };
  const resolve = options.resolve ?? defaultResolve;
  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch {
    // No se pudo resolver: no se puede afirmar que sea público. Cerrado.
    return { ok: false, reason: "dns" };
  }
  if (addresses.length === 0) return { ok: false, reason: "dns" };
  if (anyNonPublic(addresses)) return { ok: false, reason: "private-address" };
  return { ok: true, url };
}

/** Resolución real, para producción. A y AAAA juntos. */
async function defaultResolve(host: string): Promise<string[]> {
  const out: string[] = [];
  await Promise.allSettled([
    dns.resolve4(host).then((rows) => out.push(...rows)),
    dns.resolve6(host).then((rows) => out.push(...rows)),
  ]);
  return out;
}

/** Para los tests: una resolución fija por host. */
export function fakeResolver(map: Record<string, string[]>): (host: string) => Promise<string[]> {
  return (host: string) => {
    const rows = map[host] ?? map[host.replace(/^\[/, "").replace(/\]$/, "")];
    return Promise.resolve(rows ?? []);
  };
}

/** Tip de URL pública, para mostrar en la UI (nunca el endpoint completo). */
export function pushServiceName(endpoint: string): string {
  try {
    const host = new URL(endpoint).hostname;
    if (host.endsWith("googleapis.com")) return "FCM (Android)";
    if (host.endsWith("push.services.mozilla.com")) return "Mozilla";
    if (host.endsWith("notify.windows.com")) return "Windows";
    if (host === "web.push.apple.com") return "Apple";
    return host;
  } catch {
    return "desconocido";
  }
}


/**
 * Valida las claves que manda el navegador al suscribirse.
 *
 * Los navegadores mandan SIEMPRE lo mismo: la clave pública como punto sin
 * comprimir de P-256 (65 bytes, empieza en 0x04) y el secreto de autenticación
 * de 16 bytes, ambos en base64url. Si no cumple eso, es basura: guardarla haría
 * que el primer envío fallara con un error de OpenSSL crudo, y ese error
 * terminaría en `last_error` (o tumbando el proceso).
 */
export type KeysCheck = { ok: true } | { ok: false; error: string };

export function validateSubscriptionKeys(p256dh: string, auth: string): KeysCheck {
  for (const [label, value] of [["p256dh", p256dh], ["auth", auth]] as const) {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) return { ok: false, error: "La clave " + label + " no es base64url." };
  }
  let publicKey: Buffer;
  let authSecret: Buffer;
  try {
    publicKey = fromBase64Url(p256dh);
    authSecret = fromBase64Url(auth);
  } catch {
    return { ok: false, error: "Las claves no se pueden decodificar." };
  }
  if (publicKey.length !== 65 || publicKey[0] !== 0x04) {
    return { ok: false, error: "La clave pública tiene que ser un punto P-256 sin comprimir (65 bytes)." };
  }
  if (authSecret.length !== 16) {
    return { ok: false, error: "El secreto de autenticación tiene que ser de 16 bytes." };
  }
  return { ok: true };
}
