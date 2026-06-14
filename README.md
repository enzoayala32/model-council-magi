# Open Model Council

An open-source, Perplexity-style **Model Council** for the web. Ask one question and a council of frontier LLMs each writes an independent long-form answer, then **debates each other**, and finally produces a single rigorous synthesized answer with a per-model breakdown.

Built with Next.js 16 (App Router), React 19, and OpenRouter.

<img width="2484" height="1682" alt="CleanShot 2026-05-03 at 10 34 01@2x" src="https://github.com/user-attachments/assets/40e29268-4575-471e-b4cf-d27ad569d696" />

---

## What it does

- **Run Fusion-style panels** of frontier and budget models. Default panel: **Claude Fable 5 + GPT-5.5**. Other presets include Opus 4.8 + GPT-5.5 + Gemini 3.1 Pro, Opus 4.8 + GPT-5.5, and Gemini 3 Flash + Kimi K2.6 + DeepSeek V4 Pro.
- **Round 1 — Independent drafts.** Each model answers the same question in parallel, with no knowledge of the others. Long-form by design (~1,200–2,500 words target).
- **Round 2 — Debate.** Each model is then shown the other members' drafts and asked to: critique them per-model, name what they were wrong about themselves, defend what they still believe, and produce a revised answer. Sycophancy is explicitly prohibited.
- **Round 3 — Fusion judge.** A judge model extracts consensus, contradictions, partial coverage, unique insights, and coverage gaps as structured data.
- **Round 4 — Synthesis.** A reasoning model reconciles all drafts, debate critiques, and the judge report into one rigorous, in-depth answer (~1,500–3,500 words) with sections for Bottom Line, In-Depth Answer, Where the Council Agreed / Disagreed, Unique Insights, Confidence and Open Questions, and Recommended Next Steps.

You can inspect each phase in the UI — draft, debate critiques, sources, and per-model individual responses — and ask follow-up questions that carry the prior conversation as context.

---

## Highlights

- **Streaming SSE pipeline** with per-phase events (`drafting → debating → synthesizing`) and a Pro-Search-style live timeline.
- **Fusion panel presets.** Select a whole compound model panel in one click, or pass `fusionPanelId` to the API. The server resolves the panel into concrete OpenRouter model IDs.
- **Structured Fusion results.** Every streamed run can return a `fusion_judge_complete` event with panel verdict, consensus rows, disagreement rows, unique insights, and coverage gaps.
- **Search and Council modes.** Search mode runs a single model end-to-end (radio-style picker, no debate). Council mode runs the full multi-model debate + synthesis pipeline.
- **Web grounding toggle.** A `Web` button in the composer turns on OpenRouter's web search plugin so models ground their drafts in live results and cite sources inline. Works in both Search and Council modes.
- **Agentic tool use.** Draft, debate, and synthesis calls can now use OpenRouter tool calling. The first connector is GitHub, with tools for repository search, issue/PR listing, and file inspection.
- **Agent skills.** The `Agent` settings popover lets you create skills or import a `SKILL.md`/JSON skill. Enabled skills are sent as run instructions to every council phase.
- **Separate image settings.** The `Agent → Images` panel can generate an image after the answer with a dedicated image model selector.
- **Per-model reasoning effort.** Each model exposes a `Low / Medium / High` cycler in the model picker. Effort is forwarded to OpenRouter on every draft and debate call, so you can mix a fast contrarian (Low) with deep reasoners (High) in the same council.
- **Conversational follow-ups** — each thread keeps its history; the council is told the prior question + synthesis on every follow-up so answers stay relevant to the original question.
- **Stop generation** — `AbortController` on the client is propagated to the server, which short-circuits between phases and aborts in-flight OpenRouter calls.
- **Local thread persistence** — every thread (with all turns and per-model responses) is saved to `localStorage`. Sidebar shows history; click to revisit.
- **Attachments** — upload images and text-like files (`.txt`, `.md`, `.csv`, `.json`, `.ts/tsx/js/jsx`, `.css`, `.html`, `.xml`, `.yaml`); content is included in the council's context.
- **Perplexity-inspired UI** — sticky sidebar, refined composer with mode tabs, suggestion chips, source cards, debate cards, follow-up composer, light + dark mode.
- **Configurable model roster** — drop in any OpenRouter-supported model (`lib/models.ts`).

---

## Tech stack

