/**
 * Fase 4a - codigos de emparejamiento de un solo uso.
 *
 * Flujo: la PC (loopback) genera un codigo con un scope; el telefono lo
 * canjea por un dispositivo. El codigo viaja en el FRAGMENTO de la URL del
 * QR (#code=...), no en la query, para que no quede en logs de server ni
 * en el historial de proxies.
 *
 * Reglas:
 * - Un solo uso: al canjearse se marca `used_at`. Un segundo canje falla.
 * - Expiran (5 minutos por default).
 * - Se guarda HASHEADO (SHA-256): un codigo que se filtre por un log no
 *   sirve para nada. El valor en claro se muestra una unica vez en la PC.
 * - Canje requiere rate limiting (ver lib/auth/rate-limit.ts) y devuelve
 *   mensajes genericos: no filtra si el codigo existia, expiro o ya se uso.
 */

import crypto from "node:crypto";
import { getDb } from "../db";
import { isDeviceScope, type DeviceScope } from "./devices";

export const DEFAULT_PAIRING_TTL_MS = 5 * 60_000;

export type PairingCode = {
  code: string;
  scope: DeviceScope;
  expiresAt: number;
};

function hashCode(code: string): string {
  return crypto.createHash("sha256").update(code, "utf8").digest("hex");
}

function generateCode(): string {
  // 128 bits en base36, en grupos de 4 para que un humano pueda dictarlo.
  const raw = crypto.randomBytes(16).toString("hex").toUpperCase();
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`;
}

/** Crea un codigo. Devuelve el valor EN CLARO una unica vez. */
export function createPairingCode(scope: DeviceScope, ttlMs = DEFAULT_PAIRING_TTL_MS): PairingCode {
  if (!isDeviceScope(scope)) throw new Error(`Scope de emparejamiento invalido: ${String(scope)}`);
  const code = generateCode();
  const expiresAt = Date.now() + ttlMs;
  getDb()
    .prepare("INSERT INTO pairing_codes (code_hash, scope, expires_at) VALUES (?, ?, ?)")
    .run(hashCode(code), scope, expiresAt);
  return { code, scope, expiresAt };
}

export type RedeemResult =
  | { ok: true; scope: DeviceScope }
  /** Codigo inexistente, vencido o ya usado. Mensaje generico a proposito. */
  | { ok: false; error: string };

const GENERIC_ERROR = "Codigo de emparejamiento invalido o vencido.";

/** Intenta canjear. Devuelve el scope, o un error generico. */
export function redeemPairingCode(code: string): RedeemResult {
  const trimmed = code.trim();
  if (!trimmed) return { ok: false, error: GENERIC_ERROR };

  const row = getDb().prepare("SELECT code_hash, scope, expires_at, used_at FROM pairing_codes WHERE code_hash = ?").get(hashCode(trimmed)) as
    | { scope: string; expires_at: number; used_at: number | null }
    | undefined;
  if (!row) return { ok: false, error: GENERIC_ERROR };
  if (row.used_at !== null) return { ok: false, error: GENERIC_ERROR };
  if (row.expires_at <= Date.now()) return { ok: false, error: GENERIC_ERROR };
  if (!isDeviceScope(row.scope)) return { ok: false, error: GENERIC_ERROR };

  // Marca como usado ANTES de devolver el exito: si dos canjes llegan
  // igual, el UPDATE condicional deja pasar uno solo.
  const claimed = getDb()
    .prepare("UPDATE pairing_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL")
    .run(Date.now(), hashCode(trimmed));
  if (claimed.changes === 0) return { ok: false, error: GENERIC_ERROR };

  return { ok: true, scope: row.scope };
}

/** Limpieza de codigos vencidos (la UI de la PC la llama al listar). */
export function pruneExpiredPairingCodes(): number {
  const result = getDb().prepare("DELETE FROM pairing_codes WHERE expires_at <= ? OR used_at IS NOT NULL").run(Date.now());
  return result.changes;
}

/** Solo para tests. */
export function countPairingCodes(): { pending: number; used: number } {
  const rows = getDb().prepare("SELECT used_at FROM pairing_codes").all() as Array<{ used_at: number | null }>;
  return { pending: rows.filter((r) => r.used_at === null).length, used: rows.filter((r) => r.used_at !== null).length };
}
