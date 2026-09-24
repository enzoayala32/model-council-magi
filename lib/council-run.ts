import { getCouncilModel, type ReasoningEffort } from "@/lib/models";
import { createAgentCompletion, createChatCompletion, OpenRouterError, type OpenRouterTool, type OpenRouterToolCall } from "@/lib/openrouter";
import { createNvidiaAgentCompletion } from "@/lib/nvidia";
import { createGoogleAgentCompletion } from "@/lib/google-ai-studio";
import { recordModelOutcome } from "@/lib/model-health";
import type { ConversationTurn, FusionJudgeReport, StreamEvent, UploadedAttachment } from "@/lib/council-types";
import {
  buildDraftMessages,
  buildFusionJudgePrompt,
  buildVotePrompt,
  condenseDraftForPeers,
  debateSystemPrompt,
  FUSION_JUDGE_SYSTEM_PROMPT,
  renderHistoryBlock,
  VOTE_SYSTEM_PROMPT,
} from "@/lib/council-prompts";
import {
  fallbackFusionJudgeReport,
  normalizeFusionJudgeReport,
  parseFusionJudgeJson,
  parseVote,
  splitDebateOutput,
} from "@/lib/council-consensus";
import { getProviderPool, ENV_PREFIX_BY_PROVIDER } from "@/lib/provider-resilience/registry";
import { classifyProviderError, type ProviderErrorInput } from "@/lib/provider-resilience/classify";
import { computeCooldownMs } from "@/lib/provider-resilience/cooldown";
import { redactSecrets } from "@/lib/provider-resilience/redact";
import type { ProviderName } from "@/lib/provider-resilience/config";
import { classifyExhaustion, describeExhaustion } from "@/lib/provider-resilience/events";
import { recordCouncilResilienceEvent } from "@/lib/provider-resilience/council-log";
import crypto from "node:crypto";

/**
 * Orchestration for the council pipeline — the functions that actually make
 * model calls (draft, debate, vote, fusion judge) and emit SSE events as
 * they go, plus the small run-time utilities (logStep/delay/withWatchdog)
 * they share. Split out of app/api/council/stream/route.ts, which now just
 * wires these together behind the POST handler and the request/response
 * streaming plumbing.
 */

const DRAFT_STEPS = [
  "Reading the prompt and identifying the decision frame",
  "Separating factual claims from assumptions",
  "Mapping the strongest counterargument before drafting",
  "Drafting an independent long-form answer",
  "Tightening evidence and making confidence explicit",
];

const DEBATE_STEPS = [
  "Reading the other council members' answers",
  "Locating real disagreements vs. surface differences",
  "Drafting critique with concrete pushback",
  "Updating my own answer where the evidence warrants",
];

const TARGET_DRAFT_TOKENS = 9000;
const TARGET_DEBATE_TOKENS = 9000;
const FUSION_JUDGE_MODEL = "nvidia/nemotron-3.5-lightning:free";

export function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Server-side console logging so a stuck/failed run is traceable in the
 * terminal running `npm run dev` — every phase transition and every model
 * call logs a start, a finish (with duration), or a failure (with reason). */
export function logStep(label: string, detail?: Record<string, unknown>) {
  const ts = new Date().toISOString().split("T")[1]?.replace("Z", "");
  const suffix = detail ? ` ${JSON.stringify(detail)}` : "";
  console.log(`[council ${ts}] ${label}${suffix}`);
}

/** Wraps a promise with a hard ceiling so a stuck call can never hang a
 * request forever, even if its own internal timeout/retry logic compounds.
 * On timeout it logs loudly and rejects (or resolves to `fallback` if one
 * is provided) instead of leaving the client spinning with no feedback. */
