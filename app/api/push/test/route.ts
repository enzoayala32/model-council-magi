import { NextResponse } from "next/server";
import { guardRequest } from "@/lib/auth/guard";
import { requireScope } from "@/lib/auth/authorize";
import { recordAudit } from "@/lib/auth/audit";
import { loadOrCreateVapidKeys } from "@/lib/push/vapid";
import { listSubscriptions } from "@/lib/push/subscriptions";
import { dispatch, planNotifications, type NotificationEvent } from "@/lib/push/emit";
import { sendWebPush } from "@/lib/push/web-push";
import { recordSuccess, recordFailure } from "@/lib/push/subscriptions";

/**
 * Fase 6 — notificación de prueba.
 *
 * Existe para que el operador pueda comprobar, desde el teléfono, que toda la
 * cadena funciona (permiso concedido, suscripción vigente, claves VAPID ok,
 * servicio de push alcanzable) sin tener que esperar a que termine una tarea.
 *
 * Requiere scope `operate`: enviar push opera sobre el sistema de
 * notificaciones, no es solo observar.
 *
 * El envío real no lanza nunca: si el servicio de push falla, se responde con
 * el detalle para que se vea en la UI.
 */
export async function POST(request: Request) {
  const denied = guardRequest(request);
  if (denied) return denied;

  const authorized = requireScope({ method: "POST", pathname: "/api/push/test", request });
  if (!authorized.ok) return NextResponse.json({ ok: false, error: authorized.error }, { status: authorized.status });
  const { context } = authorized;

  const keys = loadOrCreateVapidKeys();
  if (!keys) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Las notificaciones no están configuradas. Definí MAGI_TOTP_KEY (o APP_ACCESS_TOKEN) en .env " +
          "para poder guardar la clave del servidor de push.",
      },
      { status: 503 },
    );
  }

  const owner = context.operator
    ? { kind: "operator" as const, id: null }
    : { kind: "device" as const, id: context.device?.id ?? null };
  const subscriptions = listSubscriptions(owner).filter((subscription) => subscription.enabled);
  if (subscriptions.length === 0) {
    return NextResponse.json({ ok: false, error: "No tenés ninguna suscripción activa." }, { status: 404 });
  }

  const now = Date.now();
  const event: NotificationEvent = {
    kind: "council.finished",
    tag: "push-test-" + now,
    title: "Consenso IA",
    body: "Notificación de prueba: si la estás viendo, todo funciona.",
    url: "/m/settings",
    at: now,
  };
  const plan = planNotifications([event], subscriptions, 0, now);
  const outcome = await dispatch(plan, subscriptions, (subscription, payload) =>
    sendWebPush(
      { endpoint: subscription.endpoint, p256dh: subscription.p256dh, auth: subscription.auth },
      payload,
      keys,
    ),
  {
    recordSuccess,
    recordFailure,
  });

  recordAudit({
    deviceId: context.device?.id ?? null,
    action: outcome.sent > 0 ? "push_sent" : "push_failed",
    result: outcome.sent > 0 ? "ok" : "error",
    detail: `${outcome.sent} ok, ${outcome.failed} fallidas`,
  });

  if (outcome.sent === 0) {
    const firstError = subscriptions.find((subscription) => subscription.lastError)?.lastError;
    return NextResponse.json(
      { ok: false, error: "El servicio de push rechazó el envío.", detail: firstError ?? "sin detalle" },
      { status: 502 },
    );
  }
  return NextResponse.json({ ok: true, sent: outcome.sent, failed: outcome.failed, dead: outcome.dead.length });
}
