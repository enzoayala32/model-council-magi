/**
 * Fase 8A — Medición local de contexto.
 *
 * IMPORTANTE: esto NO son tokens exactos. Es una estimación determinista
 * por caracteres (`ceil(chars / 4)`), útil para comparar pasos y detectar
 * crecimiento, pero el único consumo REAL es el `usage` que informa el
 * proveedor (cuando lo informa). El evento `context_usage` mantiene ambas
 * fuentes separadas y etiquetadas para no confundirlas.
 *
 * Nunca se persiste contenido: este módulo devuelve longitudes, conteos y
 * metadatos de rol/tool. El texto de mensajes, código, prompts y resultados
 * de tools se mide y se descarta.
 */
import type { ToolSet } from "ai";

export const CHARS_PER_TOKEN_ESTIMATE = 4;
export const ESTIMATE_METHOD = "ceil(chars/4)" as const;
/** Equivalente conservador para contenido no textual (imágenes/archivos
 * adjuntos). El agente de código no los usa hoy; se documenta para que el
 * número no se lea como "0 tokens reales". */
export const MEDIA_CHAR_EQUIVALENT = 4_000;

export type ContextEstimateChars = { system: number; messages: number; tools: number; total: number };
export type ContextEstimateTokens = { system: number; messages: number; tools: number; total: number };

export type MessageMeasure = {
  index: number;
  role: string;
  chars: number;
  toolNames: string[];
};

export type ContextEstimate = {
  chars: ContextEstimateChars;
  estimatedTokens: ContextEstimateTokens;
  method: typeof ESTIMATE_METHOD;
  messageCount: number;
  toolCallCount: number;
  toolResultCount: number;
  /** Los mensajes más grandes (sin contenido), para diagnóstico de budget. */
  largestMessages: MessageMeasure[];
};

export function estimateTokensFromChars(chars: number): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  return Math.ceil(chars / CHARS_PER_TOKEN_ESTIMATE);
}

function safeJsonChars(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value === "string") return value.length;
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? serialized.length : 0;
  } catch {
    // Ciclos o valores no serializables: no inventamos un tamaño enorme.
    try {
      return String(value).length;
    } catch {
      return 0;
    }
  }
}

type ContentPart = {
  type?: unknown;
  text?: unknown;
  toolName?: unknown;
  input?: unknown;
  output?: unknown;
};

function partChars(part: unknown): { chars: number; toolName?: string; isToolCall: boolean; isToolResult: boolean } {
  if (part === null || typeof part !== "object") return { chars: 0, isToolCall: false, isToolResult: false };
  const typed = part as ContentPart;
  const type = typeof typed.type === "string" ? typed.type : "";
  if (type === "text" || type === "reasoning") {
    return { chars: typeof typed.text === "string" ? typed.text.length : 0, isToolCall: false, isToolResult: false };
  }
  if (type === "tool-call") {
    const toolName = typeof typed.toolName === "string" ? typed.toolName : "?";
    return { chars: toolName.length + safeJsonChars(typed.input) + 32, toolName, isToolCall: true, isToolResult: false };
  }
  if (type === "tool-result") {
    const toolName = typeof typed.toolName === "string" ? typed.toolName : "?";
    return { chars: toolName.length + safeJsonChars(typed.output) + 32, toolName, isToolCall: false, isToolResult: true };
  }
  if (type === "file" || type === "image") {
    return { chars: MEDIA_CHAR_EQUIVALENT, isToolCall: false, isToolResult: false };
  }
  // Tipo desconocido: medimos una representación serializada, nunca el
  // contenido crudo, y solo como último recurso.
  return { chars: safeJsonChars(part), isToolCall: false, isToolResult: false };
}

export function measureMessage(message: unknown, index = 0): MessageMeasure & { toolCallCount: number; toolResultCount: number } {
  if (message === null || typeof message !== "object") {
    return { index, role: "unknown", chars: 0, toolNames: [], toolCallCount: 0, toolResultCount: 0 };
  }
  const typed = message as { role?: unknown; content?: unknown };
  const role = typeof typed.role === "string" ? typed.role : "unknown";
  const content = typed.content;
  let chars = role.length;
  let toolCallCount = 0;
  let toolResultCount = 0;
  const toolNames: string[] = [];
  if (typeof content === "string") {
    chars += content.length;
  } else if (Array.isArray(content)) {
    for (const part of content) {
      const measured = partChars(part);
      chars += measured.chars;
      if (measured.isToolCall) toolCallCount += 1;
      if (measured.isToolResult) toolResultCount += 1;
      if (measured.toolName && !toolNames.includes(measured.toolName)) toolNames.push(measured.toolName);
    }
  } else if (content !== undefined && content !== null) {
    chars += safeJsonChars(content);
  }
  return { index, role, chars, toolNames, toolCallCount, toolResultCount };
}

export function measureMessages(messages: readonly unknown[]): {
  chars: number;
  messageCount: number;
  toolCallCount: number;
  toolResultCount: number;
  messages: MessageMeasure[];
} {
  let chars = 0;
  let toolCallCount = 0;
  let toolResultCount = 0;
  const measured: MessageMeasure[] = [];
  messages.forEach((message, index) => {
    const result = measureMessage(message, index);
    chars += result.chars;
    toolCallCount += result.toolCallCount;
    toolResultCount += result.toolResultCount;
    measured.push({ index: result.index, role: result.role, chars: result.chars, toolNames: result.toolNames });
  });
  return { chars, messageCount: messages.length, toolCallCount, toolResultCount, messages: measured };
}

/** Mide el esquema de tools sin ejecutarlas. No garantiza el mismo
 * tokenizador que el proveedor; es una cota local consistente. */
export function measureTools(tools: ToolSet | undefined): number {
  if (!tools) return 0;
  let chars = 0;
  for (const [name, value] of Object.entries(tools)) {
    chars += name.length;
    const tool = value as { description?: unknown; inputSchema?: unknown; parameters?: unknown };
    if (typeof tool.description === "string") chars += tool.description.length;
    const schema = tool.inputSchema ?? tool.parameters;
    chars += safeJsonChars(schema);
    chars += 64; // sobrecosto fijo de serialización del tool
  }
  return chars;
}

export type MeasureContextInput = {
  system: string;
  messages: readonly unknown[];
  tools?: ToolSet;
  /** Cuántos mensajes grandes reportar (default 5). */
  largestMessages?: number;
};

export function measureContext(input: MeasureContextInput): ContextEstimate {
  const systemChars = typeof input.system === "string" ? input.system.length : 0;
  const messages = measureMessages(input.messages);
  const toolsChars = measureTools(input.tools);
  const total = systemChars + messages.chars + toolsChars;
  const largest = [...messages.messages]
    .sort((a, b) => b.chars - a.chars || a.index - b.index)
    .slice(0, Math.max(0, input.largestMessages ?? 5));
  return {
    chars: { system: systemChars, messages: messages.chars, tools: toolsChars, total },
    estimatedTokens: {
      system: estimateTokensFromChars(systemChars),
      messages: estimateTokensFromChars(messages.chars),
      tools: estimateTokensFromChars(toolsChars),
      total: estimateTokensFromChars(total),
    },
    method: ESTIMATE_METHOD,
    messageCount: messages.messageCount,
    toolCallCount: messages.toolCallCount,
    toolResultCount: messages.toolResultCount,
    largestMessages: largest,
  };
}
