import { NextResponse } from "next/server";
import { listDevices } from "@/lib/auth/devices";
import { isLoopbackHost } from "@/lib/auth/scopes";

/**
 * Fase 4d - listado de dispositivos emparejados.
 *
 * Solo desde loopback: ver que dispositivos tienen acceso es informacion de
 * la PC. Desde un telefono solo se puede ver el propio estado.
 */
export async function GET(request: Request) {
  if (!isLoopbackHost(request.headers.get("host"))) {
    return NextResponse.json({ ok: false, error: "Solo se ve desde esta PC." }, { status: 403 });
  }
  return NextResponse.json({ ok: true, devices: listDevices() });
}
