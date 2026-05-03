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
};

export const REASONING_EFFORTS: ReasoningEffort[] = ["low", "medium", "high"];

export const COUNCIL_MODELS: CouncilModel[] = [
  {
    id: "openai/gpt-5.4",
    label: "GPT-5.4 Thinking",
    shortName: "GPT",
    maker: "OpenAI",
    accent: "#2563eb",
    logoUrl: "/model-logos/openai.svg",
    description: "Strong default for synthesis, software, and high-context reasoning.",
    defaultSelected: true,
    defaultReasoningEffort: "high",
  },
  {
    id: "anthropic/claude-opus-4.7",
    label: "Claude Opus 4.7",
    shortName: "Claude",
    maker: "Anthropic",
    accent: "#c2410c",
    logoUrl: "/model-logos/claude.ico",
    description: "Careful long-form judgment, planning, and nuanced critique.",
    defaultSelected: true,
    defaultReasoningEffort: "high",
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
  },
  {
    id: "deepseek/deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    shortName: "DeepSeek",
    maker: "DeepSeek",
    accent: "#1d4ed8",
    logoUrl: "",
    description: "Open-weights reasoning model with strong math, code, and long-context analysis.",
    defaultSelected: false,
    defaultReasoningEffort: "high",
  },
  {
    id: "moonshotai/kimi-k2.6",
    label: "Kimi K2.6",
    shortName: "Kimi",
    maker: "Moonshot AI",
    accent: "#0891b2",
    logoUrl: "",
    description: "Long-context Chinese-and-English generalist with sharp summarization and retrieval.",
    defaultSelected: false,
    defaultReasoningEffort: "medium",
  },
  {
    id: "qwen/qwen3.6-max-preview",
    label: "Qwen 3.6 Max Preview",
    shortName: "Qwen",
    maker: "Alibaba",
    accent: "#9333ea",
    logoUrl: "",
    description: "Multilingual frontier model with strong tool use and coding benchmarks.",
    defaultSelected: false,
    defaultReasoningEffort: "high",
  },
];

export function getCouncilModel(id: string) {
  return COUNCIL_MODELS.find((model) => model.id === id);
}

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return value === "low" || value === "medium" || value === "high";
}
