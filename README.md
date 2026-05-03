# Open Model Council

An open-source, Perplexity-style **Model Council** for the web. Ask one question and a council of frontier LLMs each writes an independent long-form answer, then **debates each other**, and finally produces a single rigorous synthesized answer with a per-model breakdown.

Built with Next.js 16 (App Router), React 19, and OpenRouter.

![Council UI](./perplexity-council-redesign.png)

---

## What it does

- **Convene a council** of frontier models (GPT-5.4, Claude Opus 4.7, Gemini 3.1 Pro, Grok 4.3 by default — all configurable).
- **Round 1 — Independent drafts.** Each model answers the same question in parallel, with no knowledge of the others. Long-form by design (~1,200–2,500 words target).
- **Round 2 — Debate.** Each model is then shown the other members' drafts and asked to: critique them per-model, name what they were wrong about themselves, defend what they still believe, and produce a revised answer. Sycophancy is explicitly prohibited.
- **Round 3 — Synthesis.** A reasoning model reconciles all drafts and debate critiques into one rigorous, in-depth answer (~1,500–3,500 words) with sections for Bottom Line, In-Depth Answer, Where the Council Agreed / Disagreed, Unique Insights, Confidence and Open Questions, and Recommended Next Steps.

You can inspect each phase in the UI — draft, debate critiques, sources, and per-model individual responses — and ask follow-up questions that carry the prior conversation as context.

---

## Highlights

- **Streaming SSE pipeline** with per-phase events (`drafting → debating → synthesizing`) and a Pro-Search-style live timeline.
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
SYNTHESIS_MODEL=openai/gpt-5.4
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
  page.tsx                       Client UI (entry, thinking, results, modals)
  globals.css                    Design system (light + dark tokens)
  api/council/stream/route.ts    SSE pipeline: drafts → debate → synthesis
  api/council/route.ts           Non-stream variant (legacy)

lib/
  models.ts                      Council roster + accents
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
                │  Phase 3: synthesis                   │
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
| `synthesis_started` / `synthesis_complete` | final answer markdown |
| `model_error` / `error` / `run_complete` | terminal events |

### Thread model

Threads and turns are stored in the browser at `localStorage["council:threads:v1"]`:

```ts
type StoredTurn = {
  id: string;
  question: string;
  synthesis: string;
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
    id: "openai/gpt-5.4",          // OpenRouter model ID
    label: "GPT-5.4 Thinking",
    shortName: "GPT",
    maker: "OpenAI",
    accent: "#2563eb",             // badge color
    description: "Strong default for synthesis...",
    defaultSelected: true,
    reasoning: "thinking",
  },
  // ...
];
```

Anything OpenRouter exposes (`provider/model`) is fair game. Up to 4 council members per run.

The synthesizer model is set via `SYNTHESIS_MODEL` in `.env` (defaults to `openai/gpt-5.4`).

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

- [ ] Real web search + citations (currently demo sources only)
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
