import { getCouncilModel } from "./models";

export type ModelPingResult = {
  modelId: string;
  ok: boolean;
  latencyMs: number;
  error?: string;
};

const PING_TIMEOUT_MS = 12000;
const PING_MESSAGE = [{ role: "user" as const, content: "ping" }];

type Endpoint = { url: string; apiKey: string; extraHeaders?: Record<string, string> };

function resolveEndpoint(modelId: string): { endpoint: Endpoint; nativeModelId: string } | { error: string } {
  const model = getCouncilModel(modelId);

  if (model?.provider === "nvidia") {
    const apiKey = process.env.NVIDIA_API_KEY;
    if (!apiKey) return { error: `${model.label} requiere NVIDIA_API_KEY.` };
    return { endpoint: { url: "https://integrate.api.nvidia.com/v1/chat/completions", apiKey }, nativeModelId: modelId };
  }

  if (model?.provider === "google") {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return { error: `${model.label} requiere GEMINI_API_KEY.` };
    return {
      endpoint: { url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", apiKey },
      nativeModelId: modelId,
    };
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return { error: "Falta OPENROUTER_API_KEY en .env." };
  return {
    endpoint: {
      url: "https://openrouter.ai/api/v1/chat/completions",
      apiKey,
      extraHeaders: {
        "HTTP-Referer": process.env.OPENROUTER_SITE_URL ?? "http://localhost:3000",
        "X-Title": process.env.OPENROUTER_APP_NAME ?? "Consenso IA",
      },
    },
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
  const { endpoint, nativeModelId } = resolved;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint.url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${endpoint.apiKey}`,
        "Content-Type": "application/json",
        ...endpoint.extraHeaders,
      },
      body: JSON.stringify({
        model: nativeModelId,
        messages: PING_MESSAGE,
        max_tokens: 4,
        temperature: 0,
      }),
    });
    const latencyMs = Date.now() - started;
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      const detail = payload?.error?.message ?? `HTTP ${response.status}`;
      return { modelId, ok: false, latencyMs, error: detail };
    }
    return { modelId, ok: true, latencyMs };
  } catch (error) {
    const latencyMs = Date.now() - started;
    if (controller.signal.aborted) {
      return { modelId, ok: false, latencyMs, error: `Sin respuesta en ${PING_TIMEOUT_MS / 1000}s.` };
    }
    return { modelId, ok: false, latencyMs, error: error instanceof Error ? error.message : "Error desconocido." };
  } finally {
    clearTimeout(timer);
  }
}

export async function pingModels(modelIds: string[]): Promise<ModelPingResult[]> {
  return Promise.all(modelIds.map((id) => pingModel(id)));
}
