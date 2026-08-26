export type ReasoningEffort = "low" | "medium" | "high";

export type CouncilModel = {
  id: string;
  label: string;
  shortName: string;
  maker: string;
  accent: string;
  logoUrl: string;
  description: string;
  defaultSelected: boolean;
  defaultReasoningEffort: ReasoningEffort;
  supportsImages: boolean;
  /** Which API this model is called through. Omitted/undefined = OpenRouter
   * (the default for every model above). "nvidia" = called directly against
   * NVIDIA NIM (build.nvidia.com) using NVIDIA_API_KEY — requires that env
   * var to be set, and `id` must be NVIDIA's own native model ID (NOT an
   * OpenRouter-style "provider/model:free" string). "google" = called
   * directly against Google AI Studio's Gemini API using GEMINI_API_KEY —
   * requires that env var to be set, and `id` must be Google's own native
   * model ID (e.g. "gemini-3.7-flash", not an OpenRouter-style string). */
  provider?: "openrouter" | "nvidia" | "google";
  /** If this model's draft call fails outright (all internal retries
   * exhausted), try once more with this model instead before giving up the
   * seat entirely. The seat keeps its original identity in the UI — this is
   * an invisible engine swap, not a model substitution the user has to
   * reason about. Only set where there's a real, observed failure mode to
   * guard against (see the Google entries below). */
  fallbackModelId?: string;
};

export type FusionPanel = {
  id: string;
  label: string;
  shortName: string;
  description: string;
  modelIds: string[];
  featured?: boolean;
  scoreLabel: string;
  costLabel: string;
};

export type ImageModel = {
  id: string;
  label: string;
  maker: string;
  description: string;
};

export const REASONING_EFFORTS: ReasoningEffort[] = ["low", "medium", "high"];

