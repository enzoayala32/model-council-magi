/**
 * Fase 4a - construccion y lectura de la cookie de dispositivo.
 *
 * La cookie lleva el token en claro (es un secreto que solo conoce el
 * cliente). Lo que se guarda en la DB es el HASH (ver devices.ts), y el
 * dispositivo es revocable: borrar la cookie no es la unica forma de
 * cortar el acceso.
 *
 * Atributos, y por que:
 * - `HttpOnly`: el JS de la pagina no puede leerla. Si un XSS se cuela, no
 *   se lleva el token.
 * - `SameSite=Strict`: no se manda en ninguna navegacion cross-site.
 * - `Path=/`: la API vive bajo /api.
 * - `Secure` solo si la request vino por HTTPS (o `x-forwarded-proto` lo
 *   dice): en HTTP local, marcarla Secure haria que el navegador la
 *   descarte y el emparejamiento fallaria sin explicacion.
 * - `Max-Age`: 90 dias, renovable en cada request (ver `touchDevice`).
 */

import { readCookie } from "./cookie-parse";
import { DEVICE_COOKIE } from "./devices";

const NINETY_DAYS_SECONDS = 90 * 24 * 60 * 60;

export function buildDeviceCookie(token: string, opts: { secure: boolean }): string {
  const parts = [
    `${DEVICE_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${NINETY_DAYS_SECONDS}`,
  ];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearDeviceCookie(): string {
  return `${DEVICE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`;
}

/** Token de dispositivo desde el header Cookie, o null. */
export function readDeviceToken(request: { headers: { get(name: string): string | null } }): string | null {
  const raw = readCookie(request.headers.get("cookie"), DEVICE_COOKIE);
  return raw && raw.trim() ? raw.trim() : null;
}
