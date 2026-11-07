/**
 * Fase 6 — qué eventos del agente generan notificación.
 *
 * Un solo punto de entrada (`notifyStatusChange`) al que llama
 * `lib/agent/task-store.ts` cuando una task cambia de estado. Acá se decide
 * si el cambio es "noticiable", y se delega la decisión de a quién notificar a
 * `planNotifications` (preferencias, coalescencia y tope).
 *
 * Es un módulo aparte y no se importa desde `task-store` de forma estática
 * liviana por dos motivos:
 *
 * 1. Si no hay NADIE suscrito, no se hace nada: ni se abren las claves VAPID
 *    ni se toca la red. Los tests (que no tienen suscripciones) no cambian de
 *    comportamiento.
 * 2. El envío real nunca lanza: un servicio de push caído no puede hacer
 *    fallar una transición de task que ya quedó persistida.
 */

import { recordAudit } from "../auth/audit";
import { loadOrCreateVapidKeys } from "./vapid";
import { subscriptionsFor, recordFailure, recordSuccess } from "./subscriptions";
import { dispatch, planNotifications, type NotificationEvent } from "./emit";
import { sendWebPush } from "./web-push";
import type { TaskStatus } from "../agent/task-store";
import type { PushEvent } from "./subscriptions";

/** Estados del agente que merecen una notificación, y su evento de push.
 *  Los que no están acá (QUEUED, RUNNING, APPLYING...) no notifican: serían
 *  ruido, y el heartbeat del SSE ya cubre el "sigue vivo". */
const STATUS_EVENT: Partial<Record<TaskStatus, PushEvent>> = {
  APPLIED: "task.finished",
  NO_CHANGES: "task.finished",
  FAILED: "task.failed",
  CANCELLED: "task.failed",
  INTERRUPTED: "task.failed",
  READY_FOR_REVIEW: "approval.required",
};

/** El mapping inverso: qué estados son "de consejo terminado". */
function titleFor(event: NotificationEvent["kind"]): string {
  switch (event) {
    case "approval.required":
      return "Consenso IA — esperando tu aprobación";
    case "task.finished":
      return "Consenso IA — tarea terminada";
    case "task.failed":
      return "Consenso IA — la tarea no pudo completarse";
    default:
      return "Consenso IA";
  }
}

function bodyFor(event: NotificationEvent["kind"], prompt: string): string {
  const short = prompt.length > 120 ? prompt.slice(0, 117) + "..." : prompt;
  switch (event) {
    case "approval.required":
      return "Hay cambios listos para revisar: " + short;
    case "task.finished":
      return "Terminó: " + short;
    case "task.failed":
      return "No se pudo completar: " + short;
    default:
      return short;
  }
}

export type NotifyOutcome = {
  notified: boolean;
  reason?: string;
  sent?: number;
  failed?: number;
};

/**
 * Notifica el cambio de estado si corresponde. Devuelve siempre: el llamador
 * ignora el resultado porque una notificación fallida no deshace un cambio de
 * estado ya guardado.
 *
 * No es `async` en la firma interna: se dispara y se olvida, con el resultado
 * registrado en la auditoría y en `push_subscriptions`.
 */
export function notifyStatusChange(input: {
  taskId: string;
  status: TaskStatus;
  prompt: string;
}): NotifyOutcome {
  const event = STATUS_EVENT[input.status];
  if (!event) return { notified: false, reason: "estado no noticiable" };

  // Sin suscripciones no se hace nada: ni claves VAPID ni red.
  const subscriptions = subscriptionsFor(event);
  if (subscriptions.length === 0) return { notified: false, reason: "nadie suscrito a " + event };

  const keys = loadOrCreateVapidKeys();
  if (!keys) {
    return { notified: false, reason: "push sin configurar (falta MAGI_TOTP_KEY o APP_ACCESS_TOKEN)" };
  }

  const at = Date.now();
  const notification: NotificationEvent = {
    kind: event,
    tag: input.taskId,
    title: titleFor(event),
    body: bodyFor(event, input.prompt),
    url: "/m/tasks/" + input.taskId,
    at,
  };
  const plan = planNotifications([notification], subscriptions, 0, at);

  void dispatch(plan, subscriptions, (subscription, payload) =>
    sendWebPush(
      { endpoint: subscription.endpoint, p256dh: subscription.p256dh, auth: subscription.auth },
      payload,
      keys,
    ),
  {
    recordSuccess: (id) => recordSuccess(id),
    // `disable` ya viene decidido por `dispatch` a partir del status HTTP
    // (404/410 = suscripción muerta): no se vuelve a adivinar acá.
    recordFailure,
  }).then((outcome) => {
    recordAudit({
      deviceId: null,
      action: outcome.sent > 0 ? "push_sent" : "push_failed",
      result: outcome.sent > 0 ? "ok" : "error",
      targetId: input.taskId,
      detail: `${event}: ${outcome.sent} ok, ${outcome.failed} fallidas`,
    });
  }).catch(() => {
    // Un rechazo del servicio de push no puede tumbar una transición de task.
  });

  return { notified: true, sent: plan.length };
}
