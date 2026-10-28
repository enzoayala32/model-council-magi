/**
 * Fase 5 — tests del orquestador del consejo con proveedor falso.
 *
 * No hay red, DB, timers reales ni HTTP: `runCouncilStream` recibe un
 * `CouncilRunDeps` completo con funciones fake y un `send` que acumula
 * eventos. Se verifica la secuencia SSE (tipos y payloads clave), los
 * caminos de error y los fallbacks.
 *
 * Uso: npm run council:test-orchestrator
 */
import type { StreamEvent } from "./council-types";
import type { CouncilRunDeps } from "./council-orchestrator";
import { runCouncilStream } from "./council-orchestrator";

const results: boolean[] = [];
function check(ok: boolean, label: string, detail?: unknown): void {
  results.push(ok);
  console.log(`${ok ? "✅" : "❌"} ${label}${ok ? "" : ` — ${JSON.stringify(detail)}`}`);
}
function checkEq(actual: unknown, expected: unknown, label: string): void {
  check(JSON.stringify(actual) === JSON.stringify(expected), label, { esperado: expected, actual });
}
function includesAll(text: string, parts: string[]): boolean {
  return parts.every((part) => text.includes(part));
}

const MODEL_A = "nvidia/nemotron-3.5-lightning:free";
const MODEL_B = "openai/gpt-oss-20b:free";
const MODEL_C = "google/gemma-4-26b-a4b-it:free";

type DraftInput = Parameters<CouncilRunDeps["runDraft"]>[0];
type DebateInput = Parameters<CouncilRunDeps["runDebate"]>[0];
type VoteInput = Parameters<CouncilRunDeps["runVoteResilient"]>[0];

function baseDeps(overrides: Partial<CouncilRunDeps> = {}): CouncilRunDeps {
  return {
    runDraft: async ({ modelId }: DraftInput) => ({ ok: true as const, modelId, label: modelId, content: modelId === MODEL_A ? "alfa alfa alfa" : "beta beta beta" }),
    runDebate: async ({ self, round }: DebateInput) => ({ ok: true as const, modelId: self.modelId, label: self.label, critique: "critique", revisedAnswer: self.modelId === MODEL_A ? `gamma${round} gamma${round} gamma${round}` : `delta${round} delta${round} delta${round}` }),
    runVoteResilient: async ({ self, send }: VoteInput) => {
      send({ type: "vote_cast", modelId: self.modelId, label: self.label, votedForModelId: self.modelId, votedForLabel: self.label, rationale: "best" });
      return { modelId: self.modelId, label: self.label, votedFor: self.modelId, rationale: "best" };
    },
    createFusionJudgeReportResilient: async () => ({
      report: {
        panelVerdict: "panel verdict",
        consensus: [{ finding: "f", models: [MODEL_A], evidence: "e" }],
        contradictions: [],
        uniqueInsights: [],
        coverageGaps: [],
      },
    }),
    createAgentCompletion: async () => ({ content: "synthesis", usage: { total_tokens: 10 } }),
    createChatCompletion: async () => ({ content: '["¿Uno?","¿Dos?"]', usage: { total_tokens: 5 } }),
    createImageGeneration: async () => ({ model: "img", content: "", images: ["data:image/png;base64,AAAA"], usage: { total_tokens: 2 } }),
    withCredentialFailover: async (_provider, _signal, attempt) => attempt("fake-key"),
    withWatchdog: async (promise) => promise,
    resolveCredentials: () => ["fake-key"],
    registerSecret: () => {},
    logStep: () => {},
    executeAgentTool: async () => ({ name: "tool", content: "ok" }),
    executeFsTool: async () => ({ name: "fs", content: "ok" }),
    isFsTool: () => false,
    newProposalGroupId: () => "group-1",
    ...overrides,
  };
}

async function run(body: Parameters<typeof runCouncilStream>[0]["body"], overrides: Partial<CouncilRunDeps> = {}, signal = new AbortController().signal) {
  const events: StreamEvent[] = [];
  const send = (event: StreamEvent) => events.push(event);
  let error: unknown = null;
  try {
    await runCouncilStream({ body, signal, send, deps: baseDeps(overrides) });
  } catch (caught) {
    error = caught;
  }
  return { events, types: events.map((event) => event.type), error };
}