export function withWatchdog<T>(promise: Promise<T>, ms: number, label: string, fallback?: () => T): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      logStep(`⏱ WATCHDOG TIMEOUT: ${label} exceeded ${Math.round(ms / 1000)}s`, { hadFallback: Boolean(fallback) });
      if (fallback) {
        resolve(fallback());
      } else {
        reject(new Error(`${label} took longer than ${Math.round(ms / 1000)}s and was aborted.`));
      }
    }, ms);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * A qué provider corresponde un modelId — mismo criterio que ya usaba
 * `runCouncilCompletion` de forma inline (todo modelo es OpenRouter por
 * default, salvo que `models.ts` lo tenga marcado como
 * `"nvidia"`/`"google"`), extraído acá como función nombrada para que
 * `withCredentialFailover` (Fase 5E) pueda resolverlo ANTES de decidir de
 * qué pool pedir una credential.
 */
function resolveProviderName(modelId: string): ProviderName {
  const model = getCouncilModel(modelId);
  if (model?.provider === "nvidia") return "nvidia";
  if (model?.provider === "google") return "google";
  return "openrouter";
}

/**
 * Fase 5E: adapta un error real de Council al `ProviderErrorInput` que
 * espera `classifyProviderError()` (5B) — sin tocar `classify.ts`. Mucho
 * más simple que el equivalente del Coding Agent (`lib/agent/loop.ts`):
 * los 3 clientes de Council (`openrouter.ts`/`nvidia.ts`/
 * `google-ai-studio.ts`) YA lanzan la MISMA clase `OpenRouterError` con
 * `.status`/`.retryAfterSeconds` normalizados — no hace falta duck-typing.
 *
 * Sin `.status` reconocible, cae en la misma heurística BEST-EFFORT que
 * 5D — NO es un contrato garantizado de ningún proveedor, solo una
 * distinción razonable sobre el texto del error cuando no hay nada mejor.
 */
function toProviderErrorInput(error: unknown): ProviderErrorInput {
  if (error instanceof OpenRouterError && typeof error.status === "number") {
    return { kind: "http", status: error.status, retryAfterSeconds: error.retryAfterSeconds ?? null, message: error.message };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/timeout|timed out/i.test(message)) return { kind: "timeout" };
  if (/network|ECONNRESET|ENOTFOUND|fetch failed/i.test(message)) return { kind: "network" };
  return { kind: "unknown", message };
}

/**
 * Fase 5E — el punto central de integración de Provider Resilience con
 * Model Council. Envuelve una llamada a un modelo (`attempt`) con
 * rotación de credential vía el pool/cursor de 5A, clasificación de 5B, y
 * el bypass de `body.apiKey` de 5C — sin duplicar el retry-mismo-key que
 * YA hacen `openrouter.ts`/`nvidia.ts`/`google-ai-studio.ts` (sin tocar).
 *
 * Unidad de operación: UNA invocación de `withCredentialFailover` = UNA
 * llamada lógica a un modelo (un draft, un turno de debate, un voto, el
 * judge, una síntesis) — nunca todo un Council run. Esto es lo que
 * permite que Draft A y Draft B compartan una credential libremente (cada
 * uno arma su propio `beginOperation()`), mientras que DENTRO de una sola
 * invocación, una credential que ya falló nunca vuelve a probarse (la
 * garantía estructural de `OperationCursor`, 5A, intacta).
 *
 * Diferencia deliberada respecto al Coding Agent (5D): acá NO existe
 * ninguna restricción de "solo en el primer step" — verificado que
 * `propose_write_file`/`propose_edit_file` (`lib/fs-tools.ts`) nunca
 * escriben al disco real, solo`stageProposal` en memoria — así que
 * reiniciar una llamada completa (incluso una con tool-calling multi-step
 * ya avanzado) con otra credential es seguro, en el peor caso deja una
 * proposal duplicada y descartable.
 */
