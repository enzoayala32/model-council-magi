"use client";

import { type Dispatch, type MutableRefObject, type SetStateAction, useEffect, useRef, useState } from "react";
import { buildHistory, makeThreadTitle, newId, type StoredGeneratedImage, type StoredThread, type StoredTurn } from "@/lib/threads";
import type { AgentSkill } from "@/lib/skills";
import { DEFAULT_FUSION_PANEL_ID } from "@/lib/models";
import { DEFAULT_QUERY, INITIAL_MODELS } from "../lib/constants";
import {
  appendUnique,
  readCouncilStream,
} from "../lib/client-helpers";
import type {
  ConnectorSettings,
  CouncilStreamEvent,
  DebateRoundInfo,
  FileProposalState,
  FusionJudgeReport,
  Phase,
  ResultTab,
  RunModel,
  RunPhase,
  TokenUsage,
  UploadedAttachment,
  VoteCastInfo,
  VoteTallyInfo,
} from "../lib/client-types";

export type LiveState = {
  models: RunModel[];
  synthesis: string;
  followUps: string[];
  generatedImages: StoredGeneratedImage[];
  fusionJudge: FusionJudgeReport | null;
  question: string;
};

export type CouncilRunOptions = {
  setModels: Dispatch<SetStateAction<RunModel[]>>;
  selectedModels: RunModel[];
  phase: Phase;
  query: string;
  attachments: UploadedAttachment[];
  webGrounding: boolean;
  agentSkills: AgentSkill[];
  connectors: ConnectorSettings;
  fileAgentModelId: string;
  maxDebateRounds: number;
  personaPresetId: string;
  adaptiveMode: boolean;
  imageGenerationEnabled: boolean;
  selectedImageModel: string;
  councilEnabled: boolean;
  selectedFusionPanelId: string;
  liveStateRef: MutableRefObject<LiveState>;
  activeThreadIdRef: MutableRefObject<string | null>;
  setThreads: Dispatch<SetStateAction<StoredThread[]>>;
  setActiveThreadId: (id: string | null) => void;
  syncThread: (thread: StoredThread) => void;
  commitActiveTurn: (status: StoredTurn["status"]) => void;
  refreshModelHealth: () => void;
  setQuery: (value: string) => void;
  setCouncilEnabled: (value: boolean) => void;
  setMenuOpen: (value: boolean) => void;
  setSelectorOpen: (value: boolean) => void;
  setPhase: (value: Phase) => void;
};

/**
 * Motor de la corrida del consejo en el cliente: estado de resultados,
 * lectura del SSE, cancelación, propuestas de archivos y snapshot del turno.
 * Extraído de `app/page.tsx` en Fase 5 sin cambiar el comportamiento — la
 * página sigue siendo dueña de la configuración (modelos, adjuntos, hilos) y
 * este hook de todo lo que produce una corrida.
 */
