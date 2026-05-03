export type CouncilModel = {
  id: string;
  label: string;
  shortName: string;
  maker: string;
  accent: string;
  logoUrl: string;
  description: string;
  defaultSelected: boolean;
  reasoning?: "thinking" | "native";
};

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
    reasoning: "thinking",
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
  },
];

export function getCouncilModel(id: string) {
  return COUNCIL_MODELS.find((model) => model.id === id);
}
