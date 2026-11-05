/**
 * Lectura de cookies compartida.
 *
 *
 * Vive acá y no en `api-security.ts` porque ese modulo es la politica pura
 * del proxy y no deberia saber de dispositivos; `api-security.ts` sigue
 * teniendo su propia copia minima para no invertir la dependencia.
 */
export function readCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    const raw = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      // Cookie mal escapada: se compara el valor crudo, nunca se rompe.
      return raw;
    }
  }
  return null;
}
