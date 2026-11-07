import { NextResponse } from "next/server";
import QR from "qrcode";
import { createPairingCode } from "@/lib/auth/pairing";
import { recordAudit } from "@/lib/auth/audit";
import { allowsLocalImplicit } from "@/lib/peer";
import { constantTimeEqual } from "@/lib/api-security";
import { guardRequest } from "@/lib/auth/guard";

/**
 * Fase 4a/4d - generar un codigo de emparejamiento y su QR.
 *
 * QUIÉN puede: el operador (token de la app) o un peer loopback VERIFICADO.
 *
 * La corrección de seguridad: antes se decidía con el header `Host`, que manda
 * el CLIENTE. Alguien conectado desde una IP remota podía poner
 * `Host: localhost:3000` y generar/canjear códigos. Ahora el loopback sale de
 * `x-magi-peer`, que escribe `server.ts` con `req.socket.remoteAddress` (lo
 * fija el kernel, no el cliente). Si ese header falta (server que no es el
 * nuestro, o un test), NO se concede el loopback.
 *
 * El codigo viaja en el FRAGMENTO de la URL (#code=...), no en la query: los
 * fragments no se mandan al servidor ni quedan en logs de proxies.
 */
function authorizePairing(request: Request): { ok: true } | { ok: false; error: string } {
  // Operador activo: vale desde cualquier peer.
  const appToken = process.env.APP_ACCESS_TOKEN?.trim() ?? "";
  if (appToken) {
    const authorization = request.headers.get("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (match && constantTimeEqual(match[1].trim(), appToken)) return { ok: true };
  }

  // Peer loopback verificado por el kernel Y acceso implícito habilitado. Si
  // el server forzó MAGI_DISABLE_LOCAL_IMPLICIT (túnel o modo LAN), el peer
  // loopback no alcanza: hace falta el token del operador.
  if (allowsLocalImplicit(request)) return { ok: true };

  return {
    ok: false,
    error:
      appToken
        ? "Se requiere el token de acceso de esta PC para generar codigos."
        : "Los codigos solo se generan desde esta PC (peer no verificado).",
  };
}

/** URL que escanea el telefono: el host real de la request. */
function pairingUrl(request: Request, code: string): string {
  const host = request.headers.get("host") ?? "localhost:3000";
  const tls = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() === "https";
  return `${tls ? "https" : "http"}://${host}/m#code=${encodeURIComponent(code)}`;
}

export async function POST(request: Request) {
  const denied = guardRequest(request);
  if (denied) return denied;

  const who = authorizePairing(request);
  if (!who.ok) {
    recordAudit({ action: "pairing_created", result: "denied", detail: who.error });
    return NextResponse.json({ ok: false, error: who.error }, { status: 403 });
  }

  let scope = "observe";
  try {
    const body = (await request.json()) as { scope?: string };
    if (body.scope) scope = body.scope;
  } catch {
    // Sin body se usa el default; no es un error.
  }

  const code = createPairingCode(scope as never);
  const url = pairingUrl(request, code.code);

  let qrDataUrl: string | null = null;
  try {
    qrDataUrl = await QR.toDataURL(url, { margin: 1, width: 280 });
  } catch {
    // Si la libreria falla, el QR es prescindible: la URL y el codigo
    // alcanzan para emparejar a mano.
    qrDataUrl = null;
  }

  recordAudit({ action: "pairing_created", result: "ok", detail: `scope ${code.scope}` });
  return NextResponse.json({ ok: true, code: code.code, url, qr: qrDataUrl, scope: code.scope, expiresAt: code.expiresAt });
}
