"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, Gavel, Globe, Layers3, Sparkles } from "lucide-react";
import CouncilPanel from "./components/council/CouncilPanel";
import type { NodeState } from "./components/council/types";
import { DEFAULT_FUSION_PANEL_ID, FUSION_PANELS, IMAGE_MODELS, REASONING_EFFORTS } from "@/lib/models";
import { DEFAULT_SKILLS, type AgentSkill } from "@/lib/skills";
import {
  deleteThread as deleteThreadFromList,
  deleteThreadOnServer,
} from "@/lib/threads";
import type {
  ConnectorSettings,
  Phase,
  SettingsTab,
  UploadedAttachment,
} from "./lib/client-types";
import { DEMO_SOURCES, INITIAL_MODELS, SUGGESTIONS } from "./lib/constants";
import { Sidebar, PastTurnsFeed } from "./components/main/sidebar";
import { FollowUpComposer, CouncilComposer } from "./components/main/composer";
import { SettingsDrawer } from "./components/main/settings-drawer";
import { ThinkingStage } from "./components/main/agent-panels";
import { DebateView, SourcesView } from "./components/main/council-views";
import { ResultsDashboard, ModelResponseModal } from "./components/main/results";
import { TokenAccessGate } from "./components/auth/token-access-gate";
import { RunTraces } from "./components/main/run-traces";
import {
  compactQuestion,
  formatElapsed,
  formatTokens,
  loadAgentSkills,
  loadConnectorSettings,
  readUploads,
  saveAgentSkills,
  saveConnectorSettings,
} from "./lib/client-helpers";
import { useModelHealth } from "./hooks/useModelHealth";
import { useModelPing } from "./hooks/useModelPing";
import { useThreads } from "./hooks/useThreads";
import { useCouncilRun, type LiveState } from "./hooks/useCouncilRun";




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
  const [selectedFusionPanelId, setSelectedFusionPanelId] = useState(DEFAULT_FUSION_PANEL_ID);
  const [attachments, setAttachments] = useState<UploadedAttachment[]>([]);
  const [agentSkills, setAgentSkills] = useState<AgentSkill[]>(DEFAULT_SKILLS);
  const [connectors, setConnectors] = useState<ConnectorSettings>({ github: true, filesystem: false });
  const [fileAgentModelId, setFileAgentModelId] = useState<string>("");
  const [maxDebateRounds, setMaxDebateRounds] = useState(1);
  const [personaPresetId, setPersonaPresetId] = useState("");
  const [adaptiveMode, setAdaptiveMode] = useState(false);
  const [imageGenerationEnabled, setImageGenerationEnabled] = useState(false);
  const [selectedImageModel, setSelectedImageModel] = useState(IMAGE_MODELS[0]?.id ?? "openai/gpt-image-1.5");

  const { modelHealth, refreshModelHealth } = useModelHealth();
  const { pingStatus, pinging, runPing } = useModelPing();

  const liveStateRef = useRef<LiveState>({
    models: INITIAL_MODELS,
    synthesis: "",
    followUps: [],
    generatedImages: [],
    fusionJudge: null,
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

  const selectedModels = useMemo(() => models.filter((model) => model.selected), [models]);

  const {
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
    currentRunId,
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
  } = useCouncilRun({
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
    threads,
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
  });

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

  // Reloj del panel Consenso — vive en useCouncilRun, que corre mientras
  // `phase === "thinking"`.

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
    resetRunState();
    setActiveThreadId(null);
    setQuery("");
    setPhase("entry");
    setAttachments([]);
    window.history.replaceState(null, "", "/");
  }

  function selectThread(threadId: string) {
    abortActiveRun();
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
    loadRunFromTurn(lastTurn);
    setSelectedFusionPanelId(lastTurn.fusionPanelId ?? "custom");
    setPhase("results");
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
              onNewThread={() => {
                // /nuevo debe crear un hilo vacío SIN recargar la página: si
                // recargara, se perderían los borradores de los otros hilos.
                startNewThread();
                setMenuOpen(false);
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
                  <button
                    role="tab"
                    className={resultTab === "traces" ? "phaseTab active" : "phaseTab"}
                    onClick={() => setResultTab("traces")}
                  >
                    <Activity /> Trazas
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
                ) : resultTab === "traces" ? (
                  <RunTraces runId={currentRunId} threadId={activeThreadId} question={query} />
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

      {/* Fase 1.2: puerta de acceso por token. Sin cookie válida con
          APP_ACCESS_TOKEN definido, el proxy bloquea toda /api/* y la app
          no serviría de nada. Se reemplaza por el emparejamiento (Fase 4). */}
      <TokenAccessGate />
    </main>
  );
}
