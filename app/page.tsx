"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowRight,
  ArrowUp,
  Bookmark,
  Check,
  ChevronDown,
  CirclePlus,
  Copy,
  FileText,
  Gavel,
  Globe,
  Image as ImageIcon,
  Layers3,
  MessageSquare,
  MessageSquareQuote,
  Mic,
  Plus,
  Search,
  Share2,
  Sparkles,
  Square,
  Telescope,
  Trash2,
  TrendingUp,
  Upload,
  Wrench,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { COUNCIL_MODELS, DEFAULT_FUSION_PANEL_ID, FUSION_PANELS, IMAGE_MODELS, REASONING_EFFORTS, type ReasoningEffort } from "@/lib/models";
import { DEFAULT_SKILLS, importSkillFromText, type AgentSkill } from "@/lib/skills";
import {
  buildHistory,
  deleteThread as deleteThreadFromList,
  loadThreads,
  makeThreadTitle,
  newId,
  saveThreads,
  type StoredGeneratedImage,
  type StoredModelTurn,
  type StoredThread,
  type StoredTurn,
} from "@/lib/threads";

type Phase = "entry" | "thinking" | "results";
type ModelRunState = "queued" | "thinking" | "complete";
type ResultTab = "answer" | "debate" | "sources" | "steps";
type RunPhase = "drafting" | "debating" | "synthesizing" | "done";
type SettingsTab = "connectors" | "skills" | "research" | "images";

type ConnectorSettings = {
  github: boolean;
};

type FusionJudgeReport = {
  panelVerdict: string;
  consensus: Array<{ finding: string; models: string[]; evidence: string }>;
  contradictions: Array<{ topic: string; positions: Record<string, string>; judgment: string }>;
  uniqueInsights: Array<{ model: string; insight: string; whyItMatters: string }>;
  coverageGaps: string[];
};

type RunModel = {
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
  error?: string;
};

type UploadedAttachment = {
  id: string;
  name: string;
  type: string;
  size: number;
  kind: "image" | "text" | "file";
  dataUrl?: string;
  text?: string;
};

type CouncilStreamEvent =
  | { type: "run_started"; prompt: string; selectedModels: string[]; fusionPanelId?: string }
  | { type: "phase"; phase: RunPhase }
  | { type: "model_step"; modelId: string; label: string; step: string; steps: number; status: "thinking"; phase: RunPhase }
  | { type: "model_complete"; modelId: string; label: string; content: string; steps: number; phase: "drafting" }
  | { type: "model_debate_complete"; modelId: string; label: string; critique: string; revisedAnswer?: string; steps: number }
  | { type: "model_error"; modelId: string; label: string; error: string; steps: number; phase: RunPhase }
  | { type: "synthesis_started"; step: string }
  | { type: "fusion_judge_complete"; report: FusionJudgeReport }
  | { type: "synthesis_complete"; content: string }
  | { type: "image_started"; model: string; prompt: string }
  | { type: "image_complete"; model: string; prompt: string; images: string[] }
  | { type: "image_error"; error: string }
  | { type: "followups_complete"; questions: string[] }
  | { type: "run_complete" }
  | { type: "error"; error: string };

const DEFAULT_QUERY =
  "What were the main factors driving inflation in the United States in 2025?";

const SUGGESTIONS: Array<{ icon: LucideIcon; label: string; query: string }> = [
  { icon: TrendingUp, label: "Compare frontier model benchmarks", query: "Compare the latest frontier LLM benchmarks across reasoning, coding, and multimodal tasks." },
  { icon: Globe, label: "Drivers of US inflation in 2025", query: DEFAULT_QUERY },
  { icon: Telescope, label: "Risks of agentic AI in production", query: "What are the biggest risks of deploying agentic AI systems in production today?" },
  { icon: Sparkles, label: "Best practices for RAG at scale", query: "What are the current best practices for building RAG pipelines at scale?" },
];

const DEMO_SOURCES = [
  { title: "Federal Reserve Bank of Richmond — 2025 Outlook", domain: "richmondfed.org" },
  { title: "Deloitte Insights: Inflation drivers across goods and services", domain: "deloitte.com" },
  { title: "USAFacts — CPI breakdown by category", domain: "usafacts.org" },
  { title: "Brookings: Tariffs and the price level in 2025", domain: "brookings.edu" },
];

const MENU_OPTIONS: Array<{
  icon: LucideIcon;
  label: string;
  active?: boolean;
  upload?: boolean;
  badge?: string;
  note?: string;
}> = [
  { icon: Upload, label: "Upload files or images", upload: true, note: "Images, code, PDFs, docs" },
  { icon: Layers3, label: "Model council", active: true, note: "Compare answers from multiple models" },
];

const DEFAULT_FUSION_PANEL = FUSION_PANELS.find((panel) => panel.id === DEFAULT_FUSION_PANEL_ID) ?? FUSION_PANELS[0];
const DEFAULT_MODEL_IDS = new Set(DEFAULT_FUSION_PANEL?.modelIds ?? COUNCIL_MODELS.filter((model) => model.defaultSelected).map((model) => model.id));

const INITIAL_MODELS: RunModel[] = COUNCIL_MODELS.map((model) => ({
  id: model.id,
  label: model.label,
  maker: model.maker,
  badge: model.shortName.slice(0, 1),
  accent: model.accent,
  logoUrl: model.logoUrl,
  selected: DEFAULT_MODEL_IDS.has(model.id),
  reasoningEffort: model.defaultReasoningEffort,
  steps: 0,
  status: "queued",
  debateStatus: "queued",
  activityLog: [],
}));

const SKILLS_STORAGE_KEY = "council:agent-skills:v1";
const CONNECTORS_STORAGE_KEY = "council:connectors:v1";

const agreeRows = [
  {
    finding: "Inflation cooled from the 2022 peak, but remained sticky because services and shelter were slow to normalize.",
    models: ["openai/gpt-5.4", "anthropic/claude-opus-4.7", "google/gemini-3.1-pro-preview"],
    evidence: "Core services stayed elevated while goods disinflation faded.",
    source: "richmondfed +1",
  },
  {
    finding: "Tariffs and trade uncertainty raised expected goods prices more than they explained the whole inflation picture.",
    models: ["openai/gpt-5.4", "anthropic/claude-opus-4.7", "google/gemini-3.1-pro-preview", "x-ai/grok-4.3"],
    evidence: "Import-sensitive categories showed renewed pressure in 2025.",
    source: "deloitte +2",
  },
  {
    finding: "The labor market and wage growth kept services demand resilient, limiting how quickly inflation could return to target.",
    models: ["openai/gpt-5.4", "anthropic/claude-opus-4.7", "x-ai/grok-4.3"],
    evidence: "Services inflation tracked wage-sensitive categories.",
    source: "usafacts +2",
  },
];

const disagreeRows = [
  {
    topic: "How much tariffs mattered",
    cells: {
      "openai/gpt-5.4": "Important second-half pressure, especially for goods and inflation expectations.",
      "anthropic/claude-opus-4.7": "Meaningful, but too narrow to explain services and shelter persistence.",
      "google/gemini-3.1-pro-preview": "A relative-price shock that risked spilling into broader expectations.",
      "x-ai/grok-4.3": "Politically salient, but overstated as the single cause.",
    },
    why: "The models separate direct tariff pass-through from broader inflation persistence differently.",
  },
  {
    topic: "Shelter’s role",
    cells: {
      "openai/gpt-5.4": "Lagged rent measures were still a major source of measured CPI pressure.",
      "anthropic/claude-opus-4.7": "Shelter explained stickiness, but real-time rents pointed toward slower future pressure.",
      "google/gemini-3.1-pro-preview": "Housing supply constraints mattered more than short-run demand.",
      "x-ai/grok-4.3": "Shelter was a measurement lag story as much as a fresh inflation story.",
    },
    why: "They weigh official CPI shelter lags against real-time rental data at different levels.",
  },
];

