import { OpenRouterError, type OpenRouterMessage, type OpenRouterTool, type OpenRouterToolCall } from "./llm-shared";

/**
 * Direct client for Google AI Studio's Gemini API, called through Google's
 * own official OpenAI-compatibility endpoint:
 *   https://generativelanguage.googleapis.com/v1beta/openai/chat/completions
 * (confirmed at ai.google.dev/gemini-api/docs/openai — this is Google's own
 * documented shim, not a third-party proxy). Same request/response shape as
 * OpenAI's Chat Completions API — messages, tools, tool_choice, and even
 * `reasoning_effort` (mapped internally to Gemini's thinking-budget
 * parameter) all work exactly as they do against OpenRouter, so this file
 * mirrors lib/nvidia.ts closely rather than needing a Gemini-native request
 * shape.
 *
 * Auth: a Gemini API key from Google AI Studio (aistudio.google.com/apikey),
 * sent as a standard `Authorization: Bearer <key>` header — NOT an OpenAI
 * key, and not interchangeable with one.
 *
 * Model IDs — la lista original de este comentario (escrita antes de esta
 * revisión) ya estaba desactualizada y llevó a elegir un modelo muerto
 * (gemini-2.5-flash) para el Coding Agent, que dio 404 real en producción.
 * Re-verificado el 2026-08-27 contra la fuente oficial en sí
 * (ai.google.dev/gemini-api/docs/changelog, no un resumen de terceros):
 *   gemini-3.7-flash        — GA 13/8/2026, el más nuevo, coding/agentic
 *   gemini-3.6-flash        — GA 21/7/2026
 *   gemini-3.5-flash-lite   — GA 21/7/2026, el más barato/rápido vigente
 *   gemini-3.1-pro-preview  — flagship reasoning, 2M ctx (confirmado 0 quota gratis)
 * CONFIRMADOS MUERTOS a esta fecha (no usar, ni como default ni fallback):
 *   gemini-2.0-flash, gemini-2.0-flash-lite — dados de baja el 1/6/2026
 *   gemini-2.5-flash                        — 404 real observado el 2026-08-27
 *   gemini-2.5-flash-lite                   — misma generación que la anterior,
 *                                              marcado muerto por precaución
 *                                              (no probado en vivo todavía)
 * Si un call 404s de nuevo: NO confiar en lo que un chat con Gemini diga
 * sobre su propio catálogo (puede alucinar su propia nomenclatura — pasó
 * una vez ya, sugiriendo gemini-2.0-flash como "vigente" cuando está muerto
 * desde el 1/6/2026) — chequear siempre ai.google.dev/gemini-api/docs/models
 * y el /docs/changelog directamente.
 *
 * Reasoning cannot be fully disabled on Gemini 3.x or 2.5 Pro (only
 * low/medium/high), which is exactly the range our own ReasoningEffort type
 * already covers, so no special-casing is needed here (contrast with
 * lib/nvidia.ts's Nemotron-only reasoning_budget dance).
 */
export type GoogleAiStudioReasoningEffort = "low" | "medium" | "high";

type GoogleChatCompletionOptions = {
  model: string;
  messages: OpenRouterMessage[];
  apiKey: string;
  maxTokens?: number;
  temperature?: number;
  reasoningEffort?: GoogleAiStudioReasoningEffort;
  signal?: AbortSignal;
  tools?: OpenRouterTool[];
  toolChoice?: "auto" | "none";
  timeoutMs?: number;
};

type GoogleChatResponse = {
  choices?: Array<{
    message?: { content?: string | null; tool_calls?: OpenRouterToolCall[] };
    finish_reason?: string;
  }>;
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: { message?: string; code?: string | number };
  message?: string;
  code?: string | number;
};

function extractGoogleErrorMessage(payload: GoogleChatResponse): string | undefined {
  return payload.error?.message ?? payload.message;
}

function addUsage(
  left: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined,
  right: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined,
) {
  if (!left) return right;
  if (!right) return left;
  return {
    prompt_tokens: (left.prompt_tokens ?? 0) + (right.prompt_tokens ?? 0),
    completion_tokens: (left.completion_tokens ?? 0) + (right.completion_tokens ?? 0),
    total_tokens: (left.total_tokens ?? 0) + (right.total_tokens ?? 0),
  };
}

type GoogleAgentCompletionOptions = GoogleChatCompletionOptions & {
  maxSteps?: number;
  executeTool: (toolCall: OpenRouterToolCall, signal?: AbortSignal) => Promise<{ name: string; content: string }>;
  onToolCall?: (toolCall: OpenRouterToolCall, result: { name: string; content: string }) => void;
};

/** Mirrors createAgentCompletion() in lib/openrouter.ts — same tool-call
 * loop, calling Google AI Studio directly instead of OpenRouter. Used for
 * council models whose `provider` is "google". */
export async function createGoogleAgentCompletion({
  maxSteps = 4,
  executeTool,
  onToolCall,
  ...options
}: GoogleAgentCompletionOptions) {
  const messages = [...options.messages];
  let totalUsage: ReturnType<typeof addUsage>;
  let lastContent = "";
  let model = options.model;

  for (let step = 0; step < maxSteps; step += 1) {
    const completion = await createGoogleChatCompletion({ ...options, messages });
    model = completion.model;
    totalUsage = addUsage(totalUsage, completion.usage);
    lastContent = completion.content || lastContent;

    if (!completion.toolCalls?.length) {
      return { ...completion, content: completion.content || lastContent, usage: totalUsage };
    }

    messages.push({ role: "assistant", content: completion.content || "", tool_calls: completion.toolCalls });

    for (const toolCall of completion.toolCalls) {
      const result = await executeTool(toolCall, options.signal);
      onToolCall?.(toolCall, result);
      messages.push({ role: "tool", tool_call_id: toolCall.id, content: result.content.slice(0, 60000) });
    }
  }

  const final = await createGoogleChatCompletion({ ...options, messages, toolChoice: "none" });
  return { ...final, content: final.content || lastContent, model, usage: addUsage(totalUsage, final.usage) };
}

