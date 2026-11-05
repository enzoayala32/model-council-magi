import { NextResponse } from "next/server";
import { createPairingCode } from "@/lib/auth/pairing";
import { recordAudit } from "@/lib/auth/audit";

/**
 * Fase 4a - generar un codigo de emparejamiento.
 *
 * SOLO desde loopback: generar un codigo es conceder acceso, y eso se hace
 * desde la PC. El proxy ya rechaza Hosts no-loopback sin autenticacion, pero
 * aca se vuelve a verificar de forma explicita porque es la operacion mas
 * sensible del flujo: si el proxy se relajara por un error de configuracion,
 * esta ruta no deberia conceder acceso desde internet igual.
 */
function isLoopback(request: Request): boolean {
  const host = request.headers.get("host") ?? "";
  const hostname = host.replace(/^\[/, "").replace(/\].*$/, "").split(":")[0];
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

export async function POST(request: Request) {
  if (!isLoopback(request)) {
    recordAudit({ action: "pairing_created", result: "denied", detail: "host no loopback" });
    return NextResponse.json(
      { ok: false, error: "Los codigos de emparejamiento solo se generan desde esta PC." },
      { status: 403 },
    );
  }

  let body: { scope?: string; deviceName?: string } = {};
  try {
    body = (await request.json()) as { scope?: string };
  } catch {
    // Sin body se usa el default; no es un error.
  }
  const scope = body.scope ?? "observe";

  const code = createPairingCode(scope as never);
  recordAudit({ action: "pairing_created", result: "ok", detail: `scope ${code.scope}` });
  return NextResponse.json({ ok: true, code: code.code, scope: code.scope, expiresAt: code.expiresAt });
}
