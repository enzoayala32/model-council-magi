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

import { constantTimeEqual } from "../api-security";
import { isValidOperatorSession } from "./operator-session";

function readBearer(value: string | null): string | null {
  if (!value) return null;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match ? match[1].trim() : null;
}

type OperatorRequest = { headers: { get(name: string): string | null } };

/**
 * ¿La request viene autenticada como operador?
 *
 * Dos vías, con distinto nivel de exposición a propósito:
 * - **Bearer** (`Authorization`): el token maestro. Es para scripts, que ya
 *   lo tienen en su entorno.
 * - **Cookie**: un id de sesión opaco, validado contra `operator_sessions`.
 *   El token maestro NUNCA viaja al navegador.
 *
 * En ambos casos se valida el valor: no alcanza con que la cookie exista.
 */
export function isOperatorRequest(request: OperatorRequest): boolean {
  const expected = process.env.APP_ACCESS_TOKEN?.trim();

  // Bearer: token maestro (scripts).
  if (expected) {
    const bearer = readBearer(request.headers.get("authorization"));
    if (bearer !== null && constantTimeEqual(bearer, expected)) return true;
  }

  // Cookie: sesión opaca guardada en la DB.
  if (isValidOperatorSession(request)) return true;

  return false;
}

/** Para el mensaje de error: si hay token configurado, hay que pedirlo. */
export function operatorTokenConfigured(): boolean {
  return Boolean(process.env.APP_ACCESS_TOKEN?.trim());
}
