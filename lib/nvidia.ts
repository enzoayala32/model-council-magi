import { OpenRouterError, type OpenRouterMessage, type OpenRouterTool, type OpenRouterToolCall } from "./llm-shared";

/**
 * Direct client for NVIDIA NIM (build.nvidia.com) — a fully OpenAI-compatible
 * endpoint (https://integrate.api.nvidia.com/v1/chat/completions). Same
 * request/response shape as OpenAI's Chat Completions API, just a different
 * base URL, API key (starts with "nvapi-"), and model-ID namespace.
 *
 * Why this exists: several of the free Nemotron models we use via OpenRouter
 * (nvidia/nemotron-3.5-lightning:free, etc.) sit behind OpenRouter's SHARED
 * free-tier pool, which is what's been causing the recurring 429s across our
 * test runs. NVIDIA's own developer free tier (build.nvidia.com, sign up for
 * an nvapi- key) is a SEPARATE quota, generally much less contested. This
 * client is used as a last-resort fallback in lib/openrouter.ts: if a model
 * exhausts its OpenRouter retries and we have both an NVIDIA_API_KEY and a
 * known native model-ID mapping, we try NVIDIA directly before giving up.
 *
 * IMPORTANT — model ID mapping: NVIDIA's own catalog IDs are NOT the same
 * string as OpenRouter's. Confirmed from NVIDIA's own docs example:
 *   OpenRouter: nvidia/nemotron-3.5-lightning:free
 *   NVIDIA NIM: nvidia/nemotron-3.5-lightning-30b-a3b
 * (NVIDIA keeps the parameter-count suffix; OpenRouter drops it for
 * readability.) All four entries below are confirmed against NVIDIA's own
 * "Free Endpoint"-filtered catalog at build.nvidia.com/explore/discover
 * (Lightning from NVIDIA's docs example, the other three from the catalog
 * listing itself — their slugs match this map exactly). If NVIDIA ever
 * renames/retires one, a fallback call will fail with 404 — check the
 * catalog for the current slug and update the entry here.
 */
export const NVIDIA_MODEL_MAP: Record<string, string> = {
  "nvidia/nemotron-3.5-lightning:free": "nvidia/nemotron-3.5-lightning-30b-a3b",
  "nvidia/nemotron-3-ultra-550b-a55b:free": "nvidia/nemotron-3-ultra-550b-a55b",
  "nvidia/nemotron-3-super-120b-a12b:free": "nvidia/nemotron-3-super-120b-a12b",
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free": "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
};

export function mapToNvidiaModel(openRouterModelId: string): string | null {
  return NVIDIA_MODEL_MAP[openRouterModelId] ?? null;
}

type NvidiaChatCompletionOptions = {
  model: string;
  messages: OpenRouterMessage[];
  apiKey: string;
  maxTokens?: number;
  temperature?: number;
  reasoningEffort?: "low" | "medium" | "high";
  signal?: AbortSignal;
  tools?: OpenRouterTool[];
  toolChoice?: "auto" | "none";
  timeoutMs?: number;
};

type NvidiaResponse = {
  choices?: Array<{
    message?: { content?: string | null; tool_calls?: OpenRouterToolCall[] };
    finish_reason?: string;
  }>;
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: { message?: string; code?: string | number };
  // NVIDIA's own error responses are inconsistent — some come wrapped as
  // { error: { message } } (matches OpenAI convention), others come flat as
  // { message, type, code } with no `error` key at all. Seen both live from
  // the same endpoint on different models. Accept both shapes.
  message?: string;
  code?: string | number;
};

function extractNvidiaErrorMessage(payload: NvidiaResponse): string | undefined {
  return payload.error?.message ?? payload.message;
}

const REASONING_BUDGET_BY_EFFORT: Record<"low" | "medium" | "high", number> = {
  low: 2048,
  medium: 8192,
  high: 16384,
};

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

type NvidiaAgentCompletionOptions = NvidiaChatCompletionOptions & {
  maxSteps?: number;
  executeTool: (toolCall: OpenRouterToolCall, signal?: AbortSignal) => Promise<{ name: string; content: string }>;
  onToolCall?: (toolCall: OpenRouterToolCall, result: { name: string; content: string }) => void;
};

/** Mirrors createAgentCompletion() in lib/openrouter.ts — same tool-call
 * loop, calling NVIDIA directly instead of OpenRouter. Used for council
 * models whose `provider` is "nvidia" (native-only models like Llama 3.3
 * or DeepSeek R1 that aren't going through OpenRouter's fallback path). */