const uniqueRows = [
  {
    id: "openai/gpt-5.4",
    finding: "Business inventory front-loading likely distorted 2025 goods prices before tariffs fully landed.",
    matters: "It explains why some price pressure appeared before consumers saw the full policy effect.",
  },
  {
    id: "anthropic/claude-opus-4.7",
    finding: "Inflation expectations were a transmission channel, not just an outcome.",
    matters: "Expectations can make temporary shocks more persistent through pricing and wage negotiations.",
  },
  {
    id: "google/gemini-3.1-pro-preview",
    finding: "The cleanest story is category-specific: goods, shelter, and services each had different drivers.",
    matters: "Policy interpretation changes if inflation is decomposed instead of treated as one blob.",
  },
  {
    id: "x-ai/grok-4.3",
    finding: "Public perception lagged headline disinflation because visible prices stayed high.",
    matters: "It clarifies why consumers felt inflation even when year-over-year rates looked better.",
  },
];

const modelResponses: Record<string, string[]> = {
  "openai/gpt-5.4": [
    "The strongest explanation is a mixed-driver story: residual shelter inflation, services demand, and renewed goods pressure from trade policy.",
    "I would not attribute 2025 inflation to a single shock. Tariffs mattered most where import exposure was obvious, while shelter and wages explained persistence.",
    "Confidence is medium-high because the drivers point in the same direction across CPI components, Fed commentary, and private forecasts.",
  ],
  "anthropic/claude-opus-4.7": [
    "The main caution is that some 2025 inflation looked like policy pass-through while some was simply the slow unwinding of earlier housing and labor-market dynamics.",
    "Tariffs raise prices, but they do not automatically create durable inflation unless expectations, wages, or margins transmit the shock broadly.",
    "The most useful answer is therefore segmented: goods were tariff-sensitive, shelter was lag-sensitive, and services were wage-sensitive.",
  ],
  "google/gemini-3.1-pro-preview": [
    "The models converge on three categories: shelter, services, and import-sensitive goods. Each category had a different timing pattern.",
    "The strongest evidence is cross-source: official CPI/PCE components, Fed regional analysis, and private-sector commentary about inventory behavior.",
    "For policy, the key distinction is temporary level effects versus persistent inflation momentum.",
  ],
  "x-ai/grok-4.3": [
    "The obvious story is tariffs, but the better story is that tariffs landed on an economy where many prices had already reset upward.",
    "Consumers react to price levels, not just inflation rates. That gap explains why the political conversation sounded hotter than the headline data.",
    "The wildcard was whether firms absorbed margin pressure or passed it through quickly.",
  ],
};

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
  const [connectors, setConnectors] = useState<ConnectorSettings>({ github: true });
  const [imageGenerationEnabled, setImageGenerationEnabled] = useState(false);
  const [selectedImageModel, setSelectedImageModel] = useState(IMAGE_MODELS[0]?.id ?? "openai/gpt-image-1.5");
  const [resultTab, setResultTab] = useState<ResultTab>("answer");
  const [runPhase, setRunPhase] = useState<RunPhase>("drafting");

  const [threads, setThreads] = useState<StoredThread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const liveStateRef = useRef({
    models: INITIAL_MODELS,
    synthesis: "",
    followUps: [] as string[],
    generatedImages: [] as StoredGeneratedImage[],
    fusionJudge: null as FusionJudgeReport | null,
    question: "",
  });
  const activeThread = useMemo(
    () => threads.find((thread) => thread.id === activeThreadId) ?? null,
    [threads, activeThreadId],
  );
  const pastTurns = useMemo(() => {
    if (!activeThread) return [] as StoredTurn[];
    // While streaming the latest turn, show all earlier turns above.
    if (phase === "thinking") return activeThread.turns.slice(0, -1);
    // When viewing results, show all turns except the active (last) one.
    if (phase === "results") return activeThread.turns.slice(0, -1);
    return activeThread.turns;
  }, [activeThread, phase]);

  // Load on mount
  useEffect(() => {
    setThreads(loadThreads());
    setAgentSkills(loadAgentSkills());
    setConnectors(loadConnectorSettings());
    setHydrated(true);
  }, []);

  // Persist on every change after hydration
  useEffect(() => {
    if (!hydrated) return;
    saveThreads(threads);
  }, [threads, hydrated]);

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
  }

  function hydrateModelsFromTurn(turn: StoredTurn) {
    setModels((current) =>
      current.map((base) => {
        const stored = turn.models.find((m) => m.id === base.id);
        if (!stored) {
          return { ...base, selected: false, status: "queued", debateStatus: "queued", response: undefined, critique: undefined, revisedAnswer: undefined, error: undefined, steps: 0, activityLog: [] };
        }
        return {
          ...base,
          selected: true,
          status: "complete",
          debateStatus: stored.critique || stored.revisedAnswer ? "complete" : "queued",
          steps: stored.steps,
          response: stored.response,
          critique: stored.critique,
          revisedAnswer: stored.revisedAnswer,
          error: stored.error,
          activityLog: stored.activityLog ?? [],
        };
      }),
    );
  }

  function snapshotModelsForTurn(modelIds: string[]): StoredModelTurn[] {
    return liveStateRef.current.models
      .filter((m) => modelIds.includes(m.id))
      .map((m) => ({
        id: m.id,
        label: m.label,
        maker: m.maker,
        badge: m.badge,
        accent: m.accent,
        logoUrl: m.logoUrl,
        steps: m.steps,
        response: m.response,
        critique: m.critique,
        revisedAnswer: m.revisedAnswer,
        error: m.error,
        activityLog: m.activityLog,
      }));
  }

  function commitActiveTurn(status: StoredTurn["status"]) {
    setThreads((current) =>
      current.map((thread) => {
        if (thread.id !== activeThreadIdRef.current) return thread;
        const turns = [...thread.turns];
        const last = turns[turns.length - 1];
        if (!last) return thread;
        turns[turns.length - 1] = {
          ...last,
          synthesis: liveStateRef.current.synthesis || last.synthesis,
          followUps: liveStateRef.current.followUps.length ? liveStateRef.current.followUps : last.followUps,
          generatedImages: liveStateRef.current.generatedImages.length
            ? liveStateRef.current.generatedImages
            : last.generatedImages,
          fusionJudge: liveStateRef.current.fusionJudge ?? last.fusionJudge,
          models: snapshotModelsForTurn(last.models.map((m) => m.id)),
          status,
        };
        return { ...thread, updatedAt: Date.now(), turns };
      }),
    );
  }

  // We need a ref for activeThreadId so async callbacks can read the latest.
  const activeThreadIdRef = useRef<string | null>(null);
  useEffect(() => { activeThreadIdRef.current = activeThreadId; }, [activeThreadId]);

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
        return current.map((thread) =>
          thread.id === threadId
            ? { ...thread, updatedAt: Date.now(), turns: [...thread.turns, newTurn] }
            : thread,
        );
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
      return [created, ...current];
    });

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
    setRunFusionPanelId(nextFusionPanelId);
    setModels((current) =>
      current.map((model) => ({
        ...model,
        steps: 0,
        status: "queued",
        debateStatus: "queued",
        activityLog: nextRunModelIds.includes(model.id) ? ["Queued for independent council pass"] : [],
        response: undefined,
        critique: undefined,
        revisedAnswer: undefined,
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

  function handleStreamEvent(event: CouncilStreamEvent) {
    if (event.type === "error") { setStreamError(event.error); return; }

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
      setModels((current) =>
        current.map((model) =>
          model.id === event.modelId
            ? { ...model, status: "complete", steps: event.steps, response: event.content, activityLog: appendUnique(model.activityLog, "Completed independent draft") }
            : model,
        ),
      );
      return;
    }

    if (event.type === "model_debate_complete") {
      setModels((current) =>
        current.map((model) =>
          model.id === event.modelId
            ? {
                ...model,
                debateStatus: "complete",
                steps: event.steps,
                critique: event.critique,
                revisedAnswer: event.revisedAnswer,
                activityLog: appendUnique(model.activityLog, "Debate complete — critique submitted"),
              }
            : model,
        ),
      );
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
      setFusionJudge(event.report);
      liveStateRef.current.fusionJudge = event.report;
      setSynthesisActivity("Fusion judge report complete");
      return;
    }
    if (event.type === "synthesis_complete") {
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
      setFollowUps(event.questions);
      liveStateRef.current.followUps = event.questions;
      return;
    }
    if (event.type === "run_complete") { setPhase("results"); setRunPhase("done"); }
  }

  return (
    <main className="perplexityShell">
      <Sidebar
        threads={threads}
        activeThreadId={activeThreadId}
        onNewThread={startNewThread}
        onSelectThread={selectThread}
        onDeleteThread={removeThread}
        onOpenSettings={() => {
          setSettingsTab("connectors");
          setSettingsOpen(true);
        }}
      />

      <div className="perplexityMain">
        {phase === "entry" ? (
          <section className="entryScreen">
            <div className="entryHero">
              <div className="launchCube" aria-hidden="true">
                <div className="cubeCore" />
                <span />
                <span />
                <span />
              </div>
              <h1>
                Where <em>knowledge</em> begins
              </h1>
              <p className="entrySubcopy">
                Convene a council of frontier models, compare their independent answers, and inspect
                where they agree, disagree, and diverge.
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
                onOpenModelResponse={setActiveModal}
                onStop={stopGeneration}
              />
            ) : (
              <>
                <div className="phaseTabs" role="tablist">
                  <button
                    role="tab"
                    className={resultTab === "answer" ? "phaseTab active" : "phaseTab"}
                    onClick={() => setResultTab("answer")}
                  >
                    <Sparkles /> Answer
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
                    <Globe /> Sources <em className="count">{DEMO_SOURCES.length}</em>
                  </button>
                  <button
                    role="tab"
                    className={resultTab === "steps" ? "phaseTab active" : "phaseTab"}
                    onClick={() => setResultTab("steps")}
                  >
                    <Layers3 /> Steps <em className="count">{activeModels.length}</em>
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
                  />
                ) : resultTab === "debate" ? (
                  <DebateView models={activeModels} />
                ) : resultTab === "sources" ? (
                  <SourcesView models={activeModels} />
                ) : (
                  <ThinkingStage
                    models={activeModels}
                    synthesisActivity={synthesisActivity}
                    streamError={streamError}
                    runPhase={runPhase}
                    onOpenModelResponse={setActiveModal}
                    onStop={stopGeneration}
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
            skills={agentSkills}
            setSkills={setAgentSkills}
            webGrounding={webGrounding}
            setWebGrounding={setWebGrounding}
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

/* =========================================================
   Sidebar
   ========================================================= */

function Sidebar({
  threads, activeThreadId, onNewThread, onSelectThread, onDeleteThread, onOpenSettings,
}: {
  threads: StoredThread[];
  activeThreadId: string | null;
  onNewThread: () => void;
  onSelectThread: (id: string) => void;
  onDeleteThread: (id: string) => void;
  onOpenSettings: () => void;
}) {
  const sorted = [...threads].sort((a, b) => b.updatedAt - a.updatedAt);
  return (
    <aside className="sidebar">
      <div className="sidebarBrand">
        <div className="sidebarLogo"><Sparkles size={16} /></div>
        <span>Council</span>
      </div>

      <button className="newThread" type="button" onClick={onNewThread}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <Plus size={16} /> New Thread
        </span>
        <kbd>⌘K</kbd>
      </button>

      <div className="sidebarSection">Threads</div>
      <div className="sidebarThreads">
        {sorted.length === 0 ? (
          <p className="sidebarEmpty">No threads yet. Ask the council something to begin.</p>
        ) : (
          sorted.map((thread) => {
            const turnCount = thread.turns.length;
            const isActive = thread.id === activeThreadId;
            return (
              <div
                key={thread.id}
                className={isActive ? "sidebarThreadRow active" : "sidebarThreadRow"}
              >
                <button
                  className="sidebarThread"
                  type="button"
                  onClick={() => onSelectThread(thread.id)}
                  title={thread.title}
                >
                  <span className="sidebarThreadTitle">{thread.title}</span>
                  <span className="sidebarThreadMeta">
                    {turnCount} {turnCount === 1 ? "turn" : "turns"} · {timeAgo(thread.updatedAt)}
                  </span>
                </button>
                <button
                  className="sidebarThreadDelete"
                  type="button"
                  aria-label={`Delete ${thread.title}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (window.confirm(`Delete thread "${thread.title}"?`)) onDeleteThread(thread.id);
                  }}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            );
          })
        )}
      </div>

      <div className="sidebarFoot">
        <button className="sidebarSettings" type="button" onClick={onOpenSettings}>
          <Wrench size={15} />
          <span>Settings</span>
        </button>
        <button className="sidebarUser" type="button">
          <div className="avatar">S</div>
          <div className="userMeta">
            <strong>Sanket</strong>
            <span>Council · {threads.length} {threads.length === 1 ? "thread" : "threads"}</span>
          </div>
          <ChevronDown size={14} />
        </button>
      </div>
    </aside>
  );
}

function PastTurnsFeed({
  turns, models, onOpenModel,
}: {
  turns: StoredTurn[];
  models: RunModel[];
  onOpenModel: (id: string) => void;
}) {
  return (
    <div className="pastTurns">
      {turns.map((turn, index) => (
        <article className="pastTurn" key={turn.id}>
          <header className="pastTurnHeader">
            <span className="pastTurnLabel">Turn {index + 1}</span>
            <h2>{compactQuestion(turn.question)}</h2>
          </header>
          {turn.synthesis ? (
            <details className="pastTurnAnswer">
              <summary>
                <Sparkles size={13} /> Synthesized answer
                <span className="pastTurnHint">click to expand</span>
              </summary>
              <MarkdownLite content={turn.synthesis} />
            </details>
          ) : (
            <p className="pastTurnEmpty">
              {turn.status === "stopped" ? "Generation stopped." : "No synthesis was produced for this turn."}
            </p>
          )}
          {turn.models.length ? (
            <div className="pastTurnModels">
              {turn.models.map((m) => {
                const live = models.find((x) => x.id === m.id);
                return (
                  <button
                    key={m.id}
                    type="button"
                    className="pastTurnModel"
                    onClick={() => {
                      // Hydrate this model's stored response into live state for the modal preview.
                      if (live) {
                        // Snapshot the stored content into live model list for the modal to read.
                        live.response = m.response;
                        live.critique = m.critique;
                        live.revisedAnswer = m.revisedAnswer;
                      }
                      onOpenModel(m.id);
                    }}
                  >
                    <ModelBadge
                      model={{ ...(live ?? INITIAL_MODELS.find((x) => x.id === m.id)!), ...m }}
                      small
                    />
                    {m.label}
                  </button>
                );
              })}
            </div>
          ) : null}
        </article>
      ))}
    </div>
  );
}

function FollowUpComposer({
  selectedCount, onSubmit,
}: {
  selectedCount: number;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState("");
  function submit() {
    const trimmed = value.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    setValue("");
  }
  return (
    <div className="followUpComposer">
      <div className="followUpHead">
        <MessageSquare size={14} /> Ask a follow-up
        <span className="followUpHint">Stays in this thread · prior context is sent to the council</span>
      </div>
      <div className="followUpField">
        <textarea
          value={value}
          rows={1}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
          }}
          placeholder="Build on the council's answer…"
        />
        <div className="followUpActions">
          <span className="followUpModels">{selectedCount} models</span>
          <button
            className="submitButton"
            type="button"
            onClick={submit}
            disabled={!value.trim()}
            aria-label="Send follow-up"
          >
            <ArrowUp size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}

function timeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

/* =========================================================
   Composer
   ========================================================= */

function CouncilComposer({
  query, setQuery, councilEnabled, setCouncilEnabled, enterSearchMode, enterCouncilMode,
  webGrounding, toggleWebGrounding,
  menuOpen, setMenuOpen,
  selectorOpen, setSelectorOpen,
  selectedCount, selectedFusionPanelId, applyFusionPanel, models, toggleModel, cycleReasoningEffort,
  selectTopThree, attachments, agentSkills,
  imageGenerationEnabled, onOpenSettings,
  onFilesSelected, onRemoveAttachment, runCouncil,
}: {
  query: string;
  setQuery: (value: string) => void;
  councilEnabled: boolean;
  setCouncilEnabled: (value: boolean) => void;
  enterSearchMode: () => void;
  enterCouncilMode: () => void;
  webGrounding: boolean;
  toggleWebGrounding: () => void;
  menuOpen: boolean;
  setMenuOpen: (value: boolean) => void;
  selectorOpen: boolean;
  setSelectorOpen: (value: boolean) => void;
  selectedCount: number;
  selectedFusionPanelId: string;
  applyFusionPanel: (id: string) => void;
  models: RunModel[];
  toggleModel: (id: string) => void;
  cycleReasoningEffort: (id: string) => void;
  selectTopThree: () => void;
  attachments: UploadedAttachment[];
  agentSkills: AgentSkill[];
  imageGenerationEnabled: boolean;
  onOpenSettings: () => void;
  onFilesSelected: (files: FileList) => void | Promise<void>;
  onRemoveAttachment: (id: string) => void;
  runCouncil: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  return (
    <div className="composerWrap">
      <div className="composer">
        <div className="composerTop">
          <div className="promptField">
            {councilEnabled ? (
              <span className="councilPill">
                <Layers3 size={12} />
                Model council · {selectedCount} models
              </span>
            ) : null}
            <textarea
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Ask anything..."
              rows={1}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  runCouncil();
                }
              }}
            />
            {attachments.length ? (
              <div className="attachmentTray">
                {attachments.map((attachment) => (
                  <span className="attachmentChip" key={attachment.id}>
                    {attachment.kind === "image" ? <Upload size={12} /> : <FileText size={12} />}
                    <span>{attachment.name}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${attachment.name}`}
                      onClick={() => onRemoveAttachment(attachment.id)}
                    >
                      <X size={11} />
                    </button>
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        </div>

        <div className="composerFooter">
          <div className="composerLeft">
            <div className="plusWrap">
              <button
                className="iconBtn"
                type="button"
                onClick={() => setMenuOpen(!menuOpen)}
                aria-label="Open sources and tools"
              >
                <CirclePlus size={20} />
              </button>
              {menuOpen ? (
                <div className="plusMenu">
                  {MENU_OPTIONS.map((item) => {
                    const Icon = item.icon;
                    return (
                      <button
                        key={item.label}
                        className={item.active && councilEnabled ? "plusOption active" : "plusOption"}
                        type="button"
                        onClick={() => {
                          if (item.upload) { fileInputRef.current?.click(); setMenuOpen(false); }
                          else if (item.active) { enterCouncilMode(); setMenuOpen(false); setSelectorOpen(true); }
                        }}
                      >
                        <Icon size={16} />
                        <span>
                          {item.label}
                          {item.note ? <small>{item.note}</small> : null}
                        </span>
                        {item.badge ? <em>{item.badge}</em> : null}
                      </button>
                    );
                  })}
                </div>
              ) : null}
              <input
                ref={fileInputRef}
                className="hiddenFileInput"
                type="file"
                multiple
                accept="image/*,.txt,.md,.csv,.json,.ts,.tsx,.js,.jsx,.css,.html,.xml,.yaml,.yml,.pdf"
                onChange={(event) => {
                  if (event.target.files) void onFilesSelected(event.target.files);
                  event.currentTarget.value = "";
                }}
              />
            </div>

            <div className="modeTabs">
              <button
                type="button"
                className={!councilEnabled ? "modeTab active" : "modeTab"}
                onClick={() => enterSearchMode()}
              >
                <Search size={14} /> Search
              </button>
              <button
                type="button"
                className={councilEnabled ? "modeTab active" : "modeTab"}
                onClick={() => enterCouncilMode()}
              >
                <Layers3 size={14} /> Council
              </button>
            </div>

            <button
              type="button"
              className={webGrounding ? "modeTab active" : "modeTab"}
              onClick={toggleWebGrounding}
              title={webGrounding ? "Web grounding on — models will use live search" : "Enable web grounding"}
              aria-pressed={webGrounding}
            >
              <Globe size={14} /> Web
            </button>

            <div className="settingsWrap">
              <button
                type="button"
                className={agentSkills.some((skill) => skill.enabled) || imageGenerationEnabled ? "modeTab active" : "modeTab"}
                onClick={onOpenSettings}
                title="Open connector, skill, research, and image settings"
              >
                <Wrench size={14} /> Settings
              </button>
            </div>
          </div>

          <div className="composerRight">
            <div className="modelSelectorWrap">
              <button
                className="modelCountButton"
                type="button"
                onClick={() => setSelectorOpen(!selectorOpen)}
              >
                {councilEnabled ? `${selectedCount} models` : "1 model"} <ChevronDown size={14} />
              </button>
              {selectorOpen ? (
                <ModelSelector
                  models={models}
                  selectedCount={selectedCount}
                  selectedFusionPanelId={selectedFusionPanelId}
                  applyFusionPanel={applyFusionPanel}
                  toggleModel={toggleModel}
                  cycleReasoningEffort={cycleReasoningEffort}
                  selectTopThree={selectTopThree}
                  councilEnabled={councilEnabled}
                />
              ) : null}
            </div>
            <button className="iconBtn" type="button" aria-label="Voice input">
              <Mic size={18} />
            </button>
            <button
              className="submitButton"
              type="button"
              onClick={runCouncil}
              disabled={!query.trim() && false}
              aria-label="Send question"
            >
              <ArrowUp size={18} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* =========================================================
   Model Selector
   ========================================================= */

function ModelSelector({
  models, selectedCount, selectedFusionPanelId, applyFusionPanel, toggleModel, cycleReasoningEffort, selectTopThree, councilEnabled,
}: {
  models: RunModel[];
  selectedCount: number;
  selectedFusionPanelId: string;
  applyFusionPanel: (id: string) => void;
  toggleModel: (id: string) => void;
  cycleReasoningEffort: (id: string) => void;
  selectTopThree: () => void;
  councilEnabled: boolean;
}) {
  return (
    <aside className="modelSelector">
      <div className="selectorHeader">
        <div>
          <h2>{councilEnabled ? "Council members" : "Search model"}</h2>
          <p>
            {councilEnabled
              ? `${selectedCount} of ${models.length} selected · minimum 2`
              : `Pick one model to answer · ${models.length} available`}
          </p>
        </div>
        {councilEnabled ? (
          <button className="quickSelect" type="button" onClick={selectTopThree}>
            Reset to 3
          </button>
        ) : null}
      </div>
      {councilEnabled ? (
        <div className="fusionPanelList" aria-label="Fusion panel presets">
          {FUSION_PANELS.map((panel) => (
            <button
              key={panel.id}
              type="button"
              className={selectedFusionPanelId === panel.id ? "fusionPanel active" : "fusionPanel"}
              onClick={() => applyFusionPanel(panel.id)}
            >
              <span>
                <strong>{panel.shortName}</strong>
                {panel.featured ? <em>Fusion</em> : null}
              </span>
              <small>{panel.scoreLabel} · {panel.costLabel}</small>
            </button>
          ))}
        </div>
      ) : null}
      <div className="modelRows">
        {models.map((model) => (
          <div className="modelRow" key={model.id}>
            <ModelBadge model={model} />
            <div className="modelMeta">
              <strong>{model.label}</strong>
              <span>{model.maker}</span>
            </div>
            <button
              type="button"
              className={`effortCycler effort-${model.reasoningEffort}`}
              onClick={() => cycleReasoningEffort(model.id)}
              title="Click to cycle reasoning effort: low → medium → high"
              aria-label={`Reasoning effort: ${model.reasoningEffort}. Click to change.`}
            >
              <span className="effortLabel">Effort</span>
              <span className="effortValue">{model.reasoningEffort}</span>
            </button>
            <button
              className={model.selected ? "switch on" : "switch"}
              type="button"
              onClick={() => toggleModel(model.id)}
              aria-label={`Toggle ${model.label}`}
            >
              <span />
            </button>
          </div>
        ))}
      </div>
      <p className="selectorHint">
        {councilEnabled
          ? "Each model answers independently before synthesis."
          : "Search runs against the selected model only."}
      </p>
    </aside>
  );
}

function SettingsDrawer({
  tab,
  setTab,
  connectors,
  setConnectors,
  skills,
  setSkills,
  webGrounding,
  setWebGrounding,
  imageGenerationEnabled,
  setImageGenerationEnabled,
  selectedImageModel,
  setSelectedImageModel,
  onClose,
}: {
  tab: SettingsTab;
  setTab: (tab: SettingsTab) => void;
  connectors: ConnectorSettings;
  setConnectors: React.Dispatch<React.SetStateAction<ConnectorSettings>>;
  skills: AgentSkill[];
  setSkills: React.Dispatch<React.SetStateAction<AgentSkill[]>>;
  webGrounding: boolean;
  setWebGrounding: (value: boolean) => void;
  imageGenerationEnabled: boolean;
  setImageGenerationEnabled: (value: boolean) => void;
  selectedImageModel: string;
  setSelectedImageModel: (value: string) => void;
  onClose: () => void;
}) {
  const [draftName, setDraftName] = useState("");
  const [draftDescription, setDraftDescription] = useState("");
  const [draftBody, setDraftBody] = useState("");
  const [importText, setImportText] = useState("");

  function addSkill() {
    const body = draftBody.trim();
    const name = draftName.trim();
    if (!name || !body) return;
    setSkills((current) => [
      ...current,
      {
        id: newId("skill"),
        name,
        description: draftDescription.trim(),
        body,
        enabled: true,
        createdAt: Date.now(),
      },
    ]);
    setDraftName("");
    setDraftDescription("");
    setDraftBody("");
  }

  function importSkill() {
    const parsed = importSkillFromText(importText);
    if (!parsed.body.trim()) return;
    setSkills((current) => [
      ...current,
      {
        id: newId("skill"),
        name: parsed.name,
        description: parsed.description,
        body: parsed.body,
        enabled: true,
        createdAt: Date.now(),
      },
    ]);
    setImportText("");
  }

  return (
    <div className="settingsBackdrop" role="presentation" onClick={onClose}>
      <aside className="settingsDrawer" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <header className="settingsDrawerHeader">
          <div>
            <span>Workspace</span>
            <h2>Settings</h2>
          </div>
          <button className="closeButton" type="button" onClick={onClose} aria-label="Close settings">
            <X size={18} />
          </button>
        </header>

      <div className="settingsTabs" role="tablist">
        <button className={tab === "connectors" ? "active" : ""} type="button" onClick={() => setTab("connectors")}>
          <Globe size={13} /> Connectors
        </button>
        <button className={tab === "skills" ? "active" : ""} type="button" onClick={() => setTab("skills")}>
          <Wrench size={13} /> Skills
        </button>
        <button className={tab === "research" ? "active" : ""} type="button" onClick={() => setTab("research")}>
          <Search size={13} /> Research
        </button>
        <button className={tab === "images" ? "active" : ""} type="button" onClick={() => setTab("images")}>
          <ImageIcon size={13} /> Images
        </button>
      </div>

      {tab === "connectors" ? (
        <div className="settingsPane">
          <div className="settingsHeader">
            <strong>Connectors</strong>
            <span>{connectors.github ? "1 enabled" : "0 enabled"}</span>
          </div>
          <div className="connectorList">
            <article className="connectorRow">
              <div className="connectorIcon"><Globe size={16} /></div>
              <div>
                <strong>GitHub</strong>
                <span>Search repositories, inspect files, and list issues or pull requests during agent runs.</span>
              </div>
              <button
                className={connectors.github ? "switch on" : "switch"}
                type="button"
                onClick={() => setConnectors((current) => ({ ...current, github: !current.github }))}
                aria-label="Toggle GitHub connector"
              >
                <span />
              </button>
            </article>
          </div>
          <div className="settingsNote">
            GitHub works against public repos without setup. Add `GITHUB_TOKEN` on the server for private repos and higher API limits.
          </div>
          <div className="settingsNote">
            ChatGPT and Claude both put connectors in Settings, require per-user third-party authentication, and let chats selectively use connected sources. This app mirrors that with workspace-level connector toggles and per-run tool use.
          </div>
        </div>
      ) : tab === "skills" ? (
        <div className="settingsPane">
          <div className="settingsHeader">
            <strong>Agent skills</strong>
            <span>{skills.filter((skill) => skill.enabled).length} active</span>
          </div>
          <div className="skillList">
            {skills.map((skill) => (
              <div className="skillRow" key={skill.id}>
                <button
                  className={skill.enabled ? "switch on" : "switch"}
                  type="button"
                  onClick={() =>
                    setSkills((current) =>
                      current.map((item) => item.id === skill.id ? { ...item, enabled: !item.enabled } : item),
                    )
                  }
                  aria-label={`Toggle ${skill.name}`}
                >
                  <span />
                </button>
                <div>
                  <strong>{skill.name}</strong>
                  <span>{skill.description || "Imported run instruction"}</span>
                </div>
                <button
                  className="deleteSkill"
                  type="button"
                  onClick={() => setSkills((current) => current.filter((item) => item.id !== skill.id))}
                  aria-label={`Delete ${skill.name}`}
                >
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>

          <div className="skillEditor">
            <input value={draftName} onChange={(event) => setDraftName(event.target.value)} placeholder="New skill name" />
            <input value={draftDescription} onChange={(event) => setDraftDescription(event.target.value)} placeholder="When should this skill apply?" />
            <textarea value={draftBody} onChange={(event) => setDraftBody(event.target.value)} placeholder="Write the skill instructions..." rows={4} />
            <button type="button" onClick={addSkill} disabled={!draftName.trim() || !draftBody.trim()}>
              Create skill
            </button>
          </div>

          <div className="skillEditor">
            <textarea value={importText} onChange={(event) => setImportText(event.target.value)} placeholder="Paste a SKILL.md or JSON skill to import..." rows={4} />
            <button type="button" onClick={importSkill} disabled={!importText.trim()}>
              Import skill
            </button>
          </div>
        </div>
      ) : tab === "research" ? (
        <div className="settingsPane">
          <div className="settingsHeader">
            <strong>Research behavior</strong>
            <span>{webGrounding ? "web on" : "web off"}</span>
          </div>
          <label className="imageToggle">
            <input
              type="checkbox"
              checked={webGrounding}
              onChange={(event) => setWebGrounding(event.target.checked)}
            />
            Use OpenRouter web grounding in chat
          </label>
          <div className="researchPatternList">
            <article>
              <strong>ChatGPT-style apps/connectors</strong>
              <span>Connectors can be used in chat for file search, in deep research for multi-source cited reports, and in some cases via synced/indexed data. Users can enable them from Settings and select sources from the composer.</span>
            </article>
            <article>
              <strong>Claude-style integrations</strong>
              <span>Claude exposes integrations under Settings &gt; Connectors, with workspace/admin enablement for teams and per-user authentication. Web search is also a connector-style setting users can toggle.</span>
            </article>
            <article>
              <strong>Model Council behavior</strong>
              <span>When Web is on, drafting models receive OpenRouter web results. When connectors are enabled, the agent loop may call connector tools during draft, debate, or synthesis.</span>
            </article>
          </div>
        </div>
      ) : (
        <div className="settingsPane">
          <label className="imageToggle">
            <input
              type="checkbox"
              checked={imageGenerationEnabled}
              onChange={(event) => setImageGenerationEnabled(event.target.checked)}
            />
            Generate image after the answer
          </label>
          <div className="imageModelList">
            {IMAGE_MODELS.map((model) => (
              <button
                key={model.id}
                type="button"
                className={selectedImageModel === model.id ? "imageModelRow active" : "imageModelRow"}
                onClick={() => setSelectedImageModel(model.id)}
              >
                <strong>{model.label}</strong>
                <span>{model.maker} · {model.id}</span>
                <p>{model.description}</p>
              </button>
            ))}
          </div>
        </div>
      )}
      </aside>
    </div>
  );
}

/* =========================================================
   Thinking Stage
   ========================================================= */

function ThinkingStage({
  models, synthesisActivity, streamError, runPhase, onOpenModelResponse, onStop,
}: {
  models: RunModel[];
  synthesisActivity: string;
  streamError: string;
  runPhase: RunPhase;
  onOpenModelResponse: (id: string) => void;
  onStop?: () => void;
}) {
  const isStreaming = runPhase !== "done";
  const timelineMessage = streamError
    || (isStreaming ? synthesisActivity || currentHeadline(models) : "Final synthesis complete.");
  const synthesisBarMessage =
    runPhase === "done"
      ? "Final synthesis complete."
      : runPhase === "synthesizing" || synthesisActivity
        ? "Synthesizing drafts and debate critiques…"
        : runPhase === "debating"
          ? "Models are debating each other…"
          : "Awaiting independent drafts…";

  return (
    <div className="thinkingPanel">
      <div className="timelineHead">
        <h2 className="timelineTitle">Council in session</h2>
        {isStreaming && onStop ? (
          <button type="button" className="stopButton" onClick={onStop}>
            <Square size={13} fill="currentColor" /> Stop
          </button>
        ) : null}
      </div>

      <PhaseTracker runPhase={runPhase} />

      <div className="timelineStatus">
        <p>{timelineMessage}</p>
      </div>

      <div className="thinkingStack">
        {models.map((model) => {
          const phaseStatus =
            runPhase === "debating" || runPhase === "synthesizing" || runPhase === "done"
              ? model.debateStatus
              : model.status;
          const phaseLabel =
            runPhase === "drafting"
              ? "Drafting"
              : runPhase === "debating"
                ? "Debating"
                : runPhase === "synthesizing"
                  ? "Synthesizing"
                  : "Done";

          return (
            <article className={`thinkingCard ${phaseStatus}`} key={model.id}>
              <div className="thinkingBody">
                <div className="thinkingCardHeader">
                  <div className="modelPill">
                    <ModelBadge model={model} small />
                    <strong>{model.label}</strong>
                  </div>
                  <span className="phaseLabel">{phaseLabel}</span>
                  {model.steps ? <span className="inlineSteps">{model.steps} steps</span> : null}
                </div>
                <p className="currentActivity">
                  {model.error
                    ? `Error: ${model.error}`
                    : phaseStatus === "complete"
                      ? runPhase === "drafting"
                        ? "Completed independent draft"
                        : "Debate complete — critique submitted"
                      : latestActivity(model)}
                </p>
              </div>
              <div className="thinkingCardAction">
                {model.status === "complete" ? (
                  <button type="button" onClick={() => onOpenModelResponse(model.id)}>
                    View draft <ArrowRight size={14} />
                  </button>
                ) : phaseStatus === "thinking" ? (
                  <span className="writingPill"><i /> {runPhase === "debating" ? "Debating…" : "Writing…"}</span>
                ) : null}
              </div>
            </article>
          );
        })}
      </div>

      <div className="synthesisBar">
        <span>{synthesisBarMessage}</span>
        {isStreaming ? <div className="dotWave"><i /><i /><i /></div> : null}
      </div>
    </div>
  );
}

function PhaseTracker({ runPhase }: { runPhase: RunPhase }) {
  const phases: Array<{ id: Exclude<RunPhase, "done">; label: string; icon: LucideIcon }> = [
    { id: "drafting", label: "Independent drafts", icon: Sparkles },
    { id: "debating", label: "Council debate", icon: Gavel },
    { id: "synthesizing", label: "Final synthesis", icon: Layers3 },
  ];
  const order: RunPhase[] = ["drafting", "debating", "synthesizing", "done"];
  const activeIndex = order.indexOf(runPhase);

  return (
    <ol className="phaseTracker" aria-label="Council phases">
      {phases.map((p, index) => {
        const Icon = p.icon;
        const state = index < activeIndex ? "complete" : index === activeIndex ? "active" : "queued";
        return (
          <li key={p.id} className={`phaseStep ${state}`}>
            <span className="phaseDot"><Icon size={14} /></span>
            <span className="phaseStepLabel">{p.label}</span>
          </li>
        );
      })}
    </ol>
  );
}

function DebateView({ models }: { models: RunModel[] }) {
  const debaters = models.filter((m) => m.critique || m.revisedAnswer);
  if (!debaters.length) {
    return (
      <div className="resultSection">
        <h3>Council debate</h3>
        <p style={{ color: "var(--muted)", margin: 0 }}>
          The debate round has not produced critiques yet. It runs after each model finishes its
          independent draft.
        </p>
      </div>
    );
  }
  return (
    <div className="resultSection">
      <h3>Council debate</h3>
      <p style={{ color: "var(--muted)", margin: "-4px 0 6px", fontSize: 13.5 }}>
        After their independent drafts, each model saw the other answers and pushed back, defended,
        or updated its position.
      </p>
      <div className="debateStack">
        {debaters.map((model) => (
          <article className="debateCard" key={model.id}>
            <header>
              <div className="modelPill">
                <ModelBadge model={model} small />
                <strong>{model.label}</strong>
              </div>
              <span className="debateBadge">
                <MessageSquareQuote size={13} /> Debate response
              </span>
            </header>

            {model.critique ? (
              <section>
                <h4>Critique of the council</h4>
                <MarkdownLite content={model.critique} />
              </section>
            ) : null}

            {model.revisedAnswer ? (
              <section>
                <h4>Revised answer</h4>
                <MarkdownLite content={model.revisedAnswer} />
              </section>
            ) : null}
          </article>
        ))}
      </div>
    </div>
  );
}

/* =========================================================
   Sources view
   ========================================================= */

function SourcesView({ models }: { models: RunModel[] }) {
  return (
    <div className="resultSection">
      <h3>Cited sources</h3>
      <div className="sourcesRow">
        {DEMO_SOURCES.map((source, index) => (
          <button className="sourceCard" type="button" key={source.title}>
            <div className="sourceHead">
              <span className="num">{index + 1}</span>
              <span>{source.domain}</span>
            </div>
            <p>{source.title}</p>
          </button>
        ))}
      </div>

      <h3 style={{ marginTop: 20 }}>By model</h3>
      <div className="modelResponseButtons">
        {models.map((model) => (
          <button key={model.id} type="button">
            <ModelBadge model={model} />
            <span>{model.label}</span>
            <em>{model.steps || 0} steps</em>
            <p>Independent context drawn for this question.</p>
          </button>
        ))}
      </div>
    </div>
  );
}

/* =========================================================
   Results Dashboard
   ========================================================= */

function ResultsDashboard({
  models, query, synthesis, fusionJudge, fusionPanelId, followUps, generatedImages, imageStatus, onOpenModal, onRunFollowup,
}: {
  models: RunModel[];
  query: string;
  synthesis: string;
  fusionJudge: FusionJudgeReport | null;
  fusionPanelId: string | null;
  followUps: string[];
  generatedImages: StoredGeneratedImage[];
  imageStatus: string;
  onOpenModal: (id: string) => void;
  onRunFollowup: (query: string) => void;
}) {
  const useDemoTables = query.trim() === DEFAULT_QUERY;
  const activePanel = FUSION_PANELS.find((panel) => panel.id === fusionPanelId);

  return (
    <div className="resultsDashboard">
      <section className="summaryBlock">
        <div className="summaryHead">
          <h3><Sparkles size={16} /> Synthesized answer</h3>
          <div className="summaryActions">
            <button className="iconBtn" type="button" aria-label="Copy"><Copy size={16} /></button>
            <button className="iconBtn" type="button" aria-label="Share"><Share2 size={16} /></button>
            <button className="iconBtn" type="button" aria-label="Save"><Bookmark size={16} /></button>
          </div>
        </div>

        {synthesis ? (
          <MarkdownLite content={synthesis} />
        ) : (
          <p style={{ color: "var(--muted)", margin: 0 }}>
            The council’s strongest consensus appears here once the synthesizer compares all model responses.
          </p>
        )}

        <div className="summaryFoot">
          <span>Prepared using {models.map((model) => model.label).join(", ")}</span>
          <b>{activePanel ? `${activePanel.shortName} fusion` : useDemoTables ? `${DEMO_SOURCES.length} sources` : "Custom panel"}</b>
        </div>
      </section>

      {generatedImages.length || imageStatus ? (
        <section className="resultSection">
          <h3>Generated image</h3>
          {generatedImages.length ? (
            <div className="generatedImageGrid">
              {generatedImages.map((image) => (
                <figure className="generatedImageCard" key={image.id}>
                  <img src={image.url} alt="Generated image" />
                  <figcaption>
                    <strong>{image.model}</strong>
                    <span>{compactQuestion(image.prompt)}</span>
                  </figcaption>
                </figure>
              ))}
            </div>
          ) : (
            <p className="imageStatus">{imageStatus}</p>
          )}
        </section>
      ) : null}

      {fusionJudge ? (
        <FusionReportSections report={fusionJudge} models={models} />
      ) : useDemoTables ? (
        <>
          <section className="resultSection">
            <h3>Where models agree</h3>
            <div className="tableShell">
              <table>
                <thead>
                  <tr>
                    <th>Finding</th>
                    {models.map((model) => (
                      <th className="modelColumn" key={model.id}>
                        <ModelBadge model={model} small />
                      </th>
                    ))}
                    <th>Evidence</th>
                  </tr>
                </thead>
                <tbody>
                  {agreeRows.map((row) => (
                    <tr key={row.finding}>
                      <td>{row.finding}</td>
                      {models.map((model) => (
                        <td className="checkCell" key={model.id}>
                          {row.models.includes(model.id) ? <Check size={16} /> : <span className="dash">—</span>}
                        </td>
                      ))}
                      <td>
                        <span>{row.evidence}</span>
                        <button className="sourcePill" type="button">{row.source}</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="resultSection">
            <h3>Where models disagree</h3>
            <div className="tableShell">
              <table>
                <thead>
                  <tr>
                    <th>Topic</th>
                    {models.map((model) => (
                      <th key={model.id} className="modelColumn">
                        <ModelBadge model={model} small />
                      </th>
                    ))}
                    <th>Why they differ</th>
                  </tr>
                </thead>
                <tbody>
                  {disagreeRows.map((row) => (
                    <tr key={row.topic}>
                      <td><strong>{row.topic}</strong></td>
                      {models.map((model) => (
                        <td key={model.id}>{row.cells[model.id as keyof typeof row.cells] ?? "—"}</td>
                      ))}
                      <td>{row.why}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="resultSection">
            <h3>Unique discoveries</h3>
            <div className="uniqueGrid">
              {models.map((model) => {
                const row = uniqueRows.find((item) => item.id === model.id) ?? uniqueRows[0];
                return (
                  <article className="uniqueCard" key={model.id}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <ModelBadge model={model} small />
                      <span style={{ fontSize: 12, fontWeight: 650, color: "var(--ink)" }}>{model.label}</span>
                    </div>
                    <strong>{row.finding}</strong>
                    <p>{row.matters}</p>
                  </article>
                );
              })}
            </div>
          </section>
        </>
      ) : null}

      <section className="resultSection">
        <h3>Individual responses</h3>
        <div className="modelResponseButtons">
          {models.map((model) => (
            <button key={model.id} type="button" onClick={() => onOpenModal(model.id)}>
              <ModelBadge model={model} />
              <span>{model.label}</span>
              <em>Open →</em>
              <p>{model.response ? compactQuestion(model.response) : model.error ?? "Open the full individual response."}</p>
            </button>
          ))}
        </div>
      </section>

      <section className="followUps">
        <h3><ArrowRight size={14} /> Related questions</h3>
        {followUps.length ? (
          followUps.map((q) => (
            <button key={q} type="button" onClick={() => onRunFollowup(q)}>
              <span>{q}</span>
              <Plus size={16} />
            </button>
          ))
        ) : (
          <p className="followUpsEmpty">DeepSeek could not generate related questions for this answer.</p>
        )}
      </section>
    </div>
  );
}

function FusionReportSections({ report, models }: { report: FusionJudgeReport; models: RunModel[] }) {
  return (
    <>
      <section className="fusionVerdict">
        <div>
          <span>Fusion judge</span>
          <h3>Panel verdict</h3>
        </div>
        <p>{report.panelVerdict}</p>
      </section>

      {report.consensus.length ? (
        <section className="resultSection">
          <h3>Where models agree</h3>
          <div className="tableShell">
            <table>
              <thead>
                <tr>
                  <th>Finding</th>
                  {models.map((model) => (
                    <th className="modelColumn" key={model.id}>
                      <ModelBadge model={model} small />
                    </th>
                  ))}
                  <th>Evidence</th>
                </tr>
              </thead>
              <tbody>
                {report.consensus.map((row) => (
                  <tr key={row.finding}>
                    <td>{row.finding}</td>
                    {models.map((model) => (
                      <td className="checkCell" key={model.id}>
                        {reportNamesModel(row.models, model) ? <Check size={16} /> : <span className="dash">-</span>}
                      </td>
                    ))}
                    <td>{row.evidence}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {report.contradictions.length ? (
        <section className="resultSection">
          <h3>Where models disagree</h3>
          <div className="tableShell">
            <table>
              <thead>
                <tr>
                  <th>Topic</th>
                  {models.map((model) => (
                    <th key={model.id} className="modelColumn">
                      <ModelBadge model={model} small />
                    </th>
                  ))}
                  <th>Judge read</th>
                </tr>
              </thead>
              <tbody>
                {report.contradictions.map((row) => (
                  <tr key={row.topic}>
                    <td><strong>{row.topic}</strong></td>
                    {models.map((model) => (
                      <td key={model.id}>{positionForModel(row.positions, model) || "-"}</td>
                    ))}
                    <td>{row.judgment}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {report.uniqueInsights.length ? (
        <section className="resultSection">
          <h3>Unique discoveries</h3>
          <div className="uniqueGrid">
            {report.uniqueInsights.map((row) => {
              const model = models.find((item) => reportNamesModel([row.model], item)) ?? models[0];
              return (
                <article className="uniqueCard" key={`${row.model}-${row.insight}`}>
                  {model ? (
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <ModelBadge model={model} small />
                      <span style={{ fontSize: 12, fontWeight: 650, color: "var(--ink)" }}>{model.label}</span>
                    </div>
                  ) : null}
                  <strong>{row.insight}</strong>
                  <p>{row.whyItMatters}</p>
                </article>
              );
            })}
          </div>
        </section>
      ) : null}

      {report.coverageGaps.length ? (
        <section className="resultSection">
          <h3>Coverage gaps</h3>
          <div className="coverageGapList">
            {report.coverageGaps.map((gap) => (
              <span key={gap}>{gap}</span>
            ))}
          </div>
        </section>
      ) : null}
    </>
  );
}

function reportNamesModel(names: string[], model: RunModel) {
  const normalized = names.map(normalizeName).filter(Boolean);
  return normalized.some((name) =>
    name === normalizeName(model.label)
    || name === normalizeName(model.id)
    || name === normalizeName(model.maker)
    || name.includes(normalizeName(model.badge))
    || normalizeName(model.label).includes(name),
  );
}

function positionForModel(positions: Record<string, string>, model: RunModel) {
  const match = Object.entries(positions).find(([name]) => reportNamesModel([name], model));
  return match?.[1];
}

function normalizeName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9.]+/g, " ").trim();
}

/* =========================================================
   Modal
   ========================================================= */

function ModelResponseModal({ model, onClose }: { model: RunModel; onClose: () => void }) {
  return (
    <div className="modalBackdrop" role="presentation" onClick={onClose}>
      <article className="responseModal" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <header>
          <div>
            <ModelBadge model={model} />
            <div>
              <h2>{model.label}</h2>
              <p>{model.maker} · independent council response</p>
            </div>
          </div>
          <div className="modalActions">
            <button className="closeButton" type="button" onClick={onClose} aria-label="Close">
              <X size={18} />
            </button>
          </div>
        </header>
        <div className="modalContent">
          {model.response ? (
            <MarkdownLite content={model.response} />
          ) : (
            <>
              <h3>Main factors driving U.S. inflation in 2025</h3>
              {(modelResponses[model.id] ?? modelResponses["openai/gpt-5.4"]).map((paragraph) => (
                <p key={paragraph}>{paragraph}</p>
              ))}
              <ul>
                <li>Shelter and services kept the baseline sticky.</li>
                <li>Tariffs and inventory behavior added goods pressure.</li>
                <li>Consumer sentiment lagged headline disinflation because price levels remained high.</li>
              </ul>
            </>
          )}
        </div>
      </article>
    </div>
  );
}

/* =========================================================
   Bits
   ========================================================= */

function ModelBadge({ model, small = false }: { model: RunModel; small?: boolean }) {
  return (
    <span
      className={`${small ? "modelBadge small" : "modelBadge"}${model.logoUrl ? "" : " noLogo"}`}
      style={{ "--badge-color": model.accent } as React.CSSProperties}
      aria-label={`${model.maker} logo`}
    >
      {model.logoUrl ? <img src={model.logoUrl} alt="" aria-hidden="true" /> : model.badge}
    </span>
  );
}

function MarkdownLite({ content }: { content: string }) {
  return (
    <div className="markdownLite">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}

function appendUnique(items: string[], next: string) {
  if (items.includes(next)) return items;
  return [...items, next].slice(-6);
}

function latestActivity(model: RunModel) {
  return model.activityLog.at(-1) ?? "I will analyze the prompt and prepare an independent response.";
}

function currentHeadline(models: RunModel[]) {
  const active = models.find((model) => model.status === "thinking") ?? models[0];
  if (!active) return "Preparing council…";
  return latestActivity(active);
}

function loadAgentSkills(): AgentSkill[] {
  if (typeof window === "undefined") return DEFAULT_SKILLS;
  try {
    const raw = window.localStorage.getItem(SKILLS_STORAGE_KEY);
    if (!raw) return DEFAULT_SKILLS;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_SKILLS;
    const custom = parsed.filter((skill): skill is AgentSkill =>
      typeof skill?.id === "string" && typeof skill.name === "string" && typeof skill.body === "string",
    );
    return custom.length ? custom : DEFAULT_SKILLS;
  } catch {
    return DEFAULT_SKILLS;
  }
}

function saveAgentSkills(skills: AgentSkill[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SKILLS_STORAGE_KEY, JSON.stringify(skills.slice(0, 50)));
  } catch {
    /* localStorage may be full or disabled */
  }
}

function loadConnectorSettings(): ConnectorSettings {
  if (typeof window === "undefined") return { github: true };
  try {
    const raw = window.localStorage.getItem(CONNECTORS_STORAGE_KEY);
    if (!raw) return { github: true };
    const parsed = JSON.parse(raw) as Partial<ConnectorSettings>;
    return { github: parsed.github !== false };
  } catch {
    return { github: true };
  }
}

function saveConnectorSettings(settings: ConnectorSettings) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CONNECTORS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* localStorage may be full or disabled */
  }
}

function compactQuestion(content: string) {
  const normalized = content.replace(/\s+/g, " ").trim();
  return normalized.length > 220 ? `${normalized.slice(0, 220)}…` : normalized;
}

async function readCouncilStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: CouncilStreamEvent) => void,
  signal?: AbortSignal,
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const onAbort = () => {
    reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", onAbort);

  try {
    while (true) {
      if (signal?.aborted) break;
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() ?? "";

      for (const chunk of chunks) {
        const line = chunk.split("\n").find((item) => item.startsWith("data: "));
        if (!line) continue;
        onEvent(JSON.parse(line.replace(/^data: /, "")) as CouncilStreamEvent);
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

async function readUploads(files: FileList): Promise<UploadedAttachment[]> {
  const selected = Array.from(files).slice(0, 8);
  const attachments = await Promise.all(
    selected.map(async (file) => {
      const base = {
        id: `${file.name}-${file.size}-${file.lastModified}-${crypto.randomUUID()}`,
        name: file.name,
        type: file.type || "application/octet-stream",
        size: file.size,
      };

      if (file.type.startsWith("image/")) {
        return { ...base, kind: "image" as const, dataUrl: await readFileAsDataUrl(file) };
      }
      if (isTextLikeFile(file)) {
        return { ...base, kind: "text" as const, text: await readFileAsText(file) };
      }
      return { ...base, kind: "file" as const };
    }),
  );

  return attachments;
}

function isTextLikeFile(file: File) {
  const textTypes = ["text/", "application/json", "application/xml", "application/yaml"];
  const textExtensions = /\.(txt|md|csv|json|ts|tsx|js|jsx|css|html|xml|yaml|yml)$/i;
  return textTypes.some((type) => file.type.startsWith(type)) || textExtensions.test(file.name);
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

function readFileAsText(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name}`));
    reader.readAsText(file);
  });
}
