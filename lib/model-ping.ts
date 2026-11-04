import { openRouterHeaders } from "./http-headers";
import { getCouncilModel } from "./models";
import { getProviderPool } from "@/lib/provider-resilience/registry";
import type { ProviderName } from "@/lib/provider-resilience/config";

export type ModelPingResult = {
  modelId: string;
  ok: boolean;
  latencyMs: number;
  error?: string;
};

const PING_TIMEOUT_MS = 12000;
const PING_MESSAGE = [{ role: "user" as const, content: "ping" }];

type ResolvedEndpoint = { url: string; provider: ProviderName; extraHeaders?: Record<string, string>; nativeModelId: string };

/**
 * Resuelve URL y provider SIN elegir key: la key la da el pool (ver
 * `pingModel`). Antes elegía `process.env.NVIDIA_API_KEY` directamente,
 * así que un ping contra la primera key rate-limitada reportaba el modelo
 * como caído cuando el modelo estaba perfectamente disponible — y el
 * panel de "salud de modelos" mentía.
 */
function resolveEndpoint(modelId: string): ResolvedEndpoint | { error: string } {
  const model = getCouncilModel(modelId);

  if (model?.provider === "nvidia") {
    return {
      url: "https://integrate.api.nvidia.com/v1/chat/completions",
      provider: "nvidia",
      nativeModelId: modelId,
    };
  }

  if (model?.provider === "google") {
    return {
      url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      provider: "google",
      nativeModelId: modelId,
    };
  }

  return {
    url: "https://openrouter.ai/api/v1/chat/completions",
    provider: "openrouter",
    extraHeaders: openRouterHeaders(),
    nativeModelId: modelId,
  };
}

/**
 * Ping deliberadamente liviano: un solo intento, timeout corto (12s) y
 * `max_tokens` mínimo — solo confirma que el modelo responde antes de
 * lanzar una corrida completa. A propósito NO reutiliza los reintentos ni
 * el backoff de `createChatCompletion` (pensados para maximizar la
 * probabilidad de una buena respuesta, no para chequear salud rápido):
 * un modelo caído debe fallar rápido aquí, no después de un minuto de
 * reintentos.
 */
export async function pingModel(modelId: string): Promise<ModelPingResult> {
  const started = Date.now();
  const resolved = resolveEndpoint(modelId);
  if ("error" in resolved) {
    return { modelId, ok: false, latencyMs: 0, error: resolved.error };
  }
  const { url, provider, extraHeaders, nativeModelId } = resolved;

  // Rotación por pool, SIN retry-mismo-key (a diferencia de
  // createChatCompletion, que reintenta 429/503 con la misma key): el ping
  // es una consulta de salud, y que una key rate-limitada no ensucie el
  // veredicto del modelo es justamente el punto. Un intento por
  // credential disponible, y si todas fallan se reporta el último error.
  const pool = getProviderPool(provider);
  const cursor = pool.beginOperation();
  let lastError = "";

  while (true) {
    const acquired = cursor.next();
    if (acquired.status !== "AVAILABLE") {
      break;
    }
    const { id: credentialId, value: apiKey, healthGeneration } = acquired.lease;
    const outcome = await pingOnce(url, apiKey, nativeModelId, extraHeaders);
    if (outcome.ok) {
      pool.release(credentialId, "success", Date.now(), undefined, healthGeneration);
      return { modelId, ok: true, latencyMs: Date.now() - started };
    }
    lastError = outcome.error;
    // La degradación la decide el pool: `"cooldown"` para errores de cuota
    // o servidor, `"invalid"` para un 401/403 (donde seguir probando la
    // misma key no tiene sentido). El classify vive adentro de
    // `classifyProviderError`, no acá.
    const degraded = isAuthPingError(outcome.error) ? "invalid" : "cooldown";
    pool.release(credentialId, degraded, Date.now(), undefined, healthGeneration);
    if (!isRetryablePingError(outcome.error)) {
      break;
    }
  }

  return { modelId, ok: false, latencyMs: Date.now() - started, error: lastError || "No hay credenciales disponibles para este proveedor." };
}

/** Estados de `release` que el pool acepta para degradar una credential. */
type PingOutcome = { ok: true } | { ok: false; error: string };

function isRetryablePingError(message: string): boolean {
  return /429|rate.?limit|503|timeout|timed out|tardy|overloaded|fetch failed|ECONNRESET/i.test(message);
}

/**
 * 401/403 = la key no sirve: se marca inválida y se deja de insistir.
 * Exportado para poder fijar la clasificación en
 * `lib/test-nvidia-rotation.ts` sin necesidad de red.
 */
export function isAuthPingError(message: string): boolean {
  return /(?:^|[^0-9])(?:401|403)(?:[^0-9]|$)|invalid api key|unauthorized/i.test(message);
}

/** Un solo intento, con el timeout deliberadamente corto del ping. */
async function pingOnce(
  url: string,
  apiKey: string,
  nativeModelId: string,
  extraHeaders?: Record<string, string>,
): Promise<PingOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...extraHeaders,
      },
      body: JSON.stringify({
        model: nativeModelId,
        messages: PING_MESSAGE,
        max_tokens: 4,
        temperature: 0,
      }),
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
      return { ok: false, error: payload?.error?.message ?? `HTTP ${response.status}` };
    }
    return { ok: true };
  } catch (error) {
    if (controller.signal.aborted) {
      return { ok: false, error: `Sin respuesta en ${PING_TIMEOUT_MS / 1000}s.` };
    }
    return { ok: false, error: error instanceof Error ? error.message : "Error desconocido." };
  } finally {
    clearTimeout(timer);
  }
}

export async function pingModels(modelIds: string[]): Promise<ModelPingResult[]> {
  return Promise.all(modelIds.map((id) => pingModel(id)));
}
