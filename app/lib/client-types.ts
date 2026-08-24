import type { ReasoningEffort } from "@/lib/models";

/**
 * Shared client-side types for the council UI — split out of app/page.tsx
 * so components under app/components/ can import the same contract instead
 * of each re-declaring it or importing from page.tsx itself.
 */

export type Phase = "entry" | "thinking" | "results";
export type ModelRunState = "queued" | "thinking" | "complete";
export type ResultTab = "answer" | "debate" | "sources" | "steps";
export type RunPhase = "drafting" | "debating" | "synthesizing" | "done";
export type SettingsTab = "connectors" | "skills" | "research" | "images";

export type ConnectorSettings = {
  github: boolean;
  filesystem: boolean;
};

export type TypeCheckResult = { status: "skipped" | "checking" | "ok" | "error"; errors?: string[] };

export type FileProposalState = {
  id: string;
  groupId: string;
  modelId: string;
  kind: "write" | "edit";
  path: string;
  diff: string;
  status: "pending" | "applying" | "applied" | "rejected" | "error";
  error?: string;
  typeCheck: TypeCheckResult;
};

export type FusionJudgeReport = {
  panelVerdict: string;
  consensus: Array<{ finding: string; models: string[]; evidence: string }>;
  contradictions: Array<{ topic: string; positions: Record<string, string>; judgment: string }>;
  uniqueInsights: Array<{ model: string; insight: string; whyItMatters: string }>;
  coverageGaps: string[];
};

export type DebateRoundEntry = { round: number; maxRounds: number; critique: string; revisedAnswer?: string };

export type RunModel = {
  id: string;
  label: string;
  maker: string;
  badge: string;
  accent: string;
  logoUrl: string;
  selected: boolean;
  reasoningEffort: ReasoningEffort;
  steps: number;
  status: ModelRunState;
  debateStatus: ModelRunState;
  activityLog: string[];
  response?: string;
  critique?: string;
  revisedAnswer?: string;
  debateRound?: number;
  debateMaxRounds?: number;
  /** Historial de cada ronda de debate de este modelo — habilita el
   * scrubber de replay en DebateView. `critique`/`revisedAnswer` arriba
   * siguen siendo la ronda más reciente (compat con el resto de la UI). */
  debateHistory?: DebateRoundEntry[];
  viaFallbackFrom?: string;
  mindChangeSimilarity?: number;
  mindChanged?: boolean;
  error?: string;
};

export type DebateRoundInfo = { round: number; maxRounds: number; participantCount: number; convergence: number; converged: boolean };
export type VoteCastInfo = { modelId: string; label: string; votedForModelId: string | null; votedForLabel: string | null; rationale: string };
export type VoteTallyInfo = { tally: Array<{ modelId: string; label: string; votes: number }>; winnerModelId: string | null; winnerLabel: string | null; totalVotes: number };
export type ModelHealthInfo = { attempts: number; failures: number; lastFailureReason?: string; lastOk: boolean };

export type UploadedAttachment = {
  id: string;
  name: string;
  type: string;
  size: number;
  kind: "image" | "text" | "pdf" | "docx" | "file";
  dataUrl?: string;
  text?: string;
};

export type TokenUsage = { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };

export type CouncilStreamEvent =
  | { type: "run_started"; prompt: string; selectedModels: string[]; fusionPanelId?: string }
  | { type: "personas_assigned"; presetId: string; presetLabel: string; personas: Array<{ modelId: string; key: string; name: string; title: string }> }
  | { type: "phase"; phase: RunPhase }
  | { type: "model_step"; modelId: string; label: string; step: string; steps: number; status: "thinking"; phase: RunPhase }
  | { type: "model_complete"; modelId: string; label: string; content: string; steps: number; phase: "drafting"; usage?: TokenUsage; viaFallbackFrom?: string }
  | { type: "model_debate_complete"; modelId: string; label: string; critique: string; revisedAnswer?: string; steps: number; usage?: TokenUsage; round: number; maxRounds: number }
  | { type: "model_error"; modelId: string; label: string; error: string; steps: number; phase: RunPhase }
  | { type: "synthesis_started"; step: string }
  | { type: "fusion_judge_complete"; report: FusionJudgeReport; usage?: TokenUsage }
  | { type: "synthesis_complete"; content: string; usage?: TokenUsage }
  | { type: "image_started"; model: string; prompt: string }
  | { type: "image_complete"; model: string; prompt: string; images: string[]; usage?: TokenUsage }
  | { type: "image_error"; error: string }
  | { type: "followups_complete"; questions: string[]; usage?: TokenUsage }
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
  | { type: "vote_cast"; modelId: string; label: string; votedForModelId: string | null; votedForLabel: string | null; rationale: string; usage?: TokenUsage }
  | {
      type: "vote_tally_complete";
      tally: Array<{ modelId: string; label: string; votes: number }>;
      winnerModelId: string | null;
      winnerLabel: string | null;
      totalVotes: number;
    }
  | { type: "run_complete" }
  | { type: "error"; error: string };
