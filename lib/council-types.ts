import type { TypeCheckResult } from "@/lib/fs-tools";
import type { AgentSkill } from "@/lib/skills";

/**
 * Shared types for the council streaming pipeline — split out of
 * app/api/council/stream/route.ts so the prompt-building, consensus-math,
 * and orchestration modules (lib/council-prompts.ts, lib/council-consensus.ts,
 * lib/council-run.ts) can all import the same contract instead of each
 * re-declaring it or importing from the route file itself.
 */

export type ConversationTurn = {
  question: string;
  synthesis: string;
};

export type UploadedAttachment = {
  name: string;
  type: string;
  size: number;
  kind: "image" | "text" | "pdf" | "docx" | "file";
  dataUrl?: string;
  text?: string;
};

export type Phase = "drafting" | "debating" | "synthesizing" | "done";

export type FusionJudgeReport = {
  panelVerdict: string;
  consensus: Array<{ finding: string; models: string[]; evidence: string }>;
  contradictions: Array<{ topic: string; positions: Record<string, string>; judgment: string }>;
  uniqueInsights: Array<{ model: string; insight: string; whyItMatters: string }>;
  coverageGaps: string[];
};

export type ImageSettings = {
  enabled?: boolean;
  model?: string;
};

export type ConnectorSettings = {
  github?: boolean;
  filesystem?: boolean;
};

export type StreamRequest = {
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
  /** When set to a valid preset id from lib/persona-presets.ts AND exactly
   * 3 models are selected, each seat gets a fixed analytical persona from
   * that preset injected into its draft/debate system prompt. Undefined or
   * an unknown id disables it. No-op for any other model count. */
  personaPresetId?: string;
  /** When true, checks agreement between the independent drafts before
   * debating; if the panel already agrees enough, skips the debate (and
   * vote) rounds entirely and goes straight to synthesis — saving the calls
   * a debate round would have spent confirming what the drafts already show. */
  adaptiveMode?: boolean;
};

export type StreamEvent =
  | { type: "run_started"; prompt: string; selectedModels: string[]; fusionPanelId?: string }
  | { type: "personas_assigned"; presetId: string; presetLabel: string; personas: Array<{ modelId: string; key: string; name: string; title: string }> }
  | { type: "phase"; phase: Phase }
  | { type: "model_step"; modelId: string; label: string; step: string; steps: number; status: "thinking"; phase: Phase }
  | { type: "model_complete"; modelId: string; label: string; content: string; steps: number; phase: "drafting"; usage?: unknown; viaFallbackFrom?: string }
  | { type: "model_debate_complete"; modelId: string; label: string; critique: string; revisedAnswer?: string; steps: number; usage?: unknown; round: number; maxRounds: number }
  | { type: "model_error"; modelId: string; label: string; error: string; steps: number; phase: Phase }
  | { type: "synthesis_started"; step: string }
  | { type: "fusion_judge_complete"; report: FusionJudgeReport; usage?: unknown }
  | { type: "synthesis_complete"; content: string; usage?: unknown }
  | { type: "image_started"; model: string; prompt: string }
  | { type: "image_complete"; model: string; prompt: string; images: string[]; usage?: unknown }
  | { type: "image_error"; error: string }
  | { type: "followups_complete"; questions: string[]; usage?: unknown }
  | { type: "file_proposal"; modelId: string; proposal: { id: string; groupId: string; kind: "write" | "edit"; path: string; diff: string; typeCheck: TypeCheckResult } }
  | { type: "file_proposal_verified"; proposalId: string; typeCheck: TypeCheckResult }
  | { type: "debate_skipped"; score: number; threshold: number; participantCount: number }
  | { type: "model_mind_change"; modelId: string; label: string; similarity: number; changed: boolean }
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