export function useCouncilRun({
  setModels,
  selectedModels,
  phase,
  query,
  attachments,
  webGrounding,
  agentSkills,
  connectors,
  fileAgentModelId,
  maxDebateRounds,
  personaPresetId,
  adaptiveMode,
  imageGenerationEnabled,
  selectedImageModel,
  councilEnabled,
  selectedFusionPanelId,
  liveStateRef,
  activeThreadIdRef,
  setThreads,
  setActiveThreadId,
  syncThread,
  commitActiveTurn,
  refreshModelHealth,
  setQuery,
  setCouncilEnabled,
  setMenuOpen,
  setSelectorOpen,
  setPhase,
}: CouncilRunOptions) {
  const [runModelIds, setRunModelIds] = useState<string[]>([]);
  const [runFusionPanelId, setRunFusionPanelId] = useState<string | null>(DEFAULT_FUSION_PANEL_ID);
  const [fusionJudge, setFusionJudge] = useState<FusionJudgeReport | null>(null);
  const [synthesis, setSynthesis] = useState("");
  const [followUps, setFollowUps] = useState<string[]>([]);
  const [generatedImages, setGeneratedImages] = useState<StoredGeneratedImage[]>([]);
  const [imageStatus, setImageStatus] = useState("");
  const [synthesisActivity, setSynthesisActivity] = useState("");
  const [streamError, setStreamError] = useState("");
  const [fileProposals, setFileProposals] = useState<FileProposalState[]>([]);
  const [tokenUsage, setTokenUsage] = useState<TokenUsage>({});
  const [tokenBreakdown, setTokenBreakdown] = useState<Array<{ phase: string; modelId?: string; label?: string; usage: TokenUsage }>>([]);
  const [debateSkipped, setDebateSkipped] = useState<{ score: number; threshold: number; participantCount: number } | null>(null);
  const [seatPersonas, setSeatPersonas] = useState<Record<string, { key: string; name: string; title: string }>>({});
  const [debateRounds, setDebateRounds] = useState<DebateRoundInfo[]>([]);
  const [votes, setVotes] = useState<VoteCastInfo[]>([]);
  const [voteTally, setVoteTally] = useState<VoteTallyInfo | null>(null);
  const [resultTab, setResultTab] = useState<ResultTab>("answer");
  const [runPhase, setRunPhase] = useState<RunPhase>("drafting");
  const [elapsedMs, setElapsedMs] = useState(0);

  const abortRef = useRef<AbortController | null>(null);
  const runStartRef = useRef<number | null>(null);

  // Reloj del panel Consenso — corre mientras hay una corrida en curso.
  useEffect(() => {
    if (phase !== "thinking") return;
    const tick = () => setElapsedMs(runStartRef.current ? Date.now() - runStartRef.current : 0);
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [phase]);

  function abortActiveRun() {
    abortRef.current?.abort();
    abortRef.current = null;
  }

  function stopGeneration() {
    if (!abortRef.current) return;
    abortRef.current.abort();
    abortRef.current = null;
    setStreamError("Generation stopped.");
    setRunPhase("done");
    setPhase("results");
    commitActiveTurn("stopped");
  }

  async function runCouncil(overrideQuery?: string) {
    const nextQuery = (overrideQuery ?? query).trim() || DEFAULT_QUERY;
    const nextRunModelIds = selectedModels.map((model) => model.id);
    const nextFusionPanelId = councilEnabled && selectedFusionPanelId !== "custom" ? selectedFusionPanelId : null;
    if (!nextRunModelIds.length) return;

    // Cancel anything in flight.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    // Determine thread + history. If no active thread, create one.
    let threadId = activeThreadIdRef.current;
    let history: Array<{ question: string; synthesis: string }> = [];
    let syncedThread: StoredThread | null = null;
    const newTurn: StoredTurn = {
      id: newId("turn"),
      question: nextQuery,
      synthesis: "",
      followUps: [],
      generatedImages: [],
      fusionJudge: null,
      fusionPanelId: nextFusionPanelId,
      models: nextRunModelIds.map((id) => {
        const base = INITIAL_MODELS.find((m) => m.id === id)!;
        return { id: base.id, label: base.label, maker: base.maker, badge: base.badge, accent: base.accent, logoUrl: base.logoUrl, steps: 0, activityLog: [] };
      }),
      createdAt: Date.now(),
      status: "complete",
    };

    setThreads((current) => {
      const existing = threadId ? current.find((t) => t.id === threadId) : null;
      if (existing) {
        history = buildHistory(existing);
        const updated = { ...existing, updatedAt: Date.now(), turns: [...existing.turns, newTurn] };
        syncedThread = updated;
        return current.map((thread) => (thread.id === threadId ? updated : thread));
      }
      // New thread
      const created: StoredThread = {
        id: newId("thread"),
        title: makeThreadTitle(nextQuery),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        turns: [newTurn],
      };
      threadId = created.id;
      activeThreadIdRef.current = created.id;
      setActiveThreadId(created.id);
      history = [];
      syncedThread = created;
      return [created, ...current];
    });
    if (syncedThread) syncThread(syncedThread);

    setQuery(nextQuery);
    setCouncilEnabled(true);
    setMenuOpen(false);
    setSelectorOpen(false);
    setPhase("thinking");
    setRunModelIds(nextRunModelIds);
    setSynthesis("");
    setFollowUps([]);
    setGeneratedImages([]);
    setFusionJudge(null);
    setImageStatus("");
    setSynthesisActivity("");
    setStreamError("");
    setResultTab("answer");
    setRunPhase("drafting");
    runStartRef.current = Date.now();
    setElapsedMs(0);
    setFileProposals([]);
    setTokenUsage({});
    setTokenBreakdown([]);
    setDebateRounds([]);
    setSeatPersonas({});
    setDebateSkipped(null);
    setVotes([]);
    setVoteTally(null);
    setRunFusionPanelId(nextFusionPanelId);
    setModels((current) =>
      current.map((model) => ({
        ...model,
        steps: 0,
        status: "queued",
        debateStatus: "queued",
        activityLog: nextRunModelIds.includes(model.id) ? ["En cola para el borrador independiente"] : [],
        response: undefined,
        critique: undefined,
        revisedAnswer: undefined,
        debateHistory: undefined,
        error: undefined,
      })),
    );

    try {
      const response = await fetch("/api/council/stream", {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: nextQuery,
          selectedModels: nextRunModelIds,
          fusionPanelId: nextFusionPanelId ?? undefined,
          attachments: attachments.map(({ id: _id, ...attachment }) => attachment),
          history,
          webGrounding,
          agentSkills,
          connectors,
          fileAgentModelId: connectors.filesystem ? fileAgentModelId || undefined : undefined,
          maxDebateRounds,
          personaPresetId: personaPresetId || undefined,
          adaptiveMode,
          imageSettings: {
            enabled: imageGenerationEnabled,
            model: selectedImageModel,
          },
          reasoningEffortByModel: Object.fromEntries(
            liveStateRef.current.models
              .filter((m) => nextRunModelIds.includes(m.id))
              .map((m) => [m.id, m.reasoningEffort]),
          ),
        }),
      });

      if (!response.body) throw new Error("Council stream did not start.");

      await readCouncilStream(response.body, handleStreamEvent, controller.signal);

      // Stream completed normally — snapshot final state.
      commitActiveTurn("complete");
    } catch (error) {
      if (controller.signal.aborted) {
        // user-initiated abort already handled in stopGeneration
        return;
      }
      const message = error instanceof Error ? error.message : "Council run failed.";
      setStreamError(message);
      setRunPhase("done");
      setPhase("results");
      commitActiveTurn("errored");
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }

  async function applyFileProposal(id: string) {
    setFileProposals((current) => current.map((p) => (p.id === id ? { ...p, status: "applying" } : p)));
    try {
      const response = await fetch("/api/council/apply-file-change", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proposalId: id, action: "apply" }),
      });
      const data: { ok: boolean; error?: string } = await response.json();
      if (!data.ok) throw new Error(data.error || "No se pudo aplicar el cambio.");
      setFileProposals((current) => current.map((p) => (p.id === id ? { ...p, status: "applied" } : p)));
    } catch (error) {
      setFileProposals((current) =>
        current.map((p) => (p.id === id ? { ...p, status: "error", error: error instanceof Error ? error.message : "Error desconocido" } : p)),
      );
    }
  }

  async function rejectFileProposal(id: string) {
    setFileProposals((current) => current.map((p) => (p.id === id ? { ...p, status: "rejected" } : p)));
    try {
      await fetch("/api/council/apply-file-change", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proposalId: id, action: "reject" }),
      });
    } catch {
      // Best-effort — the proposal will just expire server-side (30 min TTL) if this fails.
    }
  }

  async function applyFileProposalGroup(groupId: string) {
    const ids = fileProposals.filter((p) => p.groupId === groupId && p.status === "pending").map((p) => p.id);
    // Sequential, not parallel — if one file in a related group fails to
    // apply, stopping avoids leaving a half-applied, inconsistent change on
    // disk for files that clearly belong together.
    for (const id of ids) {
      await applyFileProposal(id);
    }
  }

  async function rejectFileProposalGroup(groupId: string) {
    const ids = fileProposals.filter((p) => p.groupId === groupId && p.status === "pending").map((p) => p.id);
    await Promise.all(ids.map((id) => rejectFileProposal(id)));
  }

  function addUsage(next: TokenUsage | undefined, tag?: { phase: string; modelId?: string; label?: string }) {
    if (!next) return;
    setTokenUsage((current) => ({
      prompt_tokens: (current.prompt_tokens ?? 0) + (next.prompt_tokens ?? 0),
      completion_tokens: (current.completion_tokens ?? 0) + (next.completion_tokens ?? 0),
      total_tokens: (current.total_tokens ?? 0) + (next.total_tokens ?? (next.prompt_tokens ?? 0) + (next.completion_tokens ?? 0)),
    }));
    if (tag) {
      const normalized: TokenUsage = {
        prompt_tokens: next.prompt_tokens ?? 0,
        completion_tokens: next.completion_tokens ?? 0,
        total_tokens: next.total_tokens ?? (next.prompt_tokens ?? 0) + (next.completion_tokens ?? 0),
      };
      setTokenBreakdown((current) => [...current, { ...tag, usage: normalized }]);
    }
  }

  function handleStreamEvent(event: CouncilStreamEvent) {
    if (event.type === "error") { setStreamError(event.error); return; }
    if (event.type === "personas_assigned") {
      const next: Record<string, { key: string; name: string; title: string }> = {};
      for (const p of event.personas) {
        if (p.key) next[p.modelId] = { key: p.key, name: p.name, title: p.title };
      }
      setSeatPersonas(next);
      return;
    }

    if (event.type === "phase") {
      setRunPhase(event.phase);
      return;
    }

    if (event.type === "model_step") {
      setModels((current) =>
        current.map((model) => {
          if (model.id !== event.modelId) return model;
          const next = { ...model, steps: event.steps, activityLog: appendUnique(model.activityLog, event.step) };
          if (event.phase === "debating") next.debateStatus = "thinking";
          else next.status = "thinking";
          return next;
        }),
      );
      return;
    }

    if (event.type === "model_complete") {
      addUsage(event.usage, { phase: "draft", modelId: event.modelId, label: event.label });
      setModels((current) =>
        current.map((model) =>
          model.id === event.modelId
            ? {
                ...model,
                status: "complete",
                steps: event.steps,
                response: event.content,
                viaFallbackFrom: event.viaFallbackFrom,
                activityLog: appendUnique(
                  model.activityLog,
                  event.viaFallbackFrom ? `Completado vía fallback (${event.viaFallbackFrom})` : "Completed independent draft",
                ),
              }
            : model,
        ),
      );
      return;
    }

    if (event.type === "model_debate_complete") {
      addUsage(event.usage, { phase: `debate (ronda ${event.round})`, modelId: event.modelId, label: event.label });
      setModels((current) =>
        current.map((model) =>
          model.id === event.modelId
            ? {
                ...model,
                debateStatus: "complete",
                steps: event.steps,
                critique: event.critique,
                revisedAnswer: event.revisedAnswer,
                debateRound: event.round,
                debateMaxRounds: event.maxRounds,
                debateHistory: [
                  ...(model.debateHistory ?? []),
                  { round: event.round, maxRounds: event.maxRounds, critique: event.critique, revisedAnswer: event.revisedAnswer },
                ],
                activityLog: appendUnique(model.activityLog, `Ronda ${event.round}/${event.maxRounds} completa — crítica enviada`),
              }
            : model,
        ),
      );
      return;
    }
    if (event.type === "debate_round_complete") {
      setDebateRounds((current) => [
        ...current,
        { round: event.round, maxRounds: event.maxRounds, participantCount: event.participantCount, convergence: event.convergence, converged: event.converged },
      ]);
      return;
    }
    if (event.type === "vote_cast") {
      addUsage(event.usage, { phase: "vote", modelId: event.modelId, label: event.label });
      setVotes((current) => [
        ...current,
        { modelId: event.modelId, label: event.label, votedForModelId: event.votedForModelId, votedForLabel: event.votedForLabel, rationale: event.rationale },
      ]);
      return;
    }
    if (event.type === "vote_tally_complete") {
      setVoteTally({ tally: event.tally, winnerModelId: event.winnerModelId, winnerLabel: event.winnerLabel, totalVotes: event.totalVotes });
      return;
    }

    if (event.type === "model_error") {
      setModels((current) =>
        current.map((model) => {
          if (model.id !== event.modelId) return model;
          const next = {
            ...model,
            steps: event.steps,
            error: event.error,
            activityLog: appendUnique(model.activityLog, `Error: ${event.error}`),
          };
          if (event.phase === "debating") next.debateStatus = "complete";
          else next.status = "complete";
          return next;
        }),
      );
      return;
    }

    if (event.type === "synthesis_started") { setSynthesisActivity(event.step); return; }
    if (event.type === "fusion_judge_complete") {
      addUsage(event.usage, { phase: "judge" });
      setFusionJudge(event.report);
      liveStateRef.current.fusionJudge = event.report;
      setSynthesisActivity("Fusion judge report complete");
      return;
    }
    if (event.type === "synthesis_complete") {
      addUsage(event.usage, { phase: "synthesis" });
      setSynthesis(event.content);
      liveStateRef.current.synthesis = event.content;
      setSynthesisActivity("Synthesis complete");
      return;
    }
    if (event.type === "image_started") {
      setImageStatus(`Generating image with ${event.model}`);
      setSynthesisActivity(`Generating image with ${event.model}`);
      return;
    }
    if (event.type === "image_complete") {
      addUsage(event.usage, { phase: "image", label: event.model });
      const images = event.images.map((url) => ({
        id: newId("image"),
        model: event.model,
        prompt: event.prompt,
        url,
        createdAt: Date.now(),
      }));
      setGeneratedImages(images);
      liveStateRef.current.generatedImages = images;
      setImageStatus("Image generation complete");
      setSynthesisActivity("Image generation complete");
      return;
    }
    if (event.type === "image_error") {
      setImageStatus(`Image generation failed: ${event.error}`);
      setSynthesisActivity(`Image generation failed: ${event.error}`);
      return;
    }
    if (event.type === "followups_complete") {
      addUsage(event.usage, { phase: "followups" });
      setFollowUps(event.questions);
      liveStateRef.current.followUps = event.questions;
      return;
    }
    if (event.type === "file_proposal") {
      setFileProposals((current) => [
        ...current,
        {
          id: event.proposal.id,
          groupId: event.proposal.groupId,
          modelId: event.modelId,
          kind: event.proposal.kind,
          path: event.proposal.path,
          diff: event.proposal.diff,
          status: "pending",
          typeCheck: event.proposal.typeCheck,
        },
      ]);
      return;
    }
    if (event.type === "file_proposal_verified") {
      setFileProposals((current) => current.map((p) => (p.id === event.proposalId ? { ...p, typeCheck: event.typeCheck } : p)));
      return;
    }
    if (event.type === "debate_skipped") {
      setDebateSkipped({ score: event.score, threshold: event.threshold, participantCount: event.participantCount });
      return;
    }
    if (event.type === "model_mind_change") {
      setModels((current) =>
        current.map((model) =>
          model.id === event.modelId ? { ...model, mindChangeSimilarity: event.similarity, mindChanged: event.changed } : model,
        ),
      );
      return;
    }
    if (event.type === "run_complete") { setPhase("results"); setRunPhase("done"); refreshModelHealth(); }
  }

  /** Vuelve al estado de entrada sin tocar el hilo activo (eso lo decide la página). */
  function resetRunState() {
    abortActiveRun();
    setSynthesis("");
    setFollowUps([]);
    setGeneratedImages([]);
    setFusionJudge(null);
    setImageStatus("");
    setSynthesisActivity("");
    setStreamError("");
    setRunModelIds([]);
    setResultTab("answer");
    setRunFusionPanelId(selectedFusionPanelId === "custom" ? null : selectedFusionPanelId);
  }

  /** Hidrata el estado de resultados desde un turno guardado. */
  function loadRunFromTurn(turn: StoredTurn) {
    abortActiveRun();
    setSynthesis(turn.synthesis);
    setFusionJudge(turn.fusionJudge ?? null);
    setFollowUps(turn.followUps ?? []);
    setGeneratedImages(turn.generatedImages ?? []);
    setImageStatus("");
    setRunModelIds(turn.models.map((m) => m.id));
    setRunFusionPanelId(turn.fusionPanelId ?? null);
    setRunPhase("done");
    setResultTab("answer");
    setStreamError("");
    setSynthesisActivity("");
  }

  return {
    runModelIds,
    runFusionPanelId,
    fusionJudge,
    synthesis,
    followUps,
    generatedImages,
    imageStatus,
    synthesisActivity,
    streamError,
    fileProposals,
    tokenUsage,
    tokenBreakdown,
    debateSkipped,
    seatPersonas,
    debateRounds,
    votes,
    voteTally,
    resultTab,
    setResultTab,
    runPhase,
    elapsedMs,
    runCouncil,
    stopGeneration,
    abortActiveRun,
    applyFileProposal,
    rejectFileProposal,
    applyFileProposalGroup,
    rejectFileProposalGroup,
    resetRunState,
    loadRunFromTurn,
  };
}
