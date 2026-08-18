import { AGENT_TOOLS, executeAgentTool } from "@/lib/agent-tools";
import { bufferFromDataUrl, extractDocxText, extractPdfText } from "@/lib/attachment-extraction";
import { FS_TOOLS, executeFsTool, isFsTool, type FileProposal } from "@/lib/fs-tools";
import { COUNCIL_MODELS, IMAGE_MODELS, getCouncilModel, getFusionPanel, getImageModel, isReasoningEffort, type ReasoningEffort } from "@/lib/models";
import { OpenRouterMessageContent, createAgentCompletion, createChatCompletion, createImageGeneration, type OpenRouterTool, type OpenRouterToolCall } from "@/lib/openrouter";
import { createNvidiaAgentCompletion } from "@/lib/nvidia";
import { createGoogleAgentCompletion } from "@/lib/google-ai-studio";
import { renderSkillsForPrompt, type AgentSkill } from "@/lib/skills";

export const maxDuration = 300;

type StreamRequest = {
  prompt?: string;
  selectedModels?: string[];
  fusionPanelId?: string;
  apiKey?: string;
  attachments?: UploadedAttachment[];
  history?: ConversationTurn[];
  webGrounding?: boolean;
  reasoningEffortByModel?: Record<string, string>;
  agentSkills?: AgentSkill[];
  imageSettings?: ImageSettings;
  connectors?: ConnectorSettings;
  /** Which one selected model (if any) gets filesystem tools this run. */
  fileAgentModelId?: string;
  /** How many debate rounds to run at most before forcing the vote/synthesis (1-5, default 3). */
  maxDebateRounds?: number;
};

type ConversationTurn = {
  question: string;
  synthesis: string;
};

type UploadedAttachment = {
  name: string;
  type: string;
  size: number;
  kind: "image" | "text" | "pdf" | "docx" | "file";
  dataUrl?: string;
  text?: string;
};

type Phase = "drafting" | "debating" | "synthesizing" | "done";

type FusionJudgeReport = {
  panelVerdict: string;
  consensus: Array<{ finding: string; models: string[]; evidence: string }>;
  contradictions: Array<{ topic: string; positions: Record<string, string>; judgment: string }>;
  uniqueInsights: Array<{ model: string; insight: string; whyItMatters: string }>;
  coverageGaps: string[];
};

type ImageSettings = {
  enabled?: boolean;
  model?: string;
};

type ConnectorSettings = {
  github?: boolean;
  filesystem?: boolean;
};

type StreamEvent =
  | { type: "run_started"; prompt: string; selectedModels: string[]; fusionPanelId?: string }
  | { type: "phase"; phase: Phase }
  | { type: "model_step"; modelId: string; label: string; step: string; steps: number; status: "thinking"; phase: Phase }
  | { type: "model_complete"; modelId: string; label: string; content: string; steps: number; phase: "drafting"; usage?: unknown }
  | { type: "model_debate_complete"; modelId: string; label: string; critique: string; revisedAnswer?: string; steps: number; usage?: unknown; round: number; maxRounds: number }
  | { type: "model_error"; modelId: string; label: string; error: string; steps: number; phase: Phase }
  | { type: "synthesis_started"; step: string }
  | { type: "fusion_judge_complete"; report: FusionJudgeReport; usage?: unknown }
  | { type: "synthesis_complete"; content: string; usage?: unknown }
  | { type: "image_started"; model: string; prompt: string }
  | { type: "image_complete"; model: string; prompt: string; images: string[]; usage?: unknown }
  | { type: "image_error"; error: string }
  | { type: "followups_complete"; questions: string[]; usage?: unknown }
  | { type: "file_proposal"; modelId: string; proposal: { id: string; kind: "write" | "edit"; path: string; diff: string } }
  | {
      type: "debate_round_complete";
      round: number;
      maxRounds: number;
      participantCount: number;
      convergence: number;
      converged: boolean;
    }
  | { type: "vote_cast"; modelId: string; label: string; votedForModelId: string | null; votedForLabel: string | null; rationale: string; usage?: unknown }
  | {
      type: "vote_tally_complete";
      tally: Array<{ modelId: string; label: string; votes: number }>;
      winnerModelId: string | null;
      winnerLabel: string | null;
      totalVotes: number;
    }
  | { type: "run_complete" }
  | { type: "error"; error: string };

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
const TARGET_SYNTHESIS_TOKENS = 12000;

// Hard ceilings so a phase can NEVER hang the UI forever, even if a model's
// own request + internal retry compounds beyond expectations. If one fires,
// it's logged loudly to the console.
// Sized relative to the per-call timeout in lib/openrouter.ts (7 min) and
// its now-tamed internal retry budget (max 3 attempts, then 2 more on an
// empty-content retry — down from 5+5, which is what let a single call run
// 14+ minutes in a live test before this was tightened).
const PER_CALL_TIMEOUT_MS = 420_000; // keep in sync with lib/openrouter.ts default
const FUSION_JUDGE_WATCHDOG_MS = 8 * 60_000; // has a real fallback, so this can be tight
const SYNTHESIS_WATCHDOG_MS = 10 * 60_000; // applied separately to primary AND fallback attempts
const FOLLOWUP_WATCHDOG_MS = 6 * 60_000; // best-effort, cheap to skip
const FOLLOWUP_MODEL = "nvidia/nemotron-3.5-lightning:free";
const FUSION_JUDGE_MODEL = "nvidia/nemotron-3.5-lightning:free";

