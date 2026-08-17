import { createNvidiaChatCompletion, mapToNvidiaModel } from "./nvidia";
import {
  OpenRouterError,
  type OpenRouterMessage,
  type OpenRouterMessageContent,
  type OpenRouterTool,
  type OpenRouterToolCall,
} from "./llm-shared";

export { OpenRouterError };
export type { OpenRouterMessage, OpenRouterMessageContent, OpenRouterTool, OpenRouterToolCall };

type ChatCompletionOptions = {
  model: string;
  messages: OpenRouterMessage[];
  apiKey: string;
  maxTokens?: number;
  temperature?: number;
  reasoningEffort?: "low" | "medium" | "high";
  signal?: AbortSignal;
  web?: boolean;
  webMaxResults?: number;
  tools?: OpenRouterTool[];
  toolChoice?: "auto" | "none";
  /** Milliseconds before this specific call is aborted. Defaults to 55s so a
   * single slow/overloaded free-tier model can't stall an entire council
   * round — the request fails fast and the other models still complete. */
  timeoutMs?: number;
};

type AgentCompletionOptions = ChatCompletionOptions & {
  maxSteps?: number;
  executeTool: (toolCall: OpenRouterToolCall, signal?: AbortSignal) => Promise<{ name: string; content: string }>;
  onToolCall?: (toolCall: OpenRouterToolCall, result: { name: string; content: string }) => void;
};

type ImageGenerationOptions = {
  model: string;
  prompt: string;
  apiKey: string;
  signal?: AbortSignal;
};

type OpenRouterChoice = {
  message?: {
    content?: string | Array<{ type?: string; text?: string }>;
    tool_calls?: OpenRouterToolCall[];
    images?: Array<{ type?: string; image_url?: { url?: string }; imageUrl?: { url?: string } }>;
  };
  finish_reason?: string;
};

type OpenRouterResponse = {
  choices?: OpenRouterChoice[];
  model?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: {
    message?: string;
    code?: string | number;
    metadata?: { provider_name?: string; raw?: unknown; retry_after_seconds?: number };
  };
};