// Modelos gratuitos vigentes en OpenRouter (":free"). El roster de modelos
// gratis rota seguido — antes de agregar uno nuevo, confirmá que sigue
// activo en https://openrouter.ai/collections/free-models
export const COUNCIL_MODELS: CouncilModel[] = [
  {
    id: "nvidia/nemotron-3.5-lightning:free",
    label: "Nemotron 3.5 Lightning",
    shortName: "Lightning",
    maker: "NVIDIA",
    accent: "#76b900",
    logoUrl: "",
    description: "High-throughput small MoE (3B active) — the fast default for quick council rounds.",
    defaultSelected: true,
    defaultReasoningEffort: "medium",
    supportsImages: false,
  },
  {
    id: "openai/gpt-oss-20b:free",
    label: "GPT-OSS 20B",
    shortName: "GPT-OSS",
    maker: "OpenAI",
    accent: "#2563eb",
    logoUrl: "/model-logos/openai.svg",
    // CONFIRMED DEAD as of 2026-08-26: OpenRouter now 404s this slug and
    // says to use the paid "openai/gpt-oss-20b" instead — it's off the free
    // collection entirely (checked openrouter.ai/collections/free-models
    // live). No free OpenAI model currently exists on OpenRouter. Kept
    // (not defaultSelected) so old references don't break; don't re-enable
    // without re-checking the free collection first.
    description: "Open-weight OpenAI model with tool use and structured outputs. NOTE: the :free slug is currently dead on OpenRouter (404) — not recommended to select.",
    defaultSelected: false,
    defaultReasoningEffort: "medium",
    supportsImages: false,
  },
  {
    id: "google/gemma-4-26b-a4b-it:free",
    label: "Gemma 4 26B",
    shortName: "Gemma",
    maker: "Google DeepMind",
    accent: "#0f766e",
    logoUrl: "/model-logos/gemini.svg",
    // CONFIRMED DEAD as of 2026-08-26: no longer in OpenRouter's free
    // collection (checked openrouter.ai/collections/free-models live) —
    // the 429s in the 19:35 test run were the shared pool being congested
    // on its way out, not a fluke. Kept (not defaultSelected) so old
    // references don't break; don't re-enable without re-checking first.
    description: "Multimodal (text/image/video) instruction-tuned model with a 256K context window. NOTE: the :free slug appears to be off OpenRouter's free tier currently — not recommended to select.",
    defaultSelected: false,
    defaultReasoningEffort: "medium",
    supportsImages: true,
  },
  {
    id: "nvidia/nemotron-3-ultra-550b-a55b:free",
    label: "Nemotron 3 Ultra",
    shortName: "Nemotron",
    maker: "NVIDIA",
    accent: "#76b900",
    logoUrl: "",
    description: "Frontier open reasoning/orchestration MoE, 1M context. Highest quality, but noticeably slower on the free tier — opt in when you can wait.",
    defaultSelected: false,
    defaultReasoningEffort: "high",
    supportsImages: false,
  },
  {
    id: "nvidia/nemotron-3-super-120b-a12b:free",
    label: "Nemotron 3 Super",
    shortName: "Super",
    maker: "NVIDIA",
    accent: "#76b900",
    logoUrl: "",
    description: "1M-context MoE tuned for multi-agent applications and cross-document reasoning. Slower than the Nano/Lightning tiers.",
    defaultSelected: false,
    defaultReasoningEffort: "high",
    supportsImages: false,
  },
  {
    id: "poolside/laguna-s-2.1:free",
    label: "Laguna S 2.1",
    shortName: "Laguna",
    maker: "Poolside",
    accent: "#9333ea",
    logoUrl: "",
    description: "Coding-agent model, strong on terminal and SWE-style benchmarks.",
    defaultSelected: false,
    defaultReasoningEffort: "medium",
    supportsImages: false,
    // Observed live (2026-08-26 test run): this seat hit OpenRouter's shared
    // free-pool 429 three times in a row with no success. Laguna XS is the
    // same vendor's lighter model — not a different pool, but worth a shot
    // before giving up the seat entirely.
    fallbackModelId: "poolside/laguna-xs-2.1:free",
  },
  {
    id: "cohere/north-mini-code:free",
    label: "North Mini Code",
    shortName: "North",
    maker: "Cohere",
    accent: "#d97706",
    logoUrl: "",
    description: "Agentic coding model with interleaved reasoning and JSON-schema tool use.",
    defaultSelected: false,
    defaultReasoningEffort: "medium",
    supportsImages: false,
  },
  {
    id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
    label: "Nemotron 3 Nano Omni",
    shortName: "Omni",
    maker: "NVIDIA",
    accent: "#76b900",
    logoUrl: "",
    description: "Multimodal (text/image/video/audio) reasoning model for perception-heavy prompts.",
    defaultSelected: false,
    defaultReasoningEffort: "medium",
    supportsImages: true,
  },
  {
    id: "poolside/laguna-xs-2.1:free",
    label: "Laguna XS 2.1",
    shortName: "Laguna XS",
    maker: "Poolside",
    accent: "#a855f7",
    logoUrl: "",
    description: "Lighter/faster sibling of Laguna S 2.1 (33B-A3B) for local, long-horizon agentic coding and terminal tasks. Confirmed live and free on OpenRouter as of Aug 2026.",
    defaultSelected: false,
    defaultReasoningEffort: "medium",
    supportsImages: false,
    fallbackModelId: "cohere/north-mini-code:free",
  },
  {
    id: "z-ai/glm-5.2:free",
    label: "GLM-5.2",
    shortName: "GLM",
    maker: "Z.ai",
    accent: "#7c5cff",
    logoUrl: "",
    description: "Zhipu AI's flagship agentic/long-horizon reasoning model, 1M context. Confirmed live and free directly on OpenRouter as of Aug 2026 — a genuinely different vendor/perspective from the rest of the panel. (Previously wired as an NVIDIA NIM native call under the ID \"z-ai/glm-5.2\", but NVIDIA's own catalog only has the older \"z-ai/glm5\" — that mismatch meant every call would have 404'd; moved to OpenRouter's confirmed-working free slug instead.)",
    defaultSelected: false,
    defaultReasoningEffort: "high",
    supportsImages: false,
  },
  {
    id: "minimax/minimax-m3:free",
    label: "MiniMax M3",
    shortName: "MiniMax M3",
    maker: "MiniMax",
    accent: "#f97316",
    logoUrl: "",
    description: "Multimodal (text/image/video) foundation model, 1M context, built for long-horizon agentic work, coding, and tool use. Confirmed live and free on OpenRouter as of Aug 2026.",
    defaultSelected: false,
    defaultReasoningEffort: "medium",
    supportsImages: true,
  },
  {
    id: "minimax/minimax-m2.7:free",
    label: "MiniMax M2.7",
    shortName: "MiniMax M2.7",
    maker: "MiniMax",
    accent: "#fb923c",
    logoUrl: "",
    description: "Next-gen agentic model tuned for autonomous multi-step productivity work (debugging, financial modeling, document generation). Confirmed live and free on OpenRouter as of Aug 2026.",
    defaultSelected: false,
    defaultReasoningEffort: "high",
    supportsImages: false,
  },
  {
    id: "thinkingmachines/inkling:free",
    label: "Inkling",
    shortName: "Inkling",
    maker: "Thinking Machines Lab",
    accent: "#14b8a6",
    logoUrl: "",
    description: "Multimodal MoE (975B total / 41B active) for general reasoning, coding, agentic and tool-use systems, RAG, and multilingual conversation. Confirmed live and free on OpenRouter as of Aug 2026.",
    defaultSelected: false,
    defaultReasoningEffort: "medium",
    supportsImages: true,
    fallbackModelId: "thinkingmachines/inkling-small:free",
  },
  {
    id: "thinkingmachines/inkling-small:free",
    label: "Inkling Small",
    shortName: "Inkling S",
    maker: "Thinking Machines Lab",
    accent: "#2dd4bf",
    logoUrl: "",
    description: "Smaller, more efficient sibling of Inkling (276B total / 12B active) — same use cases, faster/cheaper. Confirmed live and free on OpenRouter as of Aug 2026.",
    defaultSelected: false,
    defaultReasoningEffort: "medium",
    supportsImages: true,
  },
  {
    id: "liquid/lfm-2.5-2.6b:free",
    label: "LFM2.5 2.6B",
    shortName: "LFM2.5",
    maker: "Liquid AI",
    accent: "#84cc16",
    logoUrl: "",
    description: "Small, fast compact reasoning model for agent workflows, data extraction, RAG, and long-context processing. Liquid advises against agentic-coding/knowledge-heavy tasks. Confirmed live and free on OpenRouter as of Aug 2026 — a good quick fallback seat.",
    defaultSelected: false,
    defaultReasoningEffort: "low",
    supportsImages: false,
  },
  {
    id: "dots-studio/dots-3-note-preview:free",
    label: "Dots3 Note",
    shortName: "Dots3",
    maker: "Dots Studio",
    accent: "#eab308",
    logoUrl: "",
    description: "Lightest model in the Dots 3 MoE family (280B total / 16B active) — reasoning, coding, multimodal understanding, long-context, multi-step agent workflows. Confirmed live and free on OpenRouter as of Aug 2026.",
    defaultSelected: false,
    defaultReasoningEffort: "medium",
    supportsImages: true,
  },
  // ---- Google AI Studio native models (not on OpenRouter) ----
  // Called directly via generativelanguage.googleapis.com (Google's own
  // documented OpenAI-compatibility endpoint) — needs GEMINI_API_KEY set in
  // .env, otherwise selecting these will fail with a clear
  // "GEMINI_API_KEY is not configured" error. Not defaultSelected since the
  // key is opt-in and BYOK (bring-your-own — this is Google's own paid API,
  // billed to whoever's key is configured, though it does include a
  // rate-limited free tier). Model IDs verified against ai.google.dev in
  // August 2026 — Google's lineup moves fast; if a call 404s, check
  // ai.google.dev/gemini-api/docs/models for the current slug.
  {
    id: "gemini-3.7-flash",
    label: "Gemini 3.7 Flash",
    shortName: "Gemini Flash",
    maker: "Google AI Studio",
    accent: "#4285f4",
    logoUrl: "",
    description: "Google's newest GA workhorse (Aug 2026) — strong coding/agentic performance, 1M token context, tunable thinking levels. Called directly with your own Gemini API key, not through OpenRouter.",
    defaultSelected: false,
    defaultReasoningEffort: "medium",
    supportsImages: false,
    provider: "google",
    // Observed live: transient 503 "high demand" on this newest model even
    // after the 429/503 retry loop — 2.5 Flash is a much lower-demand,
    // well-established fallback that keeps the seat productive.
    fallbackModelId: "gemini-2.5-flash",
  },
  {
    id: "gemini-3.5-flash",
    label: "Gemini 3.5 Flash",
    shortName: "Gemini 3.5",
    maker: "Google AI Studio",
    accent: "#669df6",
    logoUrl: "",
    description: "Google's prior-gen Flash (GA, May 2026) — still live and solid for sustained agentic/coding work, one step behind 3.7 Flash. Called directly with your own Gemini API key.",
    defaultSelected: false,
    defaultReasoningEffort: "medium",
    supportsImages: false,
    provider: "google",
    fallbackModelId: "gemini-2.5-flash",
  },
  {
    id: "gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
    shortName: "Gemini 2.5",
    maker: "Google AI Studio",
    accent: "#8ab4f8",
    logoUrl: "",
    description: "Google's proven prior-generation Flash — cheaper than the Gemini 3 line and a reliable free-tier fallback if 3.x quota is tight. Called directly with your own Gemini API key.",
    defaultSelected: false,
    defaultReasoningEffort: "medium",
    supportsImages: false,
    provider: "google",
  },
  {
    id: "gemini-3.1-pro-preview",
    label: "Gemini 3.1 Pro",
    shortName: "Gemini Pro",
    maker: "Google AI Studio",
    accent: "#1a73e8",
    logoUrl: "",
    description: "Google's flagship reasoning model — 2M token context, the deepest thinking in the Gemini 3 line. Confirmed live: this model has ZERO free-tier quota on Google AI Studio (limit: 0) — it requires a Google Cloud project with billing enabled, unlike Flash/Flash-Lite below. Called directly with your own Gemini API key.",
    defaultSelected: false,
    defaultReasoningEffort: "high",
    supportsImages: false,
    provider: "google",
    // Observed live: "limit: 0" on the free tier — this model simply can't
    // run without billing enabled. Falls back to 2.5 Flash instead of
    // losing the seat outright.
    fallbackModelId: "gemini-2.5-flash",
  },
  {
    id: "gemini-2.5-flash-lite",
    label: "Gemini 2.5 Flash-Lite",
    shortName: "Gemini Lite",
    maker: "Google AI Studio",
    accent: "#8ab4f8",
    logoUrl: "",
    description: "Google's cheapest, fastest Gemini model and historically the most generous free-tier daily quota — a good budget pick for quick council rounds. Called directly with your own Gemini API key.",
    defaultSelected: false,
    defaultReasoningEffort: "low",
    supportsImages: false,
    provider: "google",
  },
];

