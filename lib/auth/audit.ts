/**
 * Fase 4a - auditoria.
 *
 * Que se registra: acciones mutantes, aprobaciones, emparejamientos, y
 * fallos de autenticacion. Siempre con device_id (null para acciones sin
 * sesion: un intento fallido, por ejemplo) y resultado.
 *
 * Que NUNCA se registra (regla explicita de la fase): tokens, codigos de
 * emparejamiento, prompts, contenido de archivos, ni nada que permita
 * reconstruir un secreto. `target_id` es un id de task/corrida/device, no
 * contenido. El payload libre se recorta a `MAX_DETAIL_CHARS`.
 */

import crypto from "node:crypto";
import { getDb } from "../db";

const MAX_DETAIL_CHARS = 200;

/** Retencion por default del registro: 90 dias. */
export const AUDIT_RETENTION_DAYS = 90;

export type AuditAction =
  | "pairing_created"
  | "pairing_redeemed"
  | "pairing_redeem_failed"
  | "device_created"
  | "device_revoked"
  | "device_revoke_all"
  | "device_scope_changed"
  | "auth_token_ok"
  | "auth_token_failed"
  | "task_created"
  | "task_cancelled"
  | "task_applied"
  | "task_discarded"
  | "stepup_ok"
  | "stepup_failed"
  | "access_denied";

export type AuditResult = "ok" | "denied" | "error";

export type AuditEntry = {
  id: string;
  ts: number;
  deviceId: string | null;
  action: AuditAction;
  targetId: string | null;
  result: AuditResult;
  /** Detalle corto y sin secretos. */
  detail: string | null;
};

/** Registra. Nunca lanza: un fallo de auditoria no puede tumbar la accion. */
export function recordAudit(input: {
  deviceId?: string | null;
  action: AuditAction;
  targetId?: string | null;
  result: AuditResult;
  detail?: string | null;
}): AuditEntry | null {
  const entry: AuditEntry = {
    id: crypto.randomUUID(),
    ts: Date.now(),
    deviceId: input.deviceId ?? null,
    action: input.action,
    targetId: input.targetId ?? null,
    result: input.result,
    detail: input.detail ? input.detail.slice(0, MAX_DETAIL_CHARS) : null,
  };
  try {
    getDb()
      .prepare("INSERT INTO audit_log (id, ts, device_id, action, target_id, result, detail) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(entry.id, entry.ts, entry.deviceId, entry.action, entry.targetId, entry.result, entry.detail);
    return entry;
  } catch {
    return null;
  }
}

export type AuditQuery = { deviceId?: string | null; limit?: number };

export function listAuditLog(query: AuditQuery = {}): AuditEntry[] {
  const limit = Math.max(1, Math.min(query.limit ?? 100, 500));
  const rows = query.deviceId
    ? (getDb()
        .prepare("SELECT * FROM audit_log WHERE device_id = ? ORDER BY ts DESC LIMIT ?")
        .all(query.deviceId, limit) as AuditRow[])
    : (getDb().prepare("SELECT * FROM audit_log ORDER BY ts DESC LIMIT ?").all(limit) as AuditRow[]);
  return rows.map(rowToEntry);
}

/** Poda: devuelve cuantas filas se fueron. */
export function pruneAuditLog(retentionDays = AUDIT_RETENTION_DAYS): number {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60_000;
  const result = getDb().prepare("DELETE FROM audit_log WHERE ts < ?").run(cutoff);
  return result.changes;
}

type AuditRow = {
  id: string;
  ts: number;
  device_id: string | null;
  action: string;
  target_id: string | null;
  result: string;
  detail: string | null;
};

function rowToEntry(row: AuditRow): AuditEntry {
  return {
    id: row.id,
    ts: row.ts,
    deviceId: row.device_id,
    action: row.action as AuditAction,
    targetId: row.target_id,
    result: row.result as AuditResult,
    detail: row.detail,
  };
}

/** Solo para tests. */
export function countAuditLog(): number {
  const row = getDb().prepare("SELECT COUNT(*) as c FROM audit_log").get() as { c: number };
  return row.c;
}
