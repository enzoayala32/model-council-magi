import { NextResponse } from "next/server";
import QR from "qrcode";
import { createPairingCode } from "@/lib/auth/pairing";
import { recordAudit } from "@/lib/auth/audit";

/**
 * Fase 4a/4d - generar un codigo de emparejamiento y su QR.
 *
 * SOLO desde loopback: generar un codigo es conceder acceso, y eso se hace
 * desde la PC. El proxy ya rechaza Hosts no-loopback sin autenticacion, pero
 * aca se vuelve a verificar de forma explicita porque es la operacion mas
 * sensible del flujo.
 *
 * El codigo viaja en el FRAGMENTO de la URL (#code=...), no en la query: los
 * fragments no se mandan al servidor ni quedan en logs de proxies.
 */
function isLoopback(request: Request): boolean {
  const host = request.headers.get("host") ?? "";
  const hostname = host.replace(/^\[/, "").replace(/\].*$/, "").split(":")[0];
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

/** URL que escanea el telefono. Usa el host real de la request, asi funciona
 *  en la LAN sin configurar nada. */
function pairingUrl(request: Request, code: string): string {
  const host = request.headers.get("host") ?? "localhost:3000";
  const tls = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() === "https";
  return `${tls ? "https" : "http"}://${host}/m#code=${encodeURIComponent(code)}`;
}

export async function POST(request: Request) {
  if (!isLoopback(request)) {
    recordAudit({ action: "pairing_created", result: "denied", detail: "host no loopback" });
    return NextResponse.json(
      { ok: false, error: "Los codigos de emparejamiento solo se generan desde esta PC." },
      { status: 403 },
    );
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
