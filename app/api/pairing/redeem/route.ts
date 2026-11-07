import { NextResponse } from "next/server";
import { readJsonBody } from "@/lib/api-json";
import { redeemPairingCode } from "@/lib/auth/pairing";
import { createDevice, DEVICE_COOKIE } from "@/lib/auth/devices";
import { recordAudit } from "@/lib/auth/audit";
import { checkRateLimit, clientIdentifier, recordFailure, recordSuccess } from "@/lib/auth/rate-limit";
import { buildDeviceCookie } from "@/lib/auth/cookie";
import { guardRequest } from "@/lib/auth/guard";

/**
 * Fase 4a - canje de un codigo de emparejamiento por un dispositivo.
 *
 * Rate limiting ESTRETO con bloqueo progresivo: 5 intentos por minuto por IP
 * y bloqueo que se duplica con cada fallo. Los mensajes de error son
 * genericos a proposito (no filtra si el codigo existia, expiro o ya se
 * uso). El resultado es una cookie de dispositivo, no el token de la app.
 */
const RESOURCE = "pairing_redeem";

export async function POST(request: Request) {
  const denied = guardRequest(request);
  if (denied) return denied;

  const identifier = clientIdentifier(request);
  const gate = checkRateLimit(identifier, RESOURCE);
  if (!gate.allowed) {
    return NextResponse.json(
      { ok: false, error: "Demasiados intentos. Esperá antes de volver a probar." },
      { status: 429, headers: { "Retry-After": String(Math.ceil(gate.retryAfterMs / 1000)) } },
    );
  }

  const parsed = await readJsonBody<{ code?: string; deviceName?: string }>(request);
  if (!parsed.ok) return parsed.response;

  const code = parsed.body.code?.trim() ?? "";
  const deviceName = parsed.body.deviceName?.trim() || "Dispositivo sin nombre";
  const redeemed = redeemPairingCode(code);
  if (!redeemed.ok) {
    recordFailure(identifier, RESOURCE);
    recordAudit({ action: "pairing_redeem_failed", result: "denied" });
    return NextResponse.json({ ok: false, error: redeemed.error }, { status: 403 });
  }

  recordSuccess(identifier, RESOURCE);
  const { device, token } = createDevice({
    name: deviceName,
    scope: redeemed.scope,
    userAgent: request.headers.get("user-agent")?.slice(0, 120) ?? null,
  });
  recordAudit({ deviceId: device.id, action: "pairing_redeemed", targetId: device.id, result: "ok" });

  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const secure = forwardedProto === "https";
  const response = NextResponse.json({ ok: true, scope: device.scope, deviceId: device.id });
  response.headers.set("Set-Cookie", buildDeviceCookie(token, { secure }));
  return response;
}

export { DEVICE_COOKIE };
