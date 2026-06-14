import { AGENT_TOOLS, executeAgentTool } from "@/lib/agent-tools";
import { COUNCIL_MODELS, IMAGE_MODELS, getCouncilModel, getFusionPanel, getImageModel, isReasoningEffort, type ReasoningEffort } from "@/lib/models";
import { OpenRouterMessageContent, createAgentCompletion, createChatCompletion, createImageGeneration } from "@/lib/openrouter";
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
};

type ConversationTurn = {
  question: string;
  synthesis: string;
};

type UploadedAttachment = {
  name: string;
  type: string;
  size: number;
  kind: "image" | "text" | "file";
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
};

type StreamEvent =
  | { type: "run_started"; prompt: string; selectedModels: string[]; fusionPanelId?: string }
  | { type: "phase"; phase: Phase }
  | { type: "model_step"; modelId: string; label: string; step: string; steps: number; status: "thinking"; phase: Phase }
  | { type: "model_complete"; modelId: string; label: string; content: string; steps: number; phase: "drafting"; usage?: unknown }
  | { type: "model_debate_complete"; modelId: string; label: string; critique: string; revisedAnswer?: string; steps: number; usage?: unknown }
  | { type: "model_error"; modelId: string; label: string; error: string; steps: number; phase: Phase }
  | { type: "synthesis_started"; step: string }
  | { type: "fusion_judge_complete"; report: FusionJudgeReport; usage?: unknown }
  | { type: "synthesis_complete"; content: string; usage?: unknown }
  | { type: "image_started"; model: string; prompt: string }
  | { type: "image_complete"; model: string; prompt: string; images: string[]; usage?: unknown }
  | { type: "image_error"; error: string }
  | { type: "followups_complete"; questions: string[]; usage?: unknown }
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
const TARGET_DEBATE_TOKENS = 6000;
const TARGET_SYNTHESIS_TOKENS = 12000;
const FOLLOWUP_MODEL = "deepseek/deepseek-v4-pro";
const FUSION_JUDGE_MODEL = "deepseek/deepseek-v4-pro";

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
        const attachments = normalizeAttachments(body.attachments);
        const history = normalizeHistory(body.history);
        const webGrounding = Boolean(body.webGrounding);
        const reasoningEffortByModel = normalizeReasoningEfforts(body.reasoningEffortByModel);
        const skillPrompt = renderSkillsForPrompt(normalizeAgentSkills(body.agentSkills));
        const imageSettings = normalizeImageSettings(body.imageSettings);
        const agentTools = normalizeConnectorSettings(body.connectors).github ? AGENT_TOOLS : [];

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

        // ---------- Round 1 — independent drafts ----------
        if (isAborted()) return;
        send({ type: "phase", phase: "drafting" });

        const draftResults = await Promise.all(
          selectedModels.map((modelId, index) =>
            runDraft({
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
              agentTools,
              reasoningEffort: effortFor(modelId, reasoningEffortByModel),
            }),
          ),
        );
        const successfulDrafts = draftResults.filter((result) => result.ok && result.content);

        if (isAborted()) return;
        if (!successfulDrafts.length) {
          send({ type: "error", error: "All selected models failed to draft. Check model IDs and OpenRouter access." });
          controller.close();
          return;
        }

        // ---------- Round 2 — debate ----------
        let debateResults: Array<{ ok: boolean; modelId: string; label: string; critique?: string; revisedAnswer?: string }> = [];
        if (successfulDrafts.length >= 2) {
          if (isAborted()) return;
          send({ type: "phase", phase: "debating" });
          debateResults = await Promise.all(
            successfulDrafts.map((self, index) =>
              runDebate({
                self,
                others: successfulDrafts.filter((other) => other.modelId !== self.modelId),
                prompt,
                history,
                apiKey,
                send,
                offset: index,
                signal,
                skillPrompt,
                agentTools,
                reasoningEffort: effortFor(self.modelId, reasoningEffortByModel),
              }),
            ),
          );
        }

        // ---------- Fusion judge ----------
        if (isAborted()) return;
        send({ type: "phase", phase: "synthesizing" });
        send({ type: "synthesis_started", step: "Judge model extracting consensus, contradictions, unique insights, and gaps" });

        const fusionJudge = await createFusionJudgeReport({
          prompt,
          drafts: successfulDrafts,
          debates: debateResults,
          apiKey,
          signal,
        });

        if (isAborted()) return;
        send({ type: "fusion_judge_complete", report: fusionJudge.report, usage: fusionJudge.usage });

        // ---------- Synthesis ----------
        send({ type: "synthesis_started", step: "Grounding the final answer in the judge report and council transcripts" });

        const synthesis = await createAgentCompletion({
          model: process.env.SYNTHESIS_MODEL ?? "openai/gpt-5.5",
          apiKey,
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
              content: buildSynthesisPrompt(prompt, successfulDrafts, debateResults, history, fusionJudge.report),
            },
          ],
        });

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
            send({ type: "image_error", error: error instanceof Error ? error.message : "Image generation failed." });
          }
        }

        try {
          const followUps = await createChatCompletion({
            model: process.env.FOLLOWUP_MODEL ?? FOLLOWUP_MODEL,
            apiKey,
            maxTokens: 1400,
            temperature: 0.35,
            reasoningEffort: "low",
            signal,
            messages: buildFollowUpMessages(prompt, synthesis.content),
          });

          if (isAborted()) return;
          send({
            type: "followups_complete",
            questions: parseFollowUpQuestions(followUps.content),
            usage: followUps.usage,
          });
        } catch {
          if (isAborted()) return;
          send({ type: "followups_complete", questions: [] });
        }

        send({ type: "phase", phase: "done" });
        send({ type: "run_complete" });
      } catch (error) {
        if (isAborted() || (error instanceof Error && error.name === "AbortError")) {
          // client cancelled; quietly close
        } else {
          send({ type: "error", error: error instanceof Error ? error.message : "Council stream failed." });
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
  agentTools,
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
  agentTools: typeof AGENT_TOOLS;
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

    const completion = await createAgentCompletion({
      model: modelId,
      apiKey,
      maxTokens: TARGET_DRAFT_TOKENS,
      temperature: 0.28,
      reasoningEffort,
      signal,
      web: webGrounding,
      tools: agentTools,
      executeTool: (toolCall, toolSignal) => executeAgentTool(toolCall, toolSignal),
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

    return { ok: true as const, modelId, label, content: completion.content };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Model request failed.";
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
  agentTools,
  reasoningEffort,
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
  agentTools: typeof AGENT_TOOLS;
  reasoningEffort: ReasoningEffort;
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

    const completion = await createAgentCompletion({
      model: self.modelId,
      apiKey,
      maxTokens: TARGET_DEBATE_TOKENS,
      temperature: 0.3,
      reasoningEffort,
      signal,
      tools: agentTools,
      executeTool: (toolCall, toolSignal) => executeAgentTool(toolCall, toolSignal),
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
        { role: "system", content: [DEBATE_SYSTEM_PROMPT, skillPrompt].filter(Boolean).join("\n\n") },
        {
          role: "user",
          content: [
            renderHistoryBlock(history),
            `# Current user question\n${prompt}`,
            "",
            `# Your previous draft (you are ${self.label})`,
            self.content,
            "",
            "# Other council members' drafts",
            ...others.map((other) => `## ${other.label}\n${other.content}`),
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
    });

    return { ok: true as const, modelId: self.modelId, label: self.label, critique, revisedAnswer };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Debate request failed.";
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

const DEBATE_SYSTEM_PROMPT = [
  "You are a member of a Model Council in the debate round. You have already produced an initial draft. Now you can see the other council members' drafts.",
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
