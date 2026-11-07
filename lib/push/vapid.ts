/**
 * Fase 6 — credenciales VAPID (Voluntary Application Server Identification).
 *
 * Un servidor de push necesita un par de claves EC P-256. La pública viaja al
 * navegador para que se suscriba (no es un secreto: la ve cualquier servicio
 * de push). La privada firma un JWT de corta vida en cada envío, que es lo que
 * le dice al servicio "este envío es de este servidor".
 *
 * El par se GENERA ACÁ, localmente: no hace falta registrarse en ningún
 * servicio ni configurar nada externo. Se guarda en la DB (tabla `push_config`)
 * con la clave privada CIFRADA, reusando el mismo mecanismo que los secretos
 * TOTP (`lib/auth/step-up.ts`) — así un dump de la DB no alcanza para firmar
 * envíos.
 *
 * Sin dependencias: `node:crypto` alcanza para EC P-256 y para firmar ES256.
 */

import crypto from "node:crypto";
import { getDb } from "../db";
import { encryptSecret, decryptSecret } from "../auth/step-up";

/** Clave pública en el formato que espera el navegador: el punto sin comprimir
 *  (65 bytes: 0x04 || X || Y) en base64url. */
export function rawPublicKeyBase64Url(publicKeyDer: Buffer): string {
  // El DER de SPKI de EC P-256 termina exactamente en el punto sin comprimir.
  const raw = publicKeyDer.subarray(publicKeyDer.length - 65);
  return base64Url(raw);
}

export function base64Url(buffer: Buffer | Uint8Array): string {
  return Buffer.from(buffer).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export type VapidKeys = {
  /** base64url del punto sin comprimir (lo que se manda al navegador). */
  publicKey: string;
  /** Objeto de Node con la privada: para firmar. Nunca se serializa. */
  privateKey: crypto.KeyObject;
};

/** El pepper sale del mismo lugar que TOTP. Sin él no se puede cifrar la clave. */
function resolvePepper(): string | null {
  return process.env.MAGI_TOTP_KEY?.trim() || process.env.APP_ACCESS_TOKEN?.trim() || null;
}

type KeyPairDer = {
  publicKey: Buffer;
  privateKey: Buffer;
  publicKeyObject: crypto.KeyObject;
  privateKeyObject: crypto.KeyObject;
};

function generateKeyPairDer(): KeyPairDer {
  const pair = crypto.generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });
  return {
    publicKey: pair.publicKey as Buffer,
    privateKey: pair.privateKey as Buffer,
    publicKeyObject: crypto.createPublicKey({ key: pair.publicKey as Buffer, format: "der", type: "spki" }),
    privateKeyObject: crypto.createPrivateKey({ key: pair.privateKey as Buffer, format: "der", type: "pkcs8" }),
  };
}

/**
 * Carga el par de la DB; si no existe todavía, lo genera y lo guarda.
 *
 * Devuelve `null` si falta el pepper: en ese caso el push no está configurado y
 * el llamador tiene que decirlo claramente (no es un error del request).
 */
export function loadOrCreateVapidKeys(): VapidKeys | null {
  const pepper = resolvePepper();
  if (!pepper) return null;

  const row = getDb().prepare("SELECT public_key, private_key_enc FROM push_config WHERE id = 'vapid'").get() as
    | { public_key: string; private_key_enc: string }
    | undefined;

  if (row) {
    const privateDer = decryptToBuffer(row.private_key_enc, pepper);
    if (privateDer) {
      try {
        return {
          publicKey: row.public_key,
          privateKey: crypto.createPrivateKey({ key: privateDer, format: "der", type: "pkcs8" }),
        };
      } catch {
        // Clave corrupta: se cae al camino de regenerar (más abajo).
      }
    }
  }

  const generated = generateKeyPairDer();
  const publicKey = rawPublicKeyBase64Url(generated.publicKey);
  const privateEnc = encryptSecret(generated.privateKey.toString("base64"), pepper);
  getDb()
    .prepare(
      `INSERT INTO push_config (id, public_key, private_key_enc, created_at) VALUES ('vapid', ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET public_key = excluded.public_key, private_key_enc = excluded.private_key_enc,
         created_at = excluded.created_at`,
    )
    .run(publicKey, privateEnc, Date.now());
  return { publicKey, privateKey: generated.privateKeyObject };
}

function decryptToBuffer(payload: string, pepper: string): Buffer | null {
  const value = decryptSecret(payload, pepper);
  if (value === null) return null;
  try {
    return Buffer.from(value, "base64");
  } catch {
    return null;
  }
}

/** Solo la pública: para la ruta que le responde al navegador. No genera nada. */
export function readVapidPublicKey(): string | null {
  const row = getDb().prepare("SELECT public_key FROM push_config WHERE id = 'vapid'").get() as
    | { public_key: string }
    | undefined;
  return row?.public_key ?? null;
}

function base64UrlJson(value: unknown): string {
  return base64Url(Buffer.from(JSON.stringify(value), "utf8"));
}

/**
 * JWT VAPID: ES256 sobre `base64url(header).base64url(claims)`.
 *
 * - `aud`: el origen del servicio de push (el que corresponde al endpoint).
 * - `exp`: 12 horas, el máximo que aceptan los servicios.
 * - `sub`: mailto, por si un operador de push quiere contactarte.
 */
export function createVapidJwt(keys: VapidKeys, audience: string, subject = "mailto:admin@localhost"): string {
  const header = base64UrlJson({ typ: "JWT", alg: "ES256" });
  const claims = base64UrlJson({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: subject,
  });
  const signature = crypto.sign("sha256", Buffer.from(header + "." + claims, "utf8"), keys.privateKey);
  return header + "." + claims + "." + base64Url(signature);
}

/** Verifica un JWT VAPID (para los tests: comprueba que la firma es real). */
export function verifyVapidJwt(jwt: string, publicKeyOverride?: string): { aud: string; exp: number; sub?: string } | null {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  const [header, claims, signature] = parts;
  try {
    const publicKey = publicKeyOverride ?? readVapidPublicKey();
    if (!publicKey) return null;
    // Node no acepta el punto suelto como clave: hay que envolverlo en el DER
    // de SPKI. Sin eso, createPublicKey lanza y la verificación no llega a
    // correr (que es exactamente lo que pasaba con un bloque muerto acá).
    const normalized = crypto.createPublicKey({
      key: publicKeyDerFromRaw(fromBase64Url(publicKey)),
      format: "der",
      type: "spki",
    });
    const ok = crypto.verify("sha256", Buffer.from(header + "." + claims, "utf8"), normalized, fromBase64Url(signature));
    if (!ok) return null;
    return JSON.parse(Buffer.from(claims.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as {
      aud: string;
      exp: number;
      sub?: string;
    };
  } catch {
    return null;
  }
}

/** Envuelve un punto sin comprimir en el DER de SPKI (para createPublicKey). */
function publicKeyDerFromRaw(raw: Buffer): Buffer {
  // SPKI para prime256v1: secuencia con algoritmo EC + el punto como BIT STRING.
  const algorithm = Buffer.from("301306072a8648ce3d020106082a8648ce3d030107", "hex");
  const pointBitString = Buffer.concat([
    Buffer.from([0x03, raw.length + 1, 0x00]),
    raw,
  ]);
  const inner = Buffer.concat([algorithm, pointBitString]);
  return Buffer.concat([Buffer.from([0x30, inner.length]), inner]);
}
