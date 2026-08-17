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
   * OpenRouter-style "provider/model:free" string). */
  provider?: "openrouter" | "nvidia";
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
    description: "Open-weight OpenAI model with tool use and structured outputs — strong default all-rounder.",
    defaultSelected: true,
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
    description: "Multimodal (text/image/video) instruction-tuned model with a 256K context window.",
    defaultSelected: true,
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
  // ---- NVIDIA NIM native models (not on OpenRouter) ----
  // Called directly via build.nvidia.com, not through OpenRouter — needs
  // NVIDIA_API_KEY set in .env, otherwise selecting these will fail with a
  // clear "NVIDIA_API_KEY is not configured" error. Not defaultSelected
  // since the key is opt-in.
  {
    id: "meta/llama-3.1-8b-instruct",
    label: "Llama 3.1 8B",
    shortName: "Llama",
    maker: "Meta (via NVIDIA NIM)",
    accent: "#0866ff",
    logoUrl: "",
    description: "Meta's Llama 3.1 8B Instruct, called directly through NVIDIA NIM — a separate free quota from OpenRouter's shared pool. Smaller/faster than the 70B variant, picked after 3.3-70B consistently timed out on NVIDIA's free endpoint (likely capacity congestion on the larger model).",
    defaultSelected: false,
    defaultReasoningEffort: "medium",
    supportsImages: false,
    provider: "nvidia",
  },
  {
    id: "z-ai/glm-5.2",
    label: "GLM-5.2",
    shortName: "GLM",
    maker: "Z.ai (via NVIDIA NIM)",
    accent: "#7c5cff",
    logoUrl: "",
    description: "Zhipu AI's flagship agentic/long-horizon reasoning model, called directly through NVIDIA NIM — a genuinely different vendor/perspective from the rest of the panel.",
    defaultSelected: false,
    defaultReasoningEffort: "high",
    supportsImages: false,
    provider: "nvidia",
  },
];

export const FUSION_PANELS: FusionPanel[] = [
  {
    id: "lightning-gptoss-fusion",
    label: "Lightning + GPT-OSS 20B",
    shortName: "Lightning + GPT-OSS",
    description: "Fast free two-model panel for quick council rounds without a long wait.",
    modelIds: ["nvidia/nemotron-3.5-lightning:free", "openai/gpt-oss-20b:free"],
    featured: true,
    scoreLabel: "Fast",
    costLabel: "$0",
  },
  {
    id: "free-trio-fusion",
    label: "Lightning + GPT-OSS + Gemma 4",
    shortName: "Free trio",
    description: "Diverse three-provider free panel — broader disagreement coverage, still fast.",
    modelIds: ["nvidia/nemotron-3.5-lightning:free", "openai/gpt-oss-20b:free", "google/gemma-4-26b-a4b-it:free"],
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

export const DEFAULT_FUSION_PANEL_ID = "lightning-gptoss-fusion";

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
