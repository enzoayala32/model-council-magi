/**
 * Fase 4c - almacenamiento del secreto TOTP y sesiones de step-up.
 *
 * Regla de seguridad: el secreto TOTP NUNCA se guarda en claro. Se cifra
 * con AES-256-GCM usando una clave derivada de un "pepper" que vive en el
 * entorno, no en la DB. Si no hay pepper configurado, la inscripcion
 * FALLA con un mensaje claro: es preferible no poder anotar el dispositivo
 * que dejar el secreto legible en el archivo .db.
 *
 * La sesion de step-up es en memoria, con expiracion corta (5 min). Un
 * reinicio del server la pierde y el usuario vuelve a confirmar: no hay
 * nada que robar de un archivo.
 */

import crypto from "node:crypto";
import { getDb } from "../db";
import { generateTotpSecret, otpauthUrl, verifyTotp } from "./totp";
import { recordAudit } from "./audit";

/** Validez del step-up. Corta a proposito: confirma "estoy aca ahora". */
export const STEP_UP_TTL_MS = 5 * 60_000;

/**
 * Clave de cifrado. Orden: `MAGI_TOTP_KEY` (dedicada) y si no
 * `APP_ACCESS_TOKEN` (que ya es un secreto del operador). Las dos viven en
 * el entorno, no en la DB.
 */
function resolvePepper(): string | null {
  const dedicated = process.env.MAGI_TOTP_KEY?.trim();
  if (dedicated) return dedicated;
  const appToken = process.env.APP_ACCESS_TOKEN?.trim();
  return appToken ? appToken : null;
}

export function totpEncryptionAvailable(): boolean {
  return resolvePepper() !== null;
}

const IV_BYTES = 12; // GCM standard
const ALGORITHM = "aes-256-gcm";

/** Clave de 32 bytes: SHA-256 del pepper. El pepper es alta entropia, asi
 *  que un KDF caro no agrega nada acá. */
function deriveKey(pepper: string): Buffer {
  return crypto.createHash("sha256").update(pepper, "utf8").digest();
}

export function encryptSecret(plaintext: string, pepper: string): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, deriveKey(pepper), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), encrypted.toString("base64")].join(".");
}

export function decryptSecret(payload: string, pepper: string): string | null {
  const parts = payload.split(".");
  if (parts.length !== 3) return null;
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, deriveKey(pepper), Buffer.from(parts[0], "base64"));
    decipher.setAuthTag(Buffer.from(parts[1], "base64"));
    return Buffer.concat([decipher.update(Buffer.from(parts[2], "base64")), decipher.final()]).toString("utf8");
  } catch {
    // Tag invalido o datos corruptos: no se puede recuperar el secreto.
    return null;
  }
}

// ---------- Inscripcion ----------

export type TotpEnrollment = {
  deviceId: string;
  secret: string;
  url: string;
};

/** Genera y guarda (cifrado) el secreto para un dispositivo. */
export function enrollDeviceTotp(deviceId: string, opts: { account: string; issuer: string }): TotpEnrollment | { error: string } {
  const pepper = resolvePepper();
  if (!pepper) {
    return {
      error:
        "No hay clave para cifrar el secreto TOTP. Definí MAGI_TOTP_KEY (o APP_ACCESS_TOKEN) en .env y vuelva a intentar.",
    };
  }
  const secret = generateTotpSecret();
  const url = otpauthUrl(secret, { account: opts.account, issuer: opts.issuer });
  getDb()
    .prepare(
      `INSERT INTO device_totp (device_id, secret_enc, confirmed_at) VALUES (?, ?, ?)
       ON CONFLICT(device_id) DO UPDATE SET secret_enc = excluded.secret_enc, confirmed_at = excluded.confirmed_at`,
    )
    .run(deviceId, encryptSecret(secret, pepper), Date.now());
  recordAudit({ deviceId, action: "device_created", targetId: deviceId, result: "ok", detail: "totp inscrito" });
  return { deviceId, secret, url };
}

/** Secreto en claro, solo para verificar un codigo. null si no hay o no se puede descifrar. */
export function loadDeviceSecret(deviceId: string): string | null {
  const pepper = resolvePepper();
  if (!pepper) return null;
  const row = getDb().prepare("SELECT secret_enc FROM device_totp WHERE device_id = ?").get(deviceId) as { secret_enc: string } | undefined;
  if (!row) return null;
  return decryptSecret(row.secret_enc, pepper);
}

export function hasDeviceTotp(deviceId: string): boolean {
  const row = getDb().prepare("SELECT device_id FROM device_totp WHERE device_id = ?").get(deviceId) as { device_id: string } | undefined;
  return Boolean(row);
}

// ---------- Sesiones de step-up ----------

type StepUpSession = { tokenHash: string; expiresAt: number };

/** En memoria, por dispositivo. Un reinicio las pierde (a proposito). */
const sessions = new Map<string, StepUpSession[]>();

/** Emite un step-up si el codigo es valido. Devuelve el token o null. */
export function issueStepUp(deviceId: string, code: string): string | null {
  const secret = loadDeviceSecret(deviceId);
  if (!secret) return null;
  if (!verifyTotp(secret, code)) {
    recordAudit({ deviceId, action: "stepup_failed", result: "denied" });
    return null;
  }
  const token = crypto.randomBytes(32).toString("hex");
  const now = Date.now();
  const list = (sessions.get(deviceId) ?? []).filter((session) => session.expiresAt > now);
  list.push({ tokenHash: hashToken(token), expiresAt: now + STEP_UP_TTL_MS });
  sessions.set(deviceId, list);
  recordAudit({ deviceId, action: "stepup_ok", result: "ok" });
  return token;
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

export function isStepUpValid(deviceId: string, token: string | null | undefined): boolean {
  if (!token) return false;
  const now = Date.now();
  const list = (sessions.get(deviceId) ?? []).filter((session) => session.expiresAt > now);
  sessions.set(deviceId, list);
  const hash = hashToken(token.trim());
  return list.some((session) => session.tokenHash === hash);
}

/** Revoka las sesiones de un dispositivo (logout, revocacion, cambio de scope). */
export function clearStepUp(deviceId: string): void {
  sessions.delete(deviceId);
}

/** Solo para tests. */
export function __resetStepUpForTests(): void {
  sessions.clear();
}
