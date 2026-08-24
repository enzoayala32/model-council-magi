import { AGENT_TOOLS, executeAgentTool } from "@/lib/agent-tools";
import { bufferFromDataUrl, extractDocxText, extractPdfText } from "@/lib/attachment-extraction";
import { FS_TOOLS, executeFsTool, isFsTool, newProposalGroupId, type FileProposal, type TypeCheckResult } from "@/lib/fs-tools";
import { assignPersonas, getPersonaPreset } from "@/lib/persona-presets";
import { COUNCIL_MODELS, IMAGE_MODELS, getCouncilModel, getFusionPanel, getImageModel, isReasoningEffort, type ReasoningEffort } from "@/lib/models";
import { createAgentCompletion, createChatCompletion, createImageGeneration, type OpenRouterToolCall } from "@/lib/openrouter";
import { renderSkillsForPrompt, type AgentSkill } from "@/lib/skills";
import type {
  ConversationTurn,
  UploadedAttachment,
  Phase,
  FusionJudgeReport,
  ImageSettings,
  ConnectorSettings,
  StreamRequest,
  StreamEvent,
} from "@/lib/council-types";
import {
  buildFollowUpMessages,
  buildImagePrompt,
  buildSynthesisPrompt,
  personaPrompt,
  SYNTHESIZER_SYSTEM_PROMPT,
} from "@/lib/council-prompts";
import {
  ADAPTIVE_SKIP_THRESHOLD,
  computeConvergence,
  computeMindChange,
  fallbackFusionJudgeReport,
  parseFollowUpQuestions,
  tallyVotes,
} from "@/lib/council-consensus";
import {
  createFusionJudgeReport,
  delay,
  logStep,
  runDebate,
  runDraft,
  runVote,
  withWatchdog,
} from "@/lib/council-run";

export const maxDuration = 300;

const TARGET_SYNTHESIS_TOKENS = 12000;

// Hard ceilings so a phase can NEVER hang the UI forever, even if a model's
// own request + internal retry compounds beyond expectations. If one fires,
// it's logged loudly to the console.
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
            proposal: { id: proposal.id, groupId: proposal.groupId, kind: proposal.kind, path: proposal.relPath, diff: proposal.diff, typeCheck: proposal.typeCheck },
          });
        };
        const onFileProposalVerified = (proposalId: string, typeCheck: FileProposal["typeCheck"]) => {
          send({ type: "file_proposal_verified", proposalId, typeCheck });
        };

        /** Tools + a combined executor for one model turn — only the designated
         * file agent gets fsTools. Every propose_* call made during this one
         * turn shares a groupId, so multi-file changes can be approved as a
         * unit instead of file-by-file. */
        function toolingFor(modelId: string) {
          const groupId = newProposalGroupId();
          const tools = modelId === fileAgentModelId ? [...agentTools, ...fsTools] : agentTools;
          const executeTool = (toolCall: OpenRouterToolCall, toolSignal?: AbortSignal) =>
            isFsTool(toolCall)
              ? executeFsTool(toolCall, { groupId, onProposal: (proposal) => onFileProposal(modelId, proposal), onVerified: onFileProposalVerified })
              : executeAgentTool(toolCall, toolSignal);
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

        const activePersonaPreset = getPersonaPreset(body.personaPresetId);
        const seatPersonas = activePersonaPreset && selectedModels.length === 3 ? assignPersonas(selectedModels, activePersonaPreset) : {};
        if (Object.keys(seatPersonas).length) {
          send({
            type: "personas_assigned",
            presetId: activePersonaPreset!.id,
            presetLabel: activePersonaPreset!.label,
            personas: selectedModels.map((modelId) => {
              const persona = seatPersonas[modelId];
              return { modelId, key: persona?.key ?? "", name: persona?.name ?? "", title: persona?.title ?? "" };
            }),
          });
          logStep("◆ Persona preset", { preset: activePersonaPreset!.id, assignment: Object.fromEntries(selectedModels.map((id) => [id, seatPersonas[id]?.name])) });
        }

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
              personaPrompt: personaPrompt(seatPersonas[modelId]),
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
        const maxDebateRounds = clamp(Math.round(body.maxDebateRounds ?? 1), 1, 5);
        let debateResults: Array<{ ok: boolean; modelId: string; label: string; critique?: string; revisedAnswer?: string }> = [];
        let roundsRun = 0;
        let currentAnswers: Array<{ modelId: string; label: string; content: string }> = successfulDrafts;

        // Adaptive mode: check agreement on the independent drafts BEFORE
        // spending a debate round on a panel that already agrees. Reuses
        // the same lexical heuristic the mid-debate convergence check uses
        // (see computeConvergence below), just against the drafts instead
        // of a debate round's revised answers, and against a stricter
        // threshold (see ADAPTIVE_SKIP_THRESHOLD above).
        let adaptiveSkipped = false;
        if (body.adaptiveMode && successfulDrafts.length >= 2) {
          const initialAgreement = computeConvergence(successfulDrafts.map((d) => d.content));
          if (initialAgreement.score >= ADAPTIVE_SKIP_THRESHOLD) {
            adaptiveSkipped = true;
            if (isAborted()) return;
            send({
              type: "debate_skipped",
              score: initialAgreement.score,
              threshold: ADAPTIVE_SKIP_THRESHOLD,
              participantCount: successfulDrafts.length,
            });
            logStep("⏭ debate SKIPPED (adaptive)", { score: initialAgreement.score, participants: successfulDrafts.length });
          }
        }

        if (successfulDrafts.length >= 2 && !adaptiveSkipped) {
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
                  personaPrompt: personaPrompt(seatPersonas[self.modelId]),
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

        // ---------- Mind-change tracking — own initial draft vs own final debate answer ----------
        // Only meaningful if a debate actually happened (roundsRun >= 1); a
        // model that never debated has nothing to compare its draft against.
        if (roundsRun >= 1) {
          for (const finalAnswer of currentAnswers) {
            const initialDraft = successfulDrafts.find((d) => d.modelId === finalAnswer.modelId);
            if (!initialDraft) continue;
            const { similarity, changed } = computeMindChange(initialDraft.content, finalAnswer.content);
            send({ type: "model_mind_change", modelId: finalAnswer.modelId, label: finalAnswer.label, similarity, changed });
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


function clamp(value: number, min: number, max: number) {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