export async function withCredentialFailover<T>(
  providerName: ProviderName,
  signal: AbortSignal,
  attempt: (apiKey: string) => Promise<T>,
  options?: { explicitApiKey?: string | null },
): Promise<T> {
  const explicit = options?.explicitApiKey?.trim();
  if (explicit) {
    // body.apiKey (u otro override explícito) presente: un solo intento,
    // CERO interacción con el pool — sin cursor, sin release, sin rotar,
    // sin tocar salud de ninguna credential. El retry-mismo-key interno
    // del cliente HTTP (429/503) sigue funcionando igual, porque vive
    // DENTRO de createChatCompletion/createAgentCompletion, sin importar
    // de dónde salió la key.
    return attempt(explicit);
  }

  const pool = getProviderPool(providerName);
  const cursor = pool.beginOperation();

  while (true) {
    const acquireResult = cursor.next();
    if (acquireResult.status !== "AVAILABLE") {
      // Fase 5F: mismo fix de mensaje que `lib/agent/loop.ts` — el genérico
      // "...o todas las configuradas quedaron INVALID" conflaba casos muy
      // distintos (ver `describeExhaustion`). Solo cambia el texto/lo que se
      // observa, no la lógica de adquisición.
      let exhaustionReason: string;
      let message: string;
      if (acquireResult.status === "NO_CREDENTIALS") {
        const classified = classifyExhaustion(pool.snapshot());
        exhaustionReason = classified.reason;
        message = describeExhaustion(providerName, ENV_PREFIX_BY_PROVIDER[providerName], classified);
      } else {
        exhaustionReason = "all_cooldown";
        message = `Todas las credentials de ${providerName} están en cooldown ahora mismo — la próxima estará libre en ${new Date(acquireResult.retryAt).toISOString()}.`;
      }
      recordCouncilResilienceEvent({
        id: crypto.randomUUID(),
        ts: Date.now(),
        source: "council",
        provider: providerName,
        credentialId: null,
        reason: exhaustionReason,
        poolAction: null,
        outcome: "exhausted",
      });
      throw new Error(message);
    }

    const { id: credentialId, value: apiKey, healthGeneration } = acquireResult.lease;
    try {
      const result = await attempt(apiKey);
      pool.release(credentialId, "success", Date.now(), undefined, healthGeneration);
      return result;
    } catch (error) {
      if (signal.aborted) {
        // Cancelación real del usuario — nunca degrada la credential,
        // nunca hace failover, nunca consume otra. Se propaga tal cual.
        throw error;
      }

      const classified = classifyProviderError(toProviderErrorInput(error));

      // `classified.retrySameKey` se ignora A PROPÓSITO — el retry-mismo-key
      // de 429/503 ya lo consumió `attemptWithRateLimitRetry` DENTRO del
      // cliente HTTP (sin tocar), antes de que este catch viera el error.
      // Agregar otro nivel acá sería el retry duplicado que 5E prohíbe.
      if (classified.poolAction === "COOLDOWN") {
        const currentState = pool.snapshot().find((s) => s.id === credentialId);
        const nextFailures = (currentState?.consecutiveFailures ?? 0) + 1;
        pool.release(credentialId, "cooldown", Date.now(), computeCooldownMs(nextFailures));
      } else if (classified.poolAction === "INVALID") {
        pool.release(credentialId, "invalid");
      }
      // poolAction === "NONE" (500/502/503/timeout/network): a propósito NO
      // se llama pool.release() — la credential sigue AVAILABLE globalmente.
      // NONE nunca significa "no rotar", solo "no degradar salud" — por
      // eso la decisión de rotar depende únicamente de `failoverCredential`
      // (chequeado abajo), no de `poolAction`.

      // Fase 5F: un evento por cada credential que falló, rote o no — el
      // Council no tiene la regla de Step 0 del Coding Agent, así que acá
      // "stopped" significa siempre "el error no era failover-eligible".
      recordCouncilResilienceEvent({
        id: crypto.randomUUID(),
        ts: Date.now(),
        source: "council",
        provider: providerName,
        credentialId,
        reason: classified.reason,
        poolAction: classified.poolAction,
        outcome: classified.failoverCredential ? "rotated" : "stopped",
      });

      if (!classified.failoverCredential) throw error;
      // failoverCredential === true → vuelve al while, cursor.next() da la
      // próxima credential (o NO_CREDENTIALS si ya se agotaron todas).
    }
  }
}

