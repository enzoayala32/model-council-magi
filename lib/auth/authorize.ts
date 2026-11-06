/**
 * Fase 4b - autorizacion central.
 *
 * Decide si una request a /api/* puede pasar, y con que nivel. Se usa
 * desde las rutas (helper `requireScope`) y es la misma funcion que
 * consultan los tests, asi que no hay dos logicas que puedan divergir.
 *
 * Orden de la decision:
 * 1. Ruta sin clasificar -> DENEGADA. No existe "ruta nueva sin pensar".
 * 2. Ruta `public` -> pasa (se autentica sola: login y canje).
 * 3. Loopback SIN ninguna credencial configurada -> pasa. Es el uso local
 *    de siempre, de una sola persona, y no debe cambiar.
 * 4. Token de la app valido -> pasa con scope `approve` (es el secreto
 *    del operador: si lo tenes, sos el operador).
 * 5. Cookie de dispositivo -> pasa solo si el scope del dispositivo
 *    alcanza, y si la ruta pide step-up, solo con el header
 *    `x-magi-step-up` apuntando a una sesion vigente (4c). El operador
 *    (token de la app) y el uso local implicito no necesitan step-up: es la
 *    PC del operador, no un control remoto.
 * 6. Cualquier otra cosa -> DENEGADA.
 *
 * Loopback CON credencial configurada NO es via libre: si definis
 * APP_ACCESS_TOKEN, tambien se pide en localhost. Es lo que ya hacia el
 * proxy desde la Fase 1 y no se cambia.
 */

import { findDeviceByToken, touchDevice, type Device, type DeviceScope } from "./devices";
import { readDeviceToken } from "./cookie";
import { isLoopbackHost, ruleFor, scopeSatisfies, type RouteRule, type RouteScope } from "./scopes";
import { recordAudit } from "./audit";
import { constantTimeEqual } from "../api-security";
import { readCookie } from "./cookie-parse";
import { APP_ACCESS_TOKEN_COOKIE } from "../api-security";
import { isStepUpValid } from "./step-up";

export type AuthContext = {
  /** Dispositivo emparejado, si la request vino con una cookie valida. */
  device: Device | null;
  /** true si la autenticacion fue con el token del operador. */
  operator: boolean;
  /** true si el acceso es local sin credencial (uso de siempre). */
  localImplicit: boolean;
};

export type AuthDecision =
  | { ok: true; context: AuthContext }
  | { ok: false; status: 403 | 401; error: string; reason: string };

/** Scope maximo que concede cada modo de autenticacion. */
const OPERATOR_SCOPE: DeviceScope = "approve";

/** Resuelve QUIIEN es el cliente, sin decidir si puede pasar. */
export function resolveAuthContext(request: {
  headers: { get(name: string): string | null };
}): AuthContext {
  const appToken = process.env.APP_ACCESS_TOKEN?.trim() ?? "";
  const bearer = readBearer(request.headers.get("authorization"));
  const cookieToken = readCookie(request.headers.get("cookie"), APP_ACCESS_TOKEN_COOKIE);

  if (appToken) {
    const bearerOk = bearer !== null && constantTimeEqual(bearer, appToken);
    const cookieOk = cookieToken !== null && constantTimeEqual(cookieToken, appToken);
    if (bearerOk || cookieOk) {
      return { device: null, operator: true, localImplicit: false };
    }
  }

  const deviceToken = readDeviceToken(request);
  if (deviceToken) {
    const device = findDeviceByToken(deviceToken);
    if (device) {
      touchDevice(device.id);
      return { device, operator: false, localImplicit: false };
    }
  }

  return { device: null, operator: false, localImplicit: isLoopbackHost(request.headers.get("host")) };
}

function readBearer(value: string | null): string | null {
  if (!value) return null;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match ? match[1].trim() : null;
}

export type AuthorizeOptions = {
  method: string;
  pathname: string;
  request: { headers: { get(name: string): string | null } };
  /** Para tests de 4c: true si hay un step-up vigente. */
  stepUpValid?: boolean;
};