export async function POST(request: Request) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: StreamEvent) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      const signal = request.signal;
      const isAborted = () => signal.aborted;

      try {
        const body = (await request.json()) as StreamRequest;
        const prompt = body.prompt?.trim();
        const apiKey = body.apiKey?.trim() || process.env.OPENROUTER_API_KEY;
        const fusionPanelId = typeof body.fusionPanelId === "string" ? body.fusionPanelId : undefined;
        const selectedModels = normalizeSelection(body.selectedModels, fusionPanelId);
        const attachments = await extractAttachmentText(normalizeAttachments(body.attachments));
        const history = normalizeHistory(body.history);
        const webGrounding = Boolean(body.webGrounding);
        const reasoningEffortByModel = normalizeReasoningEfforts(body.reasoningEffortByModel);
        const skillPrompt = renderSkillsForPrompt(normalizeAgentSkills(body.agentSkills));
        const imageSettings = normalizeImageSettings(body.imageSettings);
        const connectorSettings = normalizeConnectorSettings(body.connectors);
        const agentTools = connectorSettings.github ? AGENT_TOOLS : [];
        const fsTools = connectorSettings.filesystem ? FS_TOOLS : [];
        const fileAgentModelId = connectorSettings.filesystem ? body.fileAgentModelId?.trim() : undefined;

        const onFileProposal = (modelId: string, proposal: FileProposal) => {
          send({
            type: "file_proposal",
            modelId,
            proposal: { id: proposal.id, kind: proposal.kind, path: proposal.relPath, diff: proposal.diff },
          });
        };

        /** Tools + a combined executor for one model — only the designated file agent gets fsTools. */
        function toolingFor(modelId: string) {
          const tools = modelId === fileAgentModelId ? [...agentTools, ...fsTools] : agentTools;
          const executeTool = (toolCall: OpenRouterToolCall, toolSignal?: AbortSignal) =>
            isFsTool(toolCall) ? executeFsTool(toolCall, (proposal) => onFileProposal(modelId, proposal)) : executeAgentTool(toolCall, toolSignal);
          return { tools, executeTool };
        }

        if (!prompt) {
          send({ type: "error", error: "Enter a prompt for the council." });
          controller.close();
          return;
        }

        if (!apiKey || apiKey.includes("your-key")) {
          send({
            type: "error",
            error: "Set OPENROUTER_API_KEY in .env or enter a valid OpenRouter key before running.",
          });
          controller.close();
          return;
        }

        send({ type: "run_started", prompt, selectedModels, fusionPanelId });
        logStep("▶▶ RUN START", { promptLength: prompt.length, selectedModels, fusionPanelId, webGrounding });

        // ---------- Round 1 — independent drafts ----------
        if (isAborted()) return;
        send({ type: "phase", phase: "drafting" });

        const draftResults = await Promise.all(
          selectedModels.map((modelId, index) => {
            const { tools, executeTool } = toolingFor(modelId);
            return runDraft({
              modelId,
              prompt,
              attachments,
              history,
              apiKey,
              send,
              offset: index,
              signal,
              webGrounding,
              skillPrompt,
              tools,
              executeTool,
              reasoningEffort: effortFor(modelId, reasoningEffortByModel),
            });
          }),
        );
        const successfulDrafts = draftResults.filter((result) => result.ok && result.content);

        if (isAborted()) return;
        if (!successfulDrafts.length) {
          send({ type: "error", error: "All selected models failed to draft. Check model IDs and OpenRouter access." });
          controller.close();
          return;
        }

        // ---------- Rounds 2..N — debate, looped until convergence or the round cap ----------
        const maxDebateRounds = clamp(Math.round(body.maxDebateRounds ?? 3), 1, 5);
        let debateResults: Array<{ ok: boolean; modelId: string; label: string; critique?: string; revisedAnswer?: string }> = [];
        let roundsRun = 0;
        let currentAnswers: Array<{ modelId: string; label: string; content: string }> = successfulDrafts;

        if (successfulDrafts.length >= 2) {
          for (let round = 1; round <= maxDebateRounds; round++) {
            if (isAborted()) return;
            send({ type: "phase", phase: "debating" });
            const roundResults = await Promise.all(
              currentAnswers.map((self, index) => {
                const { tools, executeTool } = toolingFor(self.modelId);
                return runDebate({
                  self,
                  others: currentAnswers.filter((other) => other.modelId !== self.modelId),
                  prompt,
                  history,
                  apiKey,
                  send,
                  offset: index,
                  signal,
                  skillPrompt,
                  tools,
                  executeTool,
                  reasoningEffort: effortFor(self.modelId, reasoningEffortByModel),
                  round,
                  maxRounds: maxDebateRounds,
                });
              }),
            );
            roundsRun = round;
            debateResults = roundResults;

            const survivors = roundResults.filter(
              (result): result is typeof result & { ok: true } => result.ok,
            );

            currentAnswers = survivors.map((result) => ({
              modelId: result.modelId,
              label: result.label,
              content: result.revisedAnswer || currentAnswers.find((a) => a.modelId === result.modelId)?.content || "",
            }));

            if (survivors.length < 2) break; // not enough models left standing to keep debating

            const convergence = computeConvergence(survivors.map((r) => r.revisedAnswer || ""));
            if (isAborted()) return;
            send({
              type: "debate_round_complete",
              round,
              maxRounds: maxDebateRounds,
              participantCount: survivors.length,
              convergence: convergence.score,
              converged: convergence.converged,
            });
            logStep("✓ debate round DONE", { round, participants: survivors.length, convergence: convergence.score, converged: convergence.converged });
            if (convergence.converged) break;
          }
        }

        // ---------- Final vote — each surviving debater picks the strongest answer ----------
        let voteSummary: string | undefined;
        if (roundsRun >= 1 && currentAnswers.length >= 2) {
          if (isAborted()) return;
          send({ type: "synthesis_started", step: "Council casting final votes on the strongest answer" });
          const votes = await Promise.all(
            currentAnswers.map((self) => runVote({ self, candidates: currentAnswers, prompt, apiKey, send, signal })),
          );
          const { tally, winner, totalVotes } = tallyVotes(votes, currentAnswers);
          if (isAborted()) return;
          send({
            type: "vote_tally_complete",
            tally,
            winnerModelId: winner?.modelId ?? null,
            winnerLabel: winner?.label ?? null,
            totalVotes,
          });
          if (totalVotes > 0) {
            voteSummary = tally
              .filter((t) => t.votes > 0)
              .sort((a, b) => b.votes - a.votes)
              .map((t) => `${t.label}: ${t.votes} vote${t.votes === 1 ? "" : "s"}${winner?.modelId === t.modelId ? " (most votes)" : ""}`)
              .join("\n");
          }
        }

        // ---------- Fusion judge ----------
        if (isAborted()) return;
        send({ type: "phase", phase: "synthesizing" });
        send({ type: "synthesis_started", step: "Judge model extracting consensus, contradictions, unique insights, and gaps" });

        logStep("→ fusion judge START");
        const judgeStartedAt = Date.now();
        const fusionJudge = await withWatchdog(
          createFusionJudgeReport({
            prompt,
            drafts: successfulDrafts,
            debates: debateResults,
            apiKey,
            signal,
          }),
          FUSION_JUDGE_WATCHDOG_MS,
          "Fusion judge",
          () => ({ report: fallbackFusionJudgeReport(successfulDrafts, debateResults), usage: undefined }),
        );
        logStep("✓ fusion judge DONE", { ms: Date.now() - judgeStartedAt });

        if (isAborted()) return;
        send({ type: "fusion_judge_complete", report: fusionJudge.report, usage: fusionJudge.usage });

        // ---------- Synthesis ----------
        send({ type: "synthesis_started", step: "Grounding the final answer in the judge report and council transcripts" });

        const SYNTHESIS_PRIMARY_MODEL = process.env.SYNTHESIS_MODEL ?? "nvidia/nemotron-3.5-lightning:free";
        // If the primary model fails outright even after its own internal
        // rate-limit/empty-content retries, this is the single point of
        // failure that would otherwise kill the whole run — so give it one
        // shot with a different model/provider before giving up entirely.
        // Picked dynamically (not hardcoded) so it's never accidentally the
        // SAME model as the primary — a live run had SYNTHESIS_MODEL
        // env-overridden to openai/gpt-oss-20b:free, which made the
        // hardcoded fallback identical to the primary: both attempts hit
        // the same saturated free-tier model back to back, ~30 minutes lost
        // for nothing.
        const SYNTHESIS_FALLBACK_CANDIDATES = [
          "nvidia/nemotron-3.5-lightning:free",
          "openai/gpt-oss-20b:free",
          "google/gemma-4-26b-a4b-it:free",
        ];
        const SYNTHESIS_FALLBACK_MODEL =
          SYNTHESIS_FALLBACK_CANDIDATES.find((id) => id !== SYNTHESIS_PRIMARY_MODEL) ?? "openai/gpt-oss-20b:free";

        function runSynthesis(modelId: string, apiKeyValue: string, promptValue: string) {
          return createAgentCompletion({
            model: modelId,
            apiKey: apiKeyValue,
            maxTokens: TARGET_SYNTHESIS_TOKENS,
            temperature: 0.18,
            reasoningEffort: "high",
            signal,
            tools: agentTools,
            executeTool: (toolCall, toolSignal) => executeAgentTool(toolCall, toolSignal),
            onToolCall: (toolCall) => {
              send({
                type: "synthesis_started",
                step: `Using ${toolCall.function.name.replace(/_/g, " ")} before final synthesis`,
              });
            },
            messages: [
              {
                role: "system",
                content: [SYNTHESIZER_SYSTEM_PROMPT, skillPrompt].filter(Boolean).join("\n\n"),
              },
              {
                role: "user",
                content: buildSynthesisPrompt(promptValue, successfulDrafts, debateResults, history, fusionJudge.report, voteSummary),
              },
            ],
          });
        }

        logStep("→ synthesis START", { model: SYNTHESIS_PRIMARY_MODEL });
        let synthesis: Awaited<ReturnType<typeof createAgentCompletion>>;
        const primaryStartedAt = Date.now();
        try {
          synthesis = await withWatchdog(runSynthesis(SYNTHESIS_PRIMARY_MODEL, apiKey, prompt), SYNTHESIS_WATCHDOG_MS, "Synthesis");
          logStep("✓ synthesis DONE (primary)", { ms: Date.now() - primaryStartedAt, tokens: synthesis.usage });
        } catch (primaryError) {
          const primaryMessage = primaryError instanceof Error ? primaryError.message : "Synthesis failed.";
          logStep("✗ synthesis FAILED (primary) — trying fallback model", {
            ms: Date.now() - primaryStartedAt,
            error: primaryMessage,
            fallbackModel: SYNTHESIS_FALLBACK_MODEL,
          });
          send({
            type: "synthesis_started",
            step: `${SYNTHESIS_PRIMARY_MODEL} failed — retrying synthesis with ${SYNTHESIS_FALLBACK_MODEL}`,
          });
          const fallbackStartedAt = Date.now();
          try {
            synthesis = await withWatchdog(runSynthesis(SYNTHESIS_FALLBACK_MODEL, apiKey, prompt), SYNTHESIS_WATCHDOG_MS, "Synthesis (fallback)");
            logStep("✓ synthesis DONE (fallback)", { ms: Date.now() - fallbackStartedAt, tokens: synthesis.usage });
          } catch (fallbackError) {
            const message = fallbackError instanceof Error ? fallbackError.message : "Synthesis failed.";
            logStep("✗ synthesis FAILED (fallback too)", { ms: Date.now() - fallbackStartedAt, error: message });
            throw fallbackError;
          }
        }

        if (isAborted()) return;
        send({ type: "synthesis_complete", content: synthesis.content, usage: synthesis.usage });

        if (imageSettings.enabled) {
          const imageModel = imageSettings.model;
          const imagePrompt = buildImagePrompt(prompt, synthesis.content);
          try {
            send({ type: "image_started", model: imageModel, prompt: imagePrompt });
            const generated = await createImageGeneration({
              model: imageModel,
              prompt: imagePrompt,
              apiKey,
              signal,
            });
            if (isAborted()) return;
            send({
              type: "image_complete",
              model: generated.model,
              prompt: imagePrompt,
              images: generated.images,
              usage: generated.usage,
            });
          } catch (error) {
            if (isAborted()) return;
            logStep("✗ image generation FAILED", { error: error instanceof Error ? error.message : String(error) });
            send({ type: "image_error", error: error instanceof Error ? error.message : "Image generation failed." });
          }
        }

        logStep("→ follow-ups START");
        try {
          const followUps = await withWatchdog(
            createChatCompletion({
              model: process.env.FOLLOWUP_MODEL ?? FOLLOWUP_MODEL,
              apiKey,
              maxTokens: 1400,
              temperature: 0.35,
              reasoningEffort: "low",
              signal,
              messages: buildFollowUpMessages(prompt, synthesis.content),
            }),
            FOLLOWUP_WATCHDOG_MS,
            "Follow-ups",
          );

          if (isAborted()) return;
          logStep("✓ follow-ups DONE");
          send({
            type: "followups_complete",
            questions: parseFollowUpQuestions(followUps.content),
            usage: followUps.usage,
          });
        } catch (error) {
          if (isAborted()) return;
          logStep("✗ follow-ups FAILED (non-fatal, continuing)", { error: error instanceof Error ? error.message : String(error) });
          send({ type: "followups_complete", questions: [] });
        }

        logStep("✓✓ RUN COMPLETE");
        send({ type: "phase", phase: "done" });
        send({ type: "run_complete" });
      } catch (error) {
        if (isAborted() || (error instanceof Error && error.name === "AbortError")) {
          logStep("⏹ RUN ABORTED (client cancelled)");
          // client cancelled; quietly close
        } else {
          const message = error instanceof Error ? error.message : "Council stream failed.";
          logStep("✗✗ RUN FAILED", { error: message, stack: error instanceof Error ? error.stack : undefined });
          send({ type: "error", error: message });
        }
      } finally {
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

/* =========================================================
   Round 1 — independent draft
   ========================================================= */

/**
 * Dispatches to the right provider client based on the council model's
 * `provider` field. Every existing model is implicitly "openrouter" (the
 * field is only set for NVIDIA-native and Google-native entries in
 * lib/models.ts). Throws a clear, specific error if a provider-locked model
 * is selected but its API key isn't configured, instead of a confusing
 * failure deep inside that provider's client.
 */
function runCouncilCompletion(
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

async function runDraft({
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
  try {
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

    const completion = await runCouncilCompletion(modelId, {
      model: modelId,
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
      messages: buildDraftMessages(prompt, attachments, history, webGrounding, model?.supportsImages ?? true, skillPrompt),
    });

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
    logStep(`✗ draft FAILED`, { modelId, ms: Date.now() - draftStartedAt, error: message });
    send({ type: "model_error", modelId, label, error: message, steps: steps + 2, phase: "drafting" });
    return { ok: false as const, modelId, label, content: "", error: message };
  }
}

/* =========================================================
   Round 2 — debate (each model sees the others)
   ========================================================= */

async function runDebate({
  self,
  others,
  prompt,
  history,
  apiKey,
  send,
  offset,
  signal,
  skillPrompt,
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
  tools: OpenRouterTool[];
  executeTool: (toolCall: OpenRouterToolCall, signal?: AbortSignal) => Promise<{ name: string; content: string }>;
  reasoningEffort: ReasoningEffort;
  round: number;
  maxRounds: number;
}) {
  const model = getCouncilModel(self.modelId);
  void model;
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
        { role: "system", content: [debateSystemPrompt(round, maxRounds), skillPrompt].filter(Boolean).join("\n\n") },
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
    logStep(`✗ debate FAILED`, { modelId: self.modelId, ms: Date.now() - debateStartedAt, error: message });
    send({ type: "model_error", modelId: self.modelId, label: self.label, error: message, steps: steps + 2, phase: "debating" });
    return { ok: false as const, modelId: self.modelId, label: self.label };
  }
}

/* =========================================================
   Prompts
   ========================================================= */

const COUNCIL_MEMBER_SYSTEM_PROMPT = [
  "You are an independent expert member of a Model Council. Other frontier models will answer the same prompt in parallel; you will then debate them. So produce your strongest, most defensible answer up front.",
  "",
  "Length and depth:",
  "• Aim for a thorough long-form answer (typically 1,200–2,500 words for substantive questions).",
  "• Do not pad. Length should come from real coverage: more sub-claims, more evidence, more concrete examples, more numbers, more named entities, more counterexamples.",
  "• Prefer specific facts, numbers, dates, names, and named mechanisms over generalities.",
  "",
  "Reasoning standard:",
  "• Stress-test your own conclusion. Name the strongest counterargument and respond to it.",
  "• Be explicit about confidence (high / medium / low) and what evidence would change your view.",
  "• If the question is contested or ambiguous, decompose it before answering.",
  "• Integrate any uploaded attachments explicitly when relevant.",
  "",
  "Required structure (use these markdown headings, in this order):",
  "## Direct Answer",
  "A self-contained 4–8 sentence answer that resolves the user's actual question. No throat-clearing.",
  "## Key Reasoning",
  "Numbered points (5–10) walking through the load-bearing logic. Each point should add a distinct argument or piece of evidence.",
  "## Evidence and Signals",
  "Concrete data, sources, mechanisms, named studies, or examples that support the reasoning. Be specific.",
  "## Assumptions",
  "What you are assuming about scope, context, or definitions. Surface anything the user may want to override.",
  "## Risks and Counterarguments",
  "The strongest case against your answer, and where it actually gains traction.",
  "## What Would Change My View",
  "Specific evidence, results, or arguments that would meaningfully shift your conclusion.",
  "## Final Recommendation",
  "Crisp, actionable, prioritized. If a decision is implied, make it.",
  "",
  "Do not reveal hidden chain-of-thought. Provide concise, auditable reasoning summaries only.",
].join("\n");

function debateSystemPrompt(round: number, maxRounds: number): string {
  const roundNote =
    round === 1
      ? "This is the first debate round."
      : round === maxRounds
        ? `This is the FINAL debate round (${round} of ${maxRounds}). If the council has substantially converged, say so plainly and stop re-litigating minor phrasing — spend your words on any real disagreement that remains.`
        : `This is debate round ${round} of ${maxRounds}. If you now agree with the others on a point from a previous round, don't re-argue it — note the agreement briefly and move on to what's still unresolved.`;

  return [
    "You are a member of a Model Council in the debate round. You have already produced an initial draft. Now you can see the other council members' latest answers.",
    roundNote,
    "",
    "Your job:",
    "• Engage substantively. Identify real disagreements, factual errors, missing considerations, weaker reasoning, or stronger framings in the other answers.",
    "• Defend your own position where you still believe it is correct, with specific reasons.",
    "• Update your own position where another member made a stronger case. Intellectual honesty over consistency.",
    "• Avoid sycophancy. Do not say 'great point' — say what is right or wrong and why.",
    "• Do not pile on agreement. If you agree, say so once and add what is still missing.",
    "",
    "Length: aim for a substantial 600–1,500 word debate response. Concrete > diplomatic.",
    "",
    "Required structure (use these exact markdown headings):",
    "## Critique",
    "Per-model critique. For each other model, name it as a sub-section (### <model name>) and give 2–5 specific points. Cite their wording when useful.",
    "## Where I Was Wrong",
    "Anything in your own draft you now think was incorrect, oversimplified, or missing. Be honest. Say 'nothing to update' only if you genuinely mean it.",
    "## Where I Stand Firm",
    "Claims from your draft you still believe, with the strongest reason each, in light of the other answers.",
    "## Revised Answer",
    "Your updated final answer to the user's original question, integrating any updates. Aim for at least 400 words. Self-contained — a reader should be able to skip everything above.",
    "",
    "Do not reveal hidden chain-of-thought. Provide concise, auditable reasoning summaries only.",
  ].join("\n");
}

const SYNTHESIZER_SYSTEM_PROMPT = [
  "You are the final synthesizer of a Model Council. You will receive the user's original question, each council member's independent draft, and (when present) each member's debate response that critiqued the others and revised their position.",
  "You may also receive a Fusion judge report that extracts consensus points, contradictions, partial coverage, unique insights, and coverage gaps. Treat it as the structural map for synthesis, while still checking the raw drafts.",
  "",
  "Your job is to produce a single rigorous, in-depth, user-ready answer. This is the artifact the user actually reads. Do not write a meta-summary of the council process — write the answer.",
  "",
  "Length and depth:",
  "• Produce a thorough long-form answer (typically 1,500–3,500 words for substantive questions).",
  "• Length must come from real coverage: more sub-claims, more concrete examples, more numbers, more named entities, more nuance.",
  "• Where the council converged, state the conclusion directly with confidence.",
  "• Where the council diverged, explain the disagreement, take a position with reasons, and surface the conditions under which each side would be right.",
  "",
  "Required structure (use these markdown headings, in this order):",
  "## Bottom Line",
  "A 4–8 sentence answer to the user's question. The user should be able to read only this and walk away with the right answer.",
  "## In-Depth Answer",
  "The full long-form answer. Use sub-headings (###) liberally. Numbered or bulleted lists where they add structure. Concrete examples. Specific numbers where credible.",
  "## Where the Council Agreed",
  "The high-confidence shared findings. For each, briefly cite which models converged.",
  "## Where the Council Disagreed",
  "Each real disagreement as its own bulleted item. State each side, the strongest reason for each, and your reconciled judgment.",
  "## Unique Insights",
  "Non-overlapping observations a single model contributed that meaningfully strengthen the answer.",
  "## Confidence and Open Questions",
  "What is high-confidence, what is contested, and what would need fresh evidence to resolve.",
  "## Recommended Next Steps",
  "Concrete, prioritized actions or follow-up questions for the user.",
  "",
  "Style:",
  "• No throat-clearing, no apologies, no 'as the council noted.' Speak directly to the user.",
  "• Be specific. Avoid generic advice. Force prioritization where multiple options exist.",
  "• Do not reveal hidden chain-of-thought. Provide concise, auditable reasoning summaries only.",
].join("\n");

const FUSION_JUDGE_SYSTEM_PROMPT = [
  "You are the judge model in a Fusion-style compound model pipeline.",
  "You receive independent model drafts and optional debate revisions. Extract the answer structure that a synthesizer should trust.",
  "",
  "Return JSON only. No markdown, no commentary.",
  "Schema:",
  "{",
  '  "panelVerdict": "one sentence on what the panel most strongly supports",',
  '  "consensus": [{"finding": "shared finding", "models": ["model labels"], "evidence": "why this is supported"}],',
  '  "contradictions": [{"topic": "disagreement topic", "positions": {"model label": "position"}, "judgment": "how to reconcile or who is stronger"}],',
  '  "uniqueInsights": [{"model": "model label", "insight": "distinct useful point", "whyItMatters": "why it changes the answer"}],',
  '  "coverageGaps": ["important missing or uncertain issue"]',
  "}",
  "",
  "Keep entries concise and concrete. Do not invent sources. If there is no real disagreement, return a short empty contradictions array.",
  "Do not reveal hidden chain-of-thought. Provide only auditable summaries.",
].join("\n");

async function createFusionJudgeReport({
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

function buildFusionJudgePrompt(
  prompt: string,
  drafts: Array<{ label: string; content: string }>,
  debates: Array<{ ok: boolean; label: string; critique?: string; revisedAnswer?: string }>,
) {
  const sections = [`# User question\n${prompt}`, "", "# Independent drafts"];
  for (const draft of drafts) {
    sections.push(`## ${draft.label}\n${compactForHistory(draft.content, 5000)}`);
  }

  const validDebates = debates.filter((debate) => debate.ok && (debate.critique || debate.revisedAnswer));
  if (validDebates.length) {
    sections.push("", "# Debate outputs");
    for (const debate of validDebates) {
      sections.push(
        [
          `## ${debate.label}`,
          debate.critique ? `### Critique\n${compactForHistory(debate.critique, 2200)}` : "",
          debate.revisedAnswer ? `### Revised answer\n${compactForHistory(debate.revisedAnswer, 2200)}` : "",
        ].filter(Boolean).join("\n\n"),
      );
    }
  }

  return sections.join("\n\n");
}

function parseFusionJudgeJson(content: string): unknown {
  const trimmed = content.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim() ?? trimmed;
  try {
    return JSON.parse(fenced);
  } catch {
    const start = fenced.indexOf("{");
    const end = fenced.lastIndexOf("}");
    if (start < 0 || end <= start) return {};
    try {
      return JSON.parse(fenced.slice(start, end + 1));
    } catch {
      return {};
    }
  }
}

function normalizeFusionJudgeReport(input: unknown, drafts: Array<{ label: string; content: string }>): FusionJudgeReport {
  if (!input || typeof input !== "object") return fallbackFusionJudgeReport(drafts, []);
  const value = input as Partial<FusionJudgeReport>;
  const labels = new Set(drafts.map((draft) => draft.label));

  return {
    panelVerdict: typeof value.panelVerdict === "string" && value.panelVerdict.trim()
      ? value.panelVerdict.trim().slice(0, 600)
      : "The panel produced enough overlapping signal for a synthesized answer, with model-specific caveats.",
    consensus: Array.isArray(value.consensus)
      ? value.consensus.slice(0, 6).map((item) => ({
          finding: typeof item?.finding === "string" ? item.finding.slice(0, 700) : "Shared finding",
          models: Array.isArray(item?.models)
            ? item.models.filter((model): model is string => typeof model === "string" && (!labels.size || labels.has(model))).slice(0, 8)
            : [],
          evidence: typeof item?.evidence === "string" ? item.evidence.slice(0, 700) : "Supported by multiple council drafts.",
        })).filter((item) => item.finding.trim())
      : [],
    contradictions: Array.isArray(value.contradictions)
      ? value.contradictions.slice(0, 5).map((item) => ({
          topic: typeof item?.topic === "string" ? item.topic.slice(0, 240) : "Disagreement",
          positions: item?.positions && typeof item.positions === "object"
            ? Object.fromEntries(
                Object.entries(item.positions)
                  .filter(([model, position]) => typeof position === "string" && (!labels.size || labels.has(model)))
                  .slice(0, 8)
                  .map(([model, position]) => [model, position.slice(0, 500)]),
              )
            : {},
          judgment: typeof item?.judgment === "string" ? item.judgment.slice(0, 700) : "The synthesizer should reconcile this point explicitly.",
        })).filter((item) => item.topic.trim())
      : [],
    uniqueInsights: Array.isArray(value.uniqueInsights)
      ? value.uniqueInsights.slice(0, 8).map((item) => ({
          model: typeof item?.model === "string" ? item.model.slice(0, 180) : "Council model",
          insight: typeof item?.insight === "string" ? item.insight.slice(0, 700) : "Distinct contribution",
          whyItMatters: typeof item?.whyItMatters === "string" ? item.whyItMatters.slice(0, 700) : "It adds coverage beyond the consensus.",
        })).filter((item) => item.insight.trim())
      : [],
    coverageGaps: Array.isArray(value.coverageGaps)
      ? value.coverageGaps.filter((gap): gap is string => typeof gap === "string").map((gap) => gap.slice(0, 400)).slice(0, 6)
      : [],
  };
}

function fallbackFusionJudgeReport(
  drafts: Array<{ label: string; content: string }>,
  debates: Array<{ ok: boolean; label: string; critique?: string; revisedAnswer?: string }>,
): FusionJudgeReport {
  const labels = drafts.map((draft) => draft.label);
  const debated = debates.filter((debate) => debate.ok && (debate.critique || debate.revisedAnswer)).map((debate) => debate.label);
  return {
    panelVerdict: labels.length > 1
      ? `The panel should synthesize ${labels.join(", ")} and give extra weight to claims that survived debate.`
      : "The selected model produced a solo answer; no cross-model consensus was available.",
    consensus: [
      {
        finding: "Use overlapping claims across the independent drafts as the highest-confidence signal.",
        models: labels,
        evidence: "The fallback judge could not parse a structured report, so the synthesizer must rely on the raw transcripts.",
      },
    ],
    contradictions: debated.length
      ? [
          {
            topic: "Debate revisions",
            positions: Object.fromEntries(debated.map((label) => [label, "Submitted critique or revised answer."])),
            judgment: "Prioritize revisions that identify concrete errors, missing evidence, or stronger framing.",
          },
        ]
      : [],
    uniqueInsights: drafts.slice(0, 4).map((draft) => ({
      model: draft.label,
      insight: compactForHistory(draft.content.replace(/\s+/g, " "), 220),
      whyItMatters: "This model's draft may contain non-overlapping context for the final synthesis.",
    })),
    coverageGaps: ["Verify any time-sensitive or source-dependent claims before treating them as final."],
  };
}

function buildSynthesisPrompt(
  prompt: string,
  drafts: Array<{ label: string; content: string }>,
  debates: Array<{ ok: boolean; label: string; critique?: string; revisedAnswer?: string }>,
  history: ConversationTurn[],
  judgeReport?: FusionJudgeReport,
  voteSummary?: string,
) {
  const sections: string[] = [];
  const historyBlock = renderHistoryBlock(history);
  if (historyBlock) sections.push(historyBlock);
  sections.push(`# Current user question\n${prompt}`, "", "# Round 1 — independent drafts");

  for (const draft of drafts) {
    sections.push(`## ${draft.label} — initial draft\n${draft.content}`);
  }

  const validDebates = debates.filter((d) => d.ok && (d.critique || d.revisedAnswer));
  if (validDebates.length) {
    sections.push("", "# Round 2 — debate (each model sees the others' drafts)");
    for (const debate of validDebates) {
      const block: string[] = [`## ${debate.label} — debate`];
      if (debate.critique) block.push(`### Critique of others\n${debate.critique}`);
      if (debate.revisedAnswer) block.push(`### Revised answer\n${debate.revisedAnswer}`);
      sections.push(block.join("\n\n"));
    }
  }

  if (judgeReport) {
    sections.push(
      "",
      "# Fusion judge report",
      "Use this structured judge report as the map for the final answer. Do not copy it mechanically; resolve it into a natural user-facing synthesis.",
      JSON.stringify(judgeReport, null, 2),
    );
  }

  if (voteSummary) {
    sections.push("", "# Council vote", "After debate concluded, each surviving model voted for the strongest final answer (including itself). Use this as one more signal, not a binding rule.", voteSummary);
  }

  sections.push(
    "",
    history.length
      ? "This is a follow-up question in an ongoing thread. Stay strictly relevant to the user's current question, but use the prior conversation as context: do not contradict earlier conclusions without explanation, and reference earlier findings when they are load-bearing. Do not repeat the entire previous answer — build on it."
      : "Now produce the final synthesized answer using the exact heading structure from your system instructions. Be specific and long-form. Do not summarize the process — answer the question.",
  );
  return sections.join("\n\n");
}

function buildFollowUpMessages(prompt: string, synthesis: string) {
  return [
    {
      role: "system" as const,
      content: [
        "You generate follow-up questions for a completed AI council answer.",
        "Return exactly four questions as a JSON array of strings.",
        "Every question must be directly grounded in the final synthesis and useful as the user's next click.",
        "Do not use generic templates. Do not mention inflation, the Fed, benchmarks, or unrelated demo topics unless they are actually in the synthesis.",
        "Keep each question under 120 characters.",
        "Return JSON only.",
      ].join(" "),
    },
    {
      role: "user" as const,
      content: [
        `Original user question:\n${prompt}`,
        "",
        `Final synthesis:\n${compactForHistory(synthesis, 7000)}`,
      ].join("\n"),
    },
  ];
}

function parseFollowUpQuestions(content: string) {
  const parsed = parseQuestionJson(content);
  const candidates = parsed.length
    ? parsed
    : content
        .split(/\r?\n/)
        .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, "").trim())
        .filter(Boolean);

  const seen = new Set<string>();
  const questions: string[] = [];
  for (const candidate of candidates) {
    const question = candidate.replace(/^["']|["']$/g, "").trim();
    if (!question || !question.endsWith("?") || seen.has(question.toLowerCase())) continue;
    seen.add(question.toLowerCase());
    questions.push(question.length > 160 ? `${question.slice(0, 157).trim()}?` : question);
    if (questions.length === 4) break;
  }
  return questions;
}

function parseQuestionJson(content: string): string[] {
  const trimmed = content.trim();
  const jsonBlock = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim() ?? trimmed;
  try {
    const parsed = JSON.parse(jsonBlock);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    const start = jsonBlock.indexOf("[");
    const end = jsonBlock.lastIndexOf("]");
    if (start < 0 || end <= start) return [];
    try {
      const parsed = JSON.parse(jsonBlock.slice(start, end + 1));
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
    } catch {
      return [];
    }
  }
}

function renderHistoryBlock(history: ConversationTurn[]) {
  if (!history.length) return "";
  const turns = history.map((turn, index) => {
    const summary = compactForHistory(turn.synthesis, 1800);
    return `### Turn ${index + 1}\n**Question:** ${turn.question}\n\n**Council's prior answer (excerpt):**\n${summary}`;
  });
  return [
    "# Conversation so far",
    "Earlier in this thread, the user asked these questions and the council answered. Use this as context — the current question is a follow-up.",
    ...turns,
  ].join("\n\n");
}

function buildDraftMessages(
  prompt: string,
  attachments: UploadedAttachment[],
  history: ConversationTurn[],
  webGrounding = false,
  supportsImages = true,
  skillPrompt = "",
) {
  let systemPrompt = history.length
    ? `${COUNCIL_MEMBER_SYSTEM_PROMPT}\n\nThis is a follow-up question inside an existing thread. The user's earlier questions and the council's prior answers are provided. Stay strictly on-topic to the current question, treat prior answers as established context, and do not re-derive earlier conclusions unless the user is challenging them.`
    : COUNCIL_MEMBER_SYSTEM_PROMPT;
  if (webGrounding) {
    systemPrompt = `${systemPrompt}\n\nWeb grounding is enabled. Live web search results will be injected before your response. Treat them as authoritative for time-sensitive facts. When you use a search result, cite it inline as a markdown link to the source URL. Prefer recent, primary sources. If results conflict, say which you trust and why.`;
  }
  if (skillPrompt) {
    systemPrompt = `${systemPrompt}\n\n${skillPrompt}`;
  }

  const userText = history.length
    ? [renderHistoryBlock(history), `# Current user question\n${prompt}`].join("\n\n")
    : prompt;

  return [
    { role: "system" as const, content: systemPrompt },
    { role: "user" as const, content: buildUserContent(userText, attachments, supportsImages) },
  ];
}

function compactForHistory(content: string, max: number) {
  const trimmed = content.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}…`;
}

function normalizeHistory(history: ConversationTurn[] | undefined): ConversationTurn[] {
  if (!Array.isArray(history)) return [];
  return history
    .filter((turn): turn is ConversationTurn =>
      typeof turn?.question === "string" && typeof turn?.synthesis === "string" && turn.question.trim().length > 0,
    )
    .slice(-6);
}

function normalizeAgentSkills(skills: AgentSkill[] | undefined): AgentSkill[] {
  if (!Array.isArray(skills)) return [];
  return skills
    .filter((skill): skill is AgentSkill =>
      Boolean(skill)
      && typeof skill.id === "string"
      && typeof skill.name === "string"
      && typeof skill.body === "string",
    )
    .map((skill) => ({
      id: skill.id.slice(0, 120),
      name: skill.name.slice(0, 120),
      description: (skill.description ?? "").slice(0, 500),
      body: skill.body.slice(0, 12000),
      enabled: Boolean(skill.enabled),
      createdAt: typeof skill.createdAt === "number" ? skill.createdAt : Date.now(),
    }))
    .slice(0, 12);
}

function splitDebateOutput(content: string) {
  // Try to split on "## Revised Answer" — keep everything above as the critique block.
  const match = content.match(/^([\s\S]*?)\n##\s+Revised Answer\s*\n([\s\S]+)$/i);
  if (!match) {
    return { critique: content.trim(), revisedAnswer: undefined as string | undefined };
  }
  return { critique: match[1].trim(), revisedAnswer: match[2].trim() };
}

/* =========================================================
   Convergence detection — lexical heuristic, no extra LLM calls.
   Deliberately cheap and free: average pairwise Jaccard similarity of
   each answer's top recurring significant words (see
   toSignificantWordSet below for why top-words instead of full text).
   This catches the common case where models genuinely converge (they
   tend to reuse similar core terminology once they agree, having just
   read each other's text), not full semantic equivalence — it can
   miss agreement expressed in very different words. Good enough as a
   "stop debating, you're already aligned" signal without adding cost
   or latency per round.
   ========================================================= */

const CONVERGENCE_THRESHOLD = 0.25;
const CONVERGENCE_TOP_WORDS = 15;

const CONVERGENCE_STOPWORDS = new Set([
  "the", "and", "for", "are", "with", "that", "this", "from", "have", "has", "was", "were", "will",
  "would", "could", "should", "not", "but", "its", "their", "them", "they", "you", "your", "our",
  "about", "into", "also", "than", "then", "these", "those", "such", "more", "most", "some", "any",
  "all", "can", "may", "might", "must", "only", "other", "over", "under", "between", "which", "what",
  "when", "where", "how", "why", "who", "whom", "whose", "been", "being", "because", "however",
  "therefore", "thus", "hence", "here", "there", "after", "before", "while", "still", "even", "just",
  "like", "much", "many", "one", "two", "get", "gets", "made", "make", "makes", "instead",
  "para", "como", "esto", "esta", "estos", "estas", "pero", "porque",
  "entre", "sobre", "cuando", "donde", "cual", "cuales", "sus", "una", "uno", "los", "las", "del",
]);

/**
 * Each answer's set of most-frequently-repeated significant words — not
 * every unique word in the whole essay. A 600-1500 word debate response
 * has hundreds of incidental words (examples, transitions, one-off
 * phrasing) that dilute a plain whole-document Jaccard score to near-zero
 * even when two answers reach the same conclusion for the same reasons.
 * Concentrating on each answer's own top ~15 recurring terms — the words
 * it keeps coming back to — tracks shared *topic and conclusion*
 * vocabulary far better. Calibrated against hand-written before/after
 * debate examples: clearly divergent answers score ~0, answers that
 * agree on substance but differ in phrasing land ~0.25-0.35, near
 * restatements land ~0.5+.
 */
function toSignificantWordSet(text: string): Set<string> {
  const words =
    text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .match(/[a-z0-9]+/g) ?? [];
  const freq = new Map<string, number>();
  for (const word of words) {
    if (word.length <= 2 || CONVERGENCE_STOPWORDS.has(word)) continue;
    freq.set(word, (freq.get(word) ?? 0) + 1);
  }
  return new Set(
    [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, CONVERGENCE_TOP_WORDS)
      .map(([word]) => word),
  );
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  let intersection = 0;
  for (const word of a) if (b.has(word)) intersection++;
  const union = a.size + b.size - intersection;
  return union ? intersection / union : 1;
}

function computeConvergence(answers: string[]): { score: number; converged: boolean } {
  const usable = answers.filter(Boolean);
  if (usable.length < 2) return { score: 1, converged: true };
  const wordSets = usable.map(toSignificantWordSet);
  let total = 0;
  let pairs = 0;
  for (let i = 0; i < wordSets.length; i++) {
    for (let j = i + 1; j < wordSets.length; j++) {
      total += jaccardSimilarity(wordSets[i], wordSets[j]);
      pairs++;
    }
  }
  const score = pairs ? total / pairs : 1;
  return { score, converged: score >= CONVERGENCE_THRESHOLD };
}

/* =========================================================
   Final vote — after debate rounds conclude, each surviving model
   casts one vote for the strongest final answer (its own allowed).
   Unlike convergence detection this DOES cost one short LLM call per
   model — the user explicitly asked for a real vote, not another
   heuristic.
   ========================================================= */

const VOTE_SYSTEM_PROMPT = [
  "You are a member of a Model Council. The debate has concluded. You will see the final answer from every council member, including your own, each labeled with the model's name.",
  "Vote for the single strongest, most accurate, most complete final answer for the user's question. It is fine to vote for your own if you genuinely still believe it is best — do not vote strategically or out of false modesty.",
  "Respond in EXACTLY this format and nothing else, no preamble:",
  "VOTE: <exact model label as shown>",
  "REASON: <one specific sentence>",
].join("\n");

function buildVotePrompt(prompt: string, candidates: Array<{ label: string; content: string }>) {
  const sections = [`# User question\n${prompt}`, "", "# Final answers"];
  for (const candidate of candidates) {
    sections.push(`## ${candidate.label}\n${compactForHistory(candidate.content, 3000)}`);
  }
  return sections.join("\n\n");
}

function parseVote(
  content: string,
  candidates: Array<{ modelId: string; label: string }>,
): { votedFor: { modelId: string; label: string } | null; rationale: string } {
  const voteMatch = content.match(/VOTE:\s*(.+)/i);
  const reasonMatch = content.match(/REASON:\s*(.+)/i);
  const rationale = reasonMatch?.[1]?.trim() || "";
  if (!voteMatch) return { votedFor: null, rationale };

  const raw = voteMatch[1].trim().toLowerCase();
  const votedFor =
    candidates.find((c) => c.label.toLowerCase() === raw)
    ?? candidates.find((c) => raw.includes(c.label.toLowerCase()) || c.label.toLowerCase().includes(raw))
    ?? null;
  return { votedFor: votedFor ? { modelId: votedFor.modelId, label: votedFor.label } : null, rationale };
}

async function runVote({
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

function tallyVotes(
  votes: Array<{ modelId: string; label: string; votedFor: string | null }>,
  candidates: Array<{ modelId: string; label: string }>,
) {
  const counts = new Map<string, number>();
  for (const vote of votes) {
    if (!vote.votedFor) continue;
    counts.set(vote.votedFor, (counts.get(vote.votedFor) ?? 0) + 1);
  }
  const tally = candidates.map((c) => ({ modelId: c.modelId, label: c.label, votes: counts.get(c.modelId) ?? 0 }));
  let winner: { modelId: string; label: string } | null = null;
  let max = 0;
  for (const entry of tally) {
    if (entry.votes > max) {
      max = entry.votes;
      winner = { modelId: entry.modelId, label: entry.label };
    }
  }
  const totalVotes = votes.filter((v) => v.votedFor).length;
  return { tally, winner: max > 0 ? winner : null, totalVotes };
}

/** Extracts a single markdown "## Heading" section's body from a draft,
 * stopping at the next "## " heading or the end of the string. */
function extractSection(content: string, heading: string): string | null {
  const pattern = new RegExp(`##\\s+${heading}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`, "i");
  const match = content.match(pattern);
  return match ? match[1].trim() : null;
}

const PEER_CONTEXT_FALLBACK_CHARS = 900;

/**
 * Condenses a council member's draft down to the load-bearing sections
 * before showing it to a DIFFERENT model during the debate round.
 *
 * Every draft follows a fixed structure (see COUNCIL_MEMBER_SYSTEM_PROMPT):
 * Direct Answer, Key Reasoning, Evidence and Signals, Assumptions, Risks and
 * Counterarguments, What Would Change My View, Final Recommendation. A peer
 * needs enough to critique the *argument* — the direct answer, the numbered
 * reasoning, and the final call — but not the full evidence/assumptions/risk
 * sections, which is where most of the length (and duplication cost) lives.
 *
 * This is the "sparse/summarized peer context" pattern from multi-agent
 * debate research (e.g. Li et al. 2024, S²-MAD): each agent still gets its
 * OWN full draft, only what it reads about OTHERS gets condensed. Reported
 * token savings in that line of work run 40-95% with no accuracy loss,
 * because the trimmed sections are supporting detail, not the claims being
 * debated.
 *
 * Falls back to a plain character-limit truncation if a model didn't follow
 * the expected heading structure, so nothing breaks for an off-format draft.
 */
function condenseDraftForPeers(content: string): string {
  const directAnswer = extractSection(content, "Direct Answer");
  const keyReasoning = extractSection(content, "Key Reasoning");
  const finalRecommendation = extractSection(content, "Final Recommendation");

  if (!directAnswer && !keyReasoning && !finalRecommendation) {
    return content.length > PEER_CONTEXT_FALLBACK_CHARS
      ? `${content.slice(0, PEER_CONTEXT_FALLBACK_CHARS).trim()}…`
      : content;
  }

  const parts: string[] = [];
  if (directAnswer) parts.push(`## Direct Answer\n${directAnswer}`);
  if (keyReasoning) parts.push(`## Key Reasoning\n${keyReasoning}`);
  if (finalRecommendation) parts.push(`## Final Recommendation\n${finalRecommendation}`);
  return parts.join("\n\n");
}

/* =========================================================
   Helpers
   ========================================================= */

function normalizeReasoningEfforts(input: Record<string, string> | undefined): Record<string, ReasoningEffort> {
  if (!input || typeof input !== "object") return {};
  const out: Record<string, ReasoningEffort> = {};
  for (const [modelId, effort] of Object.entries(input)) {
    if (isReasoningEffort(effort)) out[modelId] = effort;
  }
  return out;
}

function effortFor(modelId: string, overrides: Record<string, ReasoningEffort>): ReasoningEffort {
  const override = overrides[modelId];
  if (override) return override;
  return getCouncilModel(modelId)?.defaultReasoningEffort ?? "medium";
}

function normalizeSelection(selectedModels: string[] | undefined, fusionPanelId?: string) {
  const knownIds = new Set(COUNCIL_MODELS.map((model) => model.id));
  const panelModels = fusionPanelId ? getFusionPanel(fusionPanelId)?.modelIds : undefined;
  const requested = (selectedModels ?? [])
    .filter((id): id is string => typeof id === "string")
    .filter((id) => knownIds.has(id));

  const fallback = COUNCIL_MODELS.filter((model) => model.defaultSelected).map((model) => model.id);
  return Array.from(new Set(panelModels?.length ? panelModels : requested.length ? requested : fallback)).slice(0, 7);
}

function normalizeAttachments(attachments: UploadedAttachment[] | undefined) {
  return (attachments ?? [])
    .filter((attachment) => attachment.name && attachment.type && typeof attachment.size === "number")
    .slice(0, 8);
}

/**
 * Turns pdf/docx attachments into plain-text ones (kind: "text") by running
 * the actual extraction, once per attachment regardless of how many council
 * models end up seeing it. Everything else passes through unchanged.
 * buildUserContent() already knows how to render a "text" attachment, so no
 * downstream prompt-building code needs to know pdf/docx ever existed.
 */
async function extractAttachmentText(attachments: UploadedAttachment[]): Promise<UploadedAttachment[]> {
  return Promise.all(
    attachments.map(async (attachment) => {
      if (attachment.kind !== "pdf" && attachment.kind !== "docx") return attachment;
      if (!attachment.dataUrl) {
        return { ...attachment, kind: "text" as const, text: "(This file was not uploaded correctly — no content received.)" };
      }
      const buffer = bufferFromDataUrl(attachment.dataUrl);
      const text = attachment.kind === "pdf" ? await extractPdfText(buffer) : await extractDocxText(buffer);
      return { ...attachment, kind: "text" as const, text, dataUrl: undefined };
    }),
  );
}

function normalizeImageSettings(settings: ImageSettings | undefined): Required<ImageSettings> {
  const fallback = IMAGE_MODELS[0]?.id ?? "openai/gpt-image-1.5";
  const model = typeof settings?.model === "string" && getImageModel(settings.model)
    ? settings.model
    : fallback;
  return {
    enabled: Boolean(settings?.enabled),
    model,
  };
}

function normalizeConnectorSettings(settings: ConnectorSettings | undefined): Required<ConnectorSettings> {
  return {
    github: settings?.github !== false,
    // Opt-in (unlike github): this one touches the local filesystem, so it
    // should never turn on silently just because a field was left undefined.
    filesystem: settings?.filesystem === true,
  };
}

function buildImagePrompt(prompt: string, synthesis: string) {
  return [
    "Create a polished image that directly satisfies the user's image request or visualizes the answer.",
    "",
    "# User prompt",
    prompt,
    "",
    "# Context from the final answer",
    compactForHistory(synthesis, 1800),
    "",
    "If the user did not ask for a visual asset, create one useful conceptual image that supports the answer. Avoid text-heavy layouts unless requested.",
  ].join("\n");
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp(value: number, min: number, max: number) {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** Server-side console logging so a stuck/failed run is traceable in the
 * terminal running `npm run dev` — every phase transition and every model
 * call logs a start, a finish (with duration), or a failure (with reason). */
function logStep(label: string, detail?: Record<string, unknown>) {
  const ts = new Date().toISOString().split("T")[1]?.replace("Z", "");
  const suffix = detail ? ` ${JSON.stringify(detail)}` : "";
  console.log(`[council ${ts}] ${label}${suffix}`);
}

/** Wraps a promise with a hard ceiling so a stuck call can never hang a
 * request forever, even if its own internal timeout/retry logic compounds.
 * On timeout it logs loudly and rejects (or resolves to `fallback` if one
 * is provided) instead of leaving the client spinning with no feedback. */
function withWatchdog<T>(promise: Promise<T>, ms: number, label: string, fallback?: () => T): Promise<T> {
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

function buildUserContent(
  prompt: string,
  attachments: UploadedAttachment[],
  supportsImages = true,
): OpenRouterMessageContent {
  if (!attachments.length) return prompt;

  const hasUsableImage = supportsImages && attachments.some((a) => a.kind === "image" && a.dataUrl);
  const skippedImages = !supportsImages && attachments.some((a) => a.kind === "image");

  const parts: Exclude<OpenRouterMessageContent, string> = [
    {
      type: "text",
      text: [
        prompt,
        "",
        hasUsableImage
          ? "Uploaded attachments are included below. Use them when relevant and call out if a file type could not be directly inspected."
          : skippedImages
            ? "The user uploaded image attachments, but this model does not accept image input, so they are omitted. Answer based on the text of the prompt; if the question depends on the image, say so explicitly and answer what you can in general terms."
            : "Uploaded attachments are included below. Use them when relevant and call out if a file type could not be directly inspected.",
      ].join("\n"),
    },
  ];

  for (const attachment of attachments) {
    if (attachment.kind === "image" && attachment.dataUrl) {
      if (supportsImages) {
        parts.push({ type: "image_url", image_url: { url: attachment.dataUrl } });
      }
      // else: skip silently — text note above already explains
      continue;
    }

    if (attachment.kind === "text" && attachment.text) {
      parts.push({
        type: "text",
        text: `\n\n--- File: ${attachment.name} (${attachment.type}) ---\n${attachment.text.slice(0, 18000)}`,
      });
      continue;
    }

    parts.push({
      type: "text",
      text: `\n\n--- Uploaded file: ${attachment.name} (${attachment.type}, ${attachment.size} bytes) ---\nThis file was uploaded, but only image pixels and text-like file contents are forwarded to the model.`,
    });
  }

  return parts;
}
