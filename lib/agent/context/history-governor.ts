/**
 * Fase 8E — Governor del historial (APAGADO POR DEFECTO).
 *
 * Este módulo PLANIFICA una compactación determinista de los mensajes
 * viejos cuando el contexto se acerca al presupuesto blando. No usa un LLM,
 * no llama a la red y no toca disco. El resultado es un plan explícito y
 * auditable; aplicarlo o no es una decisión de quien lo invoca.
 *
 * Reglas de preservación (todas verificadas por los tests de 8E):
 * - TODOS los mensajes del usuario se conservan TEXTUALMENTE. Son el
 *   objetivo, las restricciones y las correcciones: recortarlos en
 *   silencio es exactamente lo que el roadmap prohíbe.
 * - Los mensajes del sistema se conservan textualmente.
 * - Las últimas `keepRecentUnits` unidades (asistente + tool-results) se
 *   conservan textualmente, para no borrar el error que explica un fallo
 *   reciente.
 * - Las unidades viejas se reemplazan por UN mensaje de resumen asistente
 *   con: hechos observados (metadatos de tools), errores preservados
 *   (redactados y recortados), dichos del asistente marcados como NO
 *   verificados, y una sección de pendientes que NO inventa nada.
 * - Nunca se copia el contenido de un tool-result al resumen: solo
 *   `ok`/`fallo` y, para fallos, un extracto del error redactado.
 * - Rutas sensibles (`.env`, claves, etc.) se omiten por completo; ni
 *   siquiera aparece su nombre.
 * - El plan solo se aplica si REDUCE de verdad la cantidad de mensajes y
 *   el resumen ocupa menos que lo removido. Si no, se devuelve el
 *   historial original con `applied: false` y el motivo.
 *
 * Trazabilidad: `HISTORY_GOVERNOR_VERSION` viaja en el resumen y en el
 * plan. Cualquier cambio de política debe subir la versión para que un
 * resumen viejo sea identificable.
 */
import type { ModelMessage } from "ai";
import { redactSecrets } from "../../provider-resilience/redact";
import { sensitiveRuleOf } from "./sensitive-paths";

export const HISTORY_GOVERNOR_VERSION = 1;

export type HistoryGovernorConfig = {
  /** Debe ser `true` explícito para compactar. Default: apagado. */
  enabled: boolean;
  /** Se dispara cuando `estimatedTokens >= softInputTokens * triggerRatio`. */
  triggerRatio?: number;
  /** Unidades recientes que se conservan textualmente. */
  keepRecentUnits?: number;
  /** No vale la pena compactar si hay menos unidades viejas que esto. */
  minOldUnits?: number;
  /** Tope duro del resumen, en caracteres. */
  maxSummaryChars?: number;
  /** Tope de cada extracto de texto/error. */
  maxTextExcerptChars?: number;
  /** Tope de errores preservados. */
  maxErrors?: number;
  /** Tope de rutas listadas. */
  maxPaths?: number;
};

export const DEFAULT_HISTORY_GOVERNOR_CONFIG: Required<HistoryGovernorConfig> = {
  enabled: false,
  triggerRatio: 0.85,
  keepRecentUnits: 6,
  minOldUnits: 2,
  maxSummaryChars: 3_500,
  maxTextExcerptChars: 220,
  maxErrors: 8,
  maxPaths: 12,
};

export type HistoryGovernorDecision =
  | "disabled"
  | "not_needed"
  | "too_few_units"
  | "summary_too_large"
  | "not_beneficial"
  | "compacted";

export type HistoryGovernorTrace = {
  keptUserMessages: number;
  keptSystemMessages: number;
  keptRecentUnits: number;
  summarizedUnits: number;
  summarizedMessages: number;
  observedToolCalls: number;
  observedToolResults: number;
  observedFailures: number;
  preservedErrors: number;
  assistantExcerpts: number;
  listedPaths: number;
  omittedSensitivePaths: number;
  removedChars: number;
  summaryChars: number;
};

