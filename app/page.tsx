"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Gavel, Globe, Layers3, Sparkles } from "lucide-react";
import CouncilPanel from "./components/council/CouncilPanel";
import type { NodeState } from "./components/council/types";
import { DEFAULT_FUSION_PANEL_ID, FUSION_PANELS, IMAGE_MODELS, REASONING_EFFORTS } from "@/lib/models";
import { DEFAULT_SKILLS, type AgentSkill } from "@/lib/skills";
import {
  buildHistory,
  deleteThread as deleteThreadFromList,
  deleteThreadOnServer,
  makeThreadTitle,
  newId,
  type StoredGeneratedImage,
  type StoredThread,
  type StoredTurn,
} from "@/lib/threads";
import type {
  ConnectorSettings,
  CouncilStreamEvent,
  DebateRoundInfo,
  FileProposalState,
  FusionJudgeReport,
  Phase,
  ResultTab,
  RunPhase,
  SettingsTab,
  TokenUsage,
  UploadedAttachment,
  VoteCastInfo,
  VoteTallyInfo,
} from "./lib/client-types";
import { DEFAULT_QUERY, DEMO_SOURCES, INITIAL_MODELS, SUGGESTIONS } from "./lib/constants";
import { Sidebar, PastTurnsFeed } from "./components/main/sidebar";
import { FollowUpComposer, CouncilComposer } from "./components/main/composer";
import { SettingsDrawer } from "./components/main/settings-drawer";
import { ThinkingStage } from "./components/main/agent-panels";
import { DebateView, SourcesView } from "./components/main/council-views";
import { ResultsDashboard, ModelResponseModal } from "./components/main/results";
import {
  appendUnique,
  compactQuestion,
  formatElapsed,
  formatTokens,
  loadAgentSkills,
  loadConnectorSettings,
  readCouncilStream,
  readUploads,
  saveAgentSkills,
  saveConnectorSettings,
} from "./lib/client-helpers";
import { useModelHealth } from "./hooks/useModelHealth";
import { useModelPing } from "./hooks/useModelPing";
import { useThreads } from "./hooks/useThreads";




