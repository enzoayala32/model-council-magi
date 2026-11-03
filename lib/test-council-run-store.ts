/**
 * Fase 7 — tests de pricing, trazas y persistencia de corridas.
 *
 * La parte de DB corre en un cwd temporal (nunca toca `data/council.db`):
 * crea una DB "vieja" con `threads` y una fila, importa `lib/db.ts` después
 * del chdir y verifica que la migración sea aditiva (la fila sobrevive) y
 * que las tres tablas nuevas funcionen.
 *
 * Uso: npm run council:test-runs
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { estimateCostUsd, formatUsd, isFreeModelId, pricingForModel } from "./model-pricing";
import {
  buildRunTrace,
  compareCouncilRuns,
  describeEvent,
  formatDurationMs,
  renderRunMarkdown,
  usageFromUnknown,
  type CouncilRunDetail,
  type CouncilRunEvent,
  type CouncilRunRecord,
  type CouncilUsageRow,
} from "./council-run-trace";
import type { StreamEvent } from "./council-types";

const results: boolean[] = [];
function check(ok: boolean, label: string, detail?: unknown): void {
  results.push(ok);
  console.log(`${ok ? "✅" : "❌"} ${label}${ok ? "" : ` — ${JSON.stringify(detail)}`}`);
}
function checkEq(actual: unknown, expected: unknown, label: string): void {
  check(JSON.stringify(actual) === JSON.stringify(expected), label, { esperado: expected, actual });
}
function checkClose(actual: number | null, expected: number, label: string): void {
  check(actual !== null && Math.abs(actual - expected) < 1e-9, label, { esperado: expected, actual });
}

type SqliteDb = {
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    all(...params: unknown[]): Array<Record<string, unknown>>;
    get(...params: unknown[]): Record<string, unknown> | undefined;
  };
  exec(sql: string): void;
  close(): void;
};

function fakeRun(overrides: Partial<CouncilRunRecord> = {}): CouncilRunRecord {
  return {
    id: "run-a",
    threadId: "thread-1",
    turnId: "turn-1",
    question: "¿Qué es MAGI?",
    selectedModels: ["m1", "m2"],
    status: "complete",
    startedAt: 1_000,
    finishedAt: 4_000,
    promptTokens: 100,
    completionTokens: 50,
    totalTokens: 150,
    costUsd: 0.001,
    synthesis: "Síntesis",
    fusionJudge: null,
    trace: { totalMs: 3_000, phases: [], models: [], eventCount: 4 },
    createdAt: 1_000,
    ...overrides,
  };
}

function fakeEvent(seq: number, type: string, at: number, payload: Record<string, unknown> = {}): CouncilRunEvent {
  return { seq, type, at, payload };
}

function fakeUsage(overrides: Partial<CouncilUsageRow> = {}): CouncilUsageRow {
  return {
    modelId: "m1",
    label: "Modelo 1",
    phase: "draft",
    promptTokens: 100,
    completionTokens: 50,
    totalTokens: 150,
    costUsd: 0,
    calls: 1,
    latencyMs: 1_200,
    fallbacks: 0,
    retries: 0,
    ...overrides,
  };
}

async function main(): Promise<void> {
  console.log("== Fase 7 — pricing, trazas y persistencia de corridas ==\n");

  console.log("--- pricing ---");
  {
    checkEq(isFreeModelId("openai/gpt-oss-20b:free"), true, "detecta el sufijo :free");
    checkEq(isFreeModelId("gemini-2.5-flash"), false, "un modelo pago no es :free");
    checkEq(pricingForModel("openai/gpt-oss-20b:free")?.inputPerMillionUsd, 0, "un :free tiene precio 0");
    checkEq(pricingForModel("modelo-desconocido"), null, "un modelo sin tabla devuelve null (no 0)");
    const free = estimateCostUsd("openai/gpt-oss-20b:free", { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 });
    checkEq(free.costUsd, 0, "un :free cuesta 0 aunque los tokens sean enormes");
    checkEq(free.free, true, "marca free=true");
    const unknown = estimateCostUsd("modelo-desconocido", { prompt_tokens: 100 });
    checkEq(unknown.costUsd, null, "modelo desconocido: costo null");
    const gemini = estimateCostUsd("gemini-2.5-flash", { prompt_tokens: 10, completion_tokens: 5 });
    checkClose(gemini.costUsd, 0.000016, "estima Gemini 2.5 Flash con la tabla");
    checkEq(gemini.estimated, true, "el costo de tabla se marca estimated");
    checkEq(estimateCostUsd("openai/gpt-oss-20b:free", undefined).costUsd, 0, "sin usage un :free sigue costando 0");
    // Fase 1.4: los modelos sin precio público verificable devuelven null.
    // Se eliminaron las entradas "estimado sobre otro modelo".
    for (const id of ["gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3.7-flash", "gemini-3.1-pro-preview", "nvidia/nemotron-3.5-lightning-30b-a3b"]) {
      checkEq(pricingForModel(id), null, `${id} no tiene precio inventado`);
      checkEq(estimateCostUsd(id, { prompt_tokens: 1000, completion_tokens: 1000 }).costUsd, null, `${id} cuesta null (—), no 0`);
    }
    // La tarifa pública sí queda.
    checkClose(estimateCostUsd("gemini-2.5-pro", { prompt_tokens: 1000, completion_tokens: 1000 }).costUsd, 0.01125, "Gemini 2.5 Pro usa la tarifa pública");
    checkEq(pricingForModel("gemini-2.5-flash-lite") !== null, true, "Gemini 2.5 Flash-Lite conserva su precio público");
    checkEq(formatUsd(null), "—", "formatUsd(null) muestra —");
    checkEq(formatUsd(0), "USD 0", "formatUsd(0) muestra USD 0");
    checkEq(formatUsd(0.000016), "USD 0.0000", "formatUsd redondea costos chicos a 4 decimales");
  }

  console.log("\n--- trazas puras ---");
  {
    const events = [
      fakeEvent(1, "phase", 1_000, { phase: "drafting" }),
      fakeEvent(2, "model_complete", 2_000, { label: "M1" }),
      fakeEvent(3, "phase", 2_100, { phase: "debating" }),
      fakeEvent(4, "model_debate_complete", 3_500, { label: "M1", round: 1 }),
      fakeEvent(5, "run_complete", 4_000, {}),
    ];
    const usage = [
      fakeUsage({ modelId: "m1", totalTokens: 150, costUsd: 0, latencyMs: 1_000 }),
      fakeUsage({ modelId: "m1", phase: "debate r1", totalTokens: 80, costUsd: 0.0001, latencyMs: 1_400 }),
      fakeUsage({ modelId: "m2", phase: "draft", totalTokens: 40, costUsd: null, latencyMs: 900 }),
    ];
    const trace = buildRunTrace({ startedAt: 1_000, finishedAt: 4_000, events, usage });
    checkEq(trace.totalMs, 3_000, "la duración total sale de started/finished");
    checkEq(trace.phases.map((phase) => phase.phase), ["drafting", "debating"], "arma una fase por cada evento phase");
    checkEq(trace.phases[0].durationMs, 1_100, "la primera fase termina cuando arranca la siguiente");
    checkEq(trace.phases[1].durationMs, 1_900, "la última fase termina en finishedAt");
    checkEq(trace.eventCount, 5, "cuenta todos los eventos");
    const m1 = trace.models.find((model) => model.modelId === "m1");
    checkEq(m1?.totalTokens, 230, "suma tokens del mismo modelo entre fases");
    checkEq(m1?.calls, 2, "suma llamadas del mismo modelo");
    checkEq(m1?.latencyMs, 1_400, "la latencia del modelo es la máxima");
    checkClose(m1?.costUsd ?? null, 0.0001, "suma el costo de las filas del mismo modelo");
    const traceWithNull = buildRunTrace({
      startedAt: 1_000,
      finishedAt: 2_000,
      events: [],
      usage: [fakeUsage({ modelId: "m1", costUsd: null })],
    });
    checkEq(traceWithNull.models[0]?.costUsd, null, "si una fila no tiene costo, el modelo queda en null (no 0)");

    const a = fakeRun({ id: "a", totalTokens: 150, costUsd: 0.001, selectedModels: ["m1", "m2"] });
    const b = fakeRun({ id: "b", totalTokens: 90, costUsd: 0.0005, selectedModels: ["m1"], finishedAt: 3_000 });
    const comparison = compareCouncilRuns(a, b);
    checkEq(comparison.sameQuestion, true, "compara corridas con la misma pregunta");
    checkEq(comparison.deltas.totalTokens, -60, "delta de tokens B - A");
    checkEq(comparison.deltas.durationMs, -1_000, "delta de duración B - A");
    checkEq(comparison.onlyInA, ["m2"], "modelos solo en A");
    checkEq(comparison.onlyInB, [], "modelos solo en B");

    const different = compareCouncilRuns(a, fakeRun({ id: "c", question: "Otra" }));
    checkEq(different.sameQuestion, false, "detecta preguntas distintas");
    const nullCost = compareCouncilRuns(fakeRun({ costUsd: null }), b);
    checkEq(nullCost.deltas.costUsd, null, "si falta un costo, el delta es null");

    checkEq(describeEvent(fakeEvent(1, "phase", 0, { phase: "drafting" })), "Fase: drafting", "describe phase");
    checkEq(describeEvent(fakeEvent(2, "model_complete", 0, { label: "M1", viaFallbackFrom: "m2" })), "Borrador completo: M1 (vía fallback: m2)", "describe fallback");
    checkEq(describeEvent(fakeEvent(3, "vote_cast", 0, { label: "M1", votedForLabel: "M2" })), "Voto: M1 → M2", "describe voto");
    checkEq(describeEvent(fakeEvent(4, "run_complete", 0, {})), "Corrida completa", "describe run_complete");
    checkEq(describeEvent(fakeEvent(5, "tipo_raro", 0, {})), "tipo_raro", "tipo desconocido se muestra crudo");
    checkEq(formatDurationMs(500), "500 ms", "formatDurationMs en ms");
    checkEq(formatDurationMs(1_500), "1.5 s", "formatDurationMs en segundos");
    checkEq(formatDurationMs(65_000), "1 min 5 s", "formatDurationMs en minutos");
    checkEq(formatDurationMs(null), "—", "formatDurationMs null");
    checkEq(usageFromUnknown({ prompt_tokens: 3, completion_tokens: 2 }), { prompt_tokens: 3, completion_tokens: 2, total_tokens: undefined }, "usageFromUnknown acepta usage parcial");
    checkEq(usageFromUnknown({ nope: 1 }), undefined, "usageFromUnknown ignora objetos sin tokens");

    const detail: CouncilRunDetail = {
      run: fakeRun({ id: "run-md", question: "¿Pregunta?", synthesis: "Respuesta final", totalTokens: 150, costUsd: 0 }),
      usage: [fakeUsage()],
      events,
    };
    const markdown = renderRunMarkdown(detail);
    check(markdown.includes("¿Pregunta?"), "el Markdown incluye la pregunta");
    check(markdown.includes("Respuesta final"), "el Markdown incluye la síntesis");
    check(markdown.includes("## Tokens y costo por modelo"), "el Markdown incluye la tabla de tokens");
    check(markdown.includes("## Timeline"), "el Markdown incluye el timeline");
    check(markdown.includes("| Modelo | Fase | Llamadas |"), "el Markdown incluye el encabezado de la tabla");
  }

  console.log("\n--- persistencia en DB temporal ---");
  const originalCwd = process.cwd();
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "magi-council-runs-"));
  let db: SqliteDb | null = null;
  let store: typeof import("./council-run-store") | null = null;

  // `MAGI_DATA_DIR` manda sobre el cwd en `lib/db.ts`. Cuando el runner
  // (Fase 1.5) ya aisló la DB, hay que escribir la "DB vieja" en ESE
  // directorio; si no, la migración aditiva corre contra la DB del
  // usuario. Solo cuando la variable no está puesta se hace el chdir,
  // que es el mecanismo original de este test.
  const inheritedDataDir = process.env.MAGI_DATA_DIR?.trim();
  const dataRoot = inheritedDataDir ? path.resolve(inheritedDataDir) : temp;

  try {
    await fs.mkdir(path.join(dataRoot), { recursive: true });
    const legacy = new Database(path.join(dataRoot, "council.db"));
    legacy.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        favorite INTEGER NOT NULL DEFAULT 0,
        search_text TEXT NOT NULL DEFAULT '',
        data TEXT NOT NULL
      );
      INSERT INTO threads (id, title, created_at, updated_at, favorite, search_text, data)
      VALUES ('thread-legacy', 'Hilo viejo', 1, 1, 0, 'hilo viejo', '{"id":"thread-legacy","title":"Hilo viejo","createdAt":1,"updatedAt":1,"turns":[]}');
    `);
    legacy.close();
    console.log("(DB pre-existente con threads y una fila creada)\n");

    if (inheritedDataDir) {
      checkEq(path.resolve(process.env.MAGI_DATA_DIR ?? ""), path.resolve(dataRoot), "el test respeta MAGI_DATA_DIR del runner");
    } else {
      process.chdir(temp);
      checkEq(process.cwd(), temp, "el test corre en un cwd temporal");
    }

    const dbModule = (await import("./db")) as { getDb(): SqliteDb };
    db = dbModule.getDb();
    store = (await import("./council-run-store")) as typeof import("./council-run-store");

    const tableNames = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
      (row) => row.name,
    );
    check(tableNames.includes("council_runs"), "creó council_runs");
    check(tableNames.includes("council_run_usage"), "creó council_run_usage");
    check(tableNames.includes("council_run_events"), "creó council_run_events");
    const legacyRow = db.prepare("SELECT title FROM threads WHERE id = 'thread-legacy'").get() as { title: string } | undefined;
    checkEq(legacyRow?.title, "Hilo viejo", "la migración aditiva preserva los hilos existentes");
    checkEq(store.countCouncilRuns(), 0, "la DB temporal arranca sin corridas");

    const recorder = store.createCouncilRunRecorder({
      id: "run-test-1",
      threadId: "thread-legacy",
      turnId: "turn-1",
      question: "¿Qué es MAGI?",
      selectedModels: ["openai/gpt-oss-20b:free", "nvidia/nemotron-3.5-lightning-30b-a3b"],
      startedAt: 1_000,
    });
    recorder.start();
    checkEq(store.countCouncilRuns(), 1, "start inserta la corrida");
    checkEq(store.getCouncilRun("run-test-1")?.status, "running", "la corrida arranca en running");

    const send = (event: StreamEvent) => recorder.recordEvent(event);
    send({ type: "run_started", prompt: "¿Qué es MAGI?", selectedModels: ["openai/gpt-oss-20b:free"] });
    send({ type: "phase", phase: "drafting" });
    send({ type: "model_step", modelId: "openai/gpt-oss-20b:free", label: "M1", step: "Calling OpenRouter for the long-form independent answer", steps: 3, status: "thinking", phase: "drafting" });
    send({ type: "model_complete", modelId: "openai/gpt-oss-20b:free", label: "M1", content: "borrador largo ".repeat(40), steps: 9, phase: "drafting", usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } });
    send({ type: "model_step", modelId: "nvidia/nemotron-3.5-lightning-30b-a3b", label: "M2", step: "Calling OpenRouter for the long-form independent answer", steps: 3, status: "thinking", phase: "drafting" });
    send({ type: "model_step", modelId: "nvidia/nemotron-3.5-lightning-30b-a3b", label: "M2", step: "Calling OpenRouter for the long-form independent answer", steps: 4, status: "thinking", phase: "drafting" });
    send({ type: "model_complete", modelId: "nvidia/nemotron-3.5-lightning-30b-a3b", label: "M2", content: "borrador corto", steps: 10, phase: "drafting", usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 }, viaFallbackFrom: "nvidia/nemotron-3.5-lightning-30b-a3b" });
    send({ type: "phase", phase: "debating" });
    send({ type: "model_step", modelId: "openai/gpt-oss-20b:free", label: "M1", step: "Calling OpenRouter for the debate critique", steps: 12, status: "thinking", phase: "debating" });
    send({ type: "model_debate_complete", modelId: "openai/gpt-oss-20b:free", label: "M1", critique: "Crítica completa", revisedAnswer: "Respuesta revisada", steps: 15, round: 1, maxRounds: 2 });
    send({ type: "debate_round_complete", round: 1, maxRounds: 2, participantCount: 2, convergence: 0.8, converged: true });
    send({ type: "vote_cast", modelId: "openai/gpt-oss-20b:free", label: "M1", votedForModelId: "nvidia/nemotron-3.5-lightning-30b-a3b", votedForLabel: "M2", rationale: "Mejor evidencia" });
    send({ type: "fusion_judge_complete", report: { panelVerdict: "Consenso", consensus: [], contradictions: [], uniqueInsights: [], coverageGaps: [] }, usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, model: "gemini-2.5-flash" });
    send({ type: "synthesis_complete", content: "Síntesis final", usage: { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 }, model: "gemini-2.5-flash" });
    send({ type: "followups_complete", questions: ["¿Uno?", "¿Dos?"], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 }, model: "gemini-2.5-flash" });
    send({ type: "run_complete" });
    recorder.finish("complete");

    const run = store.getCouncilRun("run-test-1");
    checkEq(run?.status, "complete", "finish marca la corrida completa");
    checkEq(run?.totalTokens, 255, "suma los tokens de todas las fases");
    checkEq(run?.promptTokens, 165, "suma prompt tokens");
    checkEq(run?.completionTokens, 90, "suma completion tokens");
    // La corrida mezcla modelos con precio público (gemini-2.5-flash) y uno
    // sin tabla (el nvidia del fallback). La regla de la Fase 1.4 es: si una
    // fila no tiene precio verificable, el total es null ("—"), no un número
    // parcial que parezca real. La suma parcial verificable queda en el test
    // de la fila de usage de abajo.
    checkEq(run?.costUsd, null, "con una fila sin precio verificable el costo total es null");
    checkEq(run?.synthesis, "Síntesis final", "guarda la síntesis en la corrida");
    checkEq((run?.fusionJudge as { panelVerdict?: string } | null)?.panelVerdict, "Consenso", "guarda el reporte del juez");
    checkEq(run?.trace?.eventCount, 16, "el trace cuenta los 16 eventos");

    const detail = store.getCouncilRunDetail("run-test-1");
    checkEq(detail?.events.length, 16, "getCouncilRunDetail devuelve todos los eventos");
    checkEq(detail?.events[0].seq, 1, "los eventos arrancan en seq 1");
    checkEq(detail?.events.at(-1)?.type, "run_complete", "el último evento es run_complete");
    const draftEvent = detail?.events.find((event) => event.type === "model_complete");
    check(typeof draftEvent?.payload.contentPreview === "string", "model_complete guarda un preview");
    checkEq("content" in (draftEvent?.payload ?? {}), false, "model_complete NO guarda el contenido completo");
    const debateEvent = detail?.events.find((event) => event.type === "model_debate_complete");
    checkEq(debateEvent?.payload.critique, "Crítica completa", "el debate guarda la crítica completa para el replay");
    checkEq(debateEvent?.payload.revisedAnswer, "Respuesta revisada", "el debate guarda la respuesta revisada");

    const usage = detail?.usage ?? [];
    const freeRow = usage.find((row) => row.modelId === "openai/gpt-oss-20b:free" && row.phase === "draft");
    checkEq(freeRow?.totalTokens, 150, "usage agrupa por modelo y fase");
    checkEq(freeRow?.costUsd, 0, "un modelo :free queda en costo 0");
    checkEq(freeRow?.calls, 1, "cuenta una llamada de draft");
    check(typeof freeRow?.latencyMs === "number" && freeRow.latencyMs >= 0, "mide latencia desde el primer Calling");
    const fallbackRow = usage.find((row) => row.modelId === "nvidia/nemotron-3.5-lightning-30b-a3b" && row.phase === "draft");
    checkEq(fallbackRow?.fallbacks, 1, "marca el fallback");
    checkEq(fallbackRow?.retries, 1, "cuenta el reintento visible (segundo Calling)");
    const debateRow = usage.find((row) => row.phase === "debate r1");
    checkEq(debateRow?.label, "M1", "la fila de debate conserva el label");
    const judgeRow = usage.find((row) => row.phase === "judge");
    checkEq(judgeRow?.modelId, "gemini-2.5-flash", "la fila del juez usa el modelo real del evento");
    check(typeof judgeRow?.costUsd === "number" && judgeRow.costUsd > 0, "el juez pago tiene costo estimado > 0");
    const synthesisRow = usage.find((row) => row.phase === "synthesis");
    checkEq(synthesisRow?.modelId, "gemini-2.5-flash", "la fila de síntesis usa el modelo real del evento");

    const listed = store.listCouncilRuns({ threadId: "thread-legacy" });
    checkEq(listed.length, 1, "listCouncilRuns filtra por hilo");
    checkEq(listed[0].id, "run-test-1", "listCouncilRuns devuelve la corrida correcta");
    checkEq(store.listCouncilRuns({ threadId: "otro-hilo" }).length, 0, "listCouncilRuns no mezcla hilos");
    checkEq(store.getCouncilRunDetail("no-existe"), null, "getCouncilRunDetail devuelve null si no existe");

    const markdown = renderRunMarkdown(detail!);
    check(markdown.includes("¿Qué es MAGI?"), "el export Markdown de la corrida real incluye la pregunta");
    check(markdown.includes("Síntesis final"), "el export Markdown de la corrida real incluye la síntesis");
    check(markdown.includes("## Trazas por modelo"), "el export Markdown incluye las trazas por modelo");

    const recorder2 = store.createCouncilRunRecorder({
      id: "run-test-2",
      threadId: "thread-legacy",
      turnId: "turn-2",
      question: "¿Qué es MAGI?",
      selectedModels: ["openai/gpt-oss-20b:free"],
      startedAt: 10_000,
    });
    recorder2.start();
    recorder2.recordEvent({ type: "run_started", prompt: "¿Qué es MAGI?", selectedModels: ["openai/gpt-oss-20b:free"] });
    recorder2.recordEvent({ type: "model_complete", modelId: "openai/gpt-oss-20b:free", label: "M1", content: "ok", steps: 1, phase: "drafting", usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
    recorder2.recordEvent({ type: "run_complete" });
    recorder2.finish("complete");
    const comparison = store.compareStoredCouncilRuns("run-test-1", "run-test-2");
    checkEq(comparison?.comparison.sameQuestion, true, "compareStoredCouncilRuns detecta la misma pregunta");
    checkEq(comparison?.comparison.onlyInA, ["nvidia/nemotron-3.5-lightning-30b-a3b"], "solo en A queda el modelo que no corrió en B");
    checkEq(store.compareStoredCouncilRuns("run-test-1", "no-existe"), null, "comparar con una corrida inexistente devuelve null");

    checkEq(store.deleteCouncilRun("run-test-2"), true, "deleteCouncilRun borra una corrida existente");
    checkEq(store.deleteCouncilRun("run-test-2"), false, "deleteCouncilRun devuelve false si ya no existe");
    checkEq(store.countCouncilRuns(), 1, "quedó una sola corrida después del delete");
    checkEq(store.getCouncilRunDetail("run-test-2"), null, "la corrida borrada ya no se puede leer");

    // Best-effort: con la conexión cerrada, el recorder no debe lanzar.
    db.close();
    let tolerated = true;
    try {
      const failing = store.createCouncilRunRecorder({ id: "run-fail", question: "x", selectedModels: [] });
      failing.start();
      failing.recordEvent({ type: "run_complete" });
      failing.finish("error");
      checkEq(failing.enabled(), false, "el recorder se desactiva si la DB falla");
    } catch {
      tolerated = false;
    }
    check(tolerated, "un fallo de DB no se propaga al caller");
    db = null;
  } finally {
    try {
      db?.close();
    } catch {
      // best-effort
    }
    (globalThis as unknown as { __councilDb?: unknown }).__councilDb = undefined;
    if (!inheritedDataDir) process.chdir(originalCwd);
    await fs.rm(temp, { recursive: true, force: true }).catch(() => undefined);
    if (inheritedDataDir) await fs.rm(inheritedDataDir, { recursive: true, force: true }).catch(() => undefined);
  }

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} casos OK.`);
  if (passed !== results.length) process.exit(1);
}

main().catch((error) => {
  console.error("Error inesperado en la prueba de corridas:", error);
  process.exit(1);
});
