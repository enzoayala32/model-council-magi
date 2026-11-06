/**
 * Fase 4c - TOTP (RFC 6238) con node:crypto, sin dependencias.
 *
 * Por que no una libreria: el algoritmo son 4 lineas de HMAC-SHA1 mas un
 * truncado dinamico. Meter un paquete para eso agrega superficie de
 * supply chain a cambio de nada, y `node:crypto` ya trae todo lo necesario.
 *
 * Los vectores de prueba son los PUBLICADOS en el RFC 6238 (apendice B),
 * asi que la implementacion queda verificada contra un estandar y no contra
 * si misma.
 */

import crypto from "node:crypto";

/** Paso de tiempo por default del RFC: 30 segundos. */
export const TOTP_STEP_SECONDS = 30;
/** Digitos por default (lo que pide la mayoria de los autenticadores). */
export const TOTP_DIGITS = 6;

// ---------- Base32 (RFC 4648) ----------
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buffer: Buffer): string {
  let bits = "";
  for (const byte of buffer) bits += byte.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i < bits.length; i += 5) {
    out += BASE32_ALPHABET[parseInt(bits.slice(i, i + 5).padEnd(5, "0"), 2)];
  }
  // Padding RFC 4648: multiplos de 8. Los secretos de 20 bytes (160 bits)
  // caen justo en 32 caracteres y no lo necesitan.
  while (out.length % 8 !== 0) out += "=";
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/=+$/, "").replace(/\s+/g, "");
  let bits = "";
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error("Caracter no valido en base32");
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

// ---------- TOTP ----------

/** Secreto nuevo: 20 bytes (160 bits), lo que recomienda el RFC. */
export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

/** Contador TOTP para un instante dado. */
export function counterFor(timestampMs: number, stepSeconds = TOTP_STEP_SECONDS): number {
  return Math.floor(timestampMs / 1000 / stepSeconds);
}

/**
 * Codigo TOTP. Implementacion directa del RFC 6238 seccion 5.3:
 * HMAC-SHA1(secreto, contador de 8 bytes big-endian) y truncado dinamico
 * por el ultimo nibble del digest.
 */
export function totpCode(secretBase32: string, counter: number, digits = TOTP_DIGITS): string {
  const key = base32Decode(secretBase32);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter), 0);
  const digest = crypto.createHmac("sha1", key).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  const code = binary % 10 ** digits;
  return code.toString().padStart(digits, "0");
}

export type TotpVerifyOptions = {
  /** Ventana de pasos aceptados a cada lado (default 1 = ±30s). */
  window?: number;
  stepSeconds?: number;
  now?: number;
  digits?: number;
};

/**
 * Verifica un codigo. La ventana existe para tolerar el desfase de reloj
 * entre el telefono y la PC; con window=1 se aceptan el paso anterior, el
 * actual y el siguiente.
 */
export function verifyTotp(secretBase32: string, code: string, options: TotpVerifyOptions = {}): boolean {
  const trimmed = code.replace(/\s+/g, "");
  if (!/^\d+$/.test(trimmed)) return false;
  const window = options.window ?? 1;
  const now = options.now ?? Date.now();
  const stepSeconds = options.stepSeconds ?? TOTP_STEP_SECONDS;
  const digits = options.digits ?? TOTP_DIGITS;
  const current = counterFor(now, stepSeconds);
  for (let drift = -window; drift <= window; drift += 1) {
    const expected = totpCode(secretBase32, current + drift, digits);
    // Comparacion de tiempo constante: no filtrar por timing cuantos digitos coinciden.
    if (expected.length === trimmed.length && constantTimeEqual(expected, trimmed)) return true;
  }
  return false;
}

/** Comparacion de tiempo constante para strings de igual largo. */
function constantTimeEqual(a: string, b: string): boolean {
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** URI `otpauth://` para el QR que escanea la app de autenticacion. */
export function otpauthUrl(secretBase32: string, opts: { account: string; issuer: string; digits?: number }): string {
  const digits = opts.digits ?? TOTP_DIGITS;
  const label = `${encodeURIComponent(opts.issuer)}:${encodeURIComponent(opts.account)}`;
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer: opts.issuer,
    algorithm: "SHA1",
    digits: String(digits),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
