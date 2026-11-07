/**
 * Guardia obligatoria por ruta.
 *
 * POR QUE EXISTE (corrección de seguridad #2): el proxy deja pasar
 * CUALQUIER request que traiga una cookie `magi_device_token`, porque el
 * proxy no puede consultar la DB para saber si esa cookie es de un
 * dispositivo real. Esa decisión la tiene que tomar la ruta. Y solo 7 de 35
 * rutas lo hacían: con una cookie falsa y sin token, desde la LAN,
 * `POST /api/agent/projects` creaba proyectos (201) y
 * `GET /api/agent/browse?path=/` listaba el disco (200).
 *
 * `guardRequest` es el punto único: lee método y path del propio request,
 * busca el scope en `lib/auth/scopes.ts` (que ya está completo y verificado
 * por `lib/test-route-scopes.ts`) y autoriza. Si la ruta no está declarada,
 * deniega — no existe "ruta nueva sin pensar".
 *
 * Uso, primera línea de cada handler:
 *   const denied = guardRequest(request);
 *   if (denied) return denied;
 *
 * `lib/test-route-enforcement.ts` recorre las 35 rutas y verifica que cada
 * una deniegue sin credencial: una ruta sin guardia hace fallar el test.
 */
import { NextResponse } from "next/server";
import { requireScope } from "./authorize";
import { ruleFor } from "./scopes";
import { allowsLocalImplicit } from "../peer";
import { isOperatorRequest, operatorTokenConfigured } from "./operator";

export type GuardDenial = ReturnType<typeof NextResponse.json>;

/** Autoriza la request. Devuelve `null` si puede pasar. */
export function guardRequest(request: Request): GuardDenial | null {
  const pathname = new URL(request.url).pathname;
  const method = request.method;

  const rule = ruleFor(method, pathname);
  if (!rule) {
    return NextResponse.json(
      { ok: false, error: "Ruta no autorizada: no tiene scope declarado.", reason: "unclassified_route" },
      { status: 403 },
    );
  }

  const guard = requireScope({ method, pathname, request });
  if (!guard.ok) {
    return NextResponse.json({ ok: false, error: guard.error, reason: guard.reason }, { status: guard.status });
  }
  return null;
}

/**
 * Acceso "solo desde esta PC" — decidido por peer verificado o credencial de
 * operador, NUNCA por el header `Host`.
 *
 * Lo usan las rutas de administración (dispositivos, auditoría, inscripción
 * de TOTP). Antes miraban `isLoopbackHost(request.headers.get("host"))`, que
 * el cliente falsifica: desde la LAN con `Host: localhost:3000` se pasaba.
 *
 * Devuelve `null` si puede pasar; si no, el 403 listo para responder.
 */
export function requireLocalAccess(request: Request): GuardDenial | null {
  // Operador activo, por Bearer O por cookie: el navegador manda la cookie.
  // Un solo helper para que no diverga de `authorize.ts`.
  if (isOperatorRequest(request)) return null;
  const appToken = operatorTokenConfigured();
  // Peer loopback verificado por el kernel Y acceso implícito habilitado (en
  // modo túnel/LAN el server lo fuerza apagado).
  if (allowsLocalImplicit(request)) return null;

  return NextResponse.json(
    {
      ok: false,
      error: appToken
        ? "Se requiere el token de acceso de esta PC."
        : "Solo desde esta PC (peer no verificado).",
      reason: "local_requerido",
    },
    { status: 403 },
  );
}
