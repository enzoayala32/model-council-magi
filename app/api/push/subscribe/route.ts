import { NextResponse } from "next/server";
import { readJsonBody } from "@/lib/api-json";
import { guardRequest } from "@/lib/auth/guard";
import { requireScope } from "@/lib/auth/authorize";
import { recordAudit } from "@/lib/auth/audit";
import { upsertSubscription, type PushEvent } from "@/lib/push/subscriptions";
import { validatePushEndpoint, validateSubscriptionKeys } from "@/lib/push/endpoint";
import { ownerFrom } from "@/lib/push/emit";
import { isPushEvent } from "@/lib/push/subscriptions";

/**
 * Fase 6 — suscribirse a notificaciones push.
 *
 * Body: lo que devuelve el navegador en `PushSubscription.prototype.toJSON()`:
 * `{ endpoint, keys: { p256dh, auth }, events: [...] }`.
 *
 * Dueño de la suscripción: operador o dispositivo, según quién hace la request.
 * Se guarda por endpoint (UNIQUE), así que re-suscribirse actualiza en vez de
 * duplicar. Las preferencias (`events`) son una lista CERRADA de eventos.
 *
 * No se devuelve el `auth` ni el `p256dh` de vuelta: no hacen falta y son
 * material sensible (alguien con ellos podría recibir tus notificaciones).
 */
export async function POST(request: Request) {
  const denied = guardRequest(request);
  if (denied) return denied;

  const authorized = requireScope({ method: "POST", pathname: "/api/push/subscribe", request });
  if (!authorized.ok) return NextResponse.json({ ok: false, error: authorized.error }, { status: authorized.status });
  const { context } = authorized;

  const parsed = await readJsonBody<{
    endpoint?: unknown;
    keys?: { p256dh?: unknown; auth?: unknown };
    events?: unknown;
  }>(request);
  if (!parsed.ok) return parsed.response;

  const endpoint = typeof parsed.body.endpoint === "string" ? parsed.body.endpoint.trim() : "";
  const p256dh = typeof parsed.body.keys?.p256dh === "string" ? parsed.body.keys.p256dh.trim() : "";
  const auth = typeof parsed.body.keys?.auth === "string" ? parsed.body.keys.auth.trim() : "";
  if (!endpoint || !p256dh || !auth) {
    return NextResponse.json({ ok: false, error: "Suscripción incompleta: falta endpoint, p256dh o auth." }, { status: 400 });
  }
  // Claves: lo que manda un navegador. Si no tienen la forma esperada, el
  // primer envío fallaría con un error de OpenSSL crudo — que terminaría
  // persistido en `last_error` o tumbando el proceso.
  const keysCheck = validateSubscriptionKeys(p256dh, auth);
  if (!keysCheck.ok) {
    return NextResponse.json({ ok: false, error: keysCheck.error }, { status: 400 });
  }

  // Allowlist de servicios de push + rechazo de IPs literales, hosts que
  // resuelven a redes privadas, puertos raros y credenciales en la URL. Sin
  // esto, la suscripción era un SSRF: el server mandaría un POST (con el JWT
  // VAPID en el header Authorization) a donde dijera el endpoint.
  const endpointCheck = await validatePushEndpoint(endpoint);
  if (!endpointCheck.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: pushEndpointError(endpointCheck.reason),
      },
      { status: 400 },
    );
  }

  const rawEvents = parsed.body.events;
  if (rawEvents !== undefined && !Array.isArray(rawEvents)) {
    return NextResponse.json({ ok: false, error: "Las preferencias tienen que ser una lista." }, { status: 400 });
  }
  if (Array.isArray(rawEvents) && rawEvents.some((entry) => !isPushEvent(entry))) {
    return NextResponse.json(
      { ok: false, error: "Hay eventos no reconocidos en las preferencias." },
      { status: 400 },
    );
  }

  const owner = ownerFrom(context.operator, context.device?.id ?? null);
  const subscription = upsertSubscription({
    endpoint,
    p256dh,
    auth,
    owner,
    events: rawEvents,
    userAgent: request.headers.get("user-agent")?.slice(0, 120) ?? null,
  });
  recordAudit({
    deviceId: context.device?.id ?? null,
    action: "push_subscribed",
    result: "ok",
    targetId: subscription.id,
    detail: `${subscription.events.length} evento(s)`,
  });

  return NextResponse.json({
    ok: true,
    id: subscription.id,
    events: subscription.events as PushEvent[],
    enabled: subscription.enabled,
  });
}

export { requireScope };

/** Mensajes por motivo de rechazo. Sin filtrar datos del endpoint. */
function pushEndpointError(reason: string): string {
  switch (reason) {
    case "protocol":
      return "El endpoint del servicio de push tiene que ser HTTPS.";
    case "credentials":
      return "El endpoint no puede llevar usuario ni contraseña.";
    case "port":
      return "El endpoint tiene que usar el puerto 443.";
    case "literal-ip":
      return "El endpoint tiene que ser un hostname, no una IP.";
    case "host-not-allowed":
      return "Ese host no es un servicio de push reconocido.";
    case "private-address":
      return "Ese host resuelve a una dirección privada o de loopback.";
    case "dns":
      return "Ese host no se pudo resolver.";
    default:
      return "El endpoint no es válido.";
  }
}