/**
 * Dispatches to the right provider client based on the council model's
 * `provider` field. Every existing model is implicitly "openrouter" (the
 * field is only set for NVIDIA-native and Google-native entries in
 * lib/models.ts).
 *
 * Fase 5E: `apiKey` es ahora genérico (antes `openRouterApiKey`, y las
 * ramas NVIDIA/Google leían `process.env.NVIDIA_API_KEY`/`GEMINI_API_KEY`
 * directo, ignorando cualquier parámetro) — el valor que llega acá ya
 * salió del pool/cursor correcto vía `withCredentialFailover`, así que ya
 * no hace falta el `if (!nvidiaApiKey) throw` que había antes: si no
 * hubiera ninguna credential configurada, `cursor.next()` ya lo hubiera
 * reportado como `NO_CREDENTIALS` antes de que esta función se llame.
 */
export function runCouncilCompletion(
  modelId: string,
  options: Omit<Parameters<typeof createAgentCompletion>[0], "apiKey"> & { apiKey: string },
) {
  const model = getCouncilModel(modelId);
  const { apiKey, ...rest } = options;

  if (model?.provider === "nvidia") {
    return createNvidiaAgentCompletion({ ...rest, apiKey });
  }

  if (model?.provider === "google") {
    return createGoogleAgentCompletion({ ...rest, apiKey });
  }

  return createAgentCompletion({ ...rest, apiKey });
}

/* =========================================================
   Round 1 — independent drafts
   ========================================================= */