export async function createGoogleChatCompletion({
  model,
  messages,
  apiKey,
  maxTokens = 1600,
  temperature = 0.25,
  reasoningEffort,
  signal,
  tools,
  toolChoice,
  // Same "never hang forever" discipline as lib/openrouter.ts and
  // lib/nvidia.ts — a shared inference API can stall under load.
  timeoutMs = 240000,
}: GoogleChatCompletionOptions) {
  const body: Record<string, unknown> = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
  };
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = toolChoice ?? "auto";
  }
  // Standard OpenAI-style field, honored natively by Google's compatibility
  // layer (maps internally to Gemini's thinking-budget parameter) — no
  // NVIDIA-style vendor-specific hack needed here.
  if (reasoningEffort) {
    body.reasoning_effort = reasoningEffort;
  }

  async function attempt() {
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs);
    if (signal) {
      if (signal.aborted) timeoutController.abort();
      else signal.addEventListener("abort", () => timeoutController.abort(), { once: true });
    }

    let payload: GoogleChatResponse;
    let responseOk: boolean;
    let responseStatus: number;
    let retryAfterHeader: string | null;
    try {
      const response = await fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", {
        method: "POST",
        signal: timeoutController.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
      });
      responseOk = response.ok;
      responseStatus = response.status;
      retryAfterHeader = response.headers.get("retry-after");
      // Keep the timeout armed through the body read, not just until headers
      // arrive — see the equivalent comment in lib/openrouter.ts for why.
      payload = (await response.json().catch(() => ({}))) as GoogleChatResponse;
    } catch (error) {
      if (timeoutController.signal.aborted && !signal?.aborted) {
        throw new OpenRouterError(`Google AI Studio (${model}) timed out after ${Math.round(timeoutMs / 1000)}s.`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }

    if (!responseOk) {
      console.error(`[google-ai-studio] request failed for ${model} (${responseStatus})`, JSON.stringify(payload));
      const message = extractGoogleErrorMessage(payload);
      const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : undefined;
      throw new OpenRouterError(
        message ?? `Google AI Studio request failed with ${responseStatus}`,
        responseStatus,
        Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined,
      );
    }

    const content = payload.choices?.[0]?.message?.content ?? "";
    const toolCalls = payload.choices?.[0]?.message?.tool_calls ?? [];
    const finishReason = payload.choices?.[0]?.finish_reason;

    if (!content && !toolCalls.length) {
      throw new OpenRouterError(`Google AI Studio (${model}) returned an empty response${finishReason ? ` (finish_reason: ${finishReason})` : ""}.`);
    }

    return {
      content,
      toolCalls,
      model: payload.model ?? model,
      finishReason: finishReason ?? (toolCalls.length ? "tool_calls" : "unknown"),
      usage: payload.usage,
    };
  }

  // Google AI Studio's free tier is rate-limited per project (RPM/TPM/RPD,
  // exact numbers change often — see ai.google.dev/gemini-api/docs/rate-limits).
  // Retry a 429 (rate limited) or 503 (provider overloaded — Google's own
  // error text calls this "usually temporary") with backoff instead of
  // failing the model's turn outright, mirroring lib/nvidia.ts and
  // lib/openrouter.ts. One exception: if the 429 body says "limit: 0" for
  // this model, that's not a rate limit to wait out — it means the free
  // tier has zero quota for this specific model (seen live for
  // gemini-3.1-pro-preview, which needs a billing-enabled Google Cloud
  // project) and retrying 3 times would just burn ~40s on a guaranteed
  // failure. Fail fast with a clear reason instead.
  const DEFAULT_RATE_LIMIT_WAIT_MS = 15000;
  const MAX_ATTEMPTS = 3;
  let lastError: unknown;
  for (let retry = 0; retry < MAX_ATTEMPTS; retry += 1) {
    try {
      return await attempt();
    } catch (error) {
      lastError = error;
      const isZeroQuota = error instanceof OpenRouterError && error.status === 429 && /limit["\s:]*0\b/i.test(error.message);
      if (isZeroQuota) {
        throw new OpenRouterError(
          `${model} has no free-tier quota on this Google AI Studio project (limit: 0) — enable billing at ai.google.dev/gemini-api/docs/rate-limits, or use a different Gemini model.`,
          429,
        );
      }
      const isRetryable = error instanceof OpenRouterError && (error.status === 429 || error.status === 503);
      if (!isRetryable || retry === MAX_ATTEMPTS - 1) throw error;
      const waitMs = Math.min(
        typeof (error as OpenRouterError).retryAfterSeconds === "number" ? (error as OpenRouterError).retryAfterSeconds! * 1000 + 500 : DEFAULT_RATE_LIMIT_WAIT_MS,
        30000,
      );
      console.log(`[google-ai-studio] ${model} ${(error as OpenRouterError).status}-retryable — retrying in ${Math.round(waitMs / 1000)}s (attempt ${retry + 2}/${MAX_ATTEMPTS})`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  throw lastError;
}
