import { NextResponse } from "next/server";
import { readJsonBody } from "@/lib/api-json";
import { enrollDeviceTotp, totpEncryptionAvailable } from "@/lib/auth/step-up";
import { getDevice } from "@/lib/auth/devices";
import { recordAudit } from "@/lib/auth/audit";
import { isLoopbackHost } from "@/lib/auth/scopes";

/**
 * Fase 4c - inscripcion del segundo factor.
 *
 * SOLO desde loopback: anotar el secreto TOTP de un dispositivo es una
 * operacion de la PC. El telefono no puede inscribirse a si mismo (si
 * pudiera, un token robado bastaria para autodesignarse aprobador).
 *
 * Devuelve el secreto en claro UNA vez, para mostrarlo como QR. Despues no
 * se puede volver a ver.
 */
export async function POST(request: Request) {
  if (!isLoopbackHost(request.headers.get("host"))) {
    recordAudit({ action: "device_created", result: "denied", detail: "totp enroll desde host no loopback" });
    return NextResponse.json(
      { ok: false, error: "La inscripcion del segundo factor se hace solo desde esta PC." },
      { status: 403 },
    );
  }

  if (!totpEncryptionAvailable()) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "No hay clave para cifrar el secreto. Defini MAGI_TOTP_KEY (o APP_ACCESS_TOKEN) en .env y reinicia el servidor.",
      },
      { status: 409 },
    );
  }

  const parsed = await readJsonBody<{ deviceId?: string; deviceName?: string }>(request);
  if (!parsed.ok) return parsed.response;

  const deviceId = parsed.body.deviceId?.trim() ?? "";
  if (!deviceId) return NextResponse.json({ ok: false, error: "Falta el deviceId." }, { status: 400 });

  const device = getDevice(deviceId);
  if (!device) return NextResponse.json({ ok: false, error: "No existe ese dispositivo." }, { status: 404 });
  if (device.revokedAt !== null) return NextResponse.json({ ok: false, error: "El dispositivo esta revocado." }, { status: 409 });

  const result = enrollDeviceTotp(deviceId, { account: device.name, issuer: "Consenso IA" });
  if ("error" in result) return NextResponse.json({ ok: false, error: result.error }, { status: 409 });

  recordAudit({ deviceId, action: "device_created", targetId: deviceId, result: "ok", detail: "totp inscrito" });
  return NextResponse.json({ ok: true, secret: result.secret, url: result.url });
}
