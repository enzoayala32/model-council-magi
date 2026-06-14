export type OpenRouterMessageContent =
  | string
  | Array<
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string } }
    >;

type OpenRouterMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: OpenRouterMessageContent;
  tool_call_id?: string;
  tool_calls?: OpenRouterToolCall[];
};

export type OpenRouterTool = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
};

export type OpenRouterToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments?: string;
  };
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
  tools?: OpenRouterTool[];
  toolChoice?: "auto" | "none";
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
  tools,
  toolChoice,
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
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = toolChoice ?? "auto";
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
  const toolCalls = payload.choices?.[0]?.message?.tool_calls ?? [];
  if (toolCalls.length) {
    return {
      content,
      toolCalls,
      model: payload.model ?? model,
      finishReason: payload.choices?.[0]?.finish_reason ?? "tool_calls",
      usage: payload.usage,
    };
  }
  if (!content) {
    throw new OpenRouterError("OpenRouter returned an empty response.", response.status);
  }

  return {
    content,
    toolCalls,
    model: payload.model ?? model,
    finishReason: payload.choices?.[0]?.finish_reason ?? "unknown",
    usage: payload.usage,
  };
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
      "X-Title": process.env.OPENROUTER_APP_NAME ?? "Open Model Council",
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
