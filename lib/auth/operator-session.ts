/**
 * Sesiones de operador opacas (corrección de la revisión).
 *
 * PROBLEMA: la cookie `magi_access_token` guardaba `APP_ACCESS_TOKEN` en
 * crudo. Cualquiera con acceso a la cookie (XSS, backup de perfil, historial
 * de devtools) tenía el token maestro para siempre.
 *
 * AHORA: al hacer login el server genera un id aleatorio de 256 bits, guarda
 * su SHA-256 en la DB y la cookie lleva solo ese id. Un dump de la DB no
 * recupera ninguna sesión válida, y revocar la sesión la mata aunque el
 * atacante conserve el valor.
 *
 * `Bearer` se mantiene para scripts: sigue llevando el token maestro, que es
 * lo que un operador de terminal ya tiene en su entorno.
 */

import crypto from "node:crypto";
import { getDb } from "../db";
import { APP_ACCESS_TOKEN_COOKIE } from "../api-security";
import { constantTimeEqual } from "../api-security";

/** Vida útil de la sesión: 24 horas. */
const SESSION_TTL_MS = 24 * 60 * 60_000;
/** Idle timeout: 2 horas sin uso la sesión caduca igual. */
const SESSION_IDLE_MS = 2 * 60 * 60_000;

export const OPERATOR_COOKIE_NAME = APP_ACCESS_TOKEN_COOKIE;

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

type SessionRow = {
  id: string;
  token_hash: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  revoked_at: number | null;
};

/** Crea una sesión y devuelve el valor EN CLARO (va en la cookie). */
export function createOperatorSession(): string {
  const token = crypto.randomBytes(32).toString("hex");
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO operator_sessions (id, token_hash, created_at, last_seen_at, expires_at)
       VALUES (@id, @hash, @now, @now, @expires)`,
    )
    .run({
      id: crypto.randomUUID(),
      hash: hashToken(token),
      now,
      expires: now + SESSION_TTL_MS,
    });
  return token;
}

/**
 * ¿La cookie trae una sesión válida? Además renueva el idle timeout para que
 * una sesión activa no caduque por inactividad.
 */
export function isValidOperatorSession(request: { headers: { get(name: string): string | null } }): boolean {
  // Si el operador dejó de configurar el token maestro, las sesiones
  // existentes caducan: si no, cualquiera con la cookie seguiría teniendo
  // acceso sin nada que lo justifique.
  if (!process.env.APP_ACCESS_TOKEN?.trim()) return false;
  const raw = request.headers.get("cookie") ?? "";
  let value: string | null = null;
  try {
    for (const part of raw.split(";")) {
      const sep = part.indexOf("=");
      if (sep === -1) continue;
      if (part.slice(0, sep).trim() !== OPERATOR_COOKIE_NAME) continue;
      value = decodeURIComponent(part.slice(sep + 1).trim());
      break;
    }
  } catch {
    return false;
  }
  if (!value || !/^[0-9a-f]{64}$/.test(value)) return false;

  const row = getDb()
    .prepare("SELECT * FROM operator_sessions WHERE token_hash = ?")
    .get(hashToken(value)) as SessionRow | undefined;
  if (!row) return false;
  if (row.revoked_at !== null) return false;
  const now = Date.now();
  if (row.expires_at <= now) return false;
  if (now - row.last_seen_at > SESSION_IDLE_MS) return false;
  return true;
}

/** Renueva el idle timeout de la sesión presente (si existe). */
export function touchOperatorSession(request: { headers: { get(name: string): string | null } }): void {
  if (!isValidOperatorSession(request)) return;
  const raw = request.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const sep = part.indexOf("=");
    if (sep === -1) continue;
    if (part.slice(0, sep).trim() !== OPERATOR_COOKIE_NAME) continue;
    let value: string;
    try {
      value = decodeURIComponent(part.slice(sep + 1).trim());
    } catch {
      return;
    }
    try {
      getDb()
        .prepare("UPDATE operator_sessions SET last_seen_at = ? WHERE token_hash = ?")
        .run(Date.now(), hashToken(value));
    } catch {
      /* silencioso: no puede tumbar la request */
    }
    return;
  }
}

/** Revoka TODAS las sesiones (logout global / kill switch). */
export function revokeAllOperatorSessions(): number {
  const result = getDb()
    .prepare("UPDATE operator_sessions SET revoked_at = ? WHERE revoked_at IS NULL")
    .run(Date.now());
  return result.changes;
}

/** Revoka una sesión por su valor (logout de este navegador). */
export function revokeOperatorSession(value: string): boolean {
  const result = getDb()
    .prepare("UPDATE operator_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL")
    .run(Date.now(), hashToken(value));
  return result.changes > 0;
}

/** Poda de sesiones vencidas (llamada periódica). */
export function pruneOperatorSessions(): number {
  const result = getDb().prepare("DELETE FROM operator_sessions WHERE expires_at <= ?").run(Date.now());
  return result.changes;
}

/** Solo para tests. */
export function countOperatorSessions(): number {
  const row = getDb().prepare("SELECT COUNT(*) as c FROM operator_sessions").get() as { c: number };
  return row.c;
}

export { constantTimeEqual };

/** Cookie de la sesión opaca. */
export function buildOperatorSessionCookie(token: string, opts: { secure: boolean }): string {
  const parts = [
    `${OPERATOR_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${Math.round(SESSION_TTL_MS / 1000)}`,
  ];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearOperatorSessionCookie(): string {
  return `${OPERATOR_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`;
}