- **Framework:** Next.js 16 (App Router) + React 19
- **Styling:** Vanilla CSS with a Perplexity-inspired token system (light + dark)
- **Markdown:** `react-markdown` + `remark-gfm`
- **Icons:** `lucide-react`
- **LLM gateway:** [OpenRouter](https://openrouter.ai)
- **Persistence:** Browser `localStorage`

No database, no server-side state — entirely client-persisted.

---

## Quick start

### 1. Clone and install

```bash
git clone https://github.com/sanky369/open-model-council.git
cd open-model-council
npm install
```

### 2. Set your OpenRouter key

```bash
cp .env.example .env
```

Then edit `.env`:

```env
OPENROUTER_API_KEY=sk-or-...
# Optional:
OPENROUTER_SITE_URL=http://localhost:3000
OPENROUTER_APP_NAME=Open Model Council
SYNTHESIS_MODEL=openai/gpt-5.5
FUSION_JUDGE_MODEL=deepseek/deepseek-v4-pro
GITHUB_TOKEN=github_pat_... # Optional, enables private repos and higher GitHub API limits
```

Get a key at [openrouter.ai/keys](https://openrouter.ai/keys).

### 3. Run

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

---

## Architecture

```
app/
  page.tsx                       Client UI (entry, thinking, fusion panels, results, modals)
  globals.css                    Design system (light + dark tokens)
  api/council/stream/route.ts    SSE pipeline: drafts → debate → fusion judge → synthesis
  api/council/route.ts           Non-stream variant (legacy)

lib/
  models.ts                      Council roster, Fusion panel presets + accents
  openrouter.ts                  OpenRouter client (with AbortSignal support)
  threads.ts                     Thread/Turn types + localStorage I/O
```

### Council pipeline

```
                ┌─────────────────────────────────────┐
   user prompt  │  /api/council/stream  (SSE)          │
   + history    │                                      │
   ──────────►  │  Phase 1: parallel drafts            │
                │   ├─ model A  → independent answer    │
                │   ├─ model B  → independent answer    │
                │   └─ model C  → independent answer    │
                │                                      │
                │  Phase 2: debate (each sees others)   │
                │   ├─ model A  → critique + revision   │
                │   ├─ model B  → critique + revision   │
                │   └─ model C  → critique + revision   │
                │                                      │
                │  Phase 3: Fusion judge                │
                │   └─ judge → consensus, contradictions│
                │              unique insights, gaps    │
                │                                      │
                │  Phase 4: synthesis                   │
                │   └─ synthesizer → final long-form    │
                │                     answer + tables   │
                └─────────────────────────────────────┘
```

Each phase emits stream events the client uses to update the UI live:

| Event | Payload |
|---|---|
| `phase` | `drafting` \| `debating` \| `synthesizing` \| `done` |
| `model_step` | per-model activity log + step counter |
| `model_complete` | draft content for one model |
| `model_debate_complete` | critique + revised answer for one model |
| `fusion_judge_complete` | structured panel verdict, agreement/disagreement rows, unique insights, and coverage gaps |
| `synthesis_started` / `synthesis_complete` | final answer markdown |
| `model_error` / `error` / `run_complete` | terminal events |

### Thread model

Threads and turns are stored in the browser at `localStorage["council:threads:v1"]`:

```ts
type StoredTurn = {
  id: string;
  question: string;
  synthesis: string;
  fusionPanelId?: string | null;
  fusionJudge?: FusionJudgeReport | null;
  models: StoredModelTurn[];   // per-model draft + critique + revised answer
  createdAt: number;
  status: "complete" | "stopped" | "errored";
};

type StoredThread = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  turns: StoredTurn[];
};
```

The most recent 6 turns are sent as compressed history (`question`, excerpted `synthesis`) to every follow-up run, so the council stays anchored on the original question while building on prior answers.

### Stop generation

- Client wraps the `fetch` in an `AbortController`.
- The signal is forwarded into the SSE stream reader so the response stream is cancelled cleanly.
- The route handler reads `request.signal`, checks it between phases, and threads it into every `createChatCompletion` call — so any in-flight OpenRouter request is cancelled mid-stream.
- The aborted turn is persisted with `status: "stopped"`.

---

## Configuring the roster

Edit `lib/models.ts`:

```ts
export const COUNCIL_MODELS: CouncilModel[] = [
  {
    id: "openai/gpt-5.5",            // OpenRouter model ID
    label: "GPT-5.5",
    shortName: "GPT",
    maker: "OpenAI",
    accent: "#2563eb",               // badge color
    logoUrl: "/model-logos/openai.svg",
    description: "Strong default for synthesis...",
    defaultSelected: true,
    defaultReasoningEffort: "high",  // "low" | "medium" | "high"
  },
  // ...
];
```

Anything OpenRouter exposes (`provider/model`) is fair game. Up to **7** council members per run.

`defaultReasoningEffort` is the starting value for the per-model effort cycler. Users can override it per-run from the model picker; the chosen effort is forwarded to OpenRouter as `reasoning.effort` on every draft and debate request for that model.

Fusion panel presets live in `FUSION_PANELS` in the same file. Each preset is a named model list with a stable `fusionPanelId`, label, score note, and cost note.

The synthesizer model is set via `SYNTHESIS_MODEL` in `.env` (defaults to `openai/gpt-5.5`). The structured judge model is set via `FUSION_JUDGE_MODEL` (defaults to `deepseek/deepseek-v4-pro`).

### Default roster

| Model | OpenRouter ID | Default effort | Selected by default |
|---|---|---|---|
| Claude Fable 5 | `anthropic/claude-fable-5` | high | ✅ |
| GPT-5.5 | `openai/gpt-5.5` | high | ✅ |
| Claude Opus 4.8 | `anthropic/claude-opus-4.8` | high | — |
| Gemini 3.1 Pro | `google/gemini-3.1-pro-preview` | high | — |
| Gemini 3 Flash | `google/gemini-3-flash` | medium | — |
| Grok 4.3 | `x-ai/grok-4.3` | medium | — |
| DeepSeek V4 Pro | `deepseek/deepseek-v4-pro` | high | — |
| Kimi K2.6 | `moonshotai/kimi-k2.6` | medium | — |
| Qwen 3.7 Max | `qwen/qwen3.7-max` | high | — |

### Fusion panel IDs

Use these panel slugs in the UI or by sending `fusionPanelId` to `/api/council` or `/api/council/stream`:

| Panel | `fusionPanelId` | Models |
|---|---|---|
| Fable 5 + GPT-5.5 | `fable-gpt-fusion` | Claude Fable 5, GPT-5.5 |
| Frontier trio | `frontier-trio-fusion` | Opus 4.8, GPT-5.5, Gemini 3.1 Pro |
| Opus + GPT | `opus-gpt-fusion` | Opus 4.8, GPT-5.5 |
| Budget research | `budget-research-fusion` | Gemini 3 Flash, Kimi K2.6, DeepSeek V4 Pro |

Example JSON request:

```json
{
  "prompt": "Compare the best go-to-market strategy for this product",
  "fusionPanelId": "budget-research-fusion",
  "webGrounding": true
}
```

---

## Web grounding

Click the `Web` button in the composer to enable OpenRouter's web search plugin for the next run. When on:

- Each drafting model receives live web search results before answering.
- The system prompt instructs models to treat results as authoritative for time-sensitive facts and to cite sources inline as markdown links.
- Works in both Search mode (single model, grounded answer) and Council mode (every drafter grounds independently before debate and synthesis).

Implementation: the API attaches `plugins: [{ id: "web", max_results: 5 }]` to the OpenRouter request when `webGrounding: true` is sent in the request body.

## Agent tools and skills

Every streamed run now uses an agent loop around OpenRouter chat completions. If a model asks for a tool call, the server executes the tool, appends the result, and asks the model to continue. This applies to independent drafts, debate responses, and final synthesis.

Built-in tools currently include:

- `github_search_repositories`
- `github_get_file`
- `github_list_issues`

Set `GITHUB_TOKEN` to access private repositories and avoid low unauthenticated GitHub rate limits. Without a token, public GitHub lookups still work subject to GitHub's public API limits.

Skills are stored in browser `localStorage` under `council:agent-skills:v1`. Use the `Agent → Skills` panel to:

- toggle the built-in GitHub Code Investigator skill
- create a skill with name, trigger description, and instructions
- paste/import an existing `SKILL.md` or JSON skill

Enabled skills are rendered into the system prompt for all council phases.

## Image generation

Use `Agent → Images` to enable image generation for a run and choose a dedicated image model. The route calls OpenRouter chat completions with `modalities: ["image", "text"]` and stores returned image data URLs with the thread turn.

Configured image models:

| Model | OpenRouter ID |
|---|---|
| GPT-5.4 Image 2 | `openai/gpt-5.4-image-2` |
| GPT Image 1.5 | `openai/gpt-image-1.5` |
| Seedream 4.5 | `bytedance-seed/seedream-4.5` |
| Gemini 3.1 Flash Image | `google/gemini-3.1-flash-image-preview` |
| Grok Imagine Quality | `x-ai/grok-imagine-image-quality` |

---

## Reasoning effort

Every model row in the picker shows an `Effort` cycler — click to rotate through `low → medium → high`. The selection is sent to the API as `reasoningEffortByModel: Record<modelId, effort>` and forwarded to OpenRouter via the `reasoning.effort` parameter. This lets you ask, e.g., a fast `low`-effort Grok run alongside a deep `high`-effort Claude/Gemini council in the same answer.

---

## Tuning answer length

Per-call token ceilings live at the top of `app/api/council/stream/route.ts`:

```ts
const TARGET_DRAFT_TOKENS     = 9000;
const TARGET_DEBATE_TOKENS    = 6000;
const TARGET_SYNTHESIS_TOKENS = 12000;
```

The actual output length is shaped much more by the system prompts (which target 1,200–2,500 words for drafts and 1,500–3,500 for the synthesis) than by the cap. If you want shorter or longer answers, edit `COUNCIL_MEMBER_SYSTEM_PROMPT`, `DEBATE_SYSTEM_PROMPT`, and `SYNTHESIZER_SYSTEM_PROMPT` in the same file.

---

## Roadmap

- [x] Real web search + citations (via OpenRouter's web plugin — toggle in composer)
- [ ] Token usage / cost meter per run
- [ ] Export thread to markdown
- [ ] Multi-round debate (>2 rounds, with vote / convergence detection)
- [ ] Server-side persistence option (Postgres / SQLite)
- [ ] PDF and DOCX attachment extraction

---

## License

MIT. See `LICENSE` if present, otherwise treat the repo as MIT-licensed unless stated otherwise.

---

## Acknowledgements

- Inspired by Perplexity's Model Council feature.
- Powered by [OpenRouter](https://openrouter.ai) for unified access to frontier models.