/** La decision. Pura salvo por `touchDevice` y la auditoria. */
export function authorize(options: AuthorizeOptions): AuthDecision {
  const rule = ruleFor(options.method, options.pathname);
  if (!rule) {
    return {
      ok: false,
      status: 403,
      error: "Ruta no autorizada: no tiene scope declarado.",
      reason: "unclassified_route",
    };
  }

  // `public`: la ruta se autentica sola.
  if (rule.scope === "public") {
    return { ok: true, context: { device: null, operator: false, localImplicit: false } };
  }

  const context = resolveAuthContext(options.request);

  // Uso local implicito: PC del operador, sin ninguna credencial configurada.
  const anyCredentialConfigured = Boolean(process.env.APP_ACCESS_TOKEN?.trim());
  if (!anyCredentialConfigured && context.localImplicit) {
    return { ok: true, context };
  }

  if (context.operator) {
    return { ok: true, context };
  }

  if (context.device) {
    if (!scopeSatisfies(context.device.scope, rule.scope)) {
      recordAudit({
        deviceId: context.device.id,
        action: "access_denied",
        targetId: `${options.method} ${options.pathname}`,
        result: "denied",
        detail: `scope ${context.device.scope} insuficiente para ${rule.scope}`,
      });
      return {
        ok: false,
        status: 403,
        error: `Este dispositivo tiene acceso de solo ${context.device.scope}. La accion requiere ${rule.scope}.`,
        reason: "scope_insuficiente",
      };
    }
    // Step-up (Fase 4c): ademas del scope, exige un segundo factor reciente.
    // El token viaja en un header, no en la cookie: asi no sobrevive a la
    // sesion ni queda expuesto a un XSS que lea document.cookie.
    const stepUpToken = options.request.headers.get("x-magi-step-up");
    const stepUpValid = options.stepUpValid ?? isStepUpValid(context.device.id, stepUpToken);
    if (rule.stepUp && !stepUpValid) {
      recordAudit({
        deviceId: context.device.id,
        action: "access_denied",
        targetId: `${options.method} ${options.pathname}`,
        result: "denied",
        detail: "falta step-up",
      });
      return {
        ok: false,
        status: 403,
        error: "Esta accion requiere confirmacion con el segundo factor.",
        reason: "step_up_requerido",
      };
    }
    return { ok: true, context };
  }

  // Sin identidad utilizable.
  const loopback = isLoopbackHost(options.request.headers.get("host"));
  return {
    ok: false,
    status: loopback ? 401 : 403,
    error: loopback
      ? "Se requiere el token de acceso para esta operacion."
      : "Acceso desde fuera de esta PC requiere un dispositivo emparejado.",
    reason: loopback ? "token_requerido" : "sin_dispositivo",
  };
}

/** Scope efectivo de un contexto (para logs y tests). */
export function effectiveScope(context: AuthContext): RouteScope {
  if (context.operator) return OPERATOR_SCOPE;
  if (context.device) return context.device.scope;
  return "observe";
}

/**
 * Helper para las rutas.
 *
 * Uso tipico al principio de un handler:
 *   const guard = requireScope({ method: "POST", pathname: new URL(request.url).pathname, request });
 *   if (!guard.ok) return NextResponse.json({ ok: false, error: guard.error, reason: guard.reason }, { status: guard.status });
 *
 * `stepUpValid` va explicito: hasta que exista el TOTP de la Fase 4c, ninguna
 * ruta con step-up se puede satisfacer desde un dispositivo remoto. Es a
 * proposito — fail closed.
 */
export function requireScope(options: AuthorizeOptions):
  | { ok: true; context: AuthContext; rule: RouteRule }
  | { ok: false; status: 403 | 401; error: string; reason: string } {
  const decision = authorize(options);
  if (decision.ok) {
    const rule = ruleFor(options.method, options.pathname);
    return { ok: true, context: decision.context, rule: rule as RouteRule };
  }
  return { ok: false, status: decision.status, error: decision.error, reason: decision.reason };
}