export type HistoryGovernorPlan = {
  version: typeof HISTORY_GOVERNOR_VERSION;
  enabled: boolean;
  applied: boolean;
  decision: HistoryGovernorDecision;
  /** Historial resultante. Si no se aplicó, es el MISMO array de entrada. */
  messages: ModelMessage[];
  summary: string | null;
  beforeMessages: number;
  afterMessages: number;
  removedMessages: number;
  trace: HistoryGovernorTrace;
};

export type PlanHistoryCompactionInput = {
  messages: readonly ModelMessage[];
  /** Estimación local de tokens del contexto actual (8A). */
  estimatedTokens: number;
  /** Presupuesto blando del modelo (8C). */
  softInputTokens: number;
  config: HistoryGovernorConfig;
};

type UnitKind = "user" | "system" | "assistant" | "tool-group" | "orphan-tool";

type Unit = { kind: UnitKind; messages: ModelMessage[] };

const REMOVABLE: ReadonlySet<UnitKind> = new Set<UnitKind>(["assistant", "tool-group"]);

function contentParts(message: ModelMessage): unknown[] {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content : [];
}

function hasToolCall(message: ModelMessage): boolean {
  return contentParts(message).some((part) => part !== null && typeof part === "object" && (part as { type?: unknown }).type === "tool-call");
}

/** Agrupa un assistant con tool-calls junto con sus tool-results inmediatos:
 * quitar uno sin el otro dejaría un historial inválido para el proveedor. */
function buildUnits(messages: readonly ModelMessage[]): Unit[] {
  const units: Unit[] = [];
  let index = 0;
  while (index < messages.length) {
    const message = messages[index];
    if (message.role === "assistant" && hasToolCall(message)) {
      const group: ModelMessage[] = [message];
      index += 1;
      while (index < messages.length && messages[index].role === "tool") {
        group.push(messages[index]);
        index += 1;
      }
      units.push({ kind: "tool-group", messages: group });
      continue;
    }
    if (message.role === "tool") {
      const group: ModelMessage[] = [];
      while (index < messages.length && messages[index].role === "tool") {
        group.push(messages[index]);
        index += 1;
      }
      units.push({ kind: "orphan-tool", messages: group });
      continue;
    }
    units.push({
      kind: message.role === "user" ? "user" : message.role === "system" ? "system" : "assistant",
      messages: [message],
    });
    index += 1;
  }
  return units;
}

function sanitizeLabel(value: string, maxChars: number): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, Math.max(0, maxChars));
}

function safeStringify(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    return typeof json === "string" ? json : String(value);
  } catch {
    try {
      return String(value);
    } catch {
      return "";
    }
  }
}

/** Redacta secretos registrados y recorta sin cortar a mitad de una palabra
 * Unicode (usa `slice`, que opera por unidades UTF-16; suficiente para un
 * extracto de diagnóstico y determinista). */
function safeExcerpt(value: string, maxChars: number): string {
  const redacted = redactSecrets(value);
  return sanitizeLabel(redacted, maxChars);
}

function extractPath(input: unknown): string | null {
  if (input === null || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  for (const key of ["path", "subPath"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value.replace(/\\/g, "/");
  }
  return null;
}

type ResultFact = { failed: boolean; error?: string; known: boolean };

/** Interpreta el output de un tool-result SIN volcar su contenido. */
function classifyToolOutput(output: unknown): ResultFact {
  if (output === null || typeof output !== "object") return { failed: false, known: false };
  const record = output as { type?: unknown; value?: unknown; reason?: unknown };
  if (record.type === "error-text") return { failed: true, error: typeof record.value === "string" ? record.value : "error", known: true };
  if (record.type === "error-json") return { failed: true, error: safeStringify(record.value), known: true };
  if (record.type === "execution-denied") return { failed: true, error: typeof record.reason === "string" ? record.reason : "ejecución denegada", known: true };
  if (record.type === "json") return classifyResultValue(record.value);
  if (record.type === "text") {
    const text = typeof record.value === "string" ? record.value : "";
    const trimmed = text.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return classifyResultValue(JSON.parse(trimmed));
      } catch {
        return { failed: /^error\b/i.test(trimmed), error: /^error\b/i.test(trimmed) ? trimmed : undefined, known: false };
      }
    }
    return { failed: /^error\b/i.test(trimmed), error: /^error\b/i.test(trimmed) ? trimmed : undefined, known: false };
  }
  return classifyResultValue(output);
}