export async function createNvidiaAgentCompletion({
  maxSteps = 4,
  executeTool,
  onToolCall,
  ...options
}: NvidiaAgentCompletionOptions) {
  const messages = [...options.messages];
  let totalUsage: ReturnType<typeof addUsage>;
  let lastContent = "";
  let model = options.model;

  for (let step = 0; step < maxSteps; step += 1) {
    const completion = await createNvidiaChatCompletion({ ...options, messages });
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

  const final = await createNvidiaChatCompletion({ ...options, messages, toolChoice: "none" });
  return { ...final, content: final.content || lastContent, model, usage: addUsage(totalUsage, final.usage) };
}

export async function createNvidiaChatCompletion({
  model,
  messages,
  apiKey,
  maxTokens = 1600,
  temperature = 0.25,
  reasoningEffort,
  signal,
  tools,
  toolChoice,
  // NVIDIA's own free developer tier is a separate, generally-roomier quota
  // than OpenRouter's shared free pool — but this is still a network call to
  // a shared inference service, so keep the same "never hang forever"
  // discipline as the OpenRouter client.
  timeoutMs = 240000,
}: NvidiaChatCompletionOptions) {
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
  // `chat_template_kwargs.enable_thinking` + `reasoning_budget` are a
  // NEMOTRON-SPECIFIC NIM feature (see build.nvidia.com's own code sample
  // for Lightning) — NOT a general NVIDIA NIM parameter. Sending it to a
  // non-Nemotron model breaks: Llama 3.3 70B returned a 500 ("reasoning_config
  // is not configured"), GLM-5.2 returned a 400 ("Unsupported parameter(s):
  // reasoning_budget") — both live failures from the same root cause. Only
  // attach it for Nemotron models; everyone else just gets `reasoningEffort`
  // silently ignored (matches how OpenRouter treats models with no reasoning
  // support).
  const isNemotron = model.toLowerCase().includes("nemotron");
  if (reasoningEffort && isNemotron) {
    body.chat_template_kwargs = { enable_thinking: true };
    body.reasoning_budget = REASONING_BUDGET_BY_EFFORT[reasoningEffort];
  }

  async function attempt() {
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs);
    if (signal) {
      if (signal.aborted) timeoutController.abort();
      else signal.addEventListener("abort", () => timeoutController.abort(), { once: true });
    }

    let payload: NvidiaResponse;
    let responseOk: boolean;
    let responseStatus: number;
    let retryAfterHeader: string | null;
    try {
      const response = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
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
      // arrive — an earlier version of the OpenRouter client had this exact
      // bug and it caused multi-minute silent hangs. See lib/openrouter.ts.
      payload = (await response.json().catch(() => ({}))) as NvidiaResponse;
    } catch (error) {
      if (timeoutController.signal.aborted && !signal?.aborted) {
        throw new OpenRouterError(`NVIDIA NIM (${model}) timed out after ${Math.round(timeoutMs / 1000)}s.`);
      }
      console.error(`[nvidia] network error calling ${model}:`, error instanceof Error ? error.message : error);
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }

    if (!responseOk) {
      console.error(`[nvidia] request failed for ${model} (${responseStatus})`, JSON.stringify(payload));
      const message = extractNvidiaErrorMessage(payload);
      // Standard REST convention — NVIDIA's own rate-limit docs (40 req/min
      // on the free tier) suggest 429s are likely, though the exact error
      // body shape isn't publicly documented, so we lean on the HTTP header
      // rather than parsing a specific JSON field like OpenRouter's client does.
      const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : undefined;
      throw new OpenRouterError(
        message ?? `NVIDIA NIM request failed with ${responseStatus}`,
        responseStatus,
        Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined,
      );
    }

    const content = payload.choices?.[0]?.message?.content ?? "";
    const toolCalls = payload.choices?.[0]?.message?.tool_calls ?? [];
    const finishReason = payload.choices?.[0]?.finish_reason;

    if (!content && !toolCalls.length) {
      throw new OpenRouterError(`NVIDIA NIM (${model}) returned an empty response${finishReason ? ` (finish_reason: ${finishReason})` : ""}.`);
    }

    return {
      content,
      toolCalls,
      model: payload.model ?? model,
      finishReason: finishReason ?? (toolCalls.length ? "tool_calls" : "unknown"),
      usage: payload.usage,
    };
  }

  // Defense-in-depth: if a model we didn't correctly classify as "not
  // Nemotron" still rejects the reasoning params (this is exactly how the
  // Llama 3.3 / GLM-5.2 failures showed up live — a 400 or 500 whose message
  // mentions the parameter name), strip them and retry once before falling
  // into the normal rate-limit retry loop below.
  if (body.reasoning_budget !== undefined || body.chat_template_kwargs !== undefined) {
    try {
      return await attempt();
    } catch (error) {
      const message = error instanceof OpenRouterError ? error.message : "";
      if (/reasoning_budget|thinking_token_budget|chat_template_kwargs/i.test(message)) {
        console.log(`[nvidia] ${model} rejected reasoning params (unexpected — check the isNemotron check in this file) — retrying once without them`);
        delete body.reasoning_budget;
        delete body.chat_template_kwargs;
      } else {
        throw error;
      }
    }
  }

  // NVIDIA's free tier is rate-limited (documented: 40 req/min per model) —
  // a burst of council calls can trip this. Retry a 429 with backoff instead
  // of failing the model's turn outright, mirroring lib/openrouter.ts. Also
  // retry raw network failures (fetch throwing, not an HTTP error) — seen
  // live hitting both OpenRouter and this NVIDIA fallback in the same
  // instant, pointing to a transient local network hiccup rather than the
  // provider being down.
  const DEFAULT_RATE_LIMIT_WAIT_MS = 15000;
  const NETWORK_ERROR_WAIT_MS = 4000;
  const MAX_ATTEMPTS = 3;
  let lastError: unknown;
  for (let retry = 0; retry < MAX_ATTEMPTS; retry += 1) {
    try {
      return await attempt();
    } catch (error) {
      lastError = error;
      const isRateLimit = error instanceof OpenRouterError && error.status === 429;
      const isNetworkError = !(error instanceof OpenRouterError) && error instanceof Error;
      if ((!isRateLimit && !isNetworkError) || retry === MAX_ATTEMPTS - 1) throw error;
      const waitMs = isRateLimit
        ? Math.min(
            typeof (error as OpenRouterError).retryAfterSeconds === "number" ? (error as OpenRouterError).retryAfterSeconds! * 1000 + 500 : DEFAULT_RATE_LIMIT_WAIT_MS,
            30000,
          )
        : NETWORK_ERROR_WAIT_MS;
      const reason = isRateLimit ? "rate-limited (429)" : "hit a network error";
      console.log(`[nvidia] ${model} ${reason} — retrying in ${Math.round(waitMs / 1000)}s (attempt ${retry + 2}/${MAX_ATTEMPTS})`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  throw lastError;
}
