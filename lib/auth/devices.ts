/**
 * Fase 4a - store de dispositivos emparejados.
 *
 * Reglas que este modulo hace cumplir:
 * - El token NUNCA se guarda. Se guarda `token_hash` = SHA-256 hex del
 *   token. Un token es aleatorio de 256 bits generado aca, asi que no hay
 *   dictionario que probar contra esa entropia y un salt solo complicaria
 *   la busqueda por hash, que es justo lo que hay que hacer en cada
 *   request autenticada.
 * - El token en claro se devuelve UNA sola vez, al crear el dispositivo.
 *   Despues no se puede recuperar: no hay nada de donde recuperarlo.
 * - La cookie que viaja lleva ese mismo token en claro (es un secreto del
 *   cliente), pero lo que se compara en cada request es el hash. La cookie
 *   es revocable: revocar el dispositivo la deja inservible aunque el
 *   cliente siga teniendo el valor.
 * - Scopes: observe / operate / approve. Se validan contra una lista
 *   cerrada para que un typo no cree un scope inexistente.
 */

import crypto from "node:crypto";
import { getDb } from "../db";

export const DEVICE_COOKIE = "magi_device_token";

export const DEVICE_SCOPES = ["observe", "operate", "approve"] as const;
export type DeviceScope = (typeof DEVICE_SCOPES)[number];

export function isDeviceScope(value: unknown): value is DeviceScope {
  return typeof value === "string" && (DEVICE_SCOPES as readonly string[]).includes(value);
}

/** Hash estable del token. Recorta el header de la cookie antes de hashear. */
export function hashDeviceToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

/** Token nuevo: 256 bits de entropia, en hex. */
export function generateDeviceToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export type Device = {
  id: string;
  name: string;
  scope: DeviceScope;
  userAgent: string | null;
  createdAt: number;
  lastSeenAt: number | null;
  revokedAt: number | null;
};

type DeviceRow = {
  id: string;
  name: string;
  token_hash: string;
  scope: string;
  user_agent: string | null;
  created_at: number;
  last_seen_at: number | null;
  revoked_at: number | null;
};

function rowToDevice(row: DeviceRow): Device {
  return {
    id: row.id,
    name: row.name,
    // Un scope corrupto en la DB no deberia tildar la app: cae al mas
    // restrictivo y queda a la vista para corregirlo.
    scope: isDeviceScope(row.scope) ? row.scope : "observe",
    userAgent: row.user_agent,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
  };
}

/** Crea un dispositivo y devuelve el token EN CLARO una unica vez. */
export function createDevice(input: { name: string; scope: DeviceScope; userAgent?: string | null }): { device: Device; token: string } {
  const id = crypto.randomUUID();
  const token = generateDeviceToken();
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO devices (id, name, token_hash, scope, user_agent, created_at)
       VALUES (@id, @name, @tokenHash, @scope, @userAgent, @createdAt)`,
    )
    .run({
      id,
      name: input.name,
      tokenHash: hashDeviceToken(token),
      scope: input.scope,
      userAgent: input.userAgent ?? null,
      createdAt: now,
    });
  return { device: { id, name: input.name, scope: input.scope, userAgent: input.userAgent ?? null, createdAt: now, lastSeenAt: null, revokedAt: null }, token };
}

/** Busca por token. Devuelve null si no existe O si esta revocado. */
export function findDeviceByToken(token: string): Device | null {
  const row = getDb().prepare("SELECT * FROM devices WHERE token_hash = ?").get(hashDeviceToken(token)) as DeviceRow | undefined;
  if (!row) return null;
  const device = rowToDevice(row);
  return device.revokedAt === null ? device : null;
}

export function getDevice(id: string): Device | null {
  const row = getDb().prepare("SELECT * FROM devices WHERE id = ?").get(id) as DeviceRow | undefined;
  return row ? rowToDevice(row) : null;
}

export function listDevices(): Device[] {
  const rows = getDb().prepare("SELECT * FROM devices ORDER BY created_at DESC").all() as DeviceRow[];
  return rows.map(rowToDevice);
}

/** Actualiza `last_seen_at`. Silencioso: no puede tumbar una request. */
export function touchDevice(id: string): void {
  try {
    getDb().prepare("UPDATE devices SET last_seen_at = ? WHERE id = ? AND revoked_at IS NULL").run(Date.now(), id);
  } catch {
    /* un fallo aca no debe romper la request */
  }
}

export function setDeviceScope(id: string, scope: DeviceScope): Device | null {
  if (!isDeviceScope(scope)) return null;
  getDb().prepare("UPDATE devices SET scope = ? WHERE id = ?").run(scope, id);
  return getDevice(id);
}

export function renameDevice(id: string, name: string): Device | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  getDb().prepare("UPDATE devices SET name = ? WHERE id = ?").run(trimmed, id);
  return getDevice(id);
}

export function revokeDevice(id: string): boolean {
  const result = getDb().prepare("UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(Date.now(), id);
  return result.changes > 0;
}

/** Revoca todos menos los ids excluidos (kill switch desde la UI). */
export function revokeAllDevices(exceptIds: readonly string[] = []): number {
  const db = getDb();
  const now = Date.now();
  const keep = new Set(exceptIds);
  let revoked = 0;
  const transaction = db.transaction(() => {
    for (const device of listDevices()) {
      if (device.revokedAt !== null || keep.has(device.id)) continue;
      const result = db.prepare("UPDATE devices SET revoked_at = ? WHERE id = ?").run(now, device.id);
      revoked += result.changes;
    }
  });
  transaction();
  return revoked;
}

/** Solo para tests: cuantos dispositivos activos/reservados hay. */
export function countDevices(): { total: number; active: number } {
  const row = getDb().prepare("SELECT COUNT(*) as total, SUM(CASE WHEN revoked_at IS NULL THEN 1 ELSE 0 END) as active FROM devices").get() as {
    total: number;
    active: number | null;
  };
  return { total: row.total, active: row.active ?? 0 };
}