export async function runDraft({
  modelId,
  prompt,
  attachments,
  history,
  explicitOpenRouterKey,
  send,
  offset,
  signal,
  webGrounding,
  skillPrompt,
  personaPrompt,
  tools,
  executeTool,
  reasoningEffort,
  runCouncilCompletionImpl,
}: {
  modelId: string;
  prompt: string;
  attachments: UploadedAttachment[];
  history: ConversationTurn[];
  /** Fase 5E: `body.apiKey` de la request, si el usuario pegó una key
   * temporal en la UI — `null`/`undefined` si no. Solo tiene efecto para
   * el provider OpenRouter (ver `withCredentialFailover`); NVIDIA/Google
   * siempre usan el pool, nunca tuvieron override. */
  explicitOpenRouterKey?: string | null;
  send: (event: StreamEvent) => void;
  offset: number;
  signal: AbortSignal;
  webGrounding: boolean;
  skillPrompt: string;
  personaPrompt: string;
  tools: OpenRouterTool[];
  executeTool: (toolCall: OpenRouterToolCall, signal?: AbortSignal) => Promise<{ name: string; content: string }>;
  reasoningEffort: ReasoningEffort;
  /** Solo para tests — el default es `runCouncilCompletion` real. Mismo
   * patrón que `generateTextImpl` de 5D (Coding Agent). */
  runCouncilCompletionImpl?: typeof runCouncilCompletion;
}) {
  const model = getCouncilModel(modelId);
  const label = model?.label ?? modelId;
  let steps = 0;

  for (const step of DRAFT_STEPS) {
    if (signal.aborted) return { ok: false as const, modelId, label, content: "", error: "aborted" };
    steps += 3 + offset;
    send({ type: "model_step", modelId, label, step, steps, status: "thinking", phase: "drafting" });
    await delay(140 + offset * 50);
  }

  if (attachments.length) {
    steps += 2;
    send({
      type: "model_step",
      modelId,
      label,
      step: `Reading ${attachments.length} uploaded attachment${attachments.length === 1 ? "" : "s"}`,
      steps,
      status: "thinking",
      phase: "drafting",
    });
    await delay(140);
  }

  if (webGrounding) {
    steps += 1;
    send({
      type: "model_step",
      modelId,
      label,
      step: "Searching the live web for grounding context",
      steps,
      status: "thinking",
      phase: "drafting",
    });
    await delay(120);
  }

  const draftStartedAt = Date.now();
  logStep(`→ draft START`, { modelId });

  /** Calls the given model id, sharing the outer seat's tools/effort — used
   * for both the primary model and (on failure) its configured fallback, so
   * the seat's identity (modelId/label) never changes downstream.
   *
   * Fase 5E: cada llamada a `attempt()` es su PROPIA operación lógica para
   * `withCredentialFailover` — un `beginOperation()` nuevo por cada una,
   * tanto para el modelo primario como (si hace falta) para el fallback.
   * El provider se resuelve por `callModelId`, así que un fallback a otro
   * provider (ej. OpenRouter → NVIDIA nativo) usa el pool correcto sin
   * ningún código especial acá. */
  async function attempt(callModelId: string) {
    send({
      type: "model_step",
      modelId,
      label,
      step: webGrounding
        ? "Calling OpenRouter (web-grounded) for the long-form independent answer"
        : "Calling OpenRouter for the long-form independent answer",
      steps: steps + 2,
      status: "thinking",
      phase: "drafting",
    });

    const providerName = resolveProviderName(callModelId);
    const completionImpl = runCouncilCompletionImpl ?? runCouncilCompletion;
    return withCredentialFailover(
      providerName,
      signal,
      (resolvedApiKey) =>
        completionImpl(callModelId, {
          model: callModelId,
          apiKey: resolvedApiKey,
          maxTokens: TARGET_DRAFT_TOKENS,
          temperature: 0.28,
          reasoningEffort,
          signal,
          web: webGrounding,
          tools,
          executeTool,
          onToolCall: (toolCall) => {
            steps += 1;
            send({
              type: "model_step",
              modelId,
              label,
              step: `Using ${toolCall.function.name.replace(/_/g, " ")} tool`,
              steps,
              status: "thinking",
              phase: "drafting",
            });
          },
          messages: buildDraftMessages(prompt, attachments, history, webGrounding, model?.supportsImages ?? true, skillPrompt, personaPrompt),
        }),
      { explicitApiKey: providerName === "openrouter" ? explicitOpenRouterKey : null },
    );
  }

  try {
    const completion = await attempt(modelId);
    recordModelOutcome(modelId, true);
    send({
      type: "model_complete",
      modelId,
      label,
      content: completion.content,
      steps: steps + 6,
      phase: "drafting",
      usage: completion.usage,
    });
    logStep(`✓ draft DONE`, { modelId, ms: Date.now() - draftStartedAt, tokens: completion.usage });
    return { ok: true as const, modelId, label, content: completion.content };
  } catch (error) {
    const message = redactSecrets(error instanceof Error ? error.message : "Model request failed.");
    recordModelOutcome(modelId, false, message);
    logStep(`✗ draft FAILED`, { modelId, ms: Date.now() - draftStartedAt, error: message });

    const fallbackModelId = getCouncilModel(modelId)?.fallbackModelId;
    if (fallbackModelId && fallbackModelId !== modelId) {
      logStep(`↻ draft FALLBACK`, { modelId, fallbackModelId });
      try {
        const fallbackCompletion = await attempt(fallbackModelId);
        recordModelOutcome(fallbackModelId, true);
        send({
          type: "model_complete",
          modelId,
          label,
          content: fallbackCompletion.content,
          steps: steps + 6,
          phase: "drafting",
          usage: fallbackCompletion.usage,
          viaFallbackFrom: fallbackModelId,
        });
        logStep(`✓ draft DONE (via fallback)`, { modelId, fallbackModelId, ms: Date.now() - draftStartedAt, tokens: fallbackCompletion.usage });
        return { ok: true as const, modelId, label, content: fallbackCompletion.content };
      } catch (fallbackError) {
        const fallbackMessage = redactSecrets(fallbackError instanceof Error ? fallbackError.message : "Fallback model request failed.");
        recordModelOutcome(fallbackModelId, false, fallbackMessage);
        logStep(`✗ draft FALLBACK FAILED`, { modelId, fallbackModelId, error: fallbackMessage });
        send({ type: "model_error", modelId, label, error: `${message} (fallback also failed: ${fallbackMessage})`, steps: steps + 2, phase: "drafting" });
        return { ok: false as const, modelId, label, content: "", error: message };
      }
    }

    send({ type: "model_error", modelId, label, error: message, steps: steps + 2, phase: "drafting" });
    return { ok: false as const, modelId, label, content: "", error: message };
  }
}

/* =========================================================
   Round 2..N — debate (each model sees the others)
   ========================================================= */

