import { COUNCIL_MODELS, getCouncilModel } from "@/lib/models";
import { OpenRouterMessageContent, createChatCompletion } from "@/lib/openrouter";

export const maxDuration = 300;

type StreamRequest = {
  prompt?: string;
  selectedModels?: string[];
  apiKey?: string;
  attachments?: UploadedAttachment[];
  history?: ConversationTurn[];
  webGrounding?: boolean;
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

type StreamEvent =
  | { type: "run_started"; prompt: string; selectedModels: string[] }
  | { type: "phase"; phase: Phase }
  | { type: "model_step"; modelId: string; label: string; step: string; steps: number; status: "thinking"; phase: Phase }
  | { type: "model_complete"; modelId: string; label: string; content: string; steps: number; phase: "drafting"; usage?: unknown }
  | { type: "model_debate_complete"; modelId: string; label: string; critique: string; revisedAnswer?: string; steps: number; usage?: unknown }
  | { type: "model_error"; modelId: string; label: string; error: string; steps: number; phase: Phase }
  | { type: "synthesis_started"; step: string }
  | { type: "synthesis_complete"; content: string; usage?: unknown }
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
        const selectedModels = normalizeSelection(body.selectedModels);
        const attachments = normalizeAttachments(body.attachments);
        const history = normalizeHistory(body.history);
        const webGrounding = Boolean(body.webGrounding);

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

        send({ type: "run_started", prompt, selectedModels });

        // ---------- Round 1 — independent drafts ----------
        if (isAborted()) return;
        send({ type: "phase", phase: "drafting" });

        const draftResults = await Promise.all(
          selectedModels.map((modelId, index) =>
            runDraft({ modelId, prompt, attachments, history, apiKey, send, offset: index, signal, webGrounding }),
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
              }),
            ),
          );
        }

        // ---------- Synthesis ----------
        if (isAborted()) return;
        send({ type: "phase", phase: "synthesizing" });
        send({ type: "synthesis_started", step: "Reconciling drafts and debate critiques into a single in-depth answer" });

        const synthesis = await createChatCompletion({
          model: process.env.SYNTHESIS_MODEL ?? "openai/gpt-5.4",
          apiKey,
          maxTokens: TARGET_SYNTHESIS_TOKENS,
          temperature: 0.18,
          reasoningEffort: "high",
          signal,
          messages: [
            {
              role: "system",
              content: SYNTHESIZER_SYSTEM_PROMPT,
            },
            {
              role: "user",
              content: buildSynthesisPrompt(prompt, successfulDrafts, debateResults, history),
            },
          ],
        });

        if (isAborted()) return;
        send({ type: "synthesis_complete", content: synthesis.content, usage: synthesis.usage });
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

    const completion = await createChatCompletion({
      model: modelId,
      apiKey,
      maxTokens: TARGET_DRAFT_TOKENS,
      temperature: 0.28,
      reasoningEffort: model?.reasoning ? "high" : "medium",
      signal,
      web: webGrounding,
      messages: buildDraftMessages(prompt, attachments, history, webGrounding),
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
}: {
  self: { modelId: string; label: string; content: string };
  others: Array<{ modelId: string; label: string; content: string }>;
  prompt: string;
  history: ConversationTurn[];
  apiKey: string;
  send: (event: StreamEvent) => void;
  offset: number;
  signal: AbortSignal;
}) {
  const model = getCouncilModel(self.modelId);
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

    const completion = await createChatCompletion({
      model: self.modelId,
      apiKey,
      maxTokens: TARGET_DEBATE_TOKENS,
      temperature: 0.3,
      reasoningEffort: model?.reasoning ? "high" : "medium",
      signal,
      messages: [
        { role: "system", content: DEBATE_SYSTEM_PROMPT },
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

function buildSynthesisPrompt(
  prompt: string,
  drafts: Array<{ label: string; content: string }>,
  debates: Array<{ ok: boolean; label: string; critique?: string; revisedAnswer?: string }>,
  history: ConversationTurn[],
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

  sections.push(
    "",
    history.length
      ? "This is a follow-up question in an ongoing thread. Stay strictly relevant to the user's current question, but use the prior conversation as context: do not contradict earlier conclusions without explanation, and reference earlier findings when they are load-bearing. Do not repeat the entire previous answer — build on it."
      : "Now produce the final synthesized answer using the exact heading structure from your system instructions. Be specific and long-form. Do not summarize the process — answer the question.",
  );
  return sections.join("\n\n");
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
) {
  let systemPrompt = history.length
    ? `${COUNCIL_MEMBER_SYSTEM_PROMPT}\n\nThis is a follow-up question inside an existing thread. The user's earlier questions and the council's prior answers are provided. Stay strictly on-topic to the current question, treat prior answers as established context, and do not re-derive earlier conclusions unless the user is challenging them.`
    : COUNCIL_MEMBER_SYSTEM_PROMPT;
  if (webGrounding) {
    systemPrompt = `${systemPrompt}\n\nWeb grounding is enabled. Live web search results will be injected before your response. Treat them as authoritative for time-sensitive facts. When you use a search result, cite it inline as a markdown link to the source URL. Prefer recent, primary sources. If results conflict, say which you trust and why.`;
  }

  const userText = history.length
    ? [renderHistoryBlock(history), `# Current user question\n${prompt}`].join("\n\n")
    : prompt;

  return [
    { role: "system" as const, content: systemPrompt },
    { role: "user" as const, content: buildUserContent(userText, attachments) },
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

function normalizeSelection(selectedModels: string[] | undefined) {
  const knownIds = new Set(COUNCIL_MODELS.map((model) => model.id));
  const requested = (selectedModels ?? [])
    .filter((id): id is string => typeof id === "string")
    .filter((id) => knownIds.has(id));

  const fallback = COUNCIL_MODELS.filter((model) => model.defaultSelected).map((model) => model.id);
  return Array.from(new Set(requested.length ? requested : fallback)).slice(0, 4);
}

function normalizeAttachments(attachments: UploadedAttachment[] | undefined) {
  return (attachments ?? [])
    .filter((attachment) => attachment.name && attachment.type && typeof attachment.size === "number")
    .slice(0, 8);
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildUserContent(prompt: string, attachments: UploadedAttachment[]): OpenRouterMessageContent {
  if (!attachments.length) return prompt;

  const parts: Exclude<OpenRouterMessageContent, string> = [
    {
      type: "text",
      text: [
        prompt,
        "",
        "Uploaded attachments are included below. Use them when relevant and call out if a file type could not be directly inspected.",
      ].join("\n"),
    },
  ];

  for (const attachment of attachments) {
    if (attachment.kind === "image" && attachment.dataUrl) {
      parts.push({ type: "image_url", image_url: { url: attachment.dataUrl } });
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