export const FUSION_PANELS: FusionPanel[] = [
  {
    id: "lightning-glm-fusion",
    label: "Lightning + GLM-5.2",
    shortName: "Lightning + GLM",
    // Was "Lightning + GPT-OSS 20B" — openai/gpt-oss-20b:free 404s as of
    // 2026-08-26 (off OpenRouter's free collection). Swapped for GLM-5.2,
    // confirmed live/free, and still a different vendor from Lightning.
    description: "Fast free two-model panel for quick council rounds without a long wait.",
    modelIds: ["nvidia/nemotron-3.5-lightning:free", "z-ai/glm-5.2:free"],
    featured: true,
    scoreLabel: "Fast",
    costLabel: "$0",
  },
  {
    id: "free-trio-fusion",
    label: "Lightning + GLM + MiniMax M3",
    shortName: "Free trio",
    // Was "Lightning + GPT-OSS + Gemma 4" — both gpt-oss-20b:free and
    // gemma-4-26b-a4b-it:free 404/were pulled from OpenRouter's free tier
    // as of 2026-08-26. Swapped for two confirmed-live free models from
    // different vendors (Z.ai, MiniMax) to keep the multi-provider spread.
    description: "Diverse three-provider free panel — broader disagreement coverage, still fast.",
    modelIds: ["nvidia/nemotron-3.5-lightning:free", "z-ai/glm-5.2:free", "minimax/minimax-m3:free"],
    featured: true,
    scoreLabel: "Broad coverage",
    costLabel: "$0",
  },
  {
    id: "deep-research-fusion",
    label: "Nemotron 3 Ultra + Nemotron 3 Super",
    shortName: "Deep research",
    description: "Highest-accuracy free panel using the two largest Nemotron models. Noticeably slower on the free tier — expect several minutes.",
    modelIds: ["nvidia/nemotron-3-ultra-550b-a55b:free", "nvidia/nemotron-3-super-120b-a12b:free"],
    scoreLabel: "Highest quality, slow",
    costLabel: "$0",
  },
  {
    id: "budget-coding-fusion",
    label: "Laguna S 2.1 + North Mini Code + Nemotron Nano Omni",
    shortName: "Budget coding",
    description: "Lightweight, fast free panel aimed at coding and multimodal edge cases.",
    modelIds: ["poolside/laguna-s-2.1:free", "cohere/north-mini-code:free", "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free"],
    featured: true,
    scoreLabel: "Fast",
    costLabel: "$0",
  },
];

