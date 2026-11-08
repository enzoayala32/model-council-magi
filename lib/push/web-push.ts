/**
 * Fase 6 — cliente Web Push (RFC 8291) sin dependencias.
 *
 * El servicio de push (FCM, Mozilla...) no deja que el SERVIDOR mande texto
 * plano: obliga a cifrar el payload con una clave efímera derivada de
 * ECDH(P-256) contra la clave pública del navegador. El resultado es un
 * registro `aes128gcm` que solo el navegador puede abrir.
 *
 * El flujo, tal cual lo exige la spec:
 *   1. ecdh = ECDH(privada_efimera, publica_del_navegador)
 *   2. PRK_key = HMAC-SHA256(auth_secret, ecdh)         -- auth de la suscripción
 *   3. IKM = HKDF(PRK_key, "", "WebPush: info"||0||pub_efimera||pub_navegador, 32)
 *   4. PRK = HMAC-SHA256(salt, IKM)
 *   5. CEK = HKDF(PRK, "aes128gcm", "Content-Encoding: aes128gcm"||0, 16)
 *      NONCE = HKDF(PRK, "aes128gcm", "Content-Encoding: nonce"||0, 12)
 *   6. registro = salt(16) || rs(4, BE) || idlen(1) || id(65) || ciphertext+tag
 *
 * Los tests no pueden "descifrar" (eso lo hace el navegador), así que
 * verifican la ESTRUCTURA del registro, el JWT VAPID con verificación real de
 * firma, y que el envío sea idéntico ante las mismas entradas cuando se fija
 * la aleatoriedad.
 */

import crypto from "node:crypto";
import { base64Url, fromBase64Url, createVapidJwt, type VapidKeys } from "./vapid";
import { validatePushEndpoint, type PushEndpointOptions } from "./endpoint";

export type PushSubscription = {
  /** URL del servicio de push de este navegador. */
  endpoint: string;
  /** Clave pública del navegador, base64url del punto sin comprimir. */
  p256dh: string;
  /** Secreto de autenticación de la suscripción, base64url. */
  auth: string;
};

/** Tamaño máximo de registro que aceptan los servicios (4 KB en FCM). */
const RECORD_SIZE = 4096;

function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  const prk = crypto.createHmac("sha256", salt).update(ikm).digest();
  let previous = Buffer.alloc(0);
  let output = Buffer.alloc(0);
  for (let counter = 1; output.length < length; counter += 1) {
    previous = crypto
      .createHmac("sha256", prk)
      .update(Buffer.concat([previous, info, Buffer.from([counter])]))
      .digest();
    output = Buffer.concat([output, previous]);
  }
  return output.subarray(0, length);
}

/** Construye el registro cifrado. `random` es inyectable para los tests. */
export function encryptAes128gcm(
  subscription: { p256dh: string; auth: string },
  plaintext: Buffer,
  random: (size: number) => Buffer = (size: number) => crypto.randomBytes(size),
): { body: Buffer; salt: Buffer; ephemeralPublicKey: Buffer } {
  const authSecret = fromBase64Url(subscription.auth);
  const userPublicKeyRaw = fromBase64Url(subscription.p256dh);

  // Clave pública del navegador como KeyObject de Node.
  const userPublicKey = crypto.createPublicKey({
    key: publicKeyDerFromRaw(userPublicKeyRaw),
    format: "der",
    type: "spki",
  });

  const ephemeral = crypto.generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });
  const ephemeralRaw = ephemeral.publicKey.subarray(ephemeral.publicKey.length - 65);

  const ecdhSecret = crypto.diffieHellman({
    privateKey: crypto.createPrivateKey({ key: ephemeral.privateKey, format: "der", type: "pkcs8" }),
    publicKey: userPublicKey,
  });

  const salt = random(16);
  const authInfo = Buffer.from("Content-Encoding: auth\0", "utf8");
  const keyInfo = Buffer.concat([
    Buffer.from("WebPush: info\0", "utf8"),
    ephemeralRaw,
    userPublicKeyRaw,
  ]);

  const prkKey = crypto.createHmac("sha256", authSecret).update(ecdhSecret).digest();
  const ikm = hkdf(prkKey, Buffer.alloc(0), keyInfo, 32);
  const prk = crypto.createHmac("sha256", salt).update(ikm).digest();
  void authInfo; // la spec lo usa sólo en el modo con clave del servidor

  const cek = hkdf(prk, Buffer.from("aes128gcm", "utf8"), Buffer.from("Content-Encoding: aes128gcm\0", "utf8"), 16);
  const nonce = hkdf(prk, Buffer.from("aes128gcm", "utf8"), Buffer.from("Content-Encoding: nonce\0", "utf8"), 12);

  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  cipher.setAAD(Buffer.from("Content-Encoding: aes128gcm\0", "utf8"));
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.concat([
    salt,
    Buffer.from([(RECORD_SIZE >>> 24) & 0xff, (RECORD_SIZE >>> 16) & 0xff, (RECORD_SIZE >>> 8) & 0xff, RECORD_SIZE & 0xff]),
    Buffer.from([ephemeralRaw.length]),
    ephemeralRaw,
  ]);
  return { body: Buffer.concat([header, encrypted]), salt, ephemeralPublicKey: ephemeralRaw };
}

