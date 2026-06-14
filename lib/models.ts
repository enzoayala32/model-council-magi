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

export const COUNCIL_MODELS: CouncilModel[] = [
  {
    id: "anthropic/claude-fable-5",
    label: "Claude Fable 5",
    shortName: "Fable",
    maker: "Anthropic",
    accent: "#c2410c",
    logoUrl: "/model-logos/claude.ico",
    description: "Top-tier long-form reasoning model for careful synthesis and deep research.",
    defaultSelected: true,
    defaultReasoningEffort: "high",
    supportsImages: true,
  },
  {
    id: "openai/gpt-5.5",
    label: "GPT-5.5",
    shortName: "GPT",
    maker: "OpenAI",
    accent: "#2563eb",
    logoUrl: "/model-logos/openai.svg",
    description: "Strong default for synthesis, software, and high-context reasoning.",
    defaultSelected: true,
    defaultReasoningEffort: "high",
    supportsImages: true,
  },
  {
    id: "anthropic/claude-opus-4.8",
    label: "Claude Opus 4.8",
    shortName: "Opus",
    maker: "Anthropic",
    accent: "#c2410c",
    logoUrl: "/model-logos/claude.ico",
    description: "Careful long-form judgment, planning, and nuanced critique.",
    defaultSelected: false,
    defaultReasoningEffort: "high",
    supportsImages: true,
  },
  {
    id: "google/gemini-3.1-pro-preview",
    label: "Gemini 3.1 Pro",
    shortName: "Gemini",
    maker: "Google",
    accent: "#0f766e",
    logoUrl: "/model-logos/gemini.svg",
    description: "Broad multimodal reasoning with strong systems and research coverage.",
    defaultSelected: true,
    defaultReasoningEffort: "high",
    supportsImages: true,
  },
  {
    id: "google/gemini-3-flash",
    label: "Gemini 3 Flash",
    shortName: "Flash",
    maker: "Google",
    accent: "#0f766e",
    logoUrl: "/model-logos/gemini.svg",
    description: "Fast budget model for breadth, alternate phrasings, and cheap coverage.",
    defaultSelected: false,
    defaultReasoningEffort: "medium",
    supportsImages: true,
  },
  {
    id: "x-ai/grok-4.3",
    label: "Grok 4.3",
    shortName: "Grok",
    maker: "xAI",
    accent: "#7c3aed",
    logoUrl: "/model-logos/grok.svg",
    description: "Direct contrarian checks and fast alternate framing.",
    defaultSelected: false,
    defaultReasoningEffort: "medium",
    supportsImages: true,
  },
  {
    id: "deepseek/deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    shortName: "DeepSeek",
    maker: "DeepSeek",
    accent: "#1d4ed8",
    logoUrl: "/model-logos/deepseek.svg",
    description: "Open-weights reasoning model with strong math, code, and long-context analysis.",
    defaultSelected: false,
    defaultReasoningEffort: "high",
    supportsImages: false,
  },
  {
    id: "moonshotai/kimi-k2.6",
    label: "Kimi K2.6",
    shortName: "Kimi",
    maker: "Moonshot AI",
    accent: "#0891b2",
    logoUrl: "/model-logos/kimi.svg",
    description: "Long-context Chinese-and-English generalist with sharp summarization and retrieval.",
    defaultSelected: false,
    defaultReasoningEffort: "medium",
    supportsImages: false,
  },
  {
    id: "qwen/qwen3.7-max",
    label: "Qwen 3.7 Max",
    shortName: "Qwen",
    maker: "Alibaba",
    accent: "#9333ea",
    logoUrl: "/model-logos/qwen.svg",
    description: "Multilingual frontier model with strong tool use and coding benchmarks.",
    defaultSelected: false,
    defaultReasoningEffort: "high",
    supportsImages: false,
  },
];

export const FUSION_PANELS: FusionPanel[] = [
  {
    id: "fable-gpt-fusion",
    label: "Fable 5 + GPT-5.5",
    shortName: "Fable + GPT",
    description: "Highest-accuracy two-model panel for deep research and critical decisions.",
    modelIds: ["anthropic/claude-fable-5", "openai/gpt-5.5"],
    featured: true,
    scoreLabel: "Fable-level+",
    costLabel: "Premium",
  },
  {
    id: "frontier-trio-fusion",
    label: "Opus 4.8 + GPT-5.5 + Gemini 3.1 Pro",
    shortName: "Frontier trio",
    description: "Diverse frontier panel that trades extra cost for broader disagreement coverage.",
    modelIds: ["anthropic/claude-opus-4.8", "openai/gpt-5.5", "google/gemini-3.1-pro-preview"],
    featured: true,
    scoreLabel: "Beyond solo",
    costLabel: "High",
  },
  {
    id: "opus-gpt-fusion",
    label: "Opus 4.8 + GPT-5.5",
    shortName: "Opus + GPT",
    description: "Compact frontier panel for strong synthesis without a third parallel call.",
    modelIds: ["anthropic/claude-opus-4.8", "openai/gpt-5.5"],
    scoreLabel: "Strong",
    costLabel: "Medium-high",
  },
  {
    id: "budget-research-fusion",
    label: "Gemini 3 Flash + Kimi K2.6 + DeepSeek V4 Pro",
    shortName: "Budget research",
    description: "Lower-cost diverse panel that aims to beat many solo frontier runs.",
    modelIds: ["google/gemini-3-flash", "moonshotai/kimi-k2.6", "deepseek/deepseek-v4-pro"],
    featured: true,
    scoreLabel: "Near frontier",
    costLabel: "Budget",
  },
];

export const DEFAULT_FUSION_PANEL_ID = "fable-gpt-fusion";

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
