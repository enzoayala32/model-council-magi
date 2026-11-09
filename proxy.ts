import { NextResponse, type NextRequest } from "next/server";
import { evaluateApiRequest } from "./lib/api-security";

/**
 * Rutas que NO pueden exigir token, porque existen justamente para
 * conseguirlo. Siguen sujetas a Host, Origin y Content-Type: solo se
 * salta el chequeo de `APP_ACCESS_TOKEN`.
 *
 * Se compara por prefijo exacto de segmento (no `startsWith` suelto) para
 * que `/api/auth/tokenX` no quede exento por accidente.
 */
/**
 * Rutas que se autentican SOLAS y por eso no deben pasar por la exigencia de
 * token del proxy:
 *
 * - `/api/auth/token`: es el login. Exigirle credencial sería circular.
 * - `/api/pairing` y `/api/pairing/redeem`: el emparejamiento. El cliente
 *   (el teléfono) TODAVÍA NO TIENE ninguna credencial —para eso viene—, así
 *   que pedirle `APP_ACCESS_TOKEN` hacía imposible el flujo. La ruta se
 *   protege con un código de un solo uso, TTL de 5 minutos y rate limiting
 *   estricto con bloqueo progresivo.
 *
 * Verificado contra el server real en la Etapa 0.4: sin esta exención, el
 * canje devolvía 403 "Token de acceso ausente o inválido" desde CUALQUIER peer.
 */
const TOKEN_EXEMPT_PATHS = [
  "/api/auth/token",
  "/api/pairing",
  "/api/pairing/redeem",
] as const;

function isTokenExempt(pathname: string): boolean {
  return TOKEN_EXEMPT_PATHS.some((path) => pathname === path);
}

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
      deviceTokenHeader: request.headers.get("x-magi-device-token"),
      hasBody,
      tokenExempt: isTokenExempt(request.nextUrl.pathname),
    },
    {
      ALLOWED_HOSTS: process.env.ALLOWED_HOSTS,
      ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS,
      APP_ACCESS_TOKEN: process.env.APP_ACCESS_TOKEN,
      REMOTE_ACCESS: process.env.REMOTE_ACCESS,
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
