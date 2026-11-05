import { NextResponse } from "next/server";
import { readJsonBody } from "@/lib/api-json";
import { APP_ACCESS_TOKEN_COOKIE, buildTokenCookie, constantTimeEqual } from "@/lib/api-security";
import { checkRateLimit, clientIdentifier, recordFailure, recordSuccess } from "@/lib/auth/rate-limit";
import { recordAudit } from "@/lib/auth/audit";

/**
 * Fase 1.2 - login del token de acceso.
 *
 * Fase 4a: sigue existiendo, pero ahora con rate limiting y bloqueo
 * progresivo, y queda MARCADO como flujo en retirada: el emparejamiento por
 * dispositivos (POST /api/pairing/redeem) es el reemplazo, y este endpoint
 * se retira cuando la UI migre. Mientras tanto hay que dejarlo funcional:
 * si se define APP_ACCESS_TOKEN y no hay forma de canjearlo, la app no
 * sirve para nadie.
 *
 * Este endpoint NO guarda el token en ningun lado: setea una cookie con el
 * valor que el usuario pego. La unica diferencia con el emparejamiento es
 * que la cookie de aca NO es revocable individualmente (comparte el
 * secreto del server), y por eso es el flujo con menos privilegios: solo
 * habilita el acceso, no otorga scope.
 */
const RESOURCE = "auth_token";

export async function POST(request: Request) {
  const identifier = clientIdentifier(request);
  const gate = checkRateLimit(identifier, RESOURCE);
  if (!gate.allowed) {
    return NextResponse.json(
      { ok: false, error: "Demasiados intentos. Esperá antes de volver a probar." },
      { status: 429, headers: { "Retry-After": String(Math.ceil(gate.retryAfterMs / 1000)) } },
    );
  }

  const parsed = await readJsonBody<{ token?: string }>(request);
  if (!parsed.ok) return parsed.response;

  const submitted = parsed.body.token?.trim() ?? "";
  const expected = process.env.APP_ACCESS_TOKEN?.trim() ?? "";

  // Sin token configurado no hay nada que canjear. Se responde OK sin
  // setear cookie para no delatar la configuracion a quien pregunte.
  if (!expected) {
    return NextResponse.json({ ok: true, tokenRequired: false });
  }

  if (!constantTimeEqual(submitted, expected)) {
    recordFailure(identifier, RESOURCE);
    recordAudit({ action: "auth_token_failed", result: "denied" });
    return NextResponse.json({ ok: false, error: "Token de acceso inválido." }, { status: 403 });
  }

  recordSuccess(identifier, RESOURCE);
  recordAudit({ action: "auth_token_ok", result: "ok" });
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const response = NextResponse.json({ ok: true, tokenRequired: true });
  response.headers.set("Set-Cookie", buildTokenCookie(expected, { secure: forwardedProto === "https" }));
  return response;
}

/** Borra la cookie (logout local). */
export async function DELETE() {
  const response = NextResponse.json({ ok: true });
  response.headers.set("Set-Cookie", `${APP_ACCESS_TOKEN_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`);
  return response;
}