export const DEFAULT_FUSION_PANEL_ID = "lightning-glm-fusion";

export const IMAGE_MODELS: ImageModel[] = [
  {
    id: "openai/gpt-5.4-image-2",
    label: "GPT-5.4 Image 2",
    maker: "OpenAI",
    description: "High-quality instruction-following image generation.",
  },
  {
    id: "openai/gpt-image-1.5",
    label: "GPT Image 1.5",
    maker: "OpenAI",
    description: "General image generation and editing-capable image model.",
  },
  {
    id: "bytedance-seed/seedream-4.5",
    label: "Seedream 4.5",
    maker: "ByteDance Seed",
    description: "Cinematic and design-forward image generation.",
  },
  {
    id: "google/gemini-3.1-flash-image-preview",
    label: "Gemini 3.1 Flash Image",
    maker: "Google",
    description: "Fast multimodal image generation with text grounding.",
  },
  {
    id: "x-ai/grok-imagine-image-quality",
    label: "Grok Imagine Quality",
    maker: "xAI",
    description: "Quality-focused creative image generation.",
  },
];

export function getCouncilModel(id: string) {
  return COUNCIL_MODELS.find((model) => model.id === id);
}

export function getFusionPanel(id: string) {
  return FUSION_PANELS.find((panel) => panel.id === id);
}

export function getImageModel(id: string) {
  return IMAGE_MODELS.find((model) => model.id === id);
}

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return value === "low" || value === "medium" || value === "high";
}
