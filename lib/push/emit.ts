/**
 * Fase 6 — emisión de notificaciones: coalescencia, tasa y saneamiento.
 *
 * La lógica de decisión es PURA (`planNotifications`): recibe eventos y
 * suscripciones y devuelve qué notificación mandar a quién. La que no es pura
 * (`dispatch`, que habla con el servicio de push) toma un emisor inyectable,
 * así los tests corren sin red y sin servicios reales.
 *
 * Tres problemas reales que resuelve:
 *
 * 1. **Coalescencia**: una task que emite 40 eventos no puede generar 40
 *    notificaciones. Se agrupan por `tag` (una task = un tag) y se manda UNA
 *    por tag y por suscripción, con el resumen de lo que pasó. El SO también
 *    colapsa por tag (`renotify: false` en el service worker), pero del lado
 *    del servidor hay que evitar el envío físico.
 *
 * 2. **Límite de tasa**: como máximo `MAX_PER_MINUTE` notificaciones por
 *    suscripción por minuto. Un bucle de eventos no puede convertir el
 *    teléfono en un martillo neumático.
 *
 * 3. **Saneamiento**: el payload sale por una allowlist de campos. Nada de
 *    prompts, diffs, tokens ni rutas del filesystem: solo lo que hace falta
 *    para decidir si abrir la app.
 */

import type { PushEvent, PushOwner, Subscription } from "./subscriptions";

export type NotificationEvent = {
  kind: PushEvent;
  /** Identificador estable para agrupar (ej. el id de la task). */
  tag: string;
  title: string;
  body: string;
  /** Adónde lleva el click. Relativo a la app. */
  url: string;
  at: number;
};

export type PlannedNotification = {
  subscriptionId: string;
  payload: { title: string; body: string; tag: string; url: string; count: number };
};

/** Notificaciones por suscripción por minuto. */
export const MAX_PER_MINUTE = 6;

/** Campos permitidos en el payload que viaja cifrado. */
const PAYLOAD_FIELDS = ["title", "body", "tag", "url"] as const;

/** Ventana de coalescencia: eventos más cerca que esto se agrupan. */
export const COALESCE_WINDOW_MS = 2000;

/**
 * Arma el plan: qué notificación le toca a cada suscripción.
 *
 * - Solo se notifica si la suscripción está activa y tiene el evento en sus
 *   preferencias.
 * - Los eventos se agrupan por `tag`: el cuerpo del último gana, y el título
 *   indica cuántos se agruparon.
 * - Se respeta el tope por minuto, contando lo ya enviado (`sentInLastMinute`).
 *
 * La ventana de coalescencia arranca en `now` y se extiende hacia atrás
 * `COALESCE_WINDOW_MS` por evento: agrupar por "hace menos de X" es lo que
 * sobrevive a una cola con retardo, y un evento viejo no se lleva puestos a
 * los nuevos.
 */
export function planNotifications(
  events: NotificationEvent[],
  subscriptions: Subscription[],
  sentInLastMinute: number,
  now: number,
): PlannedNotification[] {
  const plan: PlannedNotification[] = [];
  const bySubscription = new Map<string, { count: number; latest: NotificationEvent; subscriptionId: string }>();

  // Los eventos vienen en orden de llegada; se respeta.
  const sorted = [...events].sort((a, b) => a.at - b.at);
  // La ventana arranca en `now`: un evento muy viejo (cola atascada) no puede
  // arrastrar a los nuevos dentro del mismo grupo.
  const globalWindowStart = now - COALESCE_WINDOW_MS;
  // Clave de agrupación: suscripción + tag. Una task es un tag, así que dos
  // tasks distintas generan dos notificaciones distintas (el usuario quiere
  // saber de cuál habla cada una), y 40 eventos de la misma task, una sola.
  const keyOf = (subscriptionId: string, tag: string): string => subscriptionId + "|" + tag;

  for (const event of sorted) {
    const windowStart = Math.max(globalWindowStart, event.at - COALESCE_WINDOW_MS);
    for (const subscription of subscriptions) {
      if (!subscription.enabled) continue;
      if (!subscription.events.includes(event.kind)) continue;
      if (event.at < windowStart) continue;
      const key = keyOf(subscription.id, event.tag);
      const previous = bySubscription.get(key);
      if (previous) {
        previous.count += 1;
        previous.latest = event;
      } else {
        bySubscription.set(key, { count: 1, latest: event, subscriptionId: subscription.id });
      }
    }
  }

  let budget = Math.max(0, MAX_PER_MINUTE - sentInLastMinute);
  for (const [key, grouped] of bySubscription) {
    if (budget <= 0) break;
    void key;
    const payload = sanitizePayload({
      title: grouped.latest.title,
      body: grouped.count > 1 ? grouped.latest.body + " (+" + (grouped.count - 1) + " más)" : grouped.latest.body,
      tag: grouped.latest.tag,
      url: grouped.latest.url,
      count: grouped.count,
    });
    plan.push({ subscriptionId: grouped.subscriptionId, payload });
    budget -= 1;
  }
  return plan;
}

/** Deja pasar solo los campos de la allowlist. */
export function sanitizePayload(input: Record<string, unknown>): PlannedNotification["payload"] {
  const out: Record<string, unknown> = {};
  for (const field of PAYLOAD_FIELDS) {
    const value = input[field];
    if (typeof value === "string") out[field] = value.slice(0, 300);
  }
  const count = typeof input.count === "number" && Number.isFinite(input.count) ? Math.max(1, Math.floor(input.count)) : 1;
  return {
    title: typeof out.title === "string" ? out.title : "Consenso IA",
    body: typeof out.body === "string" ? out.body : "",
    tag: typeof out.tag === "string" ? out.tag : "magi",
    url: typeof out.url === "string" ? out.url : "/m",
    count,
  };
}

export type DispatchOutcome = {
  sent: number;
  failed: number;
  skipped: number;
  /** Suscripciones que el servicio dio por muertas. */
  dead: string[];
};

export type PushSender = (
  subscription: Subscription,
  payload: PlannedNotification["payload"],
) => Promise<{ ok: boolean; status: number; error?: string }>;

/**
 * Ejecuta el plan. `recordSuccess`/`recordFailure` llegan inyectados para que
 * los tests no toquen la DB.
 */
export async function dispatch(
  plan: PlannedNotification[],
  subscriptions: Subscription[],
  send: PushSender,
  hooks: {
    recordSuccess?: (id: string) => void;
    recordFailure?: (id: string, error: string, disable: boolean) => void;
  } = {},
): Promise<DispatchOutcome> {
  const byId = new Map(subscriptions.map((subscription) => [subscription.id, subscription]));
  const outcome: DispatchOutcome = { sent: 0, failed: 0, skipped: 0, dead: [] };

  for (const item of plan) {
    const subscription = byId.get(item.subscriptionId);
    if (!subscription) {
      outcome.skipped += 1;
      continue;
    }
    const result = await send(subscription, item.payload);
    if (result.ok) {
      outcome.sent += 1;
      hooks.recordSuccess?.(subscription.id);
      continue;
    }
    outcome.failed += 1;
    const dead = result.status === 404 || result.status === 410;
    hooks.recordFailure?.(subscription.id, result.error ?? "error desconocido", dead);
    if (dead) outcome.dead.push(subscription.id);
  }
  return outcome;
}

/** El dueño de una suscripción según el contexto de autorización. */
export function ownerFrom(isOperator: boolean, deviceId: string | null): PushOwner {
  if (isOperator) return { kind: "operator", id: null };
  return { kind: "device", id: deviceId };
}
