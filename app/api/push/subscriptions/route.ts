import { NextResponse } from "next/server";
import { readJsonBody } from "@/lib/api-json";
import { guardRequest } from "@/lib/auth/guard";
import { requireScope } from "@/lib/auth/authorize";
import { recordAudit } from "@/lib/auth/audit";
import { isPushEvent, listSubscriptions, setEnabled, setEvents } from "@/lib/push/subscriptions";
import { ownerFrom } from "@/lib/push/emit";

/**
 * Fase 6 — listar las suscripciones propias.
 *
 * "Propias" = las del dueño de esta request: operador o dispositivo. No se
 * devuelven nunca `p256dh` ni `auth`: quien ve esta lista no necesita ver las
 * claves ajenas, y alcanzaría con ellas para secuestrar notificaciones.
 */
export async function GET(request: Request) {
  const denied = guardRequest(request);
  if (denied) return denied;

  const authorized = requireScope({ method: "GET", pathname: "/api/push/subscriptions", request });
  if (!authorized.ok) return NextResponse.json({ ok: false, error: authorized.error }, { status: authorized.status });
  const { context } = authorized;

  const owner = ownerFrom(context.operator, context.device?.id ?? null);
  const subscriptions = listSubscriptions(owner);
  return NextResponse.json({
    ok: true,
    subscriptions: subscriptions.map((subscription) => ({
      id: subscription.id,
      endpoint: subscription.endpoint.slice(0, 80),
      userAgent: subscription.userAgent,
      events: subscription.events,
      enabled: subscription.enabled,
      createdAt: subscription.createdAt,
      lastSuccessAt: subscription.lastSuccessAt,
      lastErrorAt: subscription.lastErrorAt,
      lastError: subscription.lastError,
    })),
  });
}

/**
 * Cambiar preferencias o pausar/reanudar una suscripcion PROPIA.
 *
 * Body: `{ id, events?: [...], enabled?: boolean }`.
 *
 * Se verifica que la suscripcion sea del dueno de la request: sin eso, un
 * dispositivo podria pausar las notificaciones de otro.
 */
export async function PATCH(request: Request) {
  const denied = guardRequest(request);
  if (denied) return denied;

  const authorized = requireScope({ method: "PATCH", pathname: "/api/push/subscriptions", request });
  if (!authorized.ok) return NextResponse.json({ ok: false, error: authorized.error }, { status: authorized.status });
  const { context } = authorized;

  const parsed = await readJsonBody<{ id?: unknown; events?: unknown; enabled?: unknown }>(request);
  if (!parsed.ok) return parsed.response;

  const id = typeof parsed.body.id === "string" ? parsed.body.id.trim() : "";
  if (!id) return NextResponse.json({ ok: false, error: "Falta el id de la suscripcion." }, { status: 400 });

  const owner = ownerFrom(context.operator, context.device?.id ?? null);
  const mine = listSubscriptions(owner).some((subscription) => subscription.id === id);
  if (!mine) {
    return NextResponse.json({ ok: false, error: "Esa suscripcion no es tuya." }, { status: 403 });
  }

  if (parsed.body.events !== undefined) {
    const events = parsed.body.events;
    if (!Array.isArray(events) || events.some((entry) => !isPushEvent(entry))) {
      return NextResponse.json({ ok: false, error: "Eventos no reconocidos." }, { status: 400 });
    }
    setEvents(id, events);
  }
  if (parsed.body.enabled !== undefined) {
    setEnabled(id, parsed.body.enabled === true);
  }

  recordAudit({
    deviceId: context.device?.id ?? null,
    action: "push_subscription_updated",
    result: "ok",
    targetId: id,
  });
  return NextResponse.json({ ok: true });
}

export { requireScope };
