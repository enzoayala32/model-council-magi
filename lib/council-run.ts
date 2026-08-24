import { getCouncilModel, type ReasoningEffort } from "@/lib/models";
import { createAgentCompletion, createChatCompletion, type OpenRouterTool, type OpenRouterToolCall } from "@/lib/openrouter";
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
 * Dispatches to the right provider client based on the council model's
 * `provider` field. Every existing model is implicitly "openrouter" (the
 * field is only set for NVIDIA-native and Google-native entries in
 * lib/models.ts). Throws a clear, specific error if a provider-locked model
 * is selected but its API key isn't configured, instead of a confusing
 * failure deep inside that provider's client.
 */
export function runCouncilCompletion(
  modelId: string,
  options: Omit<Parameters<typeof createAgentCompletion>[0], "apiKey"> & { openRouterApiKey: string },
) {
  const model = getCouncilModel(modelId);
  const { openRouterApiKey, ...rest } = options;

  if (model?.provider === "nvidia") {
    const nvidiaApiKey = process.env.NVIDIA_API_KEY;
    if (!nvidiaApiKey) {
      return Promise.reject(
        new Error(`${model.label} requires NVIDIA_API_KEY to be set in .env (get one free at build.nvidia.com).`),
      );
    }
    return createNvidiaAgentCompletion({ ...rest, apiKey: nvidiaApiKey });
  }

  if (model?.provider === "google") {
    const googleApiKey = process.env.GEMINI_API_KEY;
    if (!googleApiKey) {
      return Promise.reject(
        new Error(`${model.label} requires GEMINI_API_KEY to be set in .env (get one free at aistudio.google.com/apikey).`),
      );
    }
    return createGoogleAgentCompletion({ ...rest, apiKey: googleApiKey });
  }

  return createAgentCompletion({ ...rest, apiKey: openRouterApiKey });
}

/* =========================================================
   Round 1 — independent drafts
   ========================================================= */

export async function runDraft({
  modelId,
  prompt,
  attachments,
  history,
  apiKey,
  send,
  offset,
  signal,
  webGrounding,
  skillPrompt,
  personaPrompt,
  tools,
  executeTool,
  reasoningEffort,
}: {
  modelId: string;
  prompt: string;
  attachments: UploadedAttachment[];
  history: ConversationTurn[];
  apiKey: string;
  send: (event: StreamEvent) => void;
  offset: number;
  signal: AbortSignal;
  webGrounding: boolean;
  skillPrompt: string;
  personaPrompt: string;
  tools: OpenRouterTool[];
  executeTool: (toolCall: OpenRouterToolCall, signal?: AbortSignal) => Promise<{ name: string; content: string }>;
  reasoningEffort: ReasoningEffort;
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
   * the seat's identity (modelId/label) never changes downstream. */
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

    return runCouncilCompletion(callModelId, {
      model: callModelId,
      openRouterApiKey: apiKey,
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
    });
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
    const message = error instanceof Error ? error.message : "Model request failed.";
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
        const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : "Fallback model request failed.";
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
  apiKey,
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
}: {
  self: { modelId: string; label: string; content: string };
  others: Array<{ modelId: string; label: string; content: string }>;
  prompt: string;
  history: ConversationTurn[];
  apiKey: string;
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

    const completion = await runCouncilCompletion(self.modelId, {
      model: self.modelId,
      openRouterApiKey: apiKey,
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
    });

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
    const message = error instanceof Error ? error.message : "Debate request failed.";
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
  try {
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
  } catch (error) {
    const rationale = `Vote failed: ${error instanceof Error ? error.message : "unknown error"}`;
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
  try {
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
  } catch {
    return { report: fallbackFusionJudgeReport(drafts, debates) };
  }
}
