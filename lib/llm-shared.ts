/**
 * Types and the error class shared between lib/openrouter.ts and
 * lib/nvidia.ts. Lives in its own file (rather than in openrouter.ts) so the
 * two provider clients can reference each other (openrouter.ts calls into
 * nvidia.ts as a fallback) without a circular import between them.
 */

export type OpenRouterMessageContent =
  | string
  | Array<
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string } }
    >;

export type OpenRouterMessage = {
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

export class OpenRouterError extends Error {
  status?: number;
  retryAfterSeconds?: number;

  constructor(message: string, status?: number, retryAfterSeconds?: number) {
    super(message);
    this.name = "OpenRouterError";
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