export async function runDebate({
  self,
  others,
  prompt,
  history,
  explicitOpenRouterKey,
  send,
  offset,
  signal,
  skillPrompt,
  personaPrompt,
  tools,
  executeTool,
  reasoningEffort,
  round,
  maxRounds,
  runCouncilCompletionImpl,
}: {
  self: { modelId: string; label: string; content: string };
  others: Array<{ modelId: string; label: string; content: string }>;
  prompt: string;
  history: ConversationTurn[];
  /** Fase 5E: ver el mismo campo en `runDraft` — solo afecta a OpenRouter. */
  explicitOpenRouterKey?: string | null;
  send: (event: StreamEvent) => void;
  offset: number;
  signal: AbortSignal;
  skillPrompt: string;
  personaPrompt: string;
  tools: OpenRouterTool[];
  executeTool: (toolCall: OpenRouterToolCall, signal?: AbortSignal) => Promise<{ name: string; content: string }>;
  reasoningEffort: ReasoningEffort;
  round: number;
  maxRounds: number;
  /** Solo para tests — default `runCouncilCompletion` real. */
  runCouncilCompletionImpl?: typeof runCouncilCompletion;
}) {
  let steps = 0;

  for (const step of DEBATE_STEPS) {
    if (signal.aborted) return { ok: false as const, modelId: self.modelId, label: self.label };
    steps += 2 + offset;
    send({ type: "model_step", modelId: self.modelId, label: self.label, step, steps, status: "thinking", phase: "debating" });
    await delay(120 + offset * 40);
  }

  const debateStartedAt = Date.now();
  logStep(`→ debate START`, { modelId: self.modelId });
  try {
    send({
      type: "model_step",
      modelId: self.modelId,
      label: self.label,
      step: "Sending critique + revision request to OpenRouter",
      steps: steps + 2,
      status: "thinking",
      phase: "debating",
    });

    const providerName = resolveProviderName(self.modelId);
    const completionImpl = runCouncilCompletionImpl ?? runCouncilCompletion;
    const completion = await withCredentialFailover(
      providerName,
      signal,
      (resolvedApiKey) =>
        completionImpl(self.modelId, {
          model: self.modelId,
          apiKey: resolvedApiKey,
          maxTokens: TARGET_DEBATE_TOKENS,
          temperature: 0.3,
          reasoningEffort,
          signal,
          tools,
          executeTool,
          onToolCall: (toolCall) => {
            steps += 1;
            send({
              type: "model_step",
              modelId: self.modelId,
              label: self.label,
              step: `Checking ${toolCall.function.name.replace(/_/g, " ")} during debate`,
              steps,
              status: "thinking",
              phase: "debating",
            });
          },
          messages: [
            { role: "system", content: [debateSystemPrompt(round, maxRounds, personaPrompt), skillPrompt].filter(Boolean).join("\n\n") },
            {
              role: "user",
              content: [
                renderHistoryBlock(history),
                `# Current user question\n${prompt}`,
                "",
                `# Your previous answer (you are ${self.label}, debate round ${round} of ${maxRounds})`,
                self.content,
                "",
                "# Other council members' current answers (condensed to their core answer, reasoning, and recommendation — critique the argument, evidence/assumptions sections were trimmed for length)",
                ...others.map((other) => `## ${other.label}\n${condenseDraftForPeers(other.content)}`),
                "",
                "Now produce your debate response. Use the exact section format from the system instructions.",
              ].filter(Boolean).join("\n\n"),
            },
          ],
        }),
      { explicitApiKey: providerName === "openrouter" ? explicitOpenRouterKey : null },
    );

    const { critique, revisedAnswer } = splitDebateOutput(completion.content);
    recordModelOutcome(self.modelId, true);

    send({
      type: "model_debate_complete",
      modelId: self.modelId,
      label: self.label,
      critique,
      revisedAnswer,
      steps: steps + 6,
      usage: completion.usage,
      round,
      maxRounds,
    });

    logStep(`✓ debate DONE`, { modelId: self.modelId, ms: Date.now() - debateStartedAt, tokens: completion.usage });
    return { ok: true as const, modelId: self.modelId, label: self.label, critique, revisedAnswer };
  } catch (error) {
    const message = redactSecrets(error instanceof Error ? error.message : "Debate request failed.");
    recordModelOutcome(self.modelId, false, message);
    logStep(`✗ debate FAILED`, { modelId: self.modelId, ms: Date.now() - debateStartedAt, error: message });
    send({ type: "model_error", modelId: self.modelId, label: self.label, error: message, steps: steps + 2, phase: "debating" });
    return { ok: false as const, modelId: self.modelId, label: self.label };
  }
}

