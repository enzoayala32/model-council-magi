import { Globe, Layers3, Sparkles, Telescope, TrendingUp, Upload, type LucideIcon } from "lucide-react";
import { COUNCIL_MODELS, DEFAULT_FUSION_PANEL_ID, FUSION_PANELS } from "@/lib/models";
import type { RunModel } from "./client-types";

export const DEFAULT_QUERY =
  "What were the main factors driving inflation in the United States in 2025?";

export const SUGGESTIONS: Array<{ icon: LucideIcon; label: string; query: string }> = [
  { icon: TrendingUp, label: "Comparar benchmarks de modelos de punta", query: "Comparar los últimos benchmarks de LLMs de punta en razonamiento, código y tareas multimodales." },
  { icon: Globe, label: "Motores de la inflación en EE.UU. en 2025", query: DEFAULT_QUERY },
  { icon: Telescope, label: "Riesgos de la IA agéntica en producción", query: "¿Cuáles son los mayores riesgos de desplegar sistemas de IA agéntica en producción hoy?" },
  { icon: Sparkles, label: "Buenas prácticas de RAG a gran escala", query: "¿Cuáles son las mejores prácticas actuales para construir pipelines de RAG a gran escala?" },
];

export const DEMO_SOURCES = [
  { title: "Federal Reserve Bank of Richmond — 2025 Outlook", domain: "richmondfed.org" },
  { title: "Deloitte Insights: Inflation drivers across goods and services", domain: "deloitte.com" },
  { title: "USAFacts — CPI breakdown by category", domain: "usafacts.org" },
  { title: "Brookings: Tariffs and the price level in 2025", domain: "brookings.edu" },
];

export const MENU_OPTIONS: Array<{
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
export const DEFAULT_MODEL_IDS = new Set(DEFAULT_FUSION_PANEL?.modelIds ?? COUNCIL_MODELS.filter((model) => model.defaultSelected).map((model) => model.id));

export const INITIAL_MODELS: RunModel[] = COUNCIL_MODELS.map((model) => ({
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

export const SKILLS_STORAGE_KEY = "council:agent-skills:v1";
export const CONNECTORS_STORAGE_KEY = "council:connectors:v1";
