import { compactForHistory } from "@/lib/council-prompts";
import type { FusionJudgeReport } from "@/lib/council-types";

/**
 * Pure analysis functions for the council pipeline — no network calls, no
 * side effects. Everything here takes model output text (or already-parsed
 * JSON) and returns a score, a parsed structure, or a normalized report.
 * Split out of app/api/council/stream/route.ts so this math can be reasoned
 * about (and eventually unit-tested) independent of the streaming/HTTP
 * plumbing that calls it.
 */

/** Splits a debate response into its critique block and its "## Revised Answer" section, if present. */
export function splitDebateOutput(content: string) {
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

export const CONVERGENCE_THRESHOLD = 0.25;
const CONVERGENCE_TOP_WORDS = 15;
// Deliberately stricter than CONVERGENCE_THRESHOLD: skipping the debate
// entirely (adaptive mode) is a bigger call than just stopping a debate
// that's already underway and clearly converging. Independent drafts that
// haven't read each other yet also tend to share less vocabulary on
// average than post-debate answers do, so this needs real, not marginal,
// agreement before we skip the round outright.
export const ADAPTIVE_SKIP_THRESHOLD = 0.35;

// Below this self-similarity (own initial draft vs own final debate answer),
// a model is flagged as having materially changed its position rather than
// just refined it. Calibrated separately from CONVERGENCE_THRESHOLD /
// ADAPTIVE_SKIP_THRESHOLD (which compare DIFFERENT models to each other):
// one author's own writing habits — reused phrasing, structure, vocabulary
// — make same-author self-similarity run much higher than cross-model
// similarity even when they revise their conclusion, so held-firm scores
// land ~0.65-0.8 versus ~0.00-0.05 for any real change (tested against
// held-firm, full-reversal, partial-concession, and refine-without-
// -changing-conclusion examples — the gap between "held firm" and any kind
// of actual change was wide and consistent, so 0.4 sits safely in the gap
// rather than on a fine-tuned boundary).
export const MIND_CHANGE_THRESHOLD = 0.4;

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

export function computeConvergence(answers: string[]): { score: number; converged: boolean } {
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

/**
 * Same author, two points in time — did this model's own final debate
 * answer actually change its position from its own independent draft, or
 * just refine/restate it? See MIND_CHANGE_THRESHOLD above for calibration
 * notes; a low score means the model's final answer shares little of its
 * own draft's core vocabulary, i.e. it moved.
 */
export function computeMindChange(initialDraft: string, finalAnswer: string): { similarity: number; changed: boolean } {
  if (!initialDraft || !finalAnswer) return { similarity: 1, changed: false };
  const similarity = jaccardSimilarity(toSignificantWordSet(initialDraft), toSignificantWordSet(finalAnswer));
  return { similarity, changed: similarity < MIND_CHANGE_THRESHOLD };
}

/* =========================================================
   Final vote parsing/tallying — see lib/council-prompts.ts for the
   vote system prompt and buildVotePrompt.
   ========================================================= */

export function parseVote(
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

export function tallyVotes(
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

/* =========================================================
   Fusion judge output parsing/normalizing/fallback
   ========================================================= */

export function parseFusionJudgeJson(content: string): unknown {
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

export function normalizeFusionJudgeReport(input: unknown, drafts: Array<{ label: string; content: string }>): FusionJudgeReport {
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

export function fallbackFusionJudgeReport(
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

/* =========================================================
   Follow-up question parsing
   ========================================================= */

export function parseFollowUpQuestions(content: string) {
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