/* =========================================================
   Final vote — after debate rounds conclude, each surviving model
   casts one vote for the strongest final answer (its own allowed).
   Unlike convergence detection this DOES cost one short LLM call per
   model — the user explicitly asked for a real vote, not another
   heuristic.
   ========================================================= */

export async function runVote({
  self,
  candidates,
  prompt,
  apiKey,
  send,
  signal,
}: {
  self: { modelId: string; label: string };
  candidates: Array<{ modelId: string; label: string; content: string }>;
  prompt: string;
  apiKey: string;
  send: (event: StreamEvent) => void;
  signal: AbortSignal;
}): Promise<{ modelId: string; label: string; votedFor: string | null; rationale: string; usage?: unknown }> {
  // Fase 5E: antes, esta función atrapaba su propio error acá y devolvía
  // directo un fallback ("Vote failed: ...") — eso significaba que
  // `withCredentialFailover` NUNCA veía el error, porque `runVote` nunca
  // llegaba a rechazar su promesa: cada credential fallida quedaba
  // absorbida silenciosamente en la PRIMERA que se probara, sin que la
  // rotación de credential tuviera jamás la oportunidad de actuar
  // (hallazgo real, reportado y corregido en esta ronda). Ahora el error
  // se propaga tal cual — el fallback funcional (mismo texto, mismo
  // evento SSE) se preservó intacto, pero se movió a `runVoteResilient`,
  // que lo produce recién DESPUÉS de que `withCredentialFailover` agotó
  // todo lo que podía intentar (todas las credentials, o un error no
  // failover-eligible).
  const completion = await createChatCompletion({
    model: self.modelId,
    apiKey,
    maxTokens: 220,
    temperature: 0.15,
    signal,
    messages: [
      { role: "system", content: VOTE_SYSTEM_PROMPT },
      { role: "user", content: buildVotePrompt(prompt, candidates) },
    ],
  });
  const { votedFor, rationale } = parseVote(completion.content, candidates);
  send({
    type: "vote_cast",
    modelId: self.modelId,
    label: self.label,
    votedForModelId: votedFor?.modelId ?? null,
    votedForLabel: votedFor?.label ?? null,
    rationale: rationale || "(No rationale given)",
    usage: completion.usage,
  });
  return { modelId: self.modelId, label: self.label, votedFor: votedFor?.modelId ?? null, rationale, usage: completion.usage };
}

/**
 * Fase 5E: envoltorio resiliente de `runVote` — la secuencia final queda
 * `retry HTTP interno (openrouter.ts, sin tocar) → credential failover
 * (withCredentialFailover) → agotamiento → fallback funcional de Vote`,
 * nunca al revés. El fallback (mismo texto "Vote failed: ...", mismo
 * evento `vote_cast`, mismo shape de retorno) es EXACTAMENTE el que tenía
 * `runVote` antes de esta ronda — solo se movió a que ocurra acá, después
 * de que `withCredentialFailover` ya agotó lo que tenía para intentar (o
 * decidió que el error no ameritaba ni un intento de rotar).
 */
