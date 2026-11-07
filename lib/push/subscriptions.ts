/**
 * Fase 6 — suscripciones Web Push y sus preferencias.
 *
 * Una suscripción es lo que el navegador entrega al llamar
 * `registration.pushManager.subscribe()`: un endpoint del servicio de push y
 * dos claves. Se guarda por endpoint (UNIQUE): si el mismo navegador se vuelve
 * a suscribir, se actualiza la fila en vez de duplicarla.
 *
 * Preferencias: qué eventos generan notificación. La lista es CERRADA — un
 * evento nuevo no notifica hasta que se agregue acá a propósito, igual que los
 * scopes de `lib/auth/scopes.ts`.
 */

import crypto from "node:crypto";
import { getDb } from "../db";

export const PUSH_EVENTS = ["task.finished", "task.failed", "approval.required", "council.finished"] as const;
export type PushEvent = (typeof PUSH_EVENTS)[number];

export function isPushEvent(value: unknown): value is PushEvent {
  return typeof value === "string" && (PUSH_EVENTS as readonly string[]).includes(value);
}

/** Normaliza lo que manda el cliente: solo eventos conocidos, sin duplicados. */
export function normalizeEventPrefs(value: unknown): PushEvent[] {
  if (!Array.isArray(value)) return [...PUSH_EVENTS];
  const out: PushEvent[] = [];
  for (const entry of value) {
    if (isPushEvent(entry) && !out.includes(entry)) out.push(entry);
  }
  return out.length > 0 ? out : [...PUSH_EVENTS];
}

export type PushOwner = { kind: "device" | "operator"; id: string | null };

export type SubscriptionInput = {
  endpoint: string;
  p256dh: string;
  auth: string;
  owner: PushOwner;
  events?: unknown;
  userAgent?: string | null;
  enabled?: boolean;
};

export type Subscription = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  ownerKind: string;
  ownerId: string | null;
  userAgent: string | null;
  events: PushEvent[];
  enabled: boolean;
  createdAt: number;
  lastSuccessAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
};

type Row = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth_secret: string;
  owner_kind: string;
  owner_id: string | null;
  user_agent: string | null;
  events: string;
  enabled: number;
  created_at: number;
  last_success_at: number | null;
  last_error_at: number | null;
  last_error: string | null;
};

function rowToSubscription(row: Row): Subscription {
  return {
    id: row.id,
    endpoint: row.endpoint,
    p256dh: row.p256dh,
    auth: row.auth_secret,
    ownerKind: row.owner_kind,
    ownerId: row.owner_id,
    userAgent: row.user_agent,
    events: normalizeEventPrefs(JSON.parse(row.events || "[]")),
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    lastSuccessAt: row.last_success_at,
    lastErrorAt: row.last_error_at,
    lastError: row.last_error,
  };
}

/** Crea o actualiza por endpoint. Devuelve la suscripción vigente. */
export function upsertSubscription(input: SubscriptionInput): Subscription {
  const events = normalizeEventPrefs(input.events);
  const existing = getDb().prepare("SELECT id FROM push_subscriptions WHERE endpoint = ?").get(input.endpoint) as
    | { id: string }
    | undefined;
  const id = existing?.id ?? crypto.randomUUID();

  if (existing) {
    getDb()
      .prepare(
        `UPDATE push_subscriptions SET p256dh = ?, auth_secret = ?, owner_kind = ?, owner_id = ?,
           user_agent = ?, events = ?, enabled = ?
         WHERE id = ?`,
      )
      .run(
        input.p256dh,
        input.auth,
        input.owner.kind,
        input.owner.id,
        input.userAgent ?? null,
        JSON.stringify(events),
        input.enabled === false ? 0 : 1,
        id,
      );
  } else {
    getDb()
      .prepare(
        `INSERT INTO push_subscriptions (id, endpoint, p256dh, auth_secret, owner_kind, owner_id, user_agent,
           events, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.endpoint,
        input.p256dh,
        input.auth,
        input.owner.kind,
        input.owner.id,
        input.userAgent ?? null,
        JSON.stringify(events),
        input.enabled === false ? 0 : 1,
        Date.now(),
      );
  }
  const row = getDb().prepare("SELECT * FROM push_subscriptions WHERE id = ?").get(id) as Row;
  return rowToSubscription(row);
}

export function listSubscriptions(owner?: PushOwner): Subscription[] {
  const rows = owner
    ? (getDb()
        .prepare("SELECT * FROM push_subscriptions WHERE owner_kind = ? AND owner_id = ? ORDER BY created_at DESC")
        .all(owner.kind, owner.id) as Row[])
    : (getDb().prepare("SELECT * FROM push_subscriptions ORDER BY created_at DESC").all() as Row[]);
  return rows.map(rowToSubscription);
}

/** Suscripciones activas suscriptas a un evento concreto. */
export function subscriptionsFor(event: PushEvent): Subscription[] {
  return listSubscriptions().filter((sub) => sub.enabled && sub.events.includes(event));
}

export function findByEndpoint(endpoint: string): Subscription | null {
  const row = getDb().prepare("SELECT * FROM push_subscriptions WHERE endpoint = ?").get(endpoint) as Row | undefined;
  return row ? rowToSubscription(row) : null;
}

export function deleteByEndpoint(endpoint: string): boolean {
  const result = getDb().prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
  return result.changes > 0;
}

export function setEnabled(id: string, enabled: boolean): boolean {
  const result = getDb().prepare("UPDATE push_subscriptions SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
  return result.changes > 0;
}

export function setEvents(id: string, events: unknown): PushEvent[] | null {
  const normalized = normalizeEventPrefs(events);
  const result = getDb()
    .prepare("UPDATE push_subscriptions SET events = ? WHERE id = ?")
    .run(JSON.stringify(normalized), id);
  if (result.changes === 0) return null;
  return normalized;
}

export function recordSuccess(id: string): void {
  getDb().prepare("UPDATE push_subscriptions SET last_success_at = ?, last_error = NULL WHERE id = ?").run(Date.now(), id);
}

/**
 * Un fallo repetido (404/410 = suscripción muerta) es señal de que el
 * navegador ya no acepta notificaciones: se anota y se desactiva para no
 * insistir con algo que nunca va a llegar.
 */
export function recordFailure(id: string, error: string, disable: boolean): void {
  getDb()
    .prepare("UPDATE push_subscriptions SET last_error_at = ?, last_error = ?, enabled = ? WHERE id = ?")
    .run(Date.now(), error.slice(0, 300), disable ? 0 : 1, id);
}

/** Suscripciones que el navegador dio de baja: el servicio responde 404/410. */
export function isDeadStatus(status: number): boolean {
  return status === 404 || status === 410;
}