export async function createChatCompletion({
  model,
  messages,
  apiKey,
  maxTokens = 1600,
  temperature = 0.25,
  reasoningEffort = "medium",
  signal,
  web = false,
  webMaxResults = 5,
  tools,
  toolChoice,
  // "El tiempo no es problema": the priority is correctness/quality over
  // speed. Real-world logs showed successful free-tier calls taking up to
  // ~7 minutes (e.g. a 411s debate response) even before this timeout was
  // actually enforced (see bug note below) — so this is generous. It exists
  // only to guarantee a call NEVER hangs forever, not to rush slow models.
  timeoutMs = 420000,
}: ChatCompletionOptions) {
  async function attempt(attemptMaxTokens: number, attemptEffort: typeof reasoningEffort) {
    const body: Record<string, unknown> = {
      model,
      messages,
      temperature,
      max_tokens: attemptMaxTokens,
      reasoning: {
        effort: attemptEffort,
      },
    };
    if (web) {
      body.plugins = [{ id: "web", max_results: webMaxResults }];
    }
    if (tools?.length) {
      body.tools = tools;
      body.tool_choice = toolChoice ?? "auto";
    }

    // Combine the caller's abort signal (e.g. the client disconnecting) with
    // a local timeout, so one slow/overloaded free model can't hold up an
    // entire council round. Without this, Promise.all() across models waits
    // forever.
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => {
      timeoutController.abort();
    }, timeoutMs);
    if (signal) {
      if (signal.aborted) timeoutController.abort();
      else signal.addEventListener("abort", () => timeoutController.abort(), { once: true });
    }

    let payload: OpenRouterResponse;
    let responseOk: boolean;
    let responseStatus: number;
    try {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        signal: timeoutController.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": process.env.OPENROUTER_SITE_URL ?? "http://localhost:3000",
          "X-Title": process.env.OPENROUTER_APP_NAME ?? "Consenso IA",
        },
        body: JSON.stringify(body),
      });
      responseOk = response.ok;
      responseStatus = response.status;
      // Reading the body happens INSIDE this try, still guarded by the same
      // AbortSignal — fetch() resolving only means headers arrived, the body
      // can still stall. Clearing the timeout before this line (as an
      // earlier version of this function did) left the body-read completely
      // unprotected and was the actual cause of multi-minute hangs.
      payload = (await response.json().catch(() => ({}))) as OpenRouterResponse;
    } catch (error) {
      if (timeoutController.signal.aborted && !signal?.aborted) {
        throw new OpenRouterError(
          `${model} timed out after ${Math.round(timeoutMs / 1000)}s (free-tier models can be overloaded — try again or pick a lighter model).`,
        );
      }
      // A raw network failure (DNS blip, connection reset, "fetch failed")
      // throws here as a plain TypeError, not an OpenRouterError — it was
      // previously silent (no log) and got ZERO retries, unlike a 429. Seen
      // live: both OpenRouter and the NVIDIA fallback hit this in the same
      // ~1s window on one run, which points to a local network hiccup at
      // that instant rather than both providers being down simultaneously.
      console.error(`[openrouter] network error calling ${model}:`, error instanceof Error ? error.message : error);
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }

    if (!responseOk) {
      // OpenRouter's own error messages are often vague ("Provider returned
      // error"). Log the full raw payload server-side so a failure is
      // actually debuggable, and surface whatever extra context exists
      // (provider name, upstream error code) in the thrown message too.
      console.error(`[openrouter] request failed for ${model} (${responseStatus})`, JSON.stringify(payload));
      const provider = payload.error?.metadata?.provider_name;
      const detail = [
        payload.error?.message ?? `OpenRouter request failed with ${responseStatus}`,
        provider ? `provider: ${provider}` : null,
        payload.error?.code ? `code: ${payload.error.code}` : null,
      ].filter(Boolean).join(" — ");
      throw new OpenRouterError(detail, responseStatus, payload.error?.metadata?.retry_after_seconds);
    }

    const content = normalizeContent(payload.choices?.[0]?.message?.content);
    const toolCalls = payload.choices?.[0]?.message?.tool_calls ?? [];
    const finishReason = payload.choices?.[0]?.finish_reason;
    return { content, toolCalls, model: payload.model ?? model, finishReason, usage: payload.usage };
  }

  // Free-tier shared pools rate-limit individual popular models (HTTP 429)
  // rather than failing the whole account. When OpenRouter tells us exactly
  // how long to wait (retry_after_seconds), use that; some providers omit it
  // (seen with Poolside/Laguna) — in that case still retry with a sane
  // default wait, since 429 itself is inherently transient/recoverable.
  // Also retry on raw network failures (fetch throwing, not an HTTP error) —
  // these are often even more transient than a 429 (a DNS blip, a dropped
  // connection) but previously got zero retries at all.
  // Kept modest on purpose: this function can be called TWICE in a row (see
  // the empty-content retry below), and each attempt is itself bounded by
  // the per-call timeout — stacking too many retries here compounds into
  // multi-minute worst cases. A live run hit 14+ minutes on a single
  // saturated model before this was tightened.
  const DEFAULT_RATE_LIMIT_WAIT_MS = 15000;
  const NETWORK_ERROR_WAIT_MS = 4000;
  async function attemptWithRateLimitRetry(attemptMaxTokens: number, attemptEffort: typeof reasoningEffort, maxAttempts: number) {
    let lastError: unknown;
    for (let retry = 0; retry < maxAttempts; retry += 1) {
      try {
        return await attempt(attemptMaxTokens, attemptEffort);
      } catch (error) {
        lastError = error;
        const isRateLimit = error instanceof OpenRouterError && error.status === 429;
        const isNetworkError = !(error instanceof OpenRouterError) && error instanceof Error;
        if ((!isRateLimit && !isNetworkError) || retry === maxAttempts - 1) throw error;
        const retrySeconds = isRateLimit ? (error as OpenRouterError).retryAfterSeconds : undefined;
        const waitMs = isRateLimit
          ? Math.min(typeof retrySeconds === "number" ? retrySeconds * 1000 + 500 : DEFAULT_RATE_LIMIT_WAIT_MS, 30000)
          : NETWORK_ERROR_WAIT_MS;
        const reason = isRateLimit ? "rate-limited (429)" : "hit a network error";
        console.log(`[openrouter] ${model} ${reason} — retrying in ${Math.round(waitMs / 1000)}s (attempt ${retry + 2}/${maxAttempts})`);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }
    throw lastError;
  }

  try {
    const first = await attemptWithRateLimitRetry(maxTokens, reasoningEffort, 3);
    if (first.toolCalls.length) {
      return { ...first, finishReason: first.finishReason ?? "tool_calls" };
    }
    if (first.content) {
      return { ...first, finishReason: first.finishReason ?? "unknown" };
    }

    // Empty content can come from two different causes, so handle both:
    // 1. A reasoning model burning its whole token budget on internal
    //    reasoning (finish_reason: length) — give it more headroom and a
    //    lighter reasoning effort.
    // 2. A transient provider hiccup returning 200 + empty content with some
    //    other finish_reason (seen live: gpt-oss-20b came back empty in ~6s,
    //    far too fast to be a real generation, right after being rate-limited
    //    on the same run) — just retry once with identical params after a
    //    short pause.
    // Only 2 attempts here (not another full round of 3) — this is already
    // the SECOND pass through rate-limit retries, so keep it cheap.
    const boosted = first.finishReason === "length";
    if (!boosted) {
      console.log(`[openrouter] ${model} returned empty content (finish_reason: ${first.finishReason ?? "unknown"}) — retrying once after a short pause`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    const retried = await attemptWithRateLimitRetry(
      boosted ? Math.round(maxTokens * 1.6) : maxTokens,
      boosted ? (reasoningEffort === "high" ? "medium" : "low") : reasoningEffort,
      2,
    );
    if (retried.content || retried.toolCalls.length) {
      return { ...retried, finishReason: retried.finishReason ?? "unknown" };
    }

    throw new OpenRouterError(
      `${model} returned an empty response${first.finishReason ? ` (finish_reason: ${first.finishReason})` : ""}.`,
    );
  } catch (openRouterError) {
    // Last resort: OpenRouter exhausted its retries (429s, empty content,
    // or a hard failure) for this model. If it's a known Nemotron model AND
    // the deployment has its own NVIDIA developer key configured, try
    // NVIDIA's own API directly — a separate quota from OpenRouter's shared
    // free pool, so it's often still available even when OpenRouter isn't.
    const nvidiaApiKey = process.env.NVIDIA_API_KEY;
    const nvidiaModelId = nvidiaApiKey ? mapToNvidiaModel(model) : null;
    if (!nvidiaApiKey || !nvidiaModelId) {
      throw openRouterError;
    }
    console.log(`[openrouter] ${model} exhausted OpenRouter — falling back to NVIDIA NIM direct (${nvidiaModelId})`);
    try {
      const nvidiaResult = await createNvidiaChatCompletion({
        model: nvidiaModelId,
        messages,
        apiKey: nvidiaApiKey,
        maxTokens,
        temperature,
        reasoningEffort,
        signal,
        tools,
        toolChoice,
      });
      console.log(`[openrouter] NVIDIA NIM direct fallback succeeded for ${nvidiaModelId}`);
      return nvidiaResult;
    } catch (nvidiaError) {
      console.error(`[openrouter] NVIDIA NIM direct fallback also failed for ${nvidiaModelId}:`, nvidiaError instanceof Error ? nvidiaError.message : nvidiaError);
      // Surface the ORIGINAL OpenRouter error — it's the one tied to the
      // model the caller actually asked for, and callers already know how
      // to handle OpenRouterError instances.
      throw openRouterError;
    }
  }
}

export async function createAgentCompletion({
  maxSteps = 4,
  executeTool,
  onToolCall,
  ...options
}: AgentCompletionOptions) {
  const messages = [...options.messages];
  let totalUsage: OpenRouterResponse["usage"] | undefined;
  let lastContent = "";
  let model = options.model;

  for (let step = 0; step < maxSteps; step += 1) {
    const completion = await createChatCompletion({ ...options, messages });
    model = completion.model;
    totalUsage = addUsage(totalUsage, completion.usage);
    lastContent = completion.content || lastContent;

    if (!completion.toolCalls?.length) {
      return { ...completion, content: completion.content || lastContent, usage: totalUsage };
    }

    messages.push({
      role: "assistant",
      content: completion.content || "",
      tool_calls: completion.toolCalls,
    });

    for (const toolCall of completion.toolCalls) {
      const result = await executeTool(toolCall, options.signal);
      onToolCall?.(toolCall, result);
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: result.content.slice(0, 60000),
      });
    }
  }

  const final = await createChatCompletion({ ...options, messages, toolChoice: "none" });
  return {
    ...final,
    content: final.content || lastContent,
    model,
    usage: addUsage(totalUsage, final.usage),
  };
}

