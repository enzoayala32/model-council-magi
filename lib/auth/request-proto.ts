/**
 * Fase 5.5 — ¿la request llegó por HTTPS? (aunque el TLS lo termine un túnel).
 *
 * Detrás de `tailscale serve` o de Cloudflare Tunnel, el TLS termina en el
 * proxy: la app recibe HTTP plano y se entera del protocolo original por
 * headers. Este módulo es el ÚNICO lugar que los lee.
 *
 * POR QUÉ ES SEGURO confiar en estos headers: no se usan para AUTORIZAR, se
 * usan para decidir un atributo de cookie. Si un atacante manda
 * `X-Forwarded-Proto: https` sobre HTTP plano, lo peor que consigue es que el
 * navegador descarte la cookie (no se puede mandar sin TLS) y el login falle:
 * se rompe a sí mismo, no entra. La autorización sigue saliendo del peer
 * verificado del socket y de las credenciales (`lib/peer.ts`, `lib/auth/*`).
 *
 * Headers aceptados, en orden:
 * 1. `X-Forwarded-Proto` — el estándar de facto. Puede ser una lista si pasó
 *    por varios proxies ("https, http"): manda el PRIMERO, que es el del
 *    cliente original.
 * 2. `Forwarded` (RFC 7239) — `Forwarded: proto=https`. Lo manda algún proxy
 *    que no quiere headers propietarios.
 * 3. `X-Forwarded-Ssl: on` — variante de balanceadores (AWS ELB, nginx).
 */

type ProtoRequest = { headers: { get(name: string): string | null } };

function firstValue(raw: string | null): string {
  if (!raw) return "";
  return raw.split(",")[0].trim().toLowerCase();
}

export function isHttpsRequest(request: ProtoRequest): boolean {
  if (firstValue(request.headers.get("x-forwarded-proto")) === "https") return true;

  // RFC 7239: uno o varios pares clave=valor separados por ";".
  const forwarded = request.headers.get("forwarded");
  if (forwarded && /(^|;|\s)proto\s*=\s*https/i.test(forwarded)) return true;

  const forwardedSsl = request.headers.get("x-forwarded-ssl");
  if (forwardedSsl && firstValue(forwardedSsl) === "on") return true;

  return false;
}

/** Para logs y tests: qué header decidió. No filtra valores ajenos. */
export function httpsSignal(request: ProtoRequest): "x-forwarded-proto" | "forwarded" | "x-forwarded-ssl" | "ninguno" {
  if (firstValue(request.headers.get("x-forwarded-proto")) === "https") return "x-forwarded-proto";
  const forwarded = request.headers.get("forwarded");
  if (forwarded && /(^|;|\s)proto\s*=\s*https/i.test(forwarded)) return "forwarded";
  const forwardedSsl = request.headers.get("x-forwarded-ssl");
  if (forwardedSsl && firstValue(forwardedSsl) === "on") return "x-forwarded-ssl";
  return "ninguno";
}