function event<T extends StreamEvent["type"]>(events: StreamEvent[], type: T): Extract<StreamEvent, { type: T }> | undefined {
  return events.find((item): item is Extract<StreamEvent, { type: T }> => item.type === type);
}

async function main(): Promise<void> {
  console.log("== Fase 5 — orquestador del consejo ==\n");

  console.log("--- camino feliz: 2 modelos, 1 ronda, voto, juez, síntesis ---");
  {
    const { events, types, error } = await run({
      prompt: "¿Pregunta?",
      selectedModels: [MODEL_A, MODEL_B],
      maxDebateRounds: 1,
    });
    checkEq(error, null, "no lanza");
    checkEq(types, [
      "run_started",
      "phase",
      "phase",
      "debate_round_complete",
      "model_mind_change",
      "model_mind_change",
      "synthesis_started",
      "vote_cast",
      "vote_cast",
      "vote_tally_complete",
      "phase",
      "synthesis_started",
      "fusion_judge_complete",
      "synthesis_started",
      "synthesis_complete",
      "followups_complete",
      "phase",
      "run_complete",
    ], "emite la secuencia SSE completa en orden");

    const started = event(events, "run_started");
    checkEq(started?.prompt, "¿Pregunta?", "run_started lleva el prompt");
    checkEq(started?.selectedModels, [MODEL_A, MODEL_B], "run_started lleva los modelos normalizados");

    const phases = events.filter((item) => item.type === "phase").map((item) => item.phase);
    checkEq(phases, ["drafting", "debating", "synthesizing", "done"], "las fases van drafting → debating → synthesizing → done");

    const round = event(events, "debate_round_complete");
    checkEq(round?.round, 1, "la ronda completada es la 1");
    checkEq(round?.participantCount, 2, "participaron 2 modelos");
    checkEq(round?.converged, false, "respuestas disjuntas no convergen");

    const mindChanges = events.filter((item) => item.type === "model_mind_change");
    checkEq(mindChanges.length, 2, "un mind-change por modelo");
    check(mindChanges.every((item) => item.changed === true), "los drafts disjuntos marcan cambio de opinión", mindChanges);

    const tally = event(events, "vote_tally_complete");
    checkEq(tally?.totalVotes, 2, "se contaron 2 votos");
    checkEq(tally?.winnerModelId, MODEL_A, "en empate gana el primero de los candidatos");

    const judge = event(events, "fusion_judge_complete");
    checkEq(judge?.report.panelVerdict, "panel verdict", "el reporte del juez llega tal cual");

    const synthesis = event(events, "synthesis_complete");
    checkEq(synthesis?.content, "synthesis", "la síntesis final llega al cliente");

    const followUps = event(events, "followups_complete");
    checkEq(followUps?.questions, ["¿Uno?", "¿Dos?"], "los follow-ups se parsean del texto del modelo");
  }

  console.log("\n--- validaciones de entrada ---");
  {
    const empty = await run({ prompt: "   ", selectedModels: [MODEL_A, MODEL_B] });
    checkEq(empty.types, ["error"], "prompt vacío emite solo error");
    checkEq(event(empty.events, "error")?.error, "Enter a prompt for the council.", "mensaje de prompt vacío");

    const noKey = await run({ prompt: "q", selectedModels: [MODEL_A, MODEL_B] }, { resolveCredentials: () => [] });
    checkEq(noKey.types, ["error"], "sin credenciales emite solo error");
    check(String(event(noKey.events, "error")?.error).includes("OPENROUTER_API_KEY"), "el error nombra la variable de entorno");

    const placeholder = await run({ prompt: "q", selectedModels: [MODEL_A, MODEL_B], apiKey: "your-key-here" });
    checkEq(placeholder.types, ["error"], "key placeholder emite solo error");

    let registered: string | null = null;
    const explicit = await run(
      { prompt: "q", selectedModels: [MODEL_A, MODEL_B], apiKey: "sk-real-key" },
      { registerSecret: (value) => { registered = value; } },
    );
    checkEq(registered, "sk-real-key", "la key explícita se registra para redacción");
    checkEq(event(explicit.events, "run_started")?.selectedModels, [MODEL_A, MODEL_B], "con key explícita el run arranca");
  }

  console.log("\n--- fallos de draft ---");
  {
    const allFail = await run(
      { prompt: "q", selectedModels: [MODEL_A, MODEL_B] },
      { runDraft: async ({ modelId }: DraftInput) => ({ ok: false as const, modelId, label: modelId, content: "", error: "boom" }) },
    );
    checkEq(allFail.types, ["run_started", "phase", "error"], "si todos los drafts fallan no se abre debate");
    check(String(event(allFail.events, "error")?.error).includes("All selected models failed"), "mensaje de todos los drafts fallidos");

    const oneSurvives = await run(
      { prompt: "q", selectedModels: [MODEL_A, MODEL_B] },
      {
        runDraft: async ({ modelId }: DraftInput) =>
          modelId === MODEL_A
            ? { ok: true as const, modelId, label: modelId, content: "solo A" }
            : { ok: false as const, modelId, label: modelId, content: "", error: "boom" },
      },
    );
    checkEq(oneSurvives.events.filter((item) => item.type === "phase").map((item) => item.phase), ["drafting", "synthesizing", "done"], "con un solo draft sobreviviente no hay fase debating");
    check(!oneSurvives.types.includes("debate_round_complete"), "con un solo draft no hay ronda de debate");
    check(!oneSurvives.types.includes("vote_cast"), "con un solo draft no hay votos");
    checkEq(event(oneSurvives.events, "synthesis_complete")?.content, "synthesis", "igual llega a la síntesis");
  }

  console.log("\n--- modo adaptativo ---");
  {
    const { types } = await run(
      { prompt: "q", selectedModels: [MODEL_A, MODEL_B], adaptiveMode: true },
      {
        runDraft: async ({ modelId }: DraftInput) => ({ ok: true as const, modelId, label: modelId, content: "mismo texto exacto para ambos" }),
      },
    );
    check(types.includes("debate_skipped"), "emite debate_skipped", types);
    check(!types.includes("debate_round_complete"), "no corre rondas de debate", types);
    check(!types.includes("vote_cast"), "no pide votos si no hubo debate", types);
    checkEq(types.filter((type) => type === "phase"), ["phase", "phase", "phase"], "solo drafting, synthesizing y done");
  }

  console.log("\n--- varias rondas de debate ---");
  {
    const { types, events } = await run(
      { prompt: "q", selectedModels: [MODEL_A, MODEL_B], maxDebateRounds: 2 },
      {
        runDebate: async ({ self, round }: DebateInput) => ({
          ok: true as const,
          modelId: self.modelId,
          label: self.label,
          critique: `critique ${round}`,
          revisedAnswer: self.modelId === MODEL_A ? `gamma${round} gamma${round} gamma${round}` : `delta${round} delta${round} delta${round}`,
        }),
      },
    );
    checkEq(events.filter((item) => item.type === "phase").map((item) => item.phase), ["drafting", "debating", "debating", "synthesizing", "done"], "hay 5 eventos phase en total (2 rondas de debate)");
    checkEq(events.filter((item) => item.type === "debate_round_complete").map((item) => item.round), [1, 2], "corren 2 rondas y se reportan en orden");
    checkEq(events.filter((item) => item.type === "vote_cast").length, 2, "después de 2 rondas votan los 2 sobrevivientes");
  }

  console.log("\n--- fallback de síntesis ---");
  {
    let calls = 0;
    const fallback = await run(
      { prompt: "q", selectedModels: [MODEL_A, MODEL_B] },
      {
        createAgentCompletion: async () => {
          calls += 1;
          if (calls === 1) throw new Error("primary down");
          return { content: "synthesis desde fallback", usage: { total_tokens: 7 } };
        },
      },
    );
    checkEq(calls, 2, "la síntesis se intenta dos veces");
    check(fallback.types.includes("synthesis_complete"), "el fallback completa la síntesis", fallback.types);
    const steps = fallback.events.filter((item) => item.type === "synthesis_started").map((item) => item.step);
    check(steps.some((step) => step.includes("failed — retrying synthesis with")), "avisa el cambio de modelo de síntesis", steps);
    checkEq(event(fallback.events, "synthesis_complete")?.content, "synthesis desde fallback", "el contenido es el del fallback");

    const bothFail = await run(
      { prompt: "q", selectedModels: [MODEL_A, MODEL_B] },
      { createAgentCompletion: async () => { throw new Error("todo caído"); } },
    );
    check(bothFail.error instanceof Error && bothFail.error.message === "todo caído", "si fallan primario y fallback, el error se propaga", String(bothFail.error));
    check(!bothFail.types.includes("synthesis_complete"), "no emite síntesis completa");
  }

  console.log("\n--- juez con fallback del watchdog ---");
  {
    const { events, types } = await run(
      { prompt: "q", selectedModels: [MODEL_A, MODEL_B] },
      {
        createFusionJudgeReportResilient: async () => { throw new Error("judge down"); },
        withWatchdog: async (promise, _ms, label, fallback) => {
          try {
            return await promise;
          } catch (error) {
            if (fallback && label === "Fusion judge") return fallback();
            throw error;
          }
        },
      },
    );
    check(types.includes("fusion_judge_complete"), "el fallback del juez emite fusion_judge_complete", types);
    checkEq(event(events, "fusion_judge_complete")?.report.consensus.length, 1, "el reporte de fallback conserva el consenso de los drafts");
  }

  console.log("\n--- imagen ---");
  {
    const ok = await run(
      { prompt: "q", selectedModels: [MODEL_A, MODEL_B], imageSettings: { enabled: true } },
    );
    checkEq(ok.types.filter((type) => type.startsWith("image_")), ["image_started", "image_complete"], "imagen habilitada emite started + complete");
    checkEq(event(ok.events, "image_complete")?.images, ["data:image/png;base64,AAAA"], "las imágenes llegan al cliente");

    const failed = await run(
      { prompt: "q", selectedModels: [MODEL_A, MODEL_B], imageSettings: { enabled: true } },
      { createImageGeneration: async () => { throw new Error("image down"); } },
    );
    check(failed.types.includes("image_error"), "un fallo de imagen emite image_error", failed.types);
    check(failed.types.includes("run_complete"), "el fallo de imagen no aborta el run");
  }

  console.log("\n--- follow-ups no fatales ---");
  {
    const { events, types } = await run(
      { prompt: "q", selectedModels: [MODEL_A, MODEL_B] },
      { createChatCompletion: async () => { throw new Error("followups down"); } },
    );
    check(types.includes("followups_complete"), "igual emite followups_complete", types);
    checkEq(event(events, "followups_complete")?.questions, [], "con error devuelve lista vacía");
    check(types.includes("run_complete"), "el run termina igual");
  }

  console.log("\n--- aborto ---");
  {
    const controller = new AbortController();
    controller.abort();
    const { types } = await run({ prompt: "q", selectedModels: [MODEL_A, MODEL_B] }, {}, controller.signal);
    checkEq(types, ["run_started"], "si ya está abortado solo emite run_started y sale");
  }

  console.log("\n--- personas ---");
  {
    const { events, types } = await run({
      prompt: "q",
      selectedModels: [MODEL_A, MODEL_B, MODEL_C],
      personaPresetId: "eva",
    });
    check(types.includes("personas_assigned"), "con 3 modelos y preset emite personas_assigned", types);
    const personas = event(events, "personas_assigned");
    checkEq(personas?.personas.map((persona) => persona.key), ["melchior", "balthasar", "casper"], "asigna las tres personas MAGI en orden");

    const twoModels = await run({ prompt: "q", selectedModels: [MODEL_A, MODEL_B], personaPresetId: "eva" });
    check(!twoModels.types.includes("personas_assigned"), "con 2 modelos no asigna personas");
  }

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} casos OK.`);
  if (passed !== results.length) process.exit(1);
}

main().catch((error) => {
  console.error("Error inesperado en la prueba:", error);
  process.exit(1);
});
