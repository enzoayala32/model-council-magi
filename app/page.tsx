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
  Download,
  FileText,
  FolderCog,
  Gavel,
  AlertTriangle,
  Loader2,
  Trophy,
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
import CouncilPanel from "./components/council/CouncilPanel";
import type { CouncilStatus, NodeState } from "./components/council/types";
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
  filesystem: boolean;
};

type TypeCheckResult = { status: "skipped" | "checking" | "ok" | "error"; errors?: string[] };

type FileProposalState = {
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
  debateRound?: number;
  debateMaxRounds?: number;
  viaFallbackFrom?: string;
  error?: string;
};

type DebateRoundInfo = { round: number; maxRounds: number; participantCount: number; convergence: number; converged: boolean };
type VoteCastInfo = { modelId: string; label: string; votedForModelId: string | null; votedForLabel: string | null; rationale: string };
type VoteTallyInfo = { tally: Array<{ modelId: string; label: string; votes: number }>; winnerModelId: string | null; winnerLabel: string | null; totalVotes: number };
type ModelHealthInfo = { attempts: number; failures: number; lastFailureReason?: string; lastOk: boolean };

type UploadedAttachment = {
  id: string;
  name: string;
  type: string;
  size: number;
  kind: "image" | "text" | "pdf" | "docx" | "file";
  dataUrl?: string;
  text?: string;
};

type TokenUsage = { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };

type CouncilStreamEvent =
  | { type: "run_started"; prompt: string; selectedModels: string[]; fusionPanelId?: string }
  | { type: "magi_personas_assigned"; personas: Array<{ modelId: string; key: string; name: string; title: string }> }
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

const DEFAULT_QUERY =
  "What were the main factors driving inflation in the United States in 2025?";

const SUGGESTIONS: Array<{ icon: LucideIcon; label: string; query: string }> = [
  { icon: TrendingUp, label: "Comparar benchmarks de modelos de punta", query: "Comparar los últimos benchmarks de LLMs de punta en razonamiento, código y tareas multimodales." },
  { icon: Globe, label: "Motores de la inflación en EE.UU. en 2025", query: DEFAULT_QUERY },
  { icon: Telescope, label: "Riesgos de la IA agéntica en producción", query: "¿Cuáles son los mayores riesgos de desplegar sistemas de IA agéntica en producción hoy?" },
  { icon: Sparkles, label: "Buenas prácticas de RAG a gran escala", query: "¿Cuáles son las mejores prácticas actuales para construir pipelines de RAG a gran escala?" },
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
  { icon: Upload, label: "Subir archivos o imágenes", upload: true, note: "Imágenes, código, PDFs, documentos" },
  { icon: Layers3, label: "Consenso de modelos", active: true, note: "Comparar respuestas de múltiples modelos" },
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
    models: ["openai/gpt-oss-20b:free", "nvidia/nemotron-3-ultra-550b-a55b:free", "google/gemma-4-26b-a4b-it:free"],
    evidence: "Core services stayed elevated while goods disinflation faded.",
    source: "richmondfed +1",
  },
  {
    finding: "Tariffs and trade uncertainty raised expected goods prices more than they explained the whole inflation picture.",
    models: ["openai/gpt-oss-20b:free", "nvidia/nemotron-3-ultra-550b-a55b:free", "google/gemma-4-26b-a4b-it:free", "nvidia/nemotron-3-super-120b-a12b:free"],
    evidence: "Import-sensitive categories showed renewed pressure in 2025.",
    source: "deloitte +2",
  },
  {
    finding: "The labor market and wage growth kept services demand resilient, limiting how quickly inflation could return to target.",
    models: ["openai/gpt-oss-20b:free", "nvidia/nemotron-3-ultra-550b-a55b:free", "nvidia/nemotron-3-super-120b-a12b:free"],
    evidence: "Services inflation tracked wage-sensitive categories.",
    source: "usafacts +2",
  },
];

const disagreeRows = [
  {
    topic: "How much tariffs mattered",
    cells: {
      "openai/gpt-oss-20b:free": "Important second-half pressure, especially for goods and inflation expectations.",
      "nvidia/nemotron-3-ultra-550b-a55b:free": "Meaningful, but too narrow to explain services and shelter persistence.",
      "google/gemma-4-26b-a4b-it:free": "A relative-price shock that risked spilling into broader expectations.",
      "nvidia/nemotron-3-super-120b-a12b:free": "Politically salient, but overstated as the single cause.",
    },
    why: "The models separate direct tariff pass-through from broader inflation persistence differently.",
  },
  {
    topic: "Shelter’s role",
    cells: {
      "openai/gpt-oss-20b:free": "Lagged rent measures were still a major source of measured CPI pressure.",
      "nvidia/nemotron-3-ultra-550b-a55b:free": "Shelter explained stickiness, but real-time rents pointed toward slower future pressure.",
      "google/gemma-4-26b-a4b-it:free": "Housing supply constraints mattered more than short-run demand.",
      "nvidia/nemotron-3-super-120b-a12b:free": "Shelter was a measurement lag story as much as a fresh inflation story.",
    },
    why: "They weigh official CPI shelter lags against real-time rental data at different levels.",
  },
];

const uniqueRows = [
  {
    id: "openai/gpt-oss-20b:free",
    finding: "Business inventory front-loading likely distorted 2025 goods prices before tariffs fully landed.",
    matters: "It explains why some price pressure appeared before consumers saw the full policy effect.",
  },
  {
    id: "nvidia/nemotron-3-ultra-550b-a55b:free",
    finding: "Inflation expectations were a transmission channel, not just an outcome.",
    matters: "Expectations can make temporary shocks more persistent through pricing and wage negotiations.",
  },
  {
    id: "google/gemma-4-26b-a4b-it:free",
    finding: "The cleanest story is category-specific: goods, shelter, and services each had different drivers.",
    matters: "Policy interpretation changes if inflation is decomposed instead of treated as one blob.",
  },
  {
    id: "nvidia/nemotron-3-super-120b-a12b:free",
    finding: "Public perception lagged headline disinflation because visible prices stayed high.",
    matters: "It clarifies why consumers felt inflation even when year-over-year rates looked better.",
  },
];

