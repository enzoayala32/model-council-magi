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
  /** Ver diseño de Fase 2, sección 15 (Coding Agent Model Registry). Anota
   * si este modelo del Council está habilitado para el Coding Agent —
   * campo opcional anidado en el mismo objeto en vez de una segunda lista
   * separada, para no tener dos lugares que mantener sincronizados.
   * `reason` documenta in-line por qué sí/no, no es solo un booleano mudo. */
  codingAgent?: {
    enabled: boolean;
    reason?: string;
  };
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
    // Fase 2E: es el modelo con el que se corrieron las 5 pruebas de
    // aceptación de Fase 1.5 con éxito real (ver stress-test.ts) — el
    // único candidato "sin dudas" para habilitar de entrada.
    codingAgent: { enabled: true, reason: "Validado con las 5 pruebas de aceptación de Fase 1.5 (OpenRouter)." },
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
  // ---- NVIDIA NIM native model (not on OpenRouter) ----
  // Called directly against build.nvidia.com/integrate.api.nvidia.com (a
  // fully OpenAI-compatible endpoint, see lib/nvidia.ts) — needs
  // NVIDIA_API_KEY set in .env (an "nvapi-" key from build.nvidia.com),
  // otherwise selecting this fails with a clear error. Not defaultSelected
  // (BYOK, opt-in). Existía solo como fallback interno oculto dentro de
  // OpenRouter (lib/openrouter.ts, NVIDIA_MODEL_MAP) hasta Fase 2E — esta
  // es la primera vez que aparece como asiento propio, seleccionable, del
  // Council. Model ID tomado directo de NVIDIA_MODEL_MAP en lib/nvidia.ts
  // (NVIDIA mantiene el sufijo de tamaño de parámetros, a diferencia del
  // slug de OpenRouter).
  {
    id: "nvidia/nemotron-3.5-lightning-30b-a3b",
    label: "Nemotron 3.5 Lightning (NVIDIA directo)",
    shortName: "Lightning NIM",
    maker: "NVIDIA",
    accent: "#76b900",
    logoUrl: "",
    description: "Mismo modelo que el asiento OpenRouter de Nemotron 3.5 Lightning, pero llamado directo contra la cuota propia de NVIDIA (build.nvidia.com) en vez del pool compartido de OpenRouter — evita los 429 del pool free de OpenRouter. Requiere tu propia NVIDIA_API_KEY.",
    defaultSelected: false,
    defaultReasoningEffort: "medium",
    supportsImages: false,
    provider: "nvidia",
    codingAgent: {
      enabled: true,
      reason: "Fase 2E: habilitado para probar el dispatcher multi-proveedor del Coding Agent Model Registry contra un proveedor nativo (además de OpenRouter y Google).",
    },
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
    // after the 429/503 retry loop — Gemini 3.5 Flash-Lite es un fallback
    // de mucha menor demanda y bien establecido (confirmado GA 21/7/2026)
    // que mantiene el asiento productivo. Redirigido desde gemini-2.5-flash
    // (CONFIRMED DEAD, 404 real) el 2026-08-27.
    fallbackModelId: "gemini-3.5-flash-lite",
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
    // Redirigido de gemini-2.5-flash (CONFIRMED DEAD, ver esa entrada) a
    // gemini-3.5-flash-lite (GA oficial 21/7/2026) el 2026-08-27.
    fallbackModelId: "gemini-3.5-flash-lite",
  },
  {
    id: "gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
    shortName: "Gemini 2.5",
    maker: "Google AI Studio",
    accent: "#8ab4f8",
    logoUrl: "",
    // CONFIRMED DEAD as of 2026-08-27: 404 real ("Not Found") en una
    // corrida real del usuario. Verificado contra ai.google.dev/gemini-api
    // /docs/changelog (oficial): Gemini 2.0 Flash/Flash-Lite se dieron de
    // baja el 1/6/2026, y la línea GA vigente a esta fecha es enteramente
    // 3.x (3.5/3.6/3.7 Flash, 3.5-flash-lite GA 21/7/2026, 3.7-flash GA
    // 13/8/2026) — no hay evidencia de que 2.5-flash (texto, no confundir
    // con gemini-2.5-flash-image que recién se da de baja en oct 2026)
    // siga vigente. Kept (not defaultSelected, codingAgent disabled) por
    // compatibilidad con referencias viejas — no reactivar sin re-chequear
    // el changelog oficial primero.
    description: "Google's prior-generation Flash. NOTE: confirmed dead (404) as of 2026-08-27 — not recommended to select.",
    defaultSelected: false,
    defaultReasoningEffort: "medium",
    supportsImages: false,
    provider: "google",
    codingAgent: {
      enabled: false,
      reason: "CONFIRMED DEAD — ver comentario en la definición del modelo. No reactivar sin re-verificar contra ai.google.dev/gemini-api/docs/models primero.",
    },
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
    // Redirigido de gemini-2.5-flash (CONFIRMED DEAD, ver esa entrada) a
    // gemini-3.5-flash-lite (GA oficial 21/7/2026, confirmado vivo — ver
    // ai.google.dev/gemini-api/docs/changelog) el 2026-08-27.
    fallbackModelId: "gemini-3.5-flash-lite",
  },
  {
    id: "gemini-2.5-flash-lite",
    label: "Gemini 2.5 Flash-Lite",
    shortName: "Gemini Lite",
    maker: "Google AI Studio",
    accent: "#8ab4f8",
    logoUrl: "",
    // CONFIRMED DEAD as of 2026-08-27 — mismo motivo que gemini-2.5-flash
    // (ver esa entrada): sin evidencia de que la línea 2.5 de texto siga
    // vigente en ai.google.dev/gemini-api/docs/changelog a esta fecha. No
    // se probó en vivo esta entrada puntual (solo -flash sin -lite dio el
    // 404 real), pero comparte generación — se marca preventivamente hasta
    // confirmar lo contrario, para no repetir el mismo error de elegirla
    // como pick "seguro" del Coding Agent sin haberla probado.
    description: "Google's cheapest, fastest 2.5-gen Gemini model. NOTE: probable 404 (misma generación que gemini-2.5-flash, confirmado muerto) — no recomendado hasta re-verificar contra el changelog oficial.",
    defaultSelected: false,
    defaultReasoningEffort: "low",
    supportsImages: false,
    provider: "google",
    codingAgent: {
      enabled: false,
      reason: "Probable 404 (misma generación 2.5 que gemini-2.5-flash, CONFIRMED DEAD) — no probada en vivo todavía, deshabilitada por precaución. Ver gemini-3.5-flash-lite en su lugar.",
    },
  },
  {
    id: "gemini-3.5-flash-lite",
    label: "Gemini 3.5 Flash-Lite",
    shortName: "Gemini 3.5 Lite",
    maker: "Google AI Studio",
    accent: "#8ab4f8",
    logoUrl: "",
    // Reemplaza a gemini-2.5-flash/-lite (ambos CONFIRMED DEAD) como el
    // pick "barato y confiable" de Google — confirmado GA el 21/7/2026 vía
    // ai.google.dev/gemini-api/docs/changelog (oficial, chequeado
    // 2026-08-27): "our fastest, most cost-effective 3.5 model for
    // high-throughput execution... a low-latency, highly cost-effective
    // subagent option designed for high-volume automation".
    description: "Google's fastest, cheapest 3.5-gen Gemini model — GA oficial 21/7/2026, confirmado vigente. Reemplaza a Gemini 2.5 Flash-Lite (dado de baja) como el pick barato del roster. Called directly with your own Gemini API key.",
    defaultSelected: false,
    defaultReasoningEffort: "low",
    supportsImages: false,
    provider: "google",
    codingAgent: {
      enabled: true,
      reason: "Fase 2E: reemplaza a gemini-2.5-flash/-lite (ambos CONFIRMED DEAD tras el 404 real) como pick de Google — GA oficial confirmado el 21/7/2026, la fuente más reciente y confiable que se pudo verificar (a diferencia del comentario viejo de google-ai-studio.ts, que ya estaba desactualizado).",
    },
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

/** Ver diseño de Fase 2, sección 15. El selector de modelo del Coding
 * Agent en la UI debe llamar esta función — nunca `COUNCIL_MODELS` directo
 * — para no ofrecer modelos sin validar contra tool-calling multi-step. */
export function getCodingAgentModels(): CouncilModel[] {
  return COUNCIL_MODELS.filter((m) => m.codingAgent?.enabled === true);
}

/** El endpoint de crear `CodingTask` debe validar esto antes de aceptar la
 * task — rechaza con error claro si alguien manda un `modelId` que existe
 * en el Council pero no está habilitado para agente (cliente desactualizado
 * o llamada directa a la API). */
export function isCodingAgentEnabled(modelId: string): boolean {
  return getCouncilModel(modelId)?.codingAgent?.enabled === true;
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