function publicKeyDerFromRaw(raw: Buffer): Buffer {
  const algorithm = Buffer.from("301306072a8648ce3d020106082a8648ce3d030107", "hex");
  const pointBitString = Buffer.concat([Buffer.from([0x03, raw.length + 1, 0x00]), raw]);
  const inner = Buffer.concat([algorithm, pointBitString]);
  return Buffer.concat([Buffer.from([0x30, inner.length]), inner]);
}

export type SendResult = {
  ok: boolean;
  status: number;
  /**
   * CATEGORÍA del fallo, no el mensaje crudo. `last_error` en la DB guarda
   * esto: un cuerpo de respuesta de un servicio de push puede traer el
   * endpoint, tokens o detalles de red que no tiene por qué quedar
   * persistidos ni mostrarse en la UI.
   */
  error?: PushErrorCategory;
};

export type PushErrorCategory = "rechazado" | "expirado" | "red" | "tiempo" | "no-configurado";

/**
 * Envía una notificación. Devuelve el resultado; NUNCA lanza — un servicio de
 * push caído no puede tumbar el request que originó la notificación.
 *
 * Corrección de la revisión (SSRF): ANTES de enviar se REVALIDA el endpoint
 * guardado, porque el registro puede ser anterior a la allowlist. Si no pasa,
 * no se manda nada. Los redirects son error (`redirect: "error"`): un 302 a
 * una IP interna sería el mismo SSRF por otro camino.
 */
export async function sendWebPush(
  subscription: PushSubscription,
  payload: unknown,
  keys: VapidKeys,
  fetchImpl: typeof fetch = fetch,
  endpointOptions: PushEndpointOptions = {},
): Promise<SendResult> {
  let audience: string;
  try {
    audience = new URL(subscription.endpoint).origin;
  } catch {
    return { ok: false, status: 0, error: "rechazado" };
  }

  // Revalidación al enviar (la suscripción puede ser de antes de la allowlist).
  const endpointCheck = await validatePushEndpoint(subscription.endpoint, endpointOptions);
  if (!endpointCheck.ok) {
    // Un fallo de DNS NO es un rechazo del servicio: es un problema de red, y
    // sobre todo NO debe desactivar la suscripción (el navegador seguiría
    // intentando suscribirse a un endpoint perfectamente válido).
    return { ok: false, status: 0, error: endpointCheck.reason === "dns" ? "red" : "rechazado" };
  }

  let encrypted: { body: Buffer; salt: Buffer; ephemeralPublicKey: Buffer };
  try {
    encrypted = encryptAes128gcm(subscription, Buffer.from(JSON.stringify(payload), "utf8"));
  } catch {
    // Una clave `p256dh` corrupta en la DB haría que OpenSSL lanzara acá. Ese
    // error crudo (con stack de OpenSSL) no puede salir ni persistirse: se
    // categoriza y se corta el envío.
    return { ok: false, status: 0, error: "rechazado" };
  }
  const jwt = createVapidJwt(keys, audience);

  try {
    const response = await fetchImpl(endpointCheck.url.toString(), {
      method: "POST",
      // Sin seguir redirects: un 302 a una IP privada sería el SSRF que se
      // está cerrando, por otra puerta.
      redirect: "error",
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Encoding": "aes128gcm",
        TTL: "2419200",
        Authorization: "vapid t=" + jwt + ", k=" + keys.publicKey,
        Encryption: "salt=" + base64Url(encrypted.salt),
        "Crypto-Key": "dh=" + base64Url(encrypted.ephemeralPublicKey) + "; p256ecdsa=" + keys.publicKey,
      },
      body: new Uint8Array(encrypted.body),
    });
    if (response.ok) return { ok: true, status: response.status };
    // El cuerpo NO se guarda ni se devuelve: solo la categoría.
    await response.arrayBuffer().catch(() => undefined);
    return { ok: false, status: response.status, error: categorizeHttpStatus(response.status) };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const timedOut = /timeout|abort/i.test(message);
    return { ok: false, status: 0, error: timedOut ? "tiempo" : "red" };
  }
}

/**
 * 404/410 = el servicio ya no conoce esta suscripción (el navegador la dio de
 * baja, o caducó). El resto de rechazos: credencial, payload, rate limit.
 */
export function categorizeHttpStatus(status: number): PushErrorCategory {
  if (status === 404 || status === 410 || status === 413) return "expirado";
  if (status === 401 || status === 403 || status === 429) return "rechazado";
  if (status >= 500) return "red";
  return "rechazado";
}
