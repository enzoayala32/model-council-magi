import { NextResponse, type NextRequest } from "next/server";
import { evaluateApiRequest } from "./lib/api-security";

/**
 * Fase 1 — puerta de entrada de `/api/*`.
 *
 * Next 16 renombró `middleware.ts` a `proxy.ts`; el runtime es siempre
 * Node.js (ver `get-page-static-info` de la versión instalada), así que
 * `process.env` y las allowlists funcionan sin configuración extra.
 *
 * La política completa vive en `lib/api-security.ts` (función pura y
 * testeable). Acá solo se leen los headers, se decide y se traduce a HTTP.
 */
export function proxy(request: NextRequest) {
  const contentLength = request.headers.get("content-length")?.trim();
  // Un body chunked no trae Content-Length; Transfer-Encoding lo delata.
  const hasBody = Boolean(contentLength && contentLength !== "0") || Boolean(request.headers.get("transfer-encoding"));

  const decision = evaluateApiRequest(
    {
      method: request.method,
      host: request.headers.get("host"),
      origin: request.headers.get("origin"),
      secFetchSite: request.headers.get("sec-fetch-site"),
      contentType: request.headers.get("content-type"),
      authorization: request.headers.get("authorization"),
      cookie: request.headers.get("cookie"),
      hasBody,
    },
    {
      ALLOWED_HOSTS: process.env.ALLOWED_HOSTS,
      ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS,
      APP_ACCESS_TOKEN: process.env.APP_ACCESS_TOKEN,
      PORT: process.env.PORT,
    },
  );

  if (decision.ok) return NextResponse.next();

  // Log corto y sin datos del request (ni tokens ni bodies): el mensaje
  // que ve el cliente ya es genérico y en español.
  console.warn(`[api-security] ${request.method} ${request.nextUrl.pathname} bloqueado (${decision.reason})`);
  return NextResponse.json({ ok: false, error: decision.error }, { status: decision.status });
}

export const config = {
  matcher: "/api/:path*",
};
