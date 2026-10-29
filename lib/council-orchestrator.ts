import { AGENT_TOOLS, executeAgentTool } from "@/lib/agent-tools";
import { bufferFromDataUrl, extractDocxText, extractPdfText } from "@/lib/attachment-extraction";
import {
  FS_TOOLS,
  executeFsTool,
  isFsTool,
  newProposalGroupId,
  type FileProposal,
  type TypeCheckResult,
} from "@/lib/fs-tools";
import { assignPersonas, getPersonaPreset } from "@/lib/persona-presets";
import {
  COUNCIL_MODELS,
  IMAGE_MODELS,
  getCouncilModel,
  getFusionPanel,
  getImageModel,
  isReasoningEffort,
  type ReasoningEffort,
} from "@/lib/models";
import {
  createAgentCompletion,
  createChatCompletion,
  createImageGeneration,
  type OpenRouterToolCall,
} from "@/lib/openrouter";
import { renderSkillsForPrompt, type AgentSkill } from "@/lib/skills";
import type {
  ConversationTurn,
  UploadedAttachment,
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
  createFusionJudgeReportResilient,
  logStep,
  runDebate,
  runDraft,
  runVoteResilient,
  withCredentialFailover,
  withWatchdog,
} from "@/lib/council-run";
import { registerSecret, redactSecrets } from "@/lib/provider-resilience/redact";
import { resolveCredentials } from "@/lib/provider-resilience/config";
import type { ProviderName } from "@/lib/provider-resilience/config";

/**
 * Orquestación pura del consejo: recibe el body ya parseado y un `send` de
 * eventos, corre el pipeline completo (drafts → debate → voto → juez →
 * síntesis → imagen → follow-ups) y devuelve. No conoce HTTP, ReadableStream
 * ni `Request`: eso queda en `app/api/council/stream/route.ts`.
 *
 * Todas las dependencias que hacen I/O están en `CouncilRunDeps` para que los
 * tests puedan inyectar un proveedor falso y verificar la secuencia SSE sin
 * red, sin DB y sin timers reales.
 */

export const TARGET_SYNTHESIS_TOKENS = 12000;

// Hard ceilings so a phase can NEVER hang the UI forever, even if a model's
// own request + internal retry compounds beyond expectations. If one fires,
// it's logged loudly to the console.
const FUSION_JUDGE_WATCHDOG_MS = 8 * 60_000; // has a real fallback, so this can be tight
const SYNTHESIS_WATCHDOG_MS = 10 * 60_000; // applied separately to primary AND fallback attempts
const FOLLOWUP_WATCHDOG_MS = 6 * 60_000; // best-effort, cheap to skip
const FOLLOWUP_MODEL = "nvidia/nemotron-3.5-lightning:free";

type Usage = { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };

type ChatCompletionResult = { content: string; usage?: Usage };

type ImageGenerationResult = { model: string; content: string; images: string[]; usage?: Usage };

type DraftResult = Awaited<ReturnType<typeof runDraft>>;
type DebateResult = Awaited<ReturnType<typeof runDebate>>;
type VoteResult = Awaited<ReturnType<typeof runVoteResilient>>;
type JudgeResult = Awaited<ReturnType<typeof createFusionJudgeReportResilient>>;

export type CouncilRunDeps = {
  runDraft: (input: Parameters<typeof runDraft>[0]) => Promise<DraftResult>;
  runDebate: (input: Parameters<typeof runDebate>[0]) => Promise<DebateResult>;
  runVoteResilient: (input: Parameters<typeof runVoteResilient>[0]) => Promise<VoteResult>;
  createFusionJudgeReportResilient: (input: Parameters<typeof createFusionJudgeReportResilient>[0]) => Promise<JudgeResult>;
  createAgentCompletion: (input: Parameters<typeof createAgentCompletion>[0]) => Promise<ChatCompletionResult>;
  createChatCompletion: (input: Parameters<typeof createChatCompletion>[0]) => Promise<ChatCompletionResult>;
  createImageGeneration: (input: Parameters<typeof createImageGeneration>[0]) => Promise<ImageGenerationResult>;
  withCredentialFailover: <T>(
    providerName: ProviderName,
    signal: AbortSignal,
    attempt: (apiKey: string) => Promise<T>,
    options?: { explicitApiKey?: string | null },
  ) => Promise<T>;
  withWatchdog: <T>(promise: Promise<T>, ms: number, label: string, fallback?: () => T) => Promise<T>;
  resolveCredentials: (envPrefix: string) => string[];
  registerSecret: (value: string) => void;
  logStep: (label: string, detail?: Record<string, unknown>) => void;
  executeAgentTool: (toolCall: OpenRouterToolCall, signal?: AbortSignal) => Promise<{ name: string; content: string }>;
  executeFsTool: (toolCall: OpenRouterToolCall, context: Parameters<typeof executeFsTool>[1]) => Promise<{ name: string; content: string }>;
  isFsTool: (toolCall: OpenRouterToolCall) => boolean;
  newProposalGroupId: () => string;
};

