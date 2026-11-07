/**
 * Credencial de operador: UN solo lugar que la valida.
 *
 * POR QUE EXISTE (corrección de la revisión): las rutas de administración
 * (`requireLocalAccess`) y `POST /api/pairing` aceptaban **solo**
 * `Authorization: Bearer`. Pero el navegador del operador nunca manda Bearer:
 * manda la cookie. Resultado: en modo LAN, con el token bien configurado,
 * `GET /api/agent/projects` daba 200 pero `GET /api/devices`,
 * `GET /api/audit` y `POST /api/pairing` daban 403 — la UI del operador
 * quedaba inutilizada.
 *
 * Ací se aceptan las DOS vías (Bearer o cookie) con comparación en tiempo
 * constante, y `authorize.ts` (Fase 4b), `guard.ts` y la ruta de pairing
 * reusan esta misma función. Así no pueden divergir.
 */

import { APP_ACCESS_TOKEN_COOKIE, constantTimeEqual } from "../api-security";
import { readCookie } from "./cookie-parse";

function readBearer(value: string | null): string | null {
  if (!value) return null;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match ? match[1].trim() : null;
}

type OperatorRequest = { headers: { get(name: string): string | null } };

/**
 * ¿La request viene autenticada como operador, por cualquiera de sus dos
 * vías (Bearer o cookie)?
 *
 * OJO: valida el **valor** contra `APP_ACCESS_TOKEN`. No alcanza con que la
 * cookie exista: un valor falso debe fallar.
 */
export function isOperatorRequest(request: OperatorRequest): boolean {
  const expected = process.env.APP_ACCESS_TOKEN?.trim();
  if (!expected) return false;

  const bearer = readBearer(request.headers.get("authorization"));
  if (bearer !== null && constantTimeEqual(bearer, expected)) return true;

  const cookie = readCookie(request.headers.get("cookie"), APP_ACCESS_TOKEN_COOKIE);
  if (cookie !== null && constantTimeEqual(cookie, expected)) return true;

  return false;
}

/** Para el mensaje de error: si hay token configurado, hay que pedirlo. */
export function operatorTokenConfigured(): boolean {
  return Boolean(process.env.APP_ACCESS_TOKEN?.trim());
}
