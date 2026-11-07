import { NextResponse } from "next/server";
import { readJsonBody } from "@/lib/api-json";
import { getDevice, renameDevice, setDeviceScope, revokeDevice } from "@/lib/auth/devices";
import { isDeviceScope } from "@/lib/auth/devices";
import { clearStepUp } from "@/lib/auth/step-up";
import { recordAudit } from "@/lib/auth/audit";
import { guardRequest, requireLocalAccess } from "@/lib/auth/guard";

/**
 * Fase 4d - renombrar o cambiar el scope de un dispositivo.
 *
 * Cambiar el scope invalida cualquier step-up en curso: si le bajas el
 * nivel a un dispositivo, una sesion de aprobacion vieja no deberia seguir
 * sirviendo con el scope anterior.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = guardRequest(request);
  if (denied) return denied;

  const local = requireLocalAccess(request);
  if (local) return local;
  const { id } = await params;
  const device = getDevice(id);
  if (!device) return NextResponse.json({ ok: false, error: "No existe ese dispositivo." }, { status: 404 });

  const parsed = await readJsonBody<{ name?: string; scope?: string }>(request);
  if (!parsed.ok) return parsed.response;

  let updated = device;
  if (typeof parsed.body.name === "string") {
    const renamed = renameDevice(id, parsed.body.name);
    if (!renamed) return NextResponse.json({ ok: false, error: "El nombre no puede quedar vacio." }, { status: 400 });
    updated = renamed;
  }
  if (parsed.body.scope !== undefined) {
    if (!isDeviceScope(parsed.body.scope)) {
      return NextResponse.json({ ok: false, error: "Scope invalido: observe, operate o approve." }, { status: 400 });
    }
    const changed = setDeviceScope(id, parsed.body.scope);
    if (!changed) return NextResponse.json({ ok: false, error: "No se pudo cambiar el scope." }, { status: 400 });
    updated = changed;
    // El scope cambio: cualquier step-up vigente queda sin sentido.
    clearStepUp(id);
  }

  recordAudit({
    deviceId: id,
    action: "device_scope_changed",
    targetId: id,
    result: "ok",
    detail: `scope ${updated.scope}`,
  });
  return NextResponse.json({ ok: true, device: updated });
}

/** Revocar (borrado logico: el dispositivo queda registrado, inutilizable). */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = guardRequest(request);
  if (denied) return denied;

  const local = requireLocalAccess(request);
  if (local) return local;
  const { id } = await params;
  const revoked = revokeDevice(id);
  if (!revoked) return NextResponse.json({ ok: false, error: "No existe o ya estaba revocado." }, { status: 404 });
  clearStepUp(id);
  recordAudit({ deviceId: id, action: "device_revoked", targetId: id, result: "ok" });
  return NextResponse.json({ ok: true });
}