const defaultDeps: CouncilRunDeps = {
  runDraft,
  runDebate,
  runVoteResilient,
  createFusionJudgeReportResilient,
  createAgentCompletion,
  createChatCompletion,
  createImageGeneration,
  withCredentialFailover,
  withWatchdog,
  resolveCredentials,
  registerSecret,
  logStep,
  executeAgentTool,
  executeFsTool,
  isFsTool,
  newProposalGroupId,
};

export type CouncilRunInput = {
  body: StreamRequest;
  signal: AbortSignal;
  send: (event: StreamEvent) => void;
  /** Solo para tests: cualquier clave ausente usa la implementación real. */
  deps?: Partial<CouncilRunDeps>;
};

export async function runCouncilStream({ body, signal, send, deps: overrides }: CouncilRunInput): Promise<void> {
  const deps: CouncilRunDeps = { ...defaultDeps, ...overrides };
  const isAborted = () => signal.aborted;

  const prompt = body.prompt?.trim();
  // Fase 5E: `explicitOpenRouterKey` es el override de `body.apiKey`
  // — bypassea el pool de credentials por completo (5C, ya
  // aprobado), solo para llamadas OpenRouter (drafts/debate/vote/
  // judge/synthesis). `apiKey` (legado) sigue existiendo tal cual
  // para los dos usos que 5E deliberadamente deja afuera de alcance
  // (generación de imágenes y follow-ups) — nunca pasan por el pool.
  const explicitOpenRouterKey = body.apiKey?.trim() || null;
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
  const onFileProposalVerified = (proposalId: string, typeCheck: TypeCheckResult) => {
    send({ type: "file_proposal_verified", proposalId, typeCheck });
  };

  /** Tools + a combined executor for one model turn — only the designated
   * file agent gets fsTools. Every propose_* call made during this one
   * turn shares a groupId, so multi-file changes can be approved as a
   * unit instead of file-by-file. */
  function toolingFor(modelId: string) {
    const groupId = deps.newProposalGroupId();
    const tools = modelId === fileAgentModelId ? [...agentTools, ...fsTools] : agentTools;
    const executeTool = (toolCall: OpenRouterToolCall, toolSignal?: AbortSignal) =>
      deps.isFsTool(toolCall)
        ? deps.executeFsTool(toolCall, { groupId, onProposal: (proposal) => onFileProposal(modelId, proposal), onVerified: onFileProposalVerified })
        : deps.executeAgentTool(toolCall, toolSignal);
    return { tools, executeTool };
  }

  if (!prompt) {
    send({ type: "error", error: "Enter a prompt for the council." });
    return;
  }

  // Fase 5E: antes, "hay alguna credential utilizable" se reducía a
  // un único string. Ahora, sin key explícita, hay que preguntarle
  // al mismo mecanismo de descubrimiento que usa el pool (5C) si
  // existe AL MENOS una — evita arrancar todo el run para recién
  // fallar adentro del primer draft si `.env` no tiene ninguna.
  if (explicitOpenRouterKey) {
    if (explicitOpenRouterKey.includes("your-key")) {
      send({
        type: "error",
        error: "Set OPENROUTER_API_KEY in .env or enter a valid OpenRouter key before running.",
      });
      return;
    }
    // Se registra ANTES de cualquier llamada — para que quede
    // cubierta por `redactSecrets`/`redactError` (5C) desde el
    // primer instante en que existe, igual que las credentials del
    // pool ya quedan registradas al construirse (`createProviderPool`).
    deps.registerSecret(explicitOpenRouterKey);
  } else if (deps.resolveCredentials("OPENROUTER_API_KEY").length === 0) {
    send({
      type: "error",
      error: "Set OPENROUTER_API_KEY in .env or enter a valid OpenRouter key before running.",
    });
    return;
  }

  // Fase 5E: `apiKey` (legado) — solo para los dos usos que quedan
  // deliberadamente fuera del pool en esta fase (generación de
  // imágenes y follow-ups, ver sección de riesgos del informe de
  // cierre). Para acá abajo ya está garantizado por la validación de
  // arriba que existe al menos una de las dos fuentes.
  const apiKey = explicitOpenRouterKey ?? deps.resolveCredentials("OPENROUTER_API_KEY")[0]!;

  send({ type: "run_started", prompt, selectedModels, fusionPanelId });
  deps.logStep("▶▶ RUN START", { promptLength: prompt.length, selectedModels, fusionPanelId, webGrounding });

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
    deps.logStep("◆ Persona preset", { preset: activePersonaPreset!.id, assignment: Object.fromEntries(selectedModels.map((id) => [id, seatPersonas[id]?.name])) });
  }

  // ---------- Round 1 — independent drafts ----------
  if (isAborted()) return;
  send({ type: "phase", phase: "drafting" });

  const draftResults = await Promise.all(
    selectedModels.map((modelId, index) => {
      const { tools, executeTool } = toolingFor(modelId);
      return deps.runDraft({
        modelId,
        prompt,
        attachments,
        history,
        explicitOpenRouterKey,
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
      deps.logStep("⏭ debate SKIPPED (adaptive)", { score: initialAgreement.score, participants: successfulDrafts.length });
    }
  }

  if (successfulDrafts.length >= 2 && !adaptiveSkipped) {
    for (let round = 1; round <= maxDebateRounds; round++) {
      if (isAborted()) return;
      send({ type: "phase", phase: "debating" });
      const roundResults = await Promise.all(
        currentAnswers.map((self, index) => {
          const { tools, executeTool } = toolingFor(self.modelId);
          return deps.runDebate({
            self,
            others: currentAnswers.filter((other) => other.modelId !== self.modelId),
            prompt,
            history,
            explicitOpenRouterKey,
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

      const survivors = roundResults.filter((result): result is typeof result & { ok: true } => result.ok);

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
      deps.logStep("✓ debate round DONE", { round, participants: survivors.length, convergence: convergence.score, converged: convergence.converged });
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
      currentAnswers.map((self) => deps.runVoteResilient({ self, candidates: currentAnswers, prompt, send, signal, explicitOpenRouterKey })),
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

  deps.logStep("→ fusion judge START");
  const judgeStartedAt = Date.now();
  const fusionJudge = await deps.withWatchdog(
    deps.createFusionJudgeReportResilient({
      prompt,
      drafts: successfulDrafts,
      debates: debateResults,
      signal,
      explicitOpenRouterKey,
    }),
    FUSION_JUDGE_WATCHDOG_MS,
    "Fusion judge",
    () => ({ report: fallbackFusionJudgeReport(successfulDrafts, debateResults), usage: undefined }),
  );
  deps.logStep("✓ fusion judge DONE", { ms: Date.now() - judgeStartedAt });

  if (isAborted()) return;
  send({
    type: "fusion_judge_complete",
    report: fusionJudge.report,
    usage: fusionJudge.usage,
    model: process.env.FUSION_JUDGE_MODEL ?? "nvidia/nemotron-3.5-lightning:free",
  });

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
  // 2026-09-18: openai/gpt-oss-20b:free y google/gemma-4-26b-a4b-it:free
  // (los dos candidatos originales) quedaron CONFIRMED DEAD/saturados
  // (ver notas en lib/models.ts) — con el default de SYNTHESIS_MODEL,
  // el fallback real terminaba siendo un modelo muerto, o sea NUNCA
  // servía. Reemplazados por los 2 modelos que sí anduvieron limpios
  // en la misma corrida real (nemotron-3-super-120b, gemini-3.5-flash).
  const SYNTHESIS_FALLBACK_CANDIDATES = [
    "nvidia/nemotron-3.5-lightning:free",
    "nvidia/nemotron-3-super-120b-a12b:free",
    "gemini-3.5-flash",
  ];
  const SYNTHESIS_FALLBACK_MODEL =
    SYNTHESIS_FALLBACK_CANDIDATES.find((id) => id !== SYNTHESIS_PRIMARY_MODEL) ?? "gemini-3.5-flash";

  function runSynthesis(modelId: string, apiKeyValue: string, promptValue: string) {
    return deps.createAgentCompletion({
      model: modelId,
      apiKey: apiKeyValue,
      maxTokens: TARGET_SYNTHESIS_TOKENS,
      temperature: 0.18,
      reasoningEffort: "high",
      signal,
      tools: agentTools,
      executeTool: (toolCall, toolSignal) => deps.executeAgentTool(toolCall, toolSignal),
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

  deps.logStep("→ synthesis START", { model: SYNTHESIS_PRIMARY_MODEL });
  let synthesis: Awaited<ReturnType<typeof deps.createAgentCompletion>>;
  let synthesisModelUsed = SYNTHESIS_PRIMARY_MODEL;
  const primaryStartedAt = Date.now();
  try {
    synthesis = await deps.withWatchdog(
      deps.withCredentialFailover("openrouter", signal, (synthesisApiKey) => runSynthesis(SYNTHESIS_PRIMARY_MODEL, synthesisApiKey, prompt), {
        explicitApiKey: explicitOpenRouterKey,
      }),
      SYNTHESIS_WATCHDOG_MS,
      "Synthesis",
    );
    deps.logStep("✓ synthesis DONE (primary)", { ms: Date.now() - primaryStartedAt, tokens: synthesis.usage });
  } catch (primaryError) {
    const primaryMessage = redactSecrets(primaryError instanceof Error ? primaryError.message : "Synthesis failed.");
    deps.logStep("✗ synthesis FAILED (primary) — trying fallback model", {
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
      synthesis = await deps.withWatchdog(
        deps.withCredentialFailover("openrouter", signal, (synthesisApiKey) => runSynthesis(SYNTHESIS_FALLBACK_MODEL, synthesisApiKey, prompt), {
          explicitApiKey: explicitOpenRouterKey,
        }),
        SYNTHESIS_WATCHDOG_MS,
        "Synthesis (fallback)",
      );
      synthesisModelUsed = SYNTHESIS_FALLBACK_MODEL;
      deps.logStep("✓ synthesis DONE (fallback)", { ms: Date.now() - fallbackStartedAt, tokens: synthesis.usage });
    } catch (fallbackError) {
      const message = redactSecrets(fallbackError instanceof Error ? fallbackError.message : "Synthesis failed.");
      deps.logStep("✗ synthesis FAILED (fallback too)", { ms: Date.now() - fallbackStartedAt, error: message });
      throw fallbackError;
    }
  }

  if (isAborted()) return;
  send({ type: "synthesis_complete", content: synthesis.content, usage: synthesis.usage, model: synthesisModelUsed });

  if (imageSettings.enabled) {
    const imageModel = imageSettings.model;
    const imagePrompt = buildImagePrompt(prompt, synthesis.content);
    try {
      send({ type: "image_started", model: imageModel, prompt: imagePrompt });
      const generated = await deps.createImageGeneration({
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
      const message = redactSecrets(error instanceof Error ? error.message : String(error));
      deps.logStep("✗ image generation FAILED", { error: message });
      send({ type: "image_error", error: error instanceof Error ? message : "Image generation failed." });
    }
  }

  deps.logStep("→ follow-ups START");
  const followUpModel = process.env.FOLLOWUP_MODEL ?? FOLLOWUP_MODEL;
  try {
    const followUps = await deps.withWatchdog(
      deps.createChatCompletion({
        model: followUpModel,
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
    deps.logStep("✓ follow-ups DONE");
    send({
      type: "followups_complete",
      questions: parseFollowUpQuestions(followUps.content),
      usage: followUps.usage,
      model: followUpModel,
    });
  } catch (error) {
    if (isAborted()) return;
    const message = redactSecrets(error instanceof Error ? error.message : String(error));
    deps.logStep("✗ follow-ups FAILED (non-fatal, continuing)", { error: message });
    send({ type: "followups_complete", questions: [], model: followUpModel });
  }

  deps.logStep("✓✓ RUN COMPLETE");
  send({ type: "phase", phase: "done" });
  send({ type: "run_complete" });
}

/* =========================================================
   Normalización de la request
   ========================================================= */

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
  return Array.from(new Set(panelModels?.length ? panelModels : requested.length ? requested : fallback)).slice(0, 10);
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
