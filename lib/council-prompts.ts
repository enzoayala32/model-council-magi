import type { OpenRouterMessageContent } from "@/lib/openrouter";
import type { Persona } from "@/lib/persona-presets";
import type { ConversationTurn, FusionJudgeReport, UploadedAttachment } from "@/lib/council-types";

/**
 * Prompt and message construction for the council pipeline — system
 * prompts, per-phase user-message builders, and the small text-formatting
 * helpers (condensing, truncation, history rendering) that only exist to
 * build those messages. Split out of app/api/council/stream/route.ts to
 * keep that file focused on the actual HTTP/streaming orchestration.
 *
 * Nothing in this file makes a network call or touches the filesystem —
 * every export here is a pure string/message builder.
 */

export function compactForHistory(content: string, max: number) {
  const trimmed = content.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}…`;
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
export function condenseDraftForPeers(content: string): string {
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

export function renderHistoryBlock(history: ConversationTurn[]) {
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

/* =========================================================
   Council member (draft) prompt
   ========================================================= */

export const COUNCIL_MEMBER_SYSTEM_PROMPT = [
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

/* =========================================================
   Persona presets — see lib/persona-presets.ts for the preset data.
   Each persona is a professional analytical lens, not a character to
   roleplay — see the disclaimer baked into the returned prompt text.
   ========================================================= */

export function personaPrompt(persona: Persona | undefined): string {
  if (!persona) return "";
  return [
    `# Assigned analytical persona: ${persona.name}, "${persona.title}"`,
    persona.lens,
    "This is an analytical lens on top of your normal expertise, not a character to roleplay — don't narrate being this persona or refer to yourself by this name in the answer body. Just consistently reason from this angle, the same way a real reviewer with this priority would.",
  ].join("\n");
}

export function buildDraftMessages(
  prompt: string,
  attachments: UploadedAttachment[],
  history: ConversationTurn[],
  webGrounding = false,
  supportsImages = true,
  skillPrompt = "",
  personaPromptText = "",
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
  if (personaPromptText) {
    systemPrompt = `${systemPrompt}\n\n${personaPromptText}`;
  }

  const userText = history.length
    ? [renderHistoryBlock(history), `# Current user question\n${prompt}`].join("\n\n")
    : prompt;

  return [
    { role: "system" as const, content: systemPrompt },
    { role: "user" as const, content: buildUserContent(userText, attachments, supportsImages) },
  ];
}

/* =========================================================
   Debate prompt
   ========================================================= */

export function debateSystemPrompt(round: number, maxRounds: number, personaPromptText = ""): string {
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
    ...(personaPromptText ? ["", personaPromptText] : []),
  ].join("\n");
}

/* =========================================================
   Synthesis prompt
   ========================================================= */

export const SYNTHESIZER_SYSTEM_PROMPT = [
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

export function buildSynthesisPrompt(
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

/* =========================================================
   Fusion judge prompt
   ========================================================= */

export const FUSION_JUDGE_SYSTEM_PROMPT = [
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

export function buildFusionJudgePrompt(
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

/* =========================================================
   Final vote prompt
   ========================================================= */

export const VOTE_SYSTEM_PROMPT = [
  "You are a member of a Model Council. The debate has concluded. You will see the final answer from every council member, including your own, each labeled with the model's name.",
  "Vote for the single strongest, most accurate, most complete final answer for the user's question. It is fine to vote for your own if you genuinely still believe it is best — do not vote strategically or out of false modesty.",
  "Respond in EXACTLY this format and nothing else, no preamble:",
  "VOTE: <exact model label as shown>",
  "REASON: <one specific sentence>",
].join("\n");

export function buildVotePrompt(prompt: string, candidates: Array<{ label: string; content: string }>) {
  const sections = [`# User question\n${prompt}`, "", "# Final answers"];
  for (const candidate of candidates) {
    sections.push(`## ${candidate.label}\n${compactForHistory(candidate.content, 3000)}`);
  }
  return sections.join("\n\n");
}

/* =========================================================
   Follow-up questions prompt
   ========================================================= */

export function buildFollowUpMessages(prompt: string, synthesis: string) {
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

/* =========================================================
   Image generation prompt
   ========================================================= */

export function buildImagePrompt(prompt: string, synthesis: string) {
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