export async function createImageGeneration({
  model,
  prompt,
  apiKey,
  signal,
}: ImageGenerationOptions) {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    signal,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.OPENROUTER_SITE_URL ?? "http://localhost:3000",
      "X-Title": process.env.OPENROUTER_APP_NAME ?? "Consenso IA",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      modalities: ["image", "text"],
      stream: false,
    }),
  });

  const payload = (await response.json().catch(() => ({}))) as OpenRouterResponse;
  if (!response.ok) {
    throw new OpenRouterError(
      payload.error?.message ?? `OpenRouter image request failed with ${response.status}`,
      response.status,
    );
  }

  const message = payload.choices?.[0]?.message;
  const images = (message?.images ?? [])
    .map((image) => image.image_url?.url ?? image.imageUrl?.url)
    .filter((url): url is string => Boolean(url));
  if (!images.length) {
    throw new OpenRouterError("OpenRouter returned no generated image.", response.status);
  }

  return {
    model: payload.model ?? model,
    content: normalizeContent(message?.content),
    images,
    usage: payload.usage,
  };
}

function addUsage(left: OpenRouterResponse["usage"], right: OpenRouterResponse["usage"]) {
  if (!left) return right;
  if (!right) return left;
  return {
    prompt_tokens: (left.prompt_tokens ?? 0) + (right.prompt_tokens ?? 0),
    completion_tokens: (left.completion_tokens ?? 0) + (right.completion_tokens ?? 0),
    total_tokens: (left.total_tokens ?? 0) + (right.total_tokens ?? 0),
  };
}

function normalizeContent(content: OpenRouterChoice["message"] extends infer Message
  ? Message extends { content?: infer Content }
    ? Content | undefined
    : never
  : never) {
  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => (part.type === "text" || "text" in part ? part.text ?? "" : ""))
      .join("")
      .trim();
  }

  return "";
}
