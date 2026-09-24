/**
 * Fase 5B — `classifyProviderError()`.
 *
 * Implementa la tabla definitiva de clasificación de errores (ver diseño
 * de Fase 5, ronda 3 + el mensaje de aprobación de 5B). Puro: no importa
 * `fetch`, no conoce `generateText`, `loop.ts`, `council-run.ts` ni ningún
 * cliente de provider — recibe un `ProviderErrorInput` ya normalizado por
 * el caller (eso será trabajo de 5D/5E) y devuelve una decisión.
 *
 * Separación explícita (pedida en la ronda 2 y reafirmada acá):
 * "request retryability" (`retrySameKey`) es una pregunta distinta de
 * "credential health impact" (`poolAction`) — un error puede ameritar
 * reintentar sin que eso implique nada sobre si la credential está sana
 * (500/502/503/timeout/network: `retrySameKey:true` pero `poolAction:"NONE"`).
 *
 * Decisión de diseño IMPORTANTE y explícitamente abierta (ver informe de
 * cierre de 5B): la distinción entre `403 cuota/plan` / `403 auth
 * inválida` / `403 policy` se hace por coincidencia de substrings en el
 * mensaje de error (`QUOTA_HINTS`/`AUTH_HINTS`/`POLICY_HINTS` abajo). Esto
 * NO está verificado contra respuestas reales de OpenRouter/NVIDIA/Google
 * — en el análisis de Fase 5 (rondas 1-3) se confirmó que el código actual
 * de este proyecto NUNCA maneja 401/403 de forma diferenciada en ningún
 * lado (no hay ningún precedente real que leer, a diferencia del 429 de
 * `google-ai-studio.ts`, cuyo patrón de "limit: 0" si inspiró el enfoque
 * de mirar el texto del error). Los substrings elegidos son vocabulario
 * común de mensajes de error estilo OpenAI/OpenRouter, pero son una
 * heurística best-effort, no un hecho verificado en este código — un 403
 * que no calce con ninguno cae, a propósito, en `403_unknown` → PERMANENT
 * (nunca "por las dudas" a failover, tal como se pidió explícitamente).
 */

import { parseRetryAfterMs, RETRY_SAME_KEY_THRESHOLD_MS } from "./cooldown";

export type ProviderErrorCategory = "RETRY_SAME_KEY" | "FAILOVER_CREDENTIAL" | "FAILOVER_MODEL" | "PERMANENT" | "UNKNOWN";

/** Qué debería hacer el caller con el pool de 5A a partir de esta
 * clasificación. `"NONE"` significa literalmente "no llamar a
 * `pool.release()` en absoluto" — no hace falta un cuarto `ReleaseOutcome`
 * para "sin efecto", la ausencia de la llamada ya es sin efecto. */
export type PoolAction = "NONE" | "COOLDOWN" | "INVALID";

export type ClassifiedError = {
  category: ProviderErrorCategory;
  /** ¿Vale la pena reintentar con la MISMA credential antes de rotar? */
  retrySameKey: boolean;
  /** ¿Esta clase de error habilita rotar a otra credential (inmediato, o
   * tras agotar el retry-mismo-key si `retrySameKey` es true)? */
  failoverCredential: boolean;
  poolAction: PoolAction;
  /** ¿Un fallback de modelo/provider (`fallbackModelId`, ya existente en
   * el proyecto) tiene sentido para este error, EN PRINCIPIO? 5B no sabe
   * si el modelo que falló tiene configurado un `fallbackModelId` — eso lo
   * decide el caller combinando este flag con su propia configuración. */
  allowModelFallback: boolean;
  /** Milisegundos de espera sugeridos por el proveedor (`Retry-After`),
   * `null` si no aplica o no vino ninguno. */
  retryAfterMs: number | null;
  /** Etiqueta corta y estable para logs/tests — NUNCA el mensaje crudo del
   * proveedor (que podría contener fragmentos de la request/response que
   * no corresponde persistir tal cual). */
  reason: string;
};

export type ProviderErrorInput =
  | { kind: "timeout" }
  | { kind: "network" }
  | { kind: "unknown"; message?: string }
  | {
      kind: "http";
      status: number;
      /** Segundos ya parseados, si el caller los tiene (ej.
       * `OpenRouterError.retryAfterSeconds`, confirmado como campo real
       * del proyecto en el análisis de Fase 5). */
      retryAfterSeconds?: number | null;
      /** Header crudo de `Retry-After`, si el caller no lo tiene ya
       * parseado — ver `parseRetryAfterMs` en `cooldown.ts`. */
      retryAfterHeader?: string | null;
      /** Texto del error, usado únicamente para las heurísticas de 403
       * (y para etiquetar mejor un 400) — nunca se devuelve tal cual en
       * `reason`, nunca se persiste desde acá. */
      message?: string;
    };

const QUOTA_HINTS = ["quota", "insufficient_quota", "billing", "exceeded your current", "credits", "plan limit", "out of credits"];
const AUTH_HINTS = ["invalid api key", "invalid_api_key", "unauthorized", "authentication", "invalid credential", "incorrect api key", "no auth credentials"];
const POLICY_HINTS = ["safety", "policy", "content_policy", "flagged", "moderation", "blocked_reason"];
const CONTEXT_HINTS = ["context_length_exceeded", "maximum context length", "context window", "too many tokens"];