const modelResponses: Record<string, string[]> = {
  "openai/gpt-oss-20b:free": [
    "The strongest explanation is a mixed-driver story: residual shelter inflation, services demand, and renewed goods pressure from trade policy.",
    "I would not attribute 2025 inflation to a single shock. Tariffs mattered most where import exposure was obvious, while shelter and wages explained persistence.",
    "Confidence is medium-high because the drivers point in the same direction across CPI components, Fed commentary, and private forecasts.",
  ],
  "nvidia/nemotron-3-ultra-550b-a55b:free": [
    "The main caution is that some 2025 inflation looked like policy pass-through while some was simply the slow unwinding of earlier housing and labor-market dynamics.",
    "Tariffs raise prices, but they do not automatically create durable inflation unless expectations, wages, or margins transmit the shock broadly.",
    "The most useful answer is therefore segmented: goods were tariff-sensitive, shelter was lag-sensitive, and services were wage-sensitive.",
  ],
  "google/gemma-4-26b-a4b-it:free": [
    "The models converge on three categories: shelter, services, and import-sensitive goods. Each category had a different timing pattern.",
    "The strongest evidence is cross-source: official CPI/PCE components, Fed regional analysis, and private-sector commentary about inventory behavior.",
    "For policy, the key distinction is temporary level effects versus persistent inflation momentum.",
  ],
  "nvidia/nemotron-3-super-120b-a12b:free": [
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
  const [connectors, setConnectors] = useState<ConnectorSettings>({ github: true, filesystem: false });
  const [fileAgentModelId, setFileAgentModelId] = useState<string>("");
  const [fileProposals, setFileProposals] = useState<FileProposalState[]>([]);
  const [tokenUsage, setTokenUsage] = useState<TokenUsage>({});
  const [tokenBreakdown, setTokenBreakdown] = useState<Array<{ phase: string; modelId?: string; label?: string; usage: TokenUsage }>>([]);
  const [maxDebateRounds, setMaxDebateRounds] = useState(1);
  const [magiMode, setMagiMode] = useState(false);
  const [magiPersonas, setMagiPersonas] = useState<Record<string, { key: string; name: string; title: string }>>({});
  const [debateRounds, setDebateRounds] = useState<DebateRoundInfo[]>([]);
  const [votes, setVotes] = useState<VoteCastInfo[]>([]);
  const [voteTally, setVoteTally] = useState<VoteTallyInfo | null>(null);
  const [modelHealth, setModelHealth] = useState<Record<string, ModelHealthInfo>>({});
  const [imageGenerationEnabled, setImageGenerationEnabled] = useState(false);
  const [selectedImageModel, setSelectedImageModel] = useState(IMAGE_MODELS[0]?.id ?? "openai/gpt-image-1.5");
  const [resultTab, setResultTab] = useState<ResultTab>("answer");
  const [runPhase, setRunPhase] = useState<RunPhase>("drafting");
  const [elapsedMs, setElapsedMs] = useState(0);

  const [threads, setThreads] = useState<StoredThread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

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
    refreshModelHealth();
  }, []);

  function refreshModelHealth() {
    fetch("/api/council/model-health")
      .then((res) => res.json())
      .then((data: { models: Array<ModelHealthInfo & { modelId: string }> }) => {
        const next: Record<string, ModelHealthInfo> = {};
        for (const entry of data.models ?? []) {
          next[entry.modelId] = { attempts: entry.attempts, failures: entry.failures, lastFailureReason: entry.lastFailureReason, lastOk: entry.lastOk };
        }
        setModelHealth(next);
      })
      .catch(() => {
        // Best-effort — health badges just won't show if this fails, nothing else depends on it.
      });
  }

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
    runStartRef.current = Date.now();
    setElapsedMs(0);
    setFileProposals([]);
    setTokenUsage({});
    setTokenBreakdown([]);
    setDebateRounds([]);
    setMagiPersonas({});
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
          magiMode,
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
    if (event.type === "magi_personas_assigned") {
      const next: Record<string, { key: string; name: string; title: string }> = {};
      for (const p of event.personas) {
        if (p.key) next[p.modelId] = { key: p.key, name: p.name, title: p.title };
      }
      setMagiPersonas(next);
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
                magiPersonas={magiPersonas}
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
                  <DebateView models={activeModels} debateRounds={debateRounds} votes={votes} voteTally={voteTally} magiPersonas={magiPersonas} />
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
                    magiPersonas={magiPersonas}
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
            magiMode={magiMode}
            setMagiMode={setMagiMode}
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
        <span>Consenso IA</span>
      </div>

      <button className="newThread" type="button" onClick={onNewThread}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <Plus size={16} /> Nuevo hilo
        </span>
        <kbd>⌘K</kbd>
      </button>

      <div className="sidebarSection">Hilos</div>
      <div className="sidebarThreads">
        {sorted.length === 0 ? (
          <p className="sidebarEmpty">Todavía no hay hilos. Hacele una pregunta al consenso para empezar.</p>
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
                    {turnCount} {turnCount === 1 ? "turno" : "turnos"} · {timeAgo(thread.updatedAt)}
                  </span>
                </button>
                <button
                  className="sidebarThreadDelete"
                  type="button"
                  aria-label={`Eliminar ${thread.title}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (window.confirm(`¿Eliminar el hilo "${thread.title}"?`)) onDeleteThread(thread.id);
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
          <span>Ajustes</span>
        </button>
        <button className="sidebarUser" type="button">
          <div className="avatar">T</div>
          <div className="userMeta">
            <strong>Tú</strong>
            <span>Consenso IA · {threads.length} {threads.length === 1 ? "hilo" : "hilos"}</span>
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
            <span className="pastTurnLabel">Turno {index + 1}</span>
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
        <MessageSquare size={14} /> Hacer una repregunta
        <span className="followUpHint">Se queda en este hilo · el contexto previo se envía al consenso</span>
      </div>
      <div className="followUpField">
        <textarea
          value={value}
          rows={1}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
          }}
          placeholder="Continuá sobre la respuesta del consenso…"
        />
        <div className="followUpActions">
          <span className="followUpModels">{selectedCount} modelos</span>
          <button
            className="submitButton"
            type="button"
            onClick={submit}
            disabled={!value.trim()}
            aria-label="Enviar repregunta"
          >
            <ArrowUp size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}

/** Maps a model's real run state to the CouncilPanel's NodeState — used to
 * drive both the color/animation (via CSS class) and the label shown. */
function nodeStateFor(model: RunModel, runPhase: RunPhase): NodeState {
  if (model.error) return "error";
  if (runPhase === "drafting") {
    if (model.status === "thinking") return "thinking";
    if (model.status === "complete") return "complete";
    return "waiting";
  }
  if (model.debateStatus === "thinking") return "debating";
  if (model.debateStatus === "complete") return "complete";
  return "waiting";
}

function formatElapsed(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/** Compact token count for the MAGI panel readout — "842", "12.4K", "1.2M". */
function formatTokens(value: number | undefined) {
  const n = value ?? 0;
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Display-only translation — the underlying value ("low"/"medium"/"high")
 * must stay in English since it's sent as-is to the OpenRouter/NVIDIA APIs. */
function effortLabelEs(effort: ReasoningEffort): string {
  return effort === "low" ? "bajo" : effort === "high" ? "alto" : "medio";
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
  onFilesSelected, onRemoveAttachment, runCouncil, modelHealth,
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
  modelHealth: Record<string, ModelHealthInfo>;
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
              placeholder="Preguntá lo que quieras..."
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
                accept="image/*,.txt,.md,.csv,.json,.ts,.tsx,.js,.jsx,.css,.html,.xml,.yaml,.yml,.pdf,.docx"
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
                title="Abrir ajustes de conectores, habilidades, research e imágenes"
              >
                <Wrench size={14} /> Ajustes
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
                {councilEnabled ? `${selectedCount} modelos` : "1 modelo"} <ChevronDown size={14} />
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
                  modelHealth={modelHealth}
                />
              ) : null}
            </div>
            <button className="iconBtn" type="button" aria-label="Entrada de voz">
              <Mic size={18} />
            </button>
            <button
              className="submitButton"
              type="button"
              onClick={runCouncil}
              disabled={!query.trim() && false}
              aria-label="Enviar pregunta"
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
  models, selectedCount, selectedFusionPanelId, applyFusionPanel, toggleModel, cycleReasoningEffort, selectTopThree, councilEnabled, modelHealth,
}: {
  models: RunModel[];
  selectedCount: number;
  selectedFusionPanelId: string;
  applyFusionPanel: (id: string) => void;
  toggleModel: (id: string) => void;
  cycleReasoningEffort: (id: string) => void;
  selectTopThree: () => void;
  councilEnabled: boolean;
  modelHealth: Record<string, ModelHealthInfo>;
}) {
  return (
    <aside className="modelSelector">
      <div className="selectorHeader">
        <div>
          <h2>{councilEnabled ? "Miembros del consenso" : "Buscar modelo"}</h2>
          <p>
            {councilEnabled
              ? `${selectedCount} de ${models.length} seleccionados · mínimo 2`
              : `Elegí un modelo para responder · ${models.length} disponibles`}
          </p>
        </div>
        {councilEnabled ? (
          <button className="quickSelect" type="button" onClick={selectTopThree}>
            Volver a 3
          </button>
        ) : null}
      </div>
      {councilEnabled ? (
        <div className="fusionPanelList" aria-label="Paneles de fusión predefinidos">
          {FUSION_PANELS.map((panel) => (
            <button
              key={panel.id}
              type="button"
              className={selectedFusionPanelId === panel.id ? "fusionPanel active" : "fusionPanel"}
              onClick={() => applyFusionPanel(panel.id)}
            >
              <span>
                <strong>{panel.shortName}</strong>
                {panel.featured ? <em>Fusión</em> : null}
              </span>
              <small>{panel.scoreLabel} · {panel.costLabel}</small>
            </button>
          ))}
        </div>
      ) : null}
      <div className="modelRows">
        {models.map((model) => {
          const health = modelHealth[model.id];
          const isFlaky = health && health.attempts >= 2 && health.failures / health.attempts >= 0.4;
          return (
          <div className="modelRow" key={model.id}>
            <ModelBadge model={model} />
            <div className="modelMeta">
              <strong>
                {model.label}
                {isFlaky ? (
                  <span
                    className="modelHealthWarning"
                    title={`Falló ${health.failures} de ${health.attempts} intentos recientes${health.lastFailureReason ? `: ${health.lastFailureReason}` : ""}`}
                  >
                    <AlertTriangle size={12} />
                  </span>
                ) : null}
              </strong>
              <span>{model.maker}</span>
            </div>
            <button
              type="button"
              className={`effortCycler effort-${model.reasoningEffort}`}
              onClick={() => cycleReasoningEffort(model.id)}
              title="Clic para rotar el esfuerzo de razonamiento: bajo → medio → alto"
              aria-label={`Esfuerzo de razonamiento: ${model.reasoningEffort}. Clic para cambiar.`}
            >
              <span className="effortLabel">Esfuerzo</span>
              <span className="effortValue">{effortLabelEs(model.reasoningEffort)}</span>
            </button>
            <button
              className={model.selected ? "switch on" : "switch"}
              type="button"
              onClick={() => toggleModel(model.id)}
              aria-label={`Activar/desactivar ${model.label}`}
            >
              <span />
            </button>
          </div>
          );
        })}
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
  fileAgentModelId,
  setFileAgentModelId,
  fileAgentCandidates,
  skills,
  setSkills,
  webGrounding,
  setWebGrounding,
  maxDebateRounds,
  setMaxDebateRounds,
  magiMode,
  setMagiMode,
  selectedCount,
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
  fileAgentModelId: string;
  setFileAgentModelId: (id: string) => void;
  fileAgentCandidates: Array<{ id: string; label: string }>;
  skills: AgentSkill[];
  setSkills: React.Dispatch<React.SetStateAction<AgentSkill[]>>;
  webGrounding: boolean;
  setWebGrounding: (value: boolean) => void;
  maxDebateRounds: number;
  setMaxDebateRounds: (value: number) => void;
  magiMode: boolean;
  setMagiMode: (value: boolean) => void;
  selectedCount: number;
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
            <span>Espacio de trabajo</span>
            <h2>Ajustes</h2>
          </div>
          <button className="closeButton" type="button" onClick={onClose} aria-label="Cerrar ajustes">
            <X size={18} />
          </button>
        </header>

      <div className="settingsTabs" role="tablist">
        <button className={tab === "connectors" ? "active" : ""} type="button" onClick={() => setTab("connectors")}>
          <Globe size={13} /> Conectores
        </button>
        <button className={tab === "skills" ? "active" : ""} type="button" onClick={() => setTab("skills")}>
          <Wrench size={13} /> Habilidades
        </button>
        <button className={tab === "research" ? "active" : ""} type="button" onClick={() => setTab("research")}>
          <Search size={13} /> Investigación
        </button>
        <button className={tab === "images" ? "active" : ""} type="button" onClick={() => setTab("images")}>
          <ImageIcon size={13} /> Imágenes
        </button>
      </div>

      {tab === "connectors" ? (
        <div className="settingsPane">
          <div className="settingsHeader">
            <strong>Conectores</strong>
            <span>{[connectors.github, connectors.filesystem].filter(Boolean).length} activados</span>
          </div>
          <div className="connectorList">
            <article className="connectorRow">
              <div className="connectorIcon"><Globe size={16} /></div>
              <div>
                <strong>GitHub</strong>
                <span>Busca repositorios, inspecciona archivos, y lista issues o pull requests durante las corridas del agente.</span>
              </div>
              <button
                className={connectors.github ? "switch on" : "switch"}
                type="button"
                onClick={() => setConnectors((current) => ({ ...current, github: !current.github }))}
                aria-label="Activar/desactivar conector de GitHub"
              >
                <span />
              </button>
            </article>
            <article className="connectorRow">
              <div className="connectorIcon"><FolderCog size={16} /></div>
              <div>
                <strong>Sistema de archivos (local)</strong>
                <span>
                  Le da a un modelo del panel acceso de lectura y escritura a los archivos del proyecto en esta PC. Las lecturas
                  (listar carpetas, leer archivos) corren directo; cualquier escritura o edición queda propuesta con un diff y
                  no se aplica hasta que la confirmés vos.
                </span>
              </div>
              <button
                className={connectors.filesystem ? "switch on" : "switch"}
                type="button"
                onClick={() => setConnectors((current) => ({ ...current, filesystem: !current.filesystem }))}
                aria-label="Activar/desactivar conector de sistema de archivos"
              >
                <span />
              </button>
            </article>
            {connectors.filesystem ? (
              <div className="fileAgentPicker">
                <label htmlFor="file-agent-select">Modelo agente de archivos</label>
                <select
                  id="file-agent-select"
                  value={fileAgentModelId}
                  onChange={(event) => setFileAgentModelId(event.target.value)}
                >
                  <option value="">Ninguno seleccionado</option>
                  {fileAgentCandidates.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.label}
                    </option>
                  ))}
                </select>
                <span className="settingsNote" style={{ margin: 0 }}>
                  Solo este modelo, dentro del panel elegido, va a poder leer y proponer cambios de archivos durante drafting y debate.
                </span>
              </div>
            ) : null}
          </div>
          <div className="settingsNote">
            GitHub funciona con repositorios públicos sin configuración. Agregá `GITHUB_TOKEN` en el servidor para repos privados y límites de API más altos.
          </div>
          <div className="settingsNote">
            El agente de archivos opera dentro de la carpeta del proyecto (o la que definas en `AGENT_FS_ROOT` en el servidor) y nunca puede salir de ahí.
          </div>
          <div className="settingsNote">
            Tanto ChatGPT como Claude ponen los conectores en Ajustes, requieren autenticación de terceros por usuario, y dejan que cada chat use selectivamente las fuentes conectadas. Esta app replica eso con toggles de conectores a nivel de espacio de trabajo y uso de herramientas por corrida.
          </div>
        </div>
      ) : tab === "skills" ? (
        <div className="settingsPane">
          <div className="settingsHeader">
            <strong>Habilidades del agente</strong>
            <span>{skills.filter((skill) => skill.enabled).length} activas</span>
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
                  aria-label={`Activar/desactivar ${skill.name}`}
                >
                  <span />
                </button>
                <div>
                  <strong>{skill.name}</strong>
                  <span>{skill.description || "Instrucción importada"}</span>
                </div>
                <button
                  className="deleteSkill"
                  type="button"
                  onClick={() => setSkills((current) => current.filter((item) => item.id !== skill.id))}
                  aria-label={`Eliminar ${skill.name}`}
                >
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>

          <div className="skillEditor">
            <input value={draftName} onChange={(event) => setDraftName(event.target.value)} placeholder="Nombre de la nueva habilidad" />
            <input value={draftDescription} onChange={(event) => setDraftDescription(event.target.value)} placeholder="¿Cuándo debería aplicarse esta habilidad?" />
            <textarea value={draftBody} onChange={(event) => setDraftBody(event.target.value)} placeholder="Escribí las instrucciones de la habilidad..." rows={4} />
            <button type="button" onClick={addSkill} disabled={!draftName.trim() || !draftBody.trim()}>
              Crear habilidad
            </button>
          </div>

          <div className="skillEditor">
            <textarea value={importText} onChange={(event) => setImportText(event.target.value)} placeholder="Pegá un SKILL.md o una habilidad en JSON para importar..." rows={4} />
            <button type="button" onClick={importSkill} disabled={!importText.trim()}>
              Importar habilidad
            </button>
          </div>
        </div>
      ) : tab === "research" ? (
        <div className="settingsPane">
          <div className="settingsHeader">
            <strong>Comportamiento de research</strong>
            <span>{webGrounding ? "web activada" : "web desactivada"}</span>
          </div>
          <label className="imageToggle">
            <input
              type="checkbox"
              checked={webGrounding}
              onChange={(event) => setWebGrounding(event.target.checked)}
            />
            Usar búsqueda web de OpenRouter en el chat
          </label>
          <div className="fileAgentPicker">
            <label htmlFor="max-debate-rounds">Rondas de debate (máximo)</label>
            <select
              id="max-debate-rounds"
              value={maxDebateRounds}
              onChange={(event) => setMaxDebateRounds(Number(event.target.value))}
            >
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n} {n === 1 ? "ronda" : "rondas"}
                </option>
              ))}
            </select>
            <span className="settingsNote" style={{ margin: 0 }}>
              El consejo debate hasta este máximo, pero corta antes si las respuestas convergen (medido por
              vocabulario compartido entre los modelos). Al terminar el debate, cada modelo sobreviviente vota por
              la respuesta más fuerte del panel.
            </span>
          </div>
          <div className="fileAgentPicker">
            <div className="magiModeHeader">
              <label htmlFor="magi-mode-toggle">Modo MAGI</label>
              <button
                id="magi-mode-toggle"
                className={magiMode ? "switch on" : "switch"}
                type="button"
                onClick={() => setMagiMode(!magiMode)}
                aria-label="Activar/desactivar Modo MAGI"
              >
                <span />
              </button>
            </div>
            <span className="settingsNote" style={{ margin: 0 }}>
              Asigna a cada modelo una lente analítica fija, inspirada en el sistema MAGI: <strong>Melchior</strong>{" "}
              (la científica — evidencia y rigor técnico), <strong>Balthasar</strong> (la guardiana — riesgo y
              consecuencias) y <strong>Casper</strong> (la defensora — impacto humano y contexto social). Requiere
              exactamente 3 modelos seleccionados
              {selectedCount !== 3 ? (
                <> — actualmente tenés <strong>{selectedCount}</strong>, así que no tiene efecto todavía</>
              ) : (
                "."
              )}
            </span>
          </div>
          <div className="researchPatternList">
            <article>
              <strong>Apps/conectores estilo ChatGPT</strong>
              <span>Los conectores se pueden usar en el chat para buscar archivos, en deep research para reportes con citas de múltiples fuentes, y en algunos casos vía datos sincronizados/indexados. Los usuarios los activan desde Ajustes y eligen fuentes desde el composer.</span>
            </article>
            <article>
              <strong>Integraciones estilo Claude</strong>
              <span>Claude expone las integraciones en Ajustes &gt; Conectores, con activación a nivel workspace/admin para equipos y autenticación por usuario. La búsqueda web también es un ajuste estilo conector que se puede activar/desactivar.</span>
            </article>
            <article>
              <strong>Comportamiento del consenso de modelos</strong>
              <span>Cuando Web está activa, los modelos que redactan reciben resultados de búsqueda web de OpenRouter. Cuando los conectores están activados, el loop del agente puede usar sus herramientas durante el borrador, el debate, o la síntesis.</span>
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
            Generar imagen después de la respuesta
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
  models, synthesisActivity, streamError, runPhase, elapsedMs, onOpenModelResponse, onStop, fileProposals, onApplyProposal, onRejectProposal, onApplyProposalGroup, onRejectProposalGroup, tokenUsage, debateRounds, magiPersonas,
}: {
  models: RunModel[];
  synthesisActivity: string;
  streamError: string;
  runPhase: RunPhase;
  elapsedMs: number;
  onOpenModelResponse: (id: string) => void;
  onStop?: () => void;
  fileProposals: FileProposalState[];
  onApplyProposal: (id: string) => void;
  onRejectProposal: (id: string) => void;
  onApplyProposalGroup: (groupId: string) => void;
  onRejectProposalGroup: (groupId: string) => void;
  tokenUsage: TokenUsage;
  debateRounds: DebateRoundInfo[];
  magiPersonas: Record<string, { key: string; name: string; title: string }>;
}) {
  const isStreaming = runPhase !== "done";
  const timelineMessage = streamError
    || (isStreaming ? synthesisActivity || currentHeadline(models) : "Síntesis final completa.");
  const synthesisBarMessage =
    runPhase === "done"
      ? "Síntesis final completa."
      : runPhase === "synthesizing" || synthesisActivity
        ? "Sintetizando borradores y críticas del debate…"
        : runPhase === "debating"
          ? "Los modelos están debatiendo entre sí…"
          : "Esperando los borradores independientes…";

  const councilStatus: CouncilStatus = streamError ? "error" : runPhase === "done" ? "complete" : "processing";
  const councilEyebrow = streamError
    ? "ALERTA DEL SISTEMA"
    : runPhase === "done"
      ? "DELIBERACIÓN COMPLETA"
      : "DELIBERACIÓN EN CURSO";
  const councilHeadline = streamError
    ? "ERROR"
    : runPhase === "synthesizing"
      ? "SINTETIZANDO"
      : runPhase === "done"
        ? "DECISIÓN DEL CONSENSO"
        : "DELIBERANDO";
  const councilDetail = streamError || (runPhase === "done" ? "RESPUESTA FINAL LISTA" : timelineMessage);
  const phaseIndex = runPhase === "drafting" ? 1 : runPhase === "debating" ? 2 : 3;
  const completedCount = models.filter((m) =>
    runPhase === "drafting" ? m.status === "complete" : m.debateStatus === "complete",
  ).length;

  return (
    <div className="thinkingPanel">
      <CouncilPanel
        status={councilStatus}
        phaseId={runPhase}
        eyebrow={councilEyebrow}
        headline={councilHeadline}
        detail={councilDetail}
        stats={[
          { label: "MODELOS", value: String(models.length) },
          { label: "FASE", value: `${Math.min(phaseIndex, 3)}/3` },
          { label: "RESPUESTAS", value: `${completedCount}/${models.length}` },
          ...(debateRounds.length
            ? [{ label: "RONDA", value: `${debateRounds[debateRounds.length - 1].round}/${debateRounds[debateRounds.length - 1].maxRounds}` }]
            : []),
          { label: "TRANSCURRIDO", value: formatElapsed(elapsedMs) },
          { label: "TOKENS", value: formatTokens(tokenUsage.total_tokens) },
        ]}
        nodes={models.map((model) => ({
          id: model.id,
          label: magiPersonas[model.id]?.name.toUpperCase() ?? model.label,
          badge: model.badge,
          state: nodeStateFor(model, runPhase),
        }))}
      />

      {fileProposals.length ? (
        <FileProposalsPanel
          proposals={fileProposals}
          onApply={onApplyProposal}
          onReject={onRejectProposal}
          onApplyGroup={onApplyProposalGroup}
          onRejectGroup={onRejectProposalGroup}
        />
      ) : null}

      <div className="timelineHead">
        <h2 className="timelineTitle">Consenso en sesión</h2>
        {isStreaming && onStop ? (
          <button type="button" className="stopButton" onClick={onStop}>
            <Square size={13} fill="currentColor" /> Detener
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
              ? "Redactando"
              : runPhase === "debating"
                ? "Debatiendo"
                : runPhase === "synthesizing"
                  ? "Sintetizando"
                  : "Listo";

          return (
            <article className={`thinkingCard ${phaseStatus}`} key={model.id}>
              <div className="thinkingBody">
                <div className="thinkingCardHeader">
                  <div className="modelPill">
                    <ModelBadge model={model} small />
                    <strong>{model.label}</strong>
                  </div>
                  <span className="phaseLabel">{phaseLabel}</span>
                  {model.steps ? <span className="inlineSteps">{model.steps} pasos</span> : null}
                </div>
                <p className="currentActivity">
                  {model.error
                    ? `Error: ${model.error}`
                    : phaseStatus === "complete"
                      ? runPhase === "drafting"
                        ? "Borrador independiente completado"
                        : "Debate completo — crítica enviada"
                      : latestActivity(model)}
                </p>
              </div>
              <div className="thinkingCardAction">
                {model.status === "complete" ? (
                  <button type="button" onClick={() => onOpenModelResponse(model.id)}>
                    Ver borrador <ArrowRight size={14} />
                  </button>
                ) : phaseStatus === "thinking" ? (
                  <span className="writingPill"><i /> {runPhase === "debating" ? "Debatiendo…" : "Escribiendo…"}</span>
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

function FileProposalsPanel({
  proposals,
  onApply,
  onReject,
  onApplyGroup,
  onRejectGroup,
}: {
  proposals: FileProposalState[];
  onApply: (id: string) => void;
  onReject: (id: string) => void;
  onApplyGroup: (groupId: string) => void;
  onRejectGroup: (groupId: string) => void;
}) {
  const groups = new Map<string, FileProposalState[]>();
  for (const proposal of proposals) {
    const list = groups.get(proposal.groupId) ?? [];
    list.push(proposal);
    groups.set(proposal.groupId, list);
  }

  return (
    <div className="fileProposalsPanel">
      <div className="fileProposalsHeader">
        <FolderCog size={15} />
        <strong>Cambios de archivos propuestos</strong>
        <span>{proposals.filter((p) => p.status === "pending").length} esperando revisión</span>
      </div>
      {[...groups.entries()].map(([groupId, group]) => {
        const pendingInGroup = group.filter((p) => p.status === "pending");
        const isMultiFile = group.length > 1;
        return (
          <div className="fileProposalGroup" key={groupId}>
            {isMultiFile ? (
              <div className="fileProposalGroupHeader">
                <span>{group.length} archivos relacionados (mismo turno)</span>
                {pendingInGroup.length ? (
                  <div className="fileProposalActions">
                    <button type="button" className="applyButton" onClick={() => onApplyGroup(groupId)}>
                      <Check size={13} /> Aplicar todo
                    </button>
                    <button type="button" className="rejectButton" onClick={() => onRejectGroup(groupId)}>
                      <X size={13} /> Descartar todo
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
            {group.map((proposal) => (
              <article key={proposal.id} className={`fileProposalCard status-${proposal.status}`}>
                <header>
                  <span className="fileProposalKind">{proposal.kind === "write" ? "Escribir" : "Editar"}</span>
                  <code className="fileProposalPath">{proposal.path}</code>
                  <TypeCheckBadge typeCheck={proposal.typeCheck} />
                  <span className="fileProposalStatus">
                    {proposal.status === "pending" && "Pendiente"}
                    {proposal.status === "applying" && "Aplicando…"}
                    {proposal.status === "applied" && "Aplicado"}
                    {proposal.status === "rejected" && "Descartado"}
                    {proposal.status === "error" && `Error: ${proposal.error}`}
                  </span>
                </header>
                <DiffView diff={proposal.diff} />
                {proposal.typeCheck.status === "error" && proposal.typeCheck.errors?.length ? (
                  <pre className="typeCheckErrors">{proposal.typeCheck.errors.join("\n")}</pre>
                ) : null}
                {proposal.status === "pending" ? (
                  <div className="fileProposalActions">
                    <button type="button" className="applyButton" onClick={() => onApply(proposal.id)}>
                      <Check size={13} /> Aplicar
                    </button>
                    <button type="button" className="rejectButton" onClick={() => onReject(proposal.id)}>
                      <X size={13} /> Descartar
                    </button>
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function TypeCheckBadge({ typeCheck }: { typeCheck: TypeCheckResult }) {
  if (typeCheck.status === "skipped") return null;
  if (typeCheck.status === "checking") {
    return (
      <span className="typeCheckBadge checking" title="Verificando tipos con tsc…">
        <Loader2 size={11} className="spin" /> Verificando
      </span>
    );
  }
  if (typeCheck.status === "ok") {
    return (
      <span className="typeCheckBadge ok" title="tsc --noEmit no encontró errores">
        <Check size={11} /> Compila
      </span>
    );
  }
  return (
    <span className="typeCheckBadge error" title={typeCheck.errors?.join("\n") || "tsc encontró errores"}>
      <AlertTriangle size={11} /> {typeCheck.errors?.length ?? 0} error{(typeCheck.errors?.length ?? 0) === 1 ? "" : "es"}
    </span>
  );
}

function DiffView({ diff }: { diff: string }) {
  const lines = diff.split("\n");
  return (
    <pre className="diffView">
      {lines.map((line, index) => {
        const kind = line.startsWith("+++") || line.startsWith("---")
          ? "meta"
          : line.startsWith("+")
            ? "add"
            : line.startsWith("-")
              ? "del"
              : "context";
        return (
          <div key={index} className={`diffLine diff-${kind}`}>
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
}

function PhaseTracker({ runPhase }: { runPhase: RunPhase }) {
  const phases: Array<{ id: Exclude<RunPhase, "done">; label: string; icon: LucideIcon }> = [
    { id: "drafting", label: "Borradores independientes", icon: Sparkles },
    { id: "debating", label: "Debate del consenso", icon: Gavel },
    { id: "synthesizing", label: "Síntesis final", icon: Layers3 },
  ];
  const order: RunPhase[] = ["drafting", "debating", "synthesizing", "done"];
  const activeIndex = order.indexOf(runPhase);

  return (
    <ol className="phaseTracker" aria-label="Fases del consenso">
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

function DebateView({
  models,
  debateRounds,
  votes,
  voteTally,
  magiPersonas,
}: {
  models: RunModel[];
  debateRounds: DebateRoundInfo[];
  votes: VoteCastInfo[];
  voteTally: VoteTallyInfo | null;
  magiPersonas: Record<string, { key: string; name: string; title: string }>;
}) {
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

      {debateRounds.length ? (
        <div className="debateRoundsSummary">
          {debateRounds.map((round) => (
            <div className="debateRoundChip" key={round.round}>
              <span className="debateRoundChipLabel">Ronda {round.round}/{round.maxRounds}</span>
              <span className={round.converged ? "debateRoundChipConverged" : "debateRoundChipScore"}>
                {round.converged ? "Convergió" : `${Math.round(round.convergence * 100)}% acuerdo`}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      <div className="debateStack">
        {debaters.map((model) => (
          <article className="debateCard" key={model.id}>
            <header>
              <div className="modelPill">
                <ModelBadge model={model} small />
                <strong>{model.label}</strong>
                {magiPersonas[model.id] ? (
                  <span className="magiPersonaBadge" title={magiPersonas[model.id].title}>
                    {magiPersonas[model.id].name}
                  </span>
                ) : null}
              </div>
              <span className="debateBadge">
                <MessageSquareQuote size={13} />
                {model.debateRound && model.debateMaxRounds
                  ? `Ronda ${model.debateRound}/${model.debateMaxRounds}`
                  : "Debate response"}
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

      {votes.length ? (
        <div className="voteSection">
          <h4>Votación final del consejo</h4>
          <p style={{ color: "var(--muted)", margin: "-2px 0 8px", fontSize: 13 }}>
            Cada modelo sobreviviente votó por la respuesta final más fuerte del panel (podía votarse a sí mismo).
          </p>
          <div className="voteList">
            {votes.map((vote) => (
              <div className="voteRow" key={vote.modelId}>
                <span className="voteFrom">{vote.label}</span>
                <span className="voteArrow">→</span>
                <span className="voteFor">{vote.votedForLabel ?? "(sin voto válido)"}</span>
                {vote.rationale ? <span className="voteRationale">{vote.rationale}</span> : null}
              </div>
            ))}
          </div>
          {voteTally ? (
            <div className="voteTally">
              {voteTally.tally
                .slice()
                .sort((a, b) => b.votes - a.votes)
                .map((entry) => (
                  <div className={entry.modelId === voteTally.winnerModelId ? "voteTallyBar winner" : "voteTallyBar"} key={entry.modelId}>
                    <span>{entry.label}</span>
                    <div className="voteTallyBarTrack">
                      <div
                        className="voteTallyBarFill"
                        style={{ width: voteTally.totalVotes ? `${(entry.votes / voteTally.totalVotes) * 100}%` : "0%" }}
                      />
                    </div>
                    <span>{entry.votes}</span>
                  </div>
                ))}
              {voteTally.winnerLabel ? (
                <p className="voteWinnerNote">
                  <Trophy size={13} /> El panel favoreció la respuesta de <strong>{voteTally.winnerLabel}</strong>.
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/* =========================================================
   Sources view
   ========================================================= */

function SourcesView({ models }: { models: RunModel[] }) {
  return (
    <div className="resultSection">
      <h3>Fuentes citadas</h3>
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

      <h3 style={{ marginTop: 20 }}>Por modelo</h3>
      <div className="modelResponseButtons">
        {models.map((model) => (
          <button key={model.id} type="button">
            <ModelBadge model={model} />
            <span>{model.label}</span>
            <em>{model.steps || 0} pasos</em>
            <p>Contexto independiente elaborado para esta pregunta.</p>
          </button>
        ))}
      </div>
    </div>
  );
}

/* =========================================================
   Markdown export — lets the user hand a clean, AI-friendly
   transcript to another model instead of copy/pasting the page.
   ========================================================= */

function slugify(text: string, maxLength = 60) {
  const slug = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (slug || "council-thread").slice(0, maxLength);
}

function buildMarkdownExport({
  query,
  synthesis,
  fusionJudge,
  models,
  followUps,
  tokenUsage,
}: {
  query: string;
  synthesis: string;
  fusionJudge: FusionJudgeReport | null;
  models: RunModel[];
  followUps: string[];
  tokenUsage?: TokenUsage;
}) {
  const lines: string[] = [];
  const usedModels = models.filter((model) => model.response || model.error);
  const timestamp = new Date().toISOString();

  lines.push(`# Council question`, "", query.trim(), "");
  const tokenNote = tokenUsage?.total_tokens
    ? ` — Tokens: ${tokenUsage.total_tokens} (${tokenUsage.prompt_tokens ?? 0} prompt / ${tokenUsage.completion_tokens ?? 0} completion)`
    : "";
  lines.push(
    `_Generated by Open Model Council — ${timestamp} — Models: ${usedModels.map((m) => m.label).join(", ") || "none"}${tokenNote}_`,
    "",
  );

  if (synthesis) {
    lines.push("## Synthesized answer", "", synthesis.trim(), "");
  }

  if (fusionJudge) {
    lines.push("## Fusion judge report", "");
    if (fusionJudge.panelVerdict) {
      lines.push("### Panel verdict", "", fusionJudge.panelVerdict.trim(), "");
    }
    if (fusionJudge.consensus?.length) {
      lines.push("### Where the council agreed", "");
      fusionJudge.consensus.forEach((item) => {
        lines.push(`- **${item.finding}** (agreed by: ${item.models.join(", ")}) — ${item.evidence}`);
      });
      lines.push("");
    }
    if (fusionJudge.contradictions?.length) {
      lines.push("### Where the council disagreed", "");
      fusionJudge.contradictions.forEach((item) => {
        lines.push(`#### ${item.topic}`, "");
        Object.entries(item.positions).forEach(([modelName, position]) => {
          lines.push(`- **${modelName}:** ${position}`);
        });
        lines.push("", `**Judgment:** ${item.judgment}`, "");
      });
    }
    if (fusionJudge.uniqueInsights?.length) {
      lines.push("### Unique insights", "");
      fusionJudge.uniqueInsights.forEach((item) => {
        lines.push(`- **${item.model}:** ${item.insight} — _Why it matters:_ ${item.whyItMatters}`);
      });
      lines.push("");
    }
    if (fusionJudge.coverageGaps?.length) {
      lines.push("### Coverage gaps", "");
      fusionJudge.coverageGaps.forEach((gap) => lines.push(`- ${gap}`));
      lines.push("");
    }
  }

  if (usedModels.length) {
    lines.push("## Individual model responses", "");
    usedModels.forEach((model) => {
      lines.push(`### ${model.label} (${model.maker})`, "");
      if (model.error) {
        lines.push(`**Error:** ${model.error}`, "");
        return;
      }
      if (model.response) {
        lines.push("**Independent draft:**", "", model.response.trim(), "");
      }
      if (model.critique) {
        lines.push("**Debate critique:**", "", model.critique.trim(), "");
      }
      if (model.revisedAnswer) {
        lines.push("**Revised answer:**", "", model.revisedAnswer.trim(), "");
      }
      lines.push("---", "");
    });
  }

  if (followUps.length) {
    lines.push("## Suggested follow-up questions", "");
    followUps.forEach((question, index) => lines.push(`${index + 1}. ${question}`));
    lines.push("");
  }

  return lines.join("\n").trim() + "\n";
}

function downloadTextFile(filename: string, content: string, mimeType = "text/markdown;charset=utf-8") {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

/* =========================================================
   Tribunal view — MAGI-terminal-inspired alternate rendering
   of the same council data (see globals.css .tribunal*).
   ========================================================= */

/** Short, deterministic, non-cryptographic hash — just needs to look like
 * a stable case code for the same query, not to be secure. */
function caseCode(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash << 5) - hash + text.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(16).toUpperCase().padStart(6, "0").slice(0, 6);
}

/** Pulls a short verdict line out of a draft/revised answer for the seat
 * card — prefers the "Direct Answer" section if the model followed the
 * expected format, otherwise just the first stretch of prose. */
function verdictSnippet(content: string, maxLen = 150): string {
  const match = content.match(/##\s+Direct Answer\s*\n([\s\S]*?)(?=\n##\s+|$)/i);
  const text = (match ? match[1] : content).replace(/[#*_`]/g, "").trim();
  return text.length > maxLen ? `${text.slice(0, maxLen).trim()}…` : text;
}

function TribunalView({
  models,
  query,
  fusionJudge,
  fusionPanelId,
}: {
  models: RunModel[];
  query: string;
  fusionJudge: FusionJudgeReport | null;
  fusionPanelId: string | null;
}) {
  const activeModels = models.filter((m) => m.response || m.error || m.status !== "queued");
  const contested = Boolean(fusionJudge?.contradictions?.length);
  const agreeCount = fusionJudge?.consensus?.length ?? 0;
  const disagreeCount = fusionJudge?.contradictions?.length ?? 0;
  const panel = FUSION_PANELS.find((p) => p.id === fusionPanelId);
  const isTriad = activeModels.length === 3;

  return (
    <div className="tribunal" role="region" aria-label="Tribunal view">
      <div className="tribunalCaseStrip">
        <span>CASO №<strong>{caseCode(query || "consenso")}</strong></span>
        <span className="tribunalFile">ARCHIVO: {query || "consulta sin título"}</span>
        <span>MODO: <strong>{panel ? panel.shortName.toUpperCase() : "SELECCIÓN MANUAL"}</strong></span>
        <span>ASIENTOS: <strong>{activeModels.length}</strong></span>
        <span className="tribunalStatus">
          <span className={`tribunalStatusDot${contested ? " contested" : ""}`} />
          {fusionJudge ? (contested ? "EN DISPUTA" : "RESUELTO") : "ABIERTO"}
        </span>
      </div>

      {fusionJudge ? (
        <div className="tribunalHub">
          <div className={`tribunalHubBadge${contested ? " contested" : ""}`}>
            <span className="tribunalHubLabel">Veredicto del panel</span>
            <span className={`tribunalHubVerdict${contested ? " contested" : ""}`}>
              {contested ? "DECISIÓN DIVIDIDA" : "UNÁNIME"}
            </span>
            <span className="tribunalHubTally">{agreeCount} DE ACUERDO · {disagreeCount} EN DISPUTA</span>
          </div>
        </div>
      ) : null}

      <div className={`tribunalSeats${isTriad ? " triad" : ""}`}>
        {activeModels.map((model) => {
          const verdictSource = model.revisedAnswer || model.response;
          const stateClass = model.error ? "error" : model.status;
          return (
            <div key={model.id} className={`tribunalSeat${model.error ? " error" : ""}`}>
              <div className="tribunalSeatHead">
                <div>
                  <div className="tribunalSeatName">{model.label}</div>
                  <div className="tribunalSeatMaker">{model.maker}</div>
                </div>
                <span className={`tribunalSeatDot ${stateClass}`} />
              </div>
              <div className={`tribunalSeatVerdict${model.error ? " error" : !verdictSource ? " pending" : ""}`}>
                {model.error ? model.error : verdictSource ? verdictSnippet(verdictSource) : "ESPERANDO RESPUESTA…"}
              </div>
              <div className="tribunalSeatFoot">{model.critique ? "DEBATIDO" : model.response ? "SOLO BORRADOR" : "PENDIENTE"}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}



function ResultsDashboard({
  models, query, synthesis, fusionJudge, fusionPanelId, followUps, generatedImages, imageStatus, onOpenModal, onRunFollowup, tokenUsage, tokenBreakdown,
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
  tokenUsage: TokenUsage;
  tokenBreakdown: Array<{ phase: string; modelId?: string; label?: string; usage: TokenUsage }>;
}) {
  const useDemoTables = query.trim() === DEFAULT_QUERY;
  const activePanel = FUSION_PANELS.find((panel) => panel.id === fusionPanelId);
  const [copyState, setCopyState] = useState<"idle" | "copied">("idle");
  const [tribunalMode, setTribunalMode] = useState(false);

  async function handleCopyMarkdown() {
    const markdown = buildMarkdownExport({ query, synthesis, fusionJudge, models, followUps, tokenUsage });
    try {
      await navigator.clipboard.writeText(markdown);
      setCopyState("copied");
      setTimeout(() => setCopyState("idle"), 1800);
    } catch {
      // Clipboard access can be blocked (permissions, insecure context) —
      // fall back to a download so the user isn't stuck with nothing.
      downloadTextFile(`${slugify(query)}.md`, markdown);
    }
  }

  function handleDownloadMarkdown() {
    const markdown = buildMarkdownExport({ query, synthesis, fusionJudge, models, followUps, tokenUsage });
    downloadTextFile(`${slugify(query)}.md`, markdown);
  }

  return (
    <div className="resultsDashboard">
      <section className="summaryBlock">
        <div className="summaryHead">
          <h3><Sparkles size={16} /> Respuesta consensuada</h3>
          <div className="summaryActions">
            <button
              className={`tribunalToggle${tribunalMode ? " active" : ""}`}
              type="button"
              aria-pressed={tribunalMode}
              onClick={() => setTribunalMode((v) => !v)}
              title="Toggle tribunal view"
            >
              <Gavel size={14} /> Tribunal
            </button>
            <button className="iconBtn" type="button" aria-label="Copy as Markdown" onClick={handleCopyMarkdown} title="Copy full transcript as Markdown">
              {copyState === "copied" ? <Check size={16} /> : <Copy size={16} />}
            </button>
            <button className="iconBtn" type="button" aria-label="Download as Markdown" onClick={handleDownloadMarkdown} title="Download full transcript as a .md file">
              <Download size={16} />
            </button>
            <button className="iconBtn" type="button" aria-label="Share"><Share2 size={16} /></button>
            <button className="iconBtn" type="button" aria-label="Save"><Bookmark size={16} /></button>
          </div>
        </div>

        {tribunalMode ? (
          <TribunalView models={models} query={query} fusionJudge={fusionJudge} fusionPanelId={fusionPanelId} />
        ) : synthesis ? (
          <MarkdownLite content={synthesis} />
        ) : (
          <p style={{ color: "var(--muted)", margin: 0 }}>
            The council’s strongest consensus appears here once the synthesizer compares all model responses.
          </p>
        )}

        <div className="summaryFoot">
          <span>Elaborado usando {models.map((model) => model.label).join(", ")}</span>
          <b>{activePanel ? `Fusión ${activePanel.shortName}` : useDemoTables ? `${DEMO_SOURCES.length} fuentes` : "Panel personalizado"}</b>
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
            <h3>Dónde coinciden los modelos</h3>
            <div className="tableShell">
              <table>
                <thead>
                  <tr>
                    <th>Hallazgo</th>
                    {models.map((model) => (
                      <th className="modelColumn" key={model.id}>
                        <ModelBadge model={model} small />
                      </th>
                    ))}
                    <th>Evidencia</th>
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
            <h3>Dónde discrepan los modelos</h3>
            <div className="tableShell">
              <table>
                <thead>
                  <tr>
                    <th>Tema</th>
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
            <h3>Hallazgos únicos</h3>
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

      {fusionJudge?.contradictions?.length ? (
        <section className="resultSection">
          <h3><Gavel size={14} /> Mapa de desacuerdo</h3>
          <p style={{ color: "var(--muted)", margin: "-4px 0 6px", fontSize: 13 }}>
            Puntos concretos donde el panel no coincidió, con la posición de cada modelo y cómo lo resolvió el juez.
          </p>
          <div className="disagreementMap">
            {fusionJudge.contradictions.map((item, index) => (
              <article className="disagreementCard" key={index}>
                <h4>{item.topic}</h4>
                <div className="disagreementPositions">
                  {Object.entries(item.positions).map(([modelLabel, position]) => (
                    <div className="disagreementPosition" key={modelLabel}>
                      <strong>{modelLabel}</strong>
                      <span>{position}</span>
                    </div>
                  ))}
                </div>
                <p className="disagreementJudgment"><Trophy size={12} /> {item.judgment}</p>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {tokenBreakdown.length ? <TokenBreakdownSection breakdown={tokenBreakdown} /> : null}

      <section className="resultSection">
        <h3>Respuestas individuales</h3>
        <div className="modelResponseButtons">
          {models.map((model) => (
            <button key={model.id} type="button" onClick={() => onOpenModal(model.id)}>
              <ModelBadge model={model} />
              <span>{model.label}</span>
              <em>Abrir →</em>
              <p>{model.response ? compactQuestion(model.response) : model.error ?? "Open the full individual response."}</p>
            </button>
          ))}
        </div>
      </section>

      <section className="followUps">
        <h3><ArrowRight size={14} /> Preguntas relacionadas</h3>
        {followUps.length ? (
          followUps.map((q) => (
            <button key={q} type="button" onClick={() => onRunFollowup(q)}>
              <span>{q}</span>
              <Plus size={16} />
            </button>
          ))
        ) : (
          <p className="followUpsEmpty">No se pudieron generar preguntas relacionadas para esta respuesta.</p>
        )}
      </section>
    </div>
  );
}

/**
 * Groups the run's raw per-event token usage by phase (draft/debate/vote/
 * judge/synthesis/...) so it's obvious which STEP is actually expensive —
 * e.g. the vote step sends every candidate's full answer to every voter, an
 * O(n²)-ish prompt cost that's easy to miss when only a single grand total
 * is shown.
 */
function TokenBreakdownSection({ breakdown }: { breakdown: Array<{ phase: string; modelId?: string; label?: string; usage: TokenUsage }> }) {
  const byPhase = new Map<string, { prompt: number; completion: number; total: number; calls: number }>();
  for (const entry of breakdown) {
    const current = byPhase.get(entry.phase) ?? { prompt: 0, completion: 0, total: 0, calls: 0 };
    current.prompt += entry.usage.prompt_tokens ?? 0;
    current.completion += entry.usage.completion_tokens ?? 0;
    current.total += entry.usage.total_tokens ?? 0;
    current.calls += 1;
    byPhase.set(entry.phase, current);
  }
  const rows = [...byPhase.entries()].sort((a, b) => b[1].total - a[1].total);
  const grandTotal = rows.reduce((sum, [, v]) => sum + v.total, 0) || 1;

  return (
    <section className="resultSection">
      <h3>Desglose de tokens por paso</h3>
      <p style={{ color: "var(--muted)", margin: "-4px 0 6px", fontSize: 13 }}>
        Qué parte de la corrida consumió más — por ejemplo, el paso de votación manda la respuesta completa de cada
        modelo a cada votante, así que suele pesar más de lo que parece.
      </p>
      <div className="tokenBreakdownList">
        {rows.map(([phase, v]) => (
          <div className="tokenBreakdownRow" key={phase}>
            <span className="tokenBreakdownPhase">{phase}</span>
            <div className="tokenBreakdownBarTrack">
              <div className="tokenBreakdownBarFill" style={{ width: `${(v.total / grandTotal) * 100}%` }} />
            </div>
            <span className="tokenBreakdownValue">
              {formatTokens(v.total)} <em>({v.calls} llamada{v.calls === 1 ? "" : "s"} · {formatTokens(v.prompt)} prompt / {formatTokens(v.completion)} completion)</em>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function FusionReportSections({ report, models }: { report: FusionJudgeReport; models: RunModel[] }) {
  return (
    <>
      <section className="fusionVerdict">
        <div>
          <span>Juez de fusión</span>
          <h3>Veredicto del panel</h3>
        </div>
        <p>{report.panelVerdict}</p>
      </section>

      {report.consensus.length ? (
        <section className="resultSection">
          <h3>Dónde coinciden los modelos</h3>
          <div className="tableShell">
            <table>
              <thead>
                <tr>
                  <th>Hallazgo</th>
                  {models.map((model) => (
                    <th className="modelColumn" key={model.id}>
                      <ModelBadge model={model} small />
                    </th>
                  ))}
                  <th>Evidencia</th>
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
          <h3>Dónde discrepan los modelos</h3>
          <div className="tableShell">
            <table>
              <thead>
                <tr>
                  <th>Tema</th>
                  {models.map((model) => (
                    <th key={model.id} className="modelColumn">
                      <ModelBadge model={model} small />
                    </th>
                  ))}
                  <th>Lectura del juez</th>
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
          <h3>Hallazgos únicos</h3>
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
          <h3>Vacíos de cobertura</h3>
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
              {(modelResponses[model.id] ?? modelResponses["openai/gpt-oss-20b:free"]).map((paragraph) => (
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
  if (typeof window === "undefined") return { github: true, filesystem: false };
  try {
    const raw = window.localStorage.getItem(CONNECTORS_STORAGE_KEY);
    if (!raw) return { github: true, filesystem: false };
    const parsed = JSON.parse(raw) as Partial<ConnectorSettings>;
    return { github: parsed.github !== false, filesystem: parsed.filesystem === true };
  } catch {
    return { github: true, filesystem: false };
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
      if (isPdfFile(file)) {
        return { ...base, kind: "pdf" as const, dataUrl: await readFileAsDataUrl(file) };
      }
      if (isDocxFile(file)) {
        return { ...base, kind: "docx" as const, dataUrl: await readFileAsDataUrl(file) };
      }
      if (isTextLikeFile(file)) {
        return { ...base, kind: "text" as const, text: await readFileAsText(file) };
      }
      return { ...base, kind: "file" as const };
    }),
  );

  return attachments;
}

function isPdfFile(file: File) {
  return file.type === "application/pdf" || /\.pdf$/i.test(file.name);
}

function isDocxFile(file: File) {
  return (
    file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || /\.docx$/i.test(file.name)
  );
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
