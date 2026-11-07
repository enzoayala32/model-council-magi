import { NextResponse } from "next/server";
import { listDevices } from "@/lib/auth/devices";
import { guardRequest, requireLocalAccess } from "@/lib/auth/guard";

/**
 * Fase 4d - listado de dispositivos emparejados.
 *
 * Solo desde loopback: ver que dispositivos tienen acceso es informacion de
 * la PC. Desde un telefono solo se puede ver el propio estado.
 */
export async function GET(request: Request) {
  const denied = guardRequest(request);
  if (denied) return denied;

  const local = requireLocalAccess(request);
  if (local) return local;
  return NextResponse.json({ ok: true, devices: listDevices() });
}