export default function Home() {
  const [query, setQuery] = useState("");
  const [phase, setPhase] = useState<Phase>("entry");
  const [models, setModels] = useState(INITIAL_MODELS);
  const [menuOpen, setMenuOpen] = useState(false);
  const [selectorOpen, setSelectorOpen] = useState(false);
  const [councilEnabled, setCouncilEnabled] = useState(true);
  const [webGrounding, setWebGrounding] = useState(false);
  const [activeModal, setActiveModal] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("connectors");
  const [runModelIds, setRunModelIds] = useState<string[]>([]);
  const [selectedFusionPanelId, setSelectedFusionPanelId] = useState(DEFAULT_FUSION_PANEL_ID);
  const [runFusionPanelId, setRunFusionPanelId] = useState<string | null>(DEFAULT_FUSION_PANEL_ID);
  const [fusionJudge, setFusionJudge] = useState<FusionJudgeReport | null>(null);
  const [synthesis, setSynthesis] = useState("");
  const [followUps, setFollowUps] = useState<string[]>([]);
  const [generatedImages, setGeneratedImages] = useState<StoredGeneratedImage[]>([]);
  const [imageStatus, setImageStatus] = useState("");
  const [synthesisActivity, setSynthesisActivity] = useState("");
  const [streamError, setStreamError] = useState("");
  const [attachments, setAttachments] = useState<UploadedAttachment[]>([]);
  const [agentSkills, setAgentSkills] = useState<AgentSkill[]>(DEFAULT_SKILLS);
  const [connectors, setConnectors] = useState<ConnectorSettings>({ github: true, filesystem: false });
  const [fileAgentModelId, setFileAgentModelId] = useState<string>("");
  const [fileProposals, setFileProposals] = useState<FileProposalState[]>([]);
  const [tokenUsage, setTokenUsage] = useState<TokenUsage>({});
  const [tokenBreakdown, setTokenBreakdown] = useState<Array<{ phase: string; modelId?: string; label?: string; usage: TokenUsage }>>([]);
  const [maxDebateRounds, setMaxDebateRounds] = useState(1);
  const [personaPresetId, setPersonaPresetId] = useState("");
  const [adaptiveMode, setAdaptiveMode] = useState(false);
  const [debateSkipped, setDebateSkipped] = useState<{ score: number; threshold: number; participantCount: number } | null>(null);
  const [seatPersonas, setSeatPersonas] = useState<Record<string, { key: string; name: string; title: string }>>({});
  const [debateRounds, setDebateRounds] = useState<DebateRoundInfo[]>([]);
  const [votes, setVotes] = useState<VoteCastInfo[]>([]);
  const [voteTally, setVoteTally] = useState<VoteTallyInfo | null>(null);
  const [imageGenerationEnabled, setImageGenerationEnabled] = useState(false);
  const [selectedImageModel, setSelectedImageModel] = useState(IMAGE_MODELS[0]?.id ?? "openai/gpt-image-1.5");
  const [resultTab, setResultTab] = useState<ResultTab>("answer");
  const [runPhase, setRunPhase] = useState<RunPhase>("drafting");
  const [elapsedMs, setElapsedMs] = useState(0);

  const { modelHealth, refreshModelHealth } = useModelHealth();
  const { pingStatus, pinging, runPing } = useModelPing();

  const abortRef = useRef<AbortController | null>(null);
  const runStartRef = useRef<number | null>(null);
  const liveStateRef = useRef({
    models: INITIAL_MODELS,
    synthesis: "",
    followUps: [] as string[],
    generatedImages: [] as StoredGeneratedImage[],
    fusionJudge: null as FusionJudgeReport | null,
    question: "",
  });

  const {
    threads,
    setThreads,
    activeThreadId,
    setActiveThreadId,
    pastTurns,
    activeThreadIdRef,
    hydrateModelsFromTurn,
    commitActiveTurn,
    syncThread,
    toggleFavorite,
  } = useThreads({ liveStateRef, setModels, phase });


  const [hydrated, setHydrated] = useState(false);

  // Load on mount
  useEffect(() => {
    setAgentSkills(loadAgentSkills());
    setConnectors(loadConnectorSettings());
    setHydrated(true);
  }, []);

  useEffect(() => {
    liveStateRef.current.models = models;
    liveStateRef.current.synthesis = synthesis;
    liveStateRef.current.followUps = followUps;
    liveStateRef.current.generatedImages = generatedImages;
    liveStateRef.current.fusionJudge = fusionJudge;
    liveStateRef.current.question = query;
  }, [models, synthesis, followUps, generatedImages, fusionJudge, query]);

  useEffect(() => {
    if (!hydrated) return;
    saveAgentSkills(agentSkills);
  }, [agentSkills, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    saveConnectorSettings(connectors);
  }, [connectors, hydrated]);

  // Reloj del panel Consenso — corre mientras hay una corrida en curso.
  useEffect(() => {
    if (phase !== "thinking") return;
    const tick = () => setElapsedMs(runStartRef.current ? Date.now() - runStartRef.current : 0);
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [phase]);

  const selectedModels = useMemo(() => models.filter((model) => model.selected), [models]);
  const activeModels = useMemo(() => {
    const ids = runModelIds.length ? runModelIds : selectedModels.map((model) => model.id);
    return models.filter((model) => ids.includes(model.id));
  }, [models, runModelIds, selectedModels]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setMenuOpen(false);
        setSelectorOpen(false);
        setSettingsOpen(false);
        setActiveModal(null);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  function toggleModel(id: string) {
    setSelectedFusionPanelId("custom");
    setModels((current) => {
      // Search mode: radio behavior — exactly one selected, can't deselect the active one.
      if (!councilEnabled) {
        return current.map((model) => ({ ...model, selected: model.id === id }));
      }
      return current.map((model) => {
        if (model.id !== id) return model;
        if (model.selected && current.filter((item) => item.selected).length <= 2) return model;
        return { ...model, selected: !model.selected };
      });
    });
  }

  function cycleReasoningEffort(id: string) {
    setSelectedFusionPanelId("custom");
    setModels((current) =>
      current.map((model) => {
        if (model.id !== id) return model;
        const idx = REASONING_EFFORTS.indexOf(model.reasoningEffort);
        const next = REASONING_EFFORTS[(idx + 1) % REASONING_EFFORTS.length];
        return { ...model, reasoningEffort: next };
      }),
    );
  }

  function selectTopThree() {
    applyFusionPanel(DEFAULT_FUSION_PANEL_ID);
  }

  function applyFusionPanel(panelId: string) {
    const panel = FUSION_PANELS.find((item) => item.id === panelId);
    if (!panel) return;
    const panelIds = new Set(panel.modelIds);
    setCouncilEnabled(true);
    setSelectedFusionPanelId(panelId);
    setModels((current) =>
      current.map((model) => ({ ...model, selected: panelIds.has(model.id) })),
    );
  }

  function enterSearchMode() {
    setCouncilEnabled(false);
    setSelectedFusionPanelId("custom");
    setModels((current) => {
      const firstSelectedIdx = current.findIndex((m) => m.selected);
      const keepIdx = firstSelectedIdx >= 0 ? firstSelectedIdx : 0;
      return current.map((model, index) => ({ ...model, selected: index === keepIdx }));
    });
  }

  function enterCouncilMode() {
    setCouncilEnabled(true);
    setModels((current) => {
      const selectedCount = current.filter((m) => m.selected).length;
      if (selectedCount >= 2) return current;
      // Top up to 3 from the front, preserving any existing selection.
      const toSelect = new Set(current.filter((m) => m.selected).map((m) => m.id));
      for (const m of current) {
        if (toSelect.size >= 3) break;
        toSelect.add(m.id);
      }
      return current.map((model) => ({ ...model, selected: toSelect.has(model.id) }));
    });
  }

  function startNewThread() {
    abortRef.current?.abort();
    abortRef.current = null;
    setActiveThreadId(null);
    setQuery("");
    setPhase("entry");
    setSynthesis("");
    setFollowUps([]);
    setGeneratedImages([]);
    setFusionJudge(null);
    setImageStatus("");
    setSynthesisActivity("");
    setStreamError("");
    setRunModelIds([]);
    setAttachments([]);
    setResultTab("answer");
    setRunFusionPanelId(selectedFusionPanelId === "custom" ? null : selectedFusionPanelId);
    window.history.replaceState(null, "", "/");
  }

  function selectThread(threadId: string) {
    abortRef.current?.abort();
    abortRef.current = null;
    const thread = threads.find((t) => t.id === threadId);
    if (!thread) return;
    setActiveThreadId(threadId);
    const lastTurn = thread.turns[thread.turns.length - 1];
    if (!lastTurn) {
      setPhase("entry");
      return;
    }
    hydrateModelsFromTurn(lastTurn);
    setQuery(lastTurn.question);
    setSynthesis(lastTurn.synthesis);
    setFusionJudge(lastTurn.fusionJudge ?? null);
    setFollowUps(lastTurn.followUps ?? []);
    setGeneratedImages(lastTurn.generatedImages ?? []);
    setImageStatus("");
    setRunModelIds(lastTurn.models.map((m) => m.id));
    setRunFusionPanelId(lastTurn.fusionPanelId ?? null);
    setSelectedFusionPanelId(lastTurn.fusionPanelId ?? "custom");
    setRunPhase("done");
    setPhase("results");
    setResultTab("answer");
    setStreamError("");
    setSynthesisActivity("");
    setMenuOpen(false);
    setSelectorOpen(false);
  }

  function removeThread(threadId: string) {
    setThreads((current) => deleteThreadFromList(current, threadId));
    if (activeThreadId === threadId) startNewThread();
    deleteThreadOnServer(threadId).catch(() => {
      // Best-effort — si falla, el hilo reaparecerá en la próxima carga (queda en el server).
    });
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

  return (
    <main className="perplexityShell">
      <Sidebar
        threads={threads}
        activeThreadId={activeThreadId}
        onNewThread={startNewThread}
        onSelectThread={selectThread}
        onDeleteThread={removeThread}
        onToggleFavorite={toggleFavorite}
        onOpenSettings={() => {
          setSettingsTab("connectors");
          setSettingsOpen(true);
        }}
      />

      <div className="perplexityMain">
        {phase === "entry" ? (
          <section className="entryScreen">
            <div className="entryHero">
              <CouncilPanel
                status="standby"
                eyebrow="SISTEMA CONSENSO"
                headline="EN ESPERA"
                detail="ESPERANDO CONSULTA"
                stats={[
                  { label: "MODELOS ARMADOS", value: String(selectedModels.length) },
                  {
                    label: "PANEL",
                    value:
                      selectedFusionPanelId === "custom"
                        ? "PERSONALIZADO"
                        : (FUSION_PANELS.find((p) => p.id === selectedFusionPanelId)?.label ?? "PERSONALIZADO").toUpperCase(),
                  },
                ]}
                nodes={selectedModels.map((model) => ({
                  id: model.id,
                  label: model.label,
                  badge: model.badge,
                  state: "waiting" as NodeState,
                }))}
              />
              <h1>
                Donde nace el <em>consenso</em>
              </h1>
              <p className="entrySubcopy">
                Reuní un panel de modelos de IA de punta, comparé sus respuestas independientes, y mirá
                dónde coinciden, discrepan y divergen.
              </p>
              <p className="entryFreeNotice">
                Funciona <strong>primariamente con modelos gratuitos</strong> (OpenRouter, NVIDIA NIM).
                Si tenés crédito cargado en OpenRouter (o un proveedor similar), también podés sumar
                modelos de pago al panel para mayor calidad.
              </p>
            </div>

            <CouncilComposer
              query={query}
              setQuery={setQuery}
              councilEnabled={councilEnabled}
              setCouncilEnabled={setCouncilEnabled}
              enterSearchMode={enterSearchMode}
              enterCouncilMode={enterCouncilMode}
              webGrounding={webGrounding}
              toggleWebGrounding={() => setWebGrounding((v) => !v)}
              menuOpen={menuOpen}
              setMenuOpen={setMenuOpen}
              selectorOpen={selectorOpen}
              setSelectorOpen={setSelectorOpen}
              selectedCount={selectedModels.length}
              selectedFusionPanelId={selectedFusionPanelId}
              applyFusionPanel={applyFusionPanel}
              models={models}
              toggleModel={toggleModel}
              cycleReasoningEffort={cycleReasoningEffort}
              selectTopThree={selectTopThree}
              attachments={attachments}
              agentSkills={agentSkills}
              imageGenerationEnabled={imageGenerationEnabled}
              onOpenSettings={() => {
                setSettingsTab("connectors");
                setSettingsOpen(true);
              }}
              onFilesSelected={async (files) => {
                const uploads = await readUploads(files);
                setAttachments((current) => [...current, ...uploads].slice(0, 8));
              }}
              onRemoveAttachment={(id) => setAttachments((current) => current.filter((attachment) => attachment.id !== id))}
              runCouncil={() => runCouncil()}
              modelHealth={modelHealth}
              pingStatus={pingStatus}
              pinging={pinging}
              onPingModels={() => runPing(selectedModels.map((m) => m.id))}
            />

            <div className="suggestionRow">
              {SUGGESTIONS.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.label}
                    className="suggestionChip"
                    type="button"
                    onClick={() => { setQuery(item.query); }}
                  >
                    <Icon size={14} />
                    {item.label}
                  </button>
                );
              })}
            </div>
          </section>
        ) : (
          <section className="sessionScreen">
            {pastTurns.length ? (
              <PastTurnsFeed
                turns={pastTurns}
                models={models}
                onOpenModel={setActiveModal}
              />
            ) : null}

            <div className="sessionQuestion">
              <span>{pastTurns.length ? `Follow-up · turn ${pastTurns.length + 1}` : "Question"}</span>
              <h1>{compactQuestion(query)}</h1>
            </div>

            {phase === "thinking" ? (
              <ThinkingStage
                models={activeModels}
                synthesisActivity={synthesisActivity}
                streamError={streamError}
                runPhase={runPhase}
                elapsedMs={elapsedMs}
                onOpenModelResponse={setActiveModal}
                onStop={stopGeneration}
                fileProposals={fileProposals}
                onApplyProposal={applyFileProposal}
                onRejectProposal={rejectFileProposal}
                onApplyProposalGroup={applyFileProposalGroup}
                onRejectProposalGroup={rejectFileProposalGroup}
                tokenUsage={tokenUsage}
                debateRounds={debateRounds}
                seatPersonas={seatPersonas}
              />
            ) : (
              <>
                <CouncilPanel
                  status={streamError ? "error" : "complete"}
                  eyebrow={streamError ? "ALERTA DEL SISTEMA" : "DELIBERACIÓN COMPLETA"}
                  headline={streamError ? "ERROR" : "DECISIÓN DEL CONSENSO"}
                  detail={streamError || "RESPUESTA FINAL LISTA"}
                  stats={[
                    { label: "MODELOS", value: String(activeModels.length) },
                    { label: "DEBATIERON", value: String(activeModels.filter((m) => m.critique).length) },
                    { label: "TRANSCURRIDO", value: formatElapsed(elapsedMs) },
                    { label: "TOKENS", value: formatTokens(tokenUsage.total_tokens) },
                  ]}
                  nodes={activeModels.map((model) => ({
                    id: model.id,
                    label: model.label,
                    badge: model.badge,
                    state: (model.error ? "error" : "complete") as NodeState,
                  }))}
                />
                <div className="phaseTabs" role="tablist">
                  <button
                    role="tab"
                    className={resultTab === "answer" ? "phaseTab active" : "phaseTab"}
                    onClick={() => setResultTab("answer")}
                  >
                    <Sparkles /> Respuesta
                  </button>
                  <button
                    role="tab"
                    className={resultTab === "debate" ? "phaseTab active" : "phaseTab"}
                    onClick={() => setResultTab("debate")}
                  >
                    <Gavel /> Debate <em className="count">{activeModels.filter((m) => m.critique).length}</em>
                  </button>
                  <button
                    role="tab"
                    className={resultTab === "sources" ? "phaseTab active" : "phaseTab"}
                    onClick={() => setResultTab("sources")}
                  >
                    <Globe /> Fuentes <em className="count">{DEMO_SOURCES.length}</em>
                  </button>
                  <button
                    role="tab"
                    className={resultTab === "steps" ? "phaseTab active" : "phaseTab"}
                    onClick={() => setResultTab("steps")}
                  >
                    <Layers3 /> Pasos <em className="count">{activeModels.length}</em>
                  </button>
                </div>

                {resultTab === "answer" ? (
                  <ResultsDashboard
                    models={activeModels}
                    query={query}
                    synthesis={synthesis}
                    fusionJudge={fusionJudge}
                    fusionPanelId={runFusionPanelId}
                    followUps={followUps}
                    generatedImages={generatedImages}
                    imageStatus={imageStatus}
                    onOpenModal={setActiveModal}
                    onRunFollowup={(value) => runCouncil(value)}
                    tokenUsage={tokenUsage}
                    tokenBreakdown={tokenBreakdown}
                  />
                ) : resultTab === "debate" ? (
                  <DebateView models={activeModels} debateRounds={debateRounds} votes={votes} voteTally={voteTally} seatPersonas={seatPersonas} debateSkipped={debateSkipped} />
                ) : resultTab === "sources" ? (
                  <SourcesView models={activeModels} />
                ) : (
                  <ThinkingStage
                    models={activeModels}
                    synthesisActivity={synthesisActivity}
                    streamError={streamError}
                    runPhase={runPhase}
                    elapsedMs={elapsedMs}
                    onOpenModelResponse={setActiveModal}
                    onStop={stopGeneration}
                    fileProposals={fileProposals}
                    onApplyProposal={applyFileProposal}
                    onRejectProposal={rejectFileProposal}
                    onApplyProposalGroup={applyFileProposalGroup}
                    onRejectProposalGroup={rejectFileProposalGroup}
                    tokenUsage={tokenUsage}
                    debateRounds={debateRounds}
                    seatPersonas={seatPersonas}
                  />
                )}

                <FollowUpComposer
                  selectedCount={selectedModels.length}
                  onSubmit={(value) => runCouncil(value)}
                />
              </>
            )}
          </section>
        )}

        {activeModal ? (
          <ModelResponseModal
            model={models.find((model) => model.id === activeModal) ?? activeModels[0]}
            onClose={() => setActiveModal(null)}
          />
        ) : null}

        {settingsOpen ? (
          <SettingsDrawer
            tab={settingsTab}
            setTab={setSettingsTab}
            connectors={connectors}
            setConnectors={setConnectors}
            fileAgentModelId={fileAgentModelId}
            setFileAgentModelId={setFileAgentModelId}
            fileAgentCandidates={selectedModels}
            skills={agentSkills}
            setSkills={setAgentSkills}
            webGrounding={webGrounding}
            setWebGrounding={setWebGrounding}
            maxDebateRounds={maxDebateRounds}
            setMaxDebateRounds={setMaxDebateRounds}
            personaPresetId={personaPresetId}
            setPersonaPresetId={setPersonaPresetId}
            adaptiveMode={adaptiveMode}
            setAdaptiveMode={setAdaptiveMode}
            selectedCount={selectedModels.length}
            imageGenerationEnabled={imageGenerationEnabled}
            setImageGenerationEnabled={setImageGenerationEnabled}
            selectedImageModel={selectedImageModel}
            setSelectedImageModel={setSelectedImageModel}
            onClose={() => setSettingsOpen(false)}
          />
        ) : null}
      </div>
    </main>
  );
}
