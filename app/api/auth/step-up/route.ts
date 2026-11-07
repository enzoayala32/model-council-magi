import { NextResponse } from "next/server";
import { readJsonBody } from "@/lib/api-json";
import { resolveAuthContext } from "@/lib/auth/authorize";
import { issueStepUp, hasDeviceTotp, STEP_UP_TTL_MS } from "@/lib/auth/step-up";
import { checkRateLimit, clientIdentifier, recordFailure, recordSuccess } from "@/lib/auth/rate-limit";
import { guardRequest } from "@/lib/auth/guard";

/**
 * Fase 4c - canje de un codigo TOTP por una sesion de step-up.
 *
 * Requiere un dispositivo autenticado (la cookie). El token devuelto va en
 * el header `x-magi-step-up` de las requests que aprueben cambios.
 *
 * Rate limiting: es un endpoint de credenciales, mismo trato que el login.
 */
const RESOURCE = "step_up";

export async function POST(request: Request) {
  const denied = guardRequest(request);
  if (denied) return denied;

  const identifier = clientIdentifier(request);
  const gate = checkRateLimit(identifier, RESOURCE);
  if (!gate.allowed) {
    return NextResponse.json(
      { ok: false, error: "Demasiados intentos. Espera antes de volver a probar." },
      { status: 429, headers: { "Retry-After": String(Math.ceil(gate.retryAfterMs / 1000)) } },
    );
  }

  const context = resolveAuthContext({ headers: request.headers });
  if (!context.device) {
    return NextResponse.json({ ok: false, error: "Se requiere un dispositivo emparejado." }, { status: 403 });
  }

  if (!hasDeviceTotp(context.device.id)) {
    return NextResponse.json(
      { ok: false, error: "Este dispositivo no tiene segundo factor. Anotalo desde la PC." },
      { status: 409 },
    );
  }

  const parsed = await readJsonBody<{ code?: string }>(request);
  if (!parsed.ok) return parsed.response;

  const token = issueStepUp(context.device.id, parsed.body.code?.trim() ?? "");
  if (!token) {
    recordFailure(identifier, RESOURCE);
    return NextResponse.json({ ok: false, error: "Codigo incorrecto." }, { status: 403 });
  }

  recordSuccess(identifier, RESOURCE);
  return NextResponse.json({ ok: true, stepUpToken: token, expiresInSeconds: Math.round(STEP_UP_TTL_MS / 1000) });
}
