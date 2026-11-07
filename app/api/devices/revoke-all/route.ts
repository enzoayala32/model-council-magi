import { NextResponse } from "next/server";
import { readJsonBody } from "@/lib/api-json";
import { listDevices, revokeDevice } from "@/lib/auth/devices";
import { clearStepUp } from "@/lib/auth/step-up";
import { revokeAllOperatorSessions } from "@/lib/auth/operator-session";
import { recordAudit } from "@/lib/auth/audit";
import { guardRequest, requireLocalAccess } from "@/lib/auth/guard";

/**
 * Fase 4d - kill switch desde la UI: revoca todos los dispositivos.
 *
 * A diferencia de `REMOTE_ACCESS=off` (que corta el acceso remoto entero y se
 * configura en el entorno), esto revoca las credenciales emitidas: el acceso
 * remoto sigue habilitado, pero ningun dispositivo puede usarlo hasta que se
 * empareje uno nuevo.
 */
export async function POST(request: Request) {
  const denied = guardRequest(request);
  if (denied) return denied;

  const local = requireLocalAccess(request);
  if (local) return local;

  // El cuerpo es opcional: se usa para no revocar el dispositivo desde el que
  // se esta operando (si justo se esta usando la PWA en el telefono).
  const parsed = await readJsonBody<{ exceptId?: string }>(request).catch(() => ({ ok: false as const }));
  const exceptId = parsed.ok ? parsed.body.exceptId?.trim() : undefined;

  let revoked = 0;
  for (const device of listDevices()) {
    if (device.revokedAt !== null) continue;
    if (exceptId && device.id === exceptId) continue;
    if (revokeDevice(device.id)) {
      clearStepUp(device.id);
      revoked += 1;
    }
  }

  // Kill switch completo: también las sesiones de operador del navegador.
  const sessions = revokeAllOperatorSessions();
  recordAudit({ action: "device_revoke_all", result: "ok", detail: `${revoked} dispositivos, ${sessions} sesiones` });
  return NextResponse.json({ ok: true, revoked, sessionsRevoked: sessions });
}