function includesAny(haystack: string, needles: readonly string[]): boolean {
  const lower = haystack.toLowerCase();
  return needles.some((needle) => lower.includes(needle));
}

/** Substring matching en ese orden: auth antes que quota antes que policy
 * — un mensaje que mencione "unauthorized" gana sobre cualquier otra
 * coincidencia ambigua. Devuelve `"unknown"` si ninguna coincide (ver nota
 * de cabecera del archivo — ese es el caso PERMANENT sin failover). */
function classify403(message: string | undefined): "quota" | "auth" | "policy" | "unknown" {
  const text = message ?? "";
  if (includesAny(text, AUTH_HINTS)) return "auth";
  if (includesAny(text, QUOTA_HINTS)) return "quota";
  if (includesAny(text, POLICY_HINTS)) return "policy";
  return "unknown";
}

export function classifyProviderError(input: ProviderErrorInput, now: number = Date.now()): ClassifiedError {
  if (input.kind === "timeout") {
    return { category: "RETRY_SAME_KEY", retrySameKey: true, failoverCredential: true, poolAction: "NONE", allowModelFallback: true, retryAfterMs: null, reason: "timeout" };
  }

  if (input.kind === "network") {
    return { category: "RETRY_SAME_KEY", retrySameKey: true, failoverCredential: true, poolAction: "NONE", allowModelFallback: true, retryAfterMs: null, reason: "network_error" };
  }

  if (input.kind === "unknown") {
    return { category: "UNKNOWN", retrySameKey: true, failoverCredential: false, poolAction: "NONE", allowModelFallback: false, retryAfterMs: null, reason: "unknown_first_fail" };
  }

  const { status, message } = input;
  const retryAfterMs = parseRetryAfterMs({ seconds: input.retryAfterSeconds, header: input.retryAfterHeader }, now);

  if (status === 429) {
    const retrySameKey = retryAfterMs !== null && retryAfterMs <= RETRY_SAME_KEY_THRESHOLD_MS;
    return {
      category: retrySameKey ? "RETRY_SAME_KEY" : "FAILOVER_CREDENTIAL",
      retrySameKey,
      failoverCredential: true,
      poolAction: "COOLDOWN",
      allowModelFallback: true,
      retryAfterMs,
      reason: retryAfterMs === null ? "429_no_retry_after" : retrySameKey ? "429_retry_after_short" : "429_retry_after_long",
    };
  }

  if (status === 401) {
    return { category: "FAILOVER_CREDENTIAL", retrySameKey: false, failoverCredential: true, poolAction: "INVALID", allowModelFallback: true, retryAfterMs: null, reason: "401_invalid_credential" };
  }

  if (status === 403) {
    const kind = classify403(message);
    if (kind === "quota") {
      return { category: "FAILOVER_CREDENTIAL", retrySameKey: false, failoverCredential: true, poolAction: "COOLDOWN", allowModelFallback: true, retryAfterMs, reason: "403_quota" };
    }
    if (kind === "auth") {
      return { category: "FAILOVER_CREDENTIAL", retrySameKey: false, failoverCredential: true, poolAction: "INVALID", allowModelFallback: true, retryAfterMs: null, reason: "403_auth" };
    }
    if (kind === "policy") {
      return { category: "PERMANENT", retrySameKey: false, failoverCredential: false, poolAction: "NONE", allowModelFallback: false, retryAfterMs: null, reason: "403_policy" };
    }
    return { category: "PERMANENT", retrySameKey: false, failoverCredential: false, poolAction: "NONE", allowModelFallback: false, retryAfterMs: null, reason: "403_unknown" };
  }

  if (status === 500 || status === 502 || status === 503) {
    return { category: "RETRY_SAME_KEY", retrySameKey: true, failoverCredential: true, poolAction: "NONE", allowModelFallback: true, retryAfterMs, reason: `5xx_status_${status}` };
  }

  if (status === 400) {
    const text = message ?? "";
    if (includesAny(text, CONTEXT_HINTS)) {
      return { category: "PERMANENT", retrySameKey: false, failoverCredential: false, poolAction: "NONE", allowModelFallback: false, retryAfterMs: null, reason: "context_too_large" };
    }
    if (includesAny(text, POLICY_HINTS)) {
      return { category: "PERMANENT", retrySameKey: false, failoverCredential: false, poolAction: "NONE", allowModelFallback: false, retryAfterMs: null, reason: "policy_safety" };
    }
    return { category: "PERMANENT", retrySameKey: false, failoverCredential: false, poolAction: "NONE", allowModelFallback: false, retryAfterMs: null, reason: "400_bad_request" };
  }

  if (status === 404) {
    return { category: "FAILOVER_MODEL", retrySameKey: false, failoverCredential: false, poolAction: "NONE", allowModelFallback: true, retryAfterMs: null, reason: "404_model_missing" };
  }

  // Cualquier código HTTP no cubierto explícitamente por la tabla de 5B
  // (ej. 402, 451, o algo específico de un proveedor que todavía no se
  // integró): tratado igual que "unknown" — conservador, sin tocar el
  // pool, sin failover automático. Decisión abierta, ver informe de cierre.
  return { category: "UNKNOWN", retrySameKey: true, failoverCredential: false, poolAction: "NONE", allowModelFallback: false, retryAfterMs, reason: `unrecognized_status_${status}` };
}