export async function runVoteResilient({
  self,
  candidates,
  prompt,
  send,
  signal,
  explicitOpenRouterKey,
  runVoteImpl,
}: {
  self: { modelId: string; label: string };
  candidates: Array<{ modelId: string; label: string; content: string }>;
  prompt: string;
  send: (event: StreamEvent) => void;
  signal: AbortSignal;
  explicitOpenRouterKey?: string | null;
  /** Solo para tests — default `runVote` real. No agrega ningún seam a
   * `runVote` en sí (queda con la firma de siempre); esto es exclusivo
   * del wrapper resiliente, para poder probar de verdad que este wrapper
   * observa y reacciona a un error, sin depender de red real. */
  runVoteImpl?: typeof runVote;
}): Promise<{ modelId: string; label: string; votedFor: string | null; rationale: string; usage?: unknown }> {
  const impl = runVoteImpl ?? runVote;
  try {
    return await withCredentialFailover(
      "openrouter",
      signal,
      (apiKey) => impl({ self, candidates, prompt, apiKey, send, signal }),
      { explicitApiKey: explicitOpenRouterKey },
    );
  } catch (error) {
    const rationale = `Vote failed: ${error instanceof Error ? redactSecrets(error.message) : "unknown error"}`;
    send({ type: "vote_cast", modelId: self.modelId, label: self.label, votedForModelId: null, votedForLabel: null, rationale });
    return { modelId: self.modelId, label: self.label, votedFor: null, rationale };
  }
}

/* =========================================================
   Fusion judge — a structured pre-synthesis pass
   ========================================================= */

export async function createFusionJudgeReport({
  prompt,
  drafts,
  debates,
  apiKey,
  signal,
}: {
  prompt: string;
  drafts: Array<{ modelId: string; label: string; content: string }>;
  debates: Array<{ ok: boolean; label: string; critique?: string; revisedAnswer?: string }>;
  apiKey: string;
  signal: AbortSignal;
}): Promise<{ report: FusionJudgeReport; usage?: unknown }> {
  // Fase 5E: mismo motivo que en runVote — antes esta función atrapaba su
  // propio error y devolvía el fallback directo, sin que
  // `withCredentialFailover` pudiera verlo jamás. Ahora propaga; el
  // fallback (`fallbackFusionJudgeReport`, idéntico) se movió a
  // `createFusionJudgeReportResilient`.
  const completion = await createChatCompletion({
    model: process.env.FUSION_JUDGE_MODEL ?? FUSION_JUDGE_MODEL,
    apiKey,
    maxTokens: 3600,
    temperature: 0.08,
    reasoningEffort: "medium",
    signal,
    messages: [
      { role: "system", content: FUSION_JUDGE_SYSTEM_PROMPT },
      { role: "user", content: buildFusionJudgePrompt(prompt, drafts, debates) },
    ],
  });

  return {
    report: normalizeFusionJudgeReport(parseFusionJudgeJson(completion.content), drafts),
    usage: completion.usage,
  };
}

/**
 * Fase 5E: envoltorio resiliente de `createFusionJudgeReport` — misma
 * secuencia que `runVoteResilient`: retry HTTP interno → credential
 * failover → agotamiento → fallback funcional idéntico al que ya existía
 * (`fallbackFusionJudgeReport`, sin ningún cambio de comportamiento).
 */
export async function createFusionJudgeReportResilient({
  prompt,
  drafts,
  debates,
  signal,
  explicitOpenRouterKey,
  createFusionJudgeReportImpl,
}: {
  prompt: string;
  drafts: Array<{ modelId: string; label: string; content: string }>;
  debates: Array<{ ok: boolean; label: string; critique?: string; revisedAnswer?: string }>;
  signal: AbortSignal;
  explicitOpenRouterKey?: string | null;
  /** Solo para tests — default `createFusionJudgeReport` real. Mismo
   * motivo que `runVoteImpl` en `runVoteResilient`. */
  createFusionJudgeReportImpl?: typeof createFusionJudgeReport;
}): Promise<{ report: FusionJudgeReport; usage?: unknown }> {
  const impl = createFusionJudgeReportImpl ?? createFusionJudgeReport;
  try {
    return await withCredentialFailover(
      "openrouter",
      signal,
      (apiKey) => impl({ prompt, drafts, debates, apiKey, signal }),
      { explicitApiKey: explicitOpenRouterKey },
    );
  } catch {
    return { report: fallbackFusionJudgeReport(drafts, debates) };
  }
}
