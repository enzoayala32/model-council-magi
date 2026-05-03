export type OpenRouterMessageContent =
  | string
  | Array<
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string } }
    >;

type OpenRouterMessage = {
  role: "system" | "user" | "assistant";
  content: OpenRouterMessageContent;
};

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
};

type OpenRouterChoice = {
  message?: {
    content?: string | Array<{ type?: string; text?: string }>;
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
  };
};

export class OpenRouterError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "OpenRouterError";
    this.status = status;
  }
}

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
}: ChatCompletionOptions) {
  const body: Record<string, unknown> = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
    reasoning: {
      effort: reasoningEffort,
    },
  };
  if (web) {
    body.plugins = [{ id: "web", max_results: webMaxResults }];
  }
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    signal,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.OPENROUTER_SITE_URL ?? "http://localhost:3000",
      "X-Title": process.env.OPENROUTER_APP_NAME ?? "Open Model Council",
    },
    body: JSON.stringify(body),
  });

  const payload = (await response.json().catch(() => ({}))) as OpenRouterResponse;
  if (!response.ok) {
    throw new OpenRouterError(
      payload.error?.message ?? `OpenRouter request failed with ${response.status}`,
      response.status,
    );
  }

  const content = normalizeContent(payload.choices?.[0]?.message?.content);
  if (!content) {
    throw new OpenRouterError("OpenRouter returned an empty response.", response.status);
  }

  return {
    content,
    model: payload.model ?? model,
    finishReason: payload.choices?.[0]?.finish_reason ?? "unknown",
    usage: payload.usage,
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