function classifyResultValue(value: unknown): ResultFact {
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.ok === false) return { failed: true, error: typeof record.error === "string" ? record.error : "ok:false", known: true };
    if (record.ok === true) return { failed: false, known: true };
    if (typeof record.error === "string" && record.error.length > 0) return { failed: true, error: record.error, known: true };
  }
  return { failed: false, known: false };
}

type Facts = {
  calls: Map<string, number>;
  results: Map<string, { ok: number; failed: number; unknown: number }>;
  paths: Map<string, number>;
  errors: string[];
  assistantExcerpts: string[];
  observedToolCalls: number;
  observedToolResults: number;
  observedFailures: number;
  omittedSensitivePaths: number;
};

function emptyFacts(): Facts {
  return {
    calls: new Map(),
    results: new Map(),
    paths: new Map(),
    errors: [],
    assistantExcerpts: [],
    observedToolCalls: 0,
    observedToolResults: 0,
    observedFailures: 0,
    omittedSensitivePaths: 0,
  };
}

function addPath(facts: Facts, rawPath: string | null): void {
  if (!rawPath) return;
  const normalized = rawPath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (sensitiveRuleOf(normalized)) {
    facts.omittedSensitivePaths += 1;
    return;
  }
  facts.paths.set(normalized, (facts.paths.get(normalized) ?? 0) + 1);
}

function collectFacts(units: readonly Unit[], maxTextExcerptChars: number, maxErrors: number): Facts {
  const facts = emptyFacts();
  for (const unit of units) {
    for (const message of unit.messages) {
      for (const rawPart of contentParts(message)) {
        if (rawPart === null || typeof rawPart !== "object") continue;
        const part = rawPart as { type?: unknown; toolName?: unknown; input?: unknown; output?: unknown; text?: unknown };
        const toolName = typeof part.toolName === "string" ? part.toolName : null;
        if (part.type === "tool-call" && toolName) {
          facts.observedToolCalls += 1;
          facts.calls.set(toolName, (facts.calls.get(toolName) ?? 0) + 1);
          addPath(facts, extractPath(part.input));
        } else if (part.type === "tool-result" && toolName) {
          facts.observedToolResults += 1;
          const fact = classifyToolOutput(part.output);
          const bucket = facts.results.get(toolName) ?? { ok: 0, failed: 0, unknown: 0 };
          if (!fact.known) bucket.unknown += 1;
          else if (fact.failed) bucket.failed += 1;
          else bucket.ok += 1;
          facts.results.set(toolName, bucket);
          if (fact.failed) {
            facts.observedFailures += 1;
            if (fact.error && facts.errors.length < maxErrors) {
              const excerpt = safeExcerpt(fact.error, maxTextExcerptChars);
              if (excerpt) facts.errors.push(`${toolName}: ${excerpt}`);
            }
          }
        } else if (part.type === "text" && typeof part.text === "string") {
          const excerpt = safeExcerpt(part.text, maxTextExcerptChars);
          if (excerpt) facts.assistantExcerpts.push(excerpt);
        }
      }
    }
  }
  return facts;
}

function plural(count: number, singular: string, pluralForm: string): string {
  return count === 1 ? singular : pluralForm;
}

