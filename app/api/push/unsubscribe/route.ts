import { NextResponse } from "next/server";
import { readJsonBody } from "@/lib/api-json";
import { guardRequest } from "@/lib/auth/guard";
import { requireScope } from "@/lib/auth/authorize";
import { recordAudit } from "@/lib/auth/audit";
import { listSubscriptions, deleteByEndpoint } from "@/lib/push/subscriptions";
import { ownerFrom } from "@/lib/push/emit";

/**
 * Fase 6 — darse de baja de las notificaciones.
 *
 * El navegador manda `subscription.unsubscribe()` y después este endpoint con
 * el endpoint de la suscripción (lo que devuelve `toJSON()`).
 *
 * Se comprueba que sea propia: si no, cualquiera podría borrarle las
 * notificaciones a otro. Borrar la cookie local no alcanza —la suscripción
 * vive en el servicio de push—, así que tiene que pasar por acá.
 */
export async function POST(request: Request) {
  const denied = guardRequest(request);
  if (denied) return denied;

  const authorized = requireScope({ method: "POST", pathname: "/api/push/unsubscribe", request });
  if (!authorized.ok) return NextResponse.json({ ok: false, error: authorized.error }, { status: authorized.status });
  const { context } = authorized;

  const parsed = await readJsonBody<{ endpoint?: unknown }>(request);
  if (!parsed.ok) return parsed.response;

  const endpoint = typeof parsed.body.endpoint === "string" ? parsed.body.endpoint.trim() : "";
  if (!endpoint) return NextResponse.json({ ok: false, error: "Falta el endpoint." }, { status: 400 });

  const owner = ownerFrom(context.operator, context.device?.id ?? null);
  const mine = listSubscriptions(owner).some((subscription) => subscription.endpoint === endpoint);
  if (!mine) {
    // Se responde igualmente ok: desde afuera no se puede saber si la
    // suscripción existía o no, y responder distinto filtra información.
    return NextResponse.json({ ok: true });
  }

  deleteByEndpoint(endpoint);
  recordAudit({
    deviceId: context.device?.id ?? null,
    action: "push_subscription_updated",
    result: "ok",
    detail: "baja",
  });
  return NextResponse.json({ ok: true });
}