function buildSummaryText(facts: Facts, summarizedUnits: number, summarizedMessages: number, config: Required<HistoryGovernorConfig>): string {
  const lines: string[] = [
    `## Historial compactado (gobernador v${HISTORY_GOVERNOR_VERSION})`,
    `Se compactaron ${summarizedUnits} ${plural(summarizedUnits, "unidad antigua", "unidades antiguas")} (${summarizedMessages} ${plural(summarizedMessages, "mensaje", "mensajes")}). Los mensajes del usuario y las unidades recientes se conservan textualmente.`,
    "",
    "### Hechos observados (metadatos de tools; nunca su contenido)",
  ];
  const toolNames = [...new Set([...facts.calls.keys(), ...facts.results.keys()])].sort();
  if (toolNames.length === 0) {
    lines.push("- No hubo llamadas a tools en las unidades compactadas.");
  } else {
    for (const toolName of toolNames) {
      const calls = facts.calls.get(toolName) ?? 0;
      const result = facts.results.get(toolName);
      const pieces: string[] = [`${calls} ${plural(calls, "llamada", "llamadas")}`];
      if (result) {
        if (result.ok > 0) pieces.push(`${result.ok} OK`);
        if (result.failed > 0) pieces.push(`${result.failed} ${plural(result.failed, "fallo", "fallos")}`);
        if (result.unknown > 0) pieces.push(`${result.unknown} sin estado`);
      }
      lines.push(`- ${toolName}: ${pieces.join(", ")}`);
    }
  }
  if (facts.paths.size > 0) {
    const paths = [...facts.paths.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .slice(0, config.maxPaths)
      .map(([path, count]) => `${path} (${count})`);
    lines.push(`- Rutas usadas: ${paths.join(", ")}${facts.paths.size > config.maxPaths ? ` … (+${facts.paths.size - config.maxPaths})` : ""}.`);
  }
  if (facts.omittedSensitivePaths > 0) {
    lines.push(`- Rutas sensibles omitidas: ${facts.omittedSensitivePaths} (no se listan).`);
  }

  lines.push("", "### Errores preservados (redactados y recortados)");
  if (facts.errors.length === 0) lines.push("- No hubo errores en las unidades compactadas.");
  else for (const error of facts.errors) lines.push(`- ${error}`);

  lines.push("", "### Dichos del asistente (NO verificados)");
  if (facts.assistantExcerpts.length === 0) lines.push("- Sin texto del asistente en las unidades compactadas.");
  else {
    const unique = [...new Set(facts.assistantExcerpts)].slice(0, 6);
    for (const excerpt of unique) lines.push(`- "${excerpt}"`);
  }

  lines.push(
    "",
    "### Pendientes",
    "- No inferidos por el gobernador: el estado real está en el worktree, en las tools recientes y en los mensajes del usuario. Verificá antes de afirmar que algo está hecho.",
  );

  // Recorte por líneas completas, nunca a mitad de frase.
  let text = lines.join("\n");
  let omitted = 0;
  while (text.length > config.maxSummaryChars && lines.length > 4) {
    lines.pop();
    omitted += 1;
    text = lines.join("\n");
  }
  if (omitted > 0) {
    const notice = `… (${omitted} línea(s) del resumen omitida(s) por presupuesto)`;
    if (text.length + 1 + notice.length <= config.maxSummaryChars) text = `${text}\n${notice}`;
    else text = lines.slice(0, 4).join("\n");
  }
  return text;
}

function messageChars(message: ModelMessage): number {
  try {
    const json = JSON.stringify(message);
    return typeof json === "string" ? json.length : 0;
  } catch {
    return 0;
  }
}

/**
 * Planifica la compactación. Es puro: no muta `messages`, no toca el
 * reloj, no usa aleatoriedad. Dos llamadas con la misma entrada devuelven
 * exactamente el mismo plan.
 */
export function planHistoryCompaction(input: PlanHistoryCompactionInput): HistoryGovernorPlan {
  const config: Required<HistoryGovernorConfig> = {
    ...DEFAULT_HISTORY_GOVERNOR_CONFIG,
    ...input.config,
  };
  const beforeMessages = input.messages.length;
  const baseTrace: HistoryGovernorTrace = {
    keptUserMessages: 0,
    keptSystemMessages: 0,
    keptRecentUnits: 0,
    summarizedUnits: 0,
    summarizedMessages: 0,
    observedToolCalls: 0,
    observedToolResults: 0,
    observedFailures: 0,
    preservedErrors: 0,
    assistantExcerpts: 0,
    listedPaths: 0,
    omittedSensitivePaths: 0,
    removedChars: 0,
    summaryChars: 0,
  };
  const unchanged = (decision: HistoryGovernorDecision, trace: HistoryGovernorTrace = baseTrace): HistoryGovernorPlan => ({
    version: HISTORY_GOVERNOR_VERSION,
    enabled: config.enabled,
    applied: false,
    decision,
    messages: input.messages as ModelMessage[],
    summary: null,
    beforeMessages,
    afterMessages: beforeMessages,
    removedMessages: 0,
    trace,
  });

  if (!config.enabled) return unchanged("disabled");
  if (input.messages.length === 0) return unchanged("too_few_units");
  if (!Number.isFinite(input.softInputTokens) || input.softInputTokens <= 0) return unchanged("not_needed");
  const triggerRatio = Math.min(1, Math.max(0, config.triggerRatio));
  if (input.estimatedTokens < input.softInputTokens * triggerRatio) return unchanged("not_needed");

  const units = buildUnits(input.messages);
  const removable = units.map((unit, index) => ({ unit, index })).filter(({ unit }) => REMOVABLE.has(unit.kind));
  const keepRecentUnits = Math.max(0, Math.floor(config.keepRecentUnits));
  const old = removable.slice(0, Math.max(0, removable.length - keepRecentUnits));
  if (old.length < Math.max(1, Math.floor(config.minOldUnits))) return unchanged("too_few_units");

  const facts = collectFacts(old.map(({ unit }) => unit), Math.max(20, config.maxTextExcerptChars), Math.max(0, config.maxErrors));
  const summarizedMessages = old.reduce((sum, { unit }) => sum + unit.messages.length, 0);
  const summary = buildSummaryText(facts, old.length, summarizedMessages, config);
  if (!summary || summary.length === 0 || summary.length > config.maxSummaryChars) return unchanged("summary_too_large");

  const removedChars = old.reduce((sum, { unit }) => sum + unit.messages.reduce((inner, message) => inner + messageChars(message), 0), 0);
  if (summary.length >= removedChars) return unchanged("not_beneficial");

  const oldIndices = new Set(old.map(({ index }) => index));
  const output: ModelMessage[] = [];
  let inserted = false;
  let lastInsertionIndex = -1;
  for (let index = 0; index < units.length; index++) {
    const unit = units[index];
    if (oldIndices.has(index)) {
      if (!inserted) {
        output.push({ role: "assistant", content: [{ type: "text", text: summary }] });
        lastInsertionIndex = output.length - 1;
        inserted = true;
      }
      continue;
    }
    output.push(...unit.messages);
  }

  // El resumen es un mensaje assistant: no puede quedar inmediatamente
  // después de un tool-result (rompería el pareo tool-call/tool-result).
  // En ese caso se mueve hacia adelante hasta el primer punto válido.
  if (lastInsertionIndex > 0) {
    const previous = output[lastInsertionIndex - 1];
    if (previous.role === "tool") {
      const [summaryMessage] = output.splice(lastInsertionIndex, 1);
      let insertion = lastInsertionIndex;
      while (insertion < output.length && output[insertion].role === "tool") insertion += 1;
      output.splice(insertion, 0, summaryMessage);
    }
  }

  const afterMessages = output.length;
  if (afterMessages >= beforeMessages) return unchanged("not_beneficial");

  return {
    version: HISTORY_GOVERNOR_VERSION,
    enabled: true,
    applied: true,
    decision: "compacted",
    messages: output,
    summary,
    beforeMessages,
    afterMessages,
    removedMessages: beforeMessages - afterMessages,
    trace: {
      keptUserMessages: units.filter((unit) => unit.kind === "user").length,
      keptSystemMessages: units.filter((unit) => unit.kind === "system").length,
      keptRecentUnits: removable.length - old.length,
      summarizedUnits: old.length,
      summarizedMessages,
      observedToolCalls: facts.observedToolCalls,
      observedToolResults: facts.observedToolResults,
      observedFailures: facts.observedFailures,
      preservedErrors: facts.errors.length,
      assistantExcerpts: facts.assistantExcerpts.length,
      listedPaths: facts.paths.size,
      omittedSensitivePaths: facts.omittedSensitivePaths,
      removedChars,
      summaryChars: summary.length,
    },
  };
}
