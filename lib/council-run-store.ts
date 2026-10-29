/**
 * Fase 7 — persistencia de corridas del consejo.
 *
 * Tres tablas aditivas (`council_runs`, `council_run_usage`,
 * `council_run_events`) guardan el detalle de cada corrida para:
 * - tokens/costo por modelo y fase (7A),
 * - export Markdown/JSON (7B),
 * - comparación de dos corridas (7C),
 * - timeline/replay del debate (7D),
 * - latencia/fallback/reintentos por modelo (7E).
 *
 * Regla de oro: la persistencia es best-effort. Si la DB falla (schema
 * viejo, disco lleno, lock), la corrida SSE sigue igual: el recorder se
 * desactiva y solo loguea un warning. Nunca se propaga un error de DB al
 * stream.
 */
import crypto from "node:crypto";
import { getDb } from "./db";
import { estimateCostUsd } from "./model-pricing";
import {
  buildRunTrace,
  compareCouncilRuns,
  type CouncilRunDetail,
  type CouncilRunEvent,
  type CouncilRunRecord,
  type CouncilRunStatus,
  type CouncilRunTrace,
  type CouncilUsageRow,
  type RunComparison,
} from "./council-run-trace";
import { usageFromUnknown } from "./council-run-trace";
import type { StreamEvent } from "./council-types";

export type CreateCouncilRunInput = {
  id?: string;
  threadId?: string | null;
  turnId?: string | null;
  question: string;
  selectedModels: string[];
  startedAt?: number;
};

export type CouncilRunRecorder = {
  readonly runId: string;
  start(): void;
  recordEvent(event: StreamEvent): void;
  finish(status: CouncilRunStatus): void;
  enabled(): boolean;
};

type RunRow = {
  id: string;
  thread_id: string | null;
  turn_id: string | null;
  question: string;
  selected_models: string;
  status: string;
  started_at: number;
  finished_at: number | null;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost_usd: number | null;
  synthesis: string | null;
  fusion_judge: string | null;
  trace_json: string | null;
  created_at: number;
};

type UsageRow = {
  model_id: string;
  label: string;
  phase: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost_usd: number | null;
  calls: number;
  latency_ms: number | null;
  fallbacks: number;
  retries: number;
};

type UsageAccumulator = CouncilUsageRow;

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function rowToRun(row: RunRow): CouncilRunRecord {
  const selected = parseJson<string[]>(row.selected_models);
  return {
    id: row.id,
    threadId: row.thread_id,
    turnId: row.turn_id,
    question: row.question,
    selectedModels: Array.isArray(selected) ? selected : [],
    status: (row.status as CouncilRunStatus) ?? "error",
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    totalTokens: row.total_tokens,
    costUsd: row.cost_usd,
    synthesis: row.synthesis,
    fusionJudge: parseJson<unknown>(row.fusion_judge),
    trace: parseJson<CouncilRunTrace>(row.trace_json),
    createdAt: row.created_at,
  };
}

function rowToUsage(row: UsageRow): CouncilUsageRow {
  return {
    modelId: row.model_id,
    label: row.label,
    phase: row.phase,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    totalTokens: row.total_tokens,
    costUsd: row.cost_usd,
    calls: row.calls,
    latencyMs: row.latency_ms,
    fallbacks: row.fallbacks,
    retries: row.retries,
  };
}

/** Copia del evento sin contenido pesado. El debate SÍ se guarda completo
 * (es lo que alimenta el replay); el borrador y los diffs de propuestas se
 * recortan porque pueden ser enormes y no hacen falta para la traza. */
function sanitizeEvent(event: StreamEvent): Record<string, unknown> {
  const payload = { ...event } as Record<string, unknown>;
  delete payload.type;

  if (event.type === "model_complete") {
    const content = event.content ?? "";
    payload.contentChars = content.length;
    payload.contentPreview = content.slice(0, 280);
    delete payload.content;
  }
  if (event.type === "file_proposal") {
    const proposal = event.proposal;
    payload.proposal = { id: proposal.id, groupId: proposal.groupId, kind: proposal.kind, path: proposal.path };
  }
  return payload;
}

function payloadJson(event: StreamEvent): string {
  try {
    return JSON.stringify(sanitizeEvent(event));
  } catch {
    return JSON.stringify({ serializationError: true });
  }
}

function emptyUsage(modelId: string, label: string, phase: string): UsageAccumulator {
  return {
    modelId,
    label,
    phase,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    // Un modelo :free (o con precio conocido) arranca en 0; uno sin tabla
    // arranca en null para que la UI muestre "—" y no un falso USD 0.
    costUsd: estimateCostUsd(modelId, undefined).costUsd,
    calls: 0,
    latencyMs: null,
    fallbacks: 0,
    retries: 0,
  };
}

function addUsage(target: UsageAccumulator, modelId: string, usage: ReturnType<typeof usageFromUnknown>): void {
  if (!usage) return;
  const prompt = usage.prompt_tokens ?? 0;
  const completion = usage.completion_tokens ?? 0;
  const total = usage.total_tokens ?? prompt + completion;
  target.promptTokens += prompt;
  target.completionTokens += completion;
  target.totalTokens += total;
  const estimate = estimateCostUsd(modelId, { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total });
  if (estimate.costUsd === null) {
    target.costUsd = null;
  } else if (target.costUsd !== null) {
    target.costUsd = Math.round((target.costUsd + estimate.costUsd) * 1e6) / 1e6;
  }
}

/**
 * Recorder en memoria + flush a SQLite al terminar. Los eventos se insertan
 * a medida que llegan (para que un crash deje algo de traza); el usage y el
 * resumen se escriben en `finish`.
 */
class SqliteCouncilRunRecorder implements CouncilRunRecorder {
  readonly runId: string;
  private readonly threadId: string | null;
  private readonly turnId: string | null;
  private readonly question: string;
  private readonly selectedModels: string[];
  private readonly startedAt: number;
  private readonly events: CouncilRunEvent[] = [];
  private readonly usage = new Map<string, UsageAccumulator>();
  private readonly attemptStart = new Map<string, number>();
  private readonly attemptCount = new Map<string, number>();
  private seq = 0;
  private status: CouncilRunStatus = "running";
  private finishedAt: number | null = null;
  private started = false;
  private finished = false;
  private disabled = false;
  private warned = false;
  private synthesis: string | null = null;
  private fusionJudge: unknown = null;
  private lastSynthesisStartedAt: number | null = null;
  private imageStartedAt: number | null = null;

  constructor(input: CreateCouncilRunInput) {
    this.runId = input.id?.trim() || crypto.randomUUID();
    this.threadId = input.threadId ?? null;
    this.turnId = input.turnId ?? null;
    this.question = input.question;
    this.selectedModels = input.selectedModels;
    this.startedAt = input.startedAt ?? Date.now();
  }

  enabled(): boolean {
    return !this.disabled;
  }

  start(): void {
    if (this.started || this.disabled) return;
    this.started = true;
    try {
      getDb()
        .prepare(
          `INSERT INTO council_runs
             (id, thread_id, turn_id, question, selected_models, status, started_at, created_at)
           VALUES (@id, @threadId, @turnId, @question, @selectedModels, 'running', @startedAt, @createdAt)`,
        )
        .run({
          id: this.runId,
          threadId: this.threadId,
          turnId: this.turnId,
          question: this.question,
          selectedModels: JSON.stringify(this.selectedModels),
          startedAt: this.startedAt,
          createdAt: Date.now(),
        });
    } catch (error) {
      this.disable(error);
    }
  }

  recordEvent(event: StreamEvent): void {
    if (this.disabled || !this.started || this.finished) return;
    const at = Date.now();
    this.seq += 1;
    const stored: CouncilRunEvent = { seq: this.seq, type: event.type, at, payload: sanitizeEvent(event) };
    this.events.push(stored);

    try {
      getDb()
        .prepare("INSERT INTO council_run_events (run_id, seq, type, at, payload) VALUES (?, ?, ?, ?, ?)")
        .run(this.runId, stored.seq, stored.type, stored.at, payloadJson(event));
    } catch (error) {
      this.disable(error);
      return;
    }

    this.trackUsage(event, at);
  }

  finish(status: CouncilRunStatus): void {
    if (this.disabled || !this.started || this.finished) return;
    this.finished = true;
    if (this.status === "running") this.status = status;
    this.finishedAt = Date.now();
    this.persistSummary();
  }

  private trackUsage(event: StreamEvent, at: number): void {
    switch (event.type) {
      case "model_step": {
        if (!event.step.startsWith("Calling ")) return;
        const key = `${event.modelId}\u0000${event.phase}`;
        if (!this.attemptStart.has(key)) this.attemptStart.set(key, at);
        this.attemptCount.set(key, (this.attemptCount.get(key) ?? 0) + 1);
        return;
      }
      case "model_complete": {
        const seatKey = `${event.modelId}\u0000drafting`;
        const actualModelId = event.viaFallbackFrom ?? event.modelId;
        const row = this.usageFor(actualModelId, event.label, "draft");
        addUsage(row, actualModelId, usageFromUnknown(event.usage));
        row.calls += 1;
        row.fallbacks += event.viaFallbackFrom ? 1 : 0;
        row.retries += Math.max(0, (this.attemptCount.get(seatKey) ?? 1) - 1);
        row.latencyMs = this.latencySince(this.attemptStart.get(seatKey), at);
        return;
      }
      case "model_debate_complete": {
        const seatKey = `${event.modelId}\u0000debating`;
        const phase = `debate r${event.round}`;
        const row = this.usageFor(event.modelId, event.label, phase);
        addUsage(row, event.modelId, usageFromUnknown(event.usage));
        row.calls += 1;
        row.retries += Math.max(0, (this.attemptCount.get(seatKey) ?? 1) - 1);
        row.latencyMs = this.latencySince(this.attemptStart.get(seatKey), at);
        // La próxima ronda arranca de cero: si no se resetea, la latencia
        // acumularía el tiempo de todas las rondas anteriores.
        this.attemptStart.delete(seatKey);
        this.attemptCount.delete(seatKey);
        return;
      }
      case "model_error": {
        const phase = event.phase === "debating" ? "debate" : "draft";
        const key = `${event.modelId}\u0000${event.phase}`;
        const row = this.usageFor(event.modelId, event.label, phase);
        row.calls += 1;
        row.latencyMs = this.latencySince(this.attemptStart.get(key), at);
        this.attemptStart.delete(key);
        this.attemptCount.delete(key);
        return;
      }
      case "vote_cast": {
        const row = this.usageFor(event.modelId, event.label, "vote");
        addUsage(row, event.modelId, usageFromUnknown(event.usage));
        row.calls += 1;
        return;
      }
      case "fusion_judge_complete": {
        const modelId = event.model ?? "fusion-judge";
        const row = this.usageFor(modelId, "Juez de fusión", "judge");
        addUsage(row, modelId, usageFromUnknown(event.usage));
        row.calls += 1;
        row.latencyMs = this.latencySince(this.lastSynthesisStartedAt, at);
        this.fusionJudge = event.report;
        return;
      }
      case "synthesis_started": {
        this.lastSynthesisStartedAt = at;
        return;
      }
      case "synthesis_complete": {
        const modelId = event.model ?? "synthesis";
        const row = this.usageFor(modelId, "Síntesis", "synthesis");
        addUsage(row, modelId, usageFromUnknown(event.usage));
        row.calls += 1;
        row.latencyMs = this.latencySince(this.lastSynthesisStartedAt, at);
        this.synthesis = event.content;
        return;
      }
      case "image_started": {
        this.imageStartedAt = at;
        return;
      }
      case "image_complete": {
        const row = this.usageFor(event.model, `Imagen (${event.model})`, "image");
        addUsage(row, event.model, usageFromUnknown(event.usage));
        row.calls += 1;
        row.latencyMs = this.latencySince(this.imageStartedAt, at);
        this.imageStartedAt = null;
        return;
      }
      case "followups_complete": {
        if (!event.usage) return;
        const modelId = event.model ?? "followups";
        const row = this.usageFor(modelId, "Follow-ups", "followups");
        addUsage(row, modelId, usageFromUnknown(event.usage));
        row.calls += 1;
        return;
      }
      case "run_complete": {
        this.status = "complete";
        return;
      }
      case "error": {
        this.status = "error";
        return;
      }
      default:
        return;
    }
  }

  private usageFor(modelId: string, label: string, phase: string): UsageAccumulator {
    const key = `${modelId}\u0000${phase}`;
    const existing = this.usage.get(key);
    if (existing) {
      if (label) existing.label = label;
      return existing;
    }
    const row = emptyUsage(modelId, label, phase);
    this.usage.set(key, row);
    return row;
  }

  private latencySince(start: number | null | undefined, end: number): number | null {
    if (start === null || start === undefined) return null;
    return Math.max(0, end - start);
  }

  private persistSummary(): void {
    try {
      const db = getDb();
      const finishedAt = this.finishedAt ?? Date.now();
      const rows = [...this.usage.values()].sort((a, b) => b.totalTokens - a.totalTokens);
      const promptTokens = rows.reduce((sum, row) => sum + row.promptTokens, 0);
      const completionTokens = rows.reduce((sum, row) => sum + row.completionTokens, 0);
      const totalTokens = rows.reduce((sum, row) => sum + row.totalTokens, 0);
      let costUsd: number | null = rows.length ? 0 : null;
      for (const row of rows) {
        if (row.costUsd === null) {
          costUsd = null;
          break;
        }
        costUsd = Math.round(((costUsd ?? 0) + row.costUsd) * 1e6) / 1e6;
      }
      const trace = buildRunTrace({ startedAt: this.startedAt, finishedAt, events: this.events, usage: rows });

      const upsertUsage = db.prepare(
        `INSERT INTO council_run_usage
           (id, run_id, model_id, label, phase, prompt_tokens, completion_tokens, total_tokens,
            cost_usd, calls, latency_ms, fallbacks, retries)
         VALUES (@id, @runId, @modelId, @label, @phase, @promptTokens, @completionTokens, @totalTokens,
                 @costUsd, @calls, @latencyMs, @fallbacks, @retries)
         ON CONFLICT(run_id, model_id, phase) DO UPDATE SET
           label = excluded.label,
           prompt_tokens = excluded.prompt_tokens,
           completion_tokens = excluded.completion_tokens,
           total_tokens = excluded.total_tokens,
           cost_usd = excluded.cost_usd,
           calls = excluded.calls,
           latency_ms = excluded.latency_ms,
           fallbacks = excluded.fallbacks,
           retries = excluded.retries`,
      );
      const transaction = db.transaction(() => {
        for (const row of rows) {
          upsertUsage.run({
            id: crypto.randomUUID(),
            runId: this.runId,
            modelId: row.modelId,
            label: row.label,
            phase: row.phase,
            promptTokens: row.promptTokens,
            completionTokens: row.completionTokens,
            totalTokens: row.totalTokens,
            costUsd: row.costUsd,
            calls: row.calls,
            latencyMs: row.latencyMs,
            fallbacks: row.fallbacks,
            retries: row.retries,
          });
        }
        db.prepare(
          `UPDATE council_runs SET
             status = @status,
             finished_at = @finishedAt,
             prompt_tokens = @promptTokens,
             completion_tokens = @completionTokens,
             total_tokens = @totalTokens,
             cost_usd = @costUsd,
             synthesis = @synthesis,
             fusion_judge = @fusionJudge,
             trace_json = @traceJson
           WHERE id = @id`,
        ).run({
          status: this.status,
          finishedAt,
          promptTokens,
          completionTokens,
          totalTokens,
          costUsd,
          synthesis: this.synthesis,
          fusionJudge: this.fusionJudge === null ? null : JSON.stringify(this.fusionJudge),
          traceJson: JSON.stringify(trace),
          id: this.runId,
        });
      });
      transaction();
    } catch (error) {
      this.disable(error);
    }
  }

  private disable(error: unknown): void {
    this.disabled = true;
    if (this.warned) return;
    this.warned = true;
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[council-run-store] persistencia desactivada para ${this.runId}: ${message}`);
  }
}

export function createCouncilRunRecorder(input: CreateCouncilRunInput): CouncilRunRecorder {
  return new SqliteCouncilRunRecorder(input);
}

export function listCouncilRuns(opts: { threadId?: string | null; limit?: number } = {}): CouncilRunRecord[] {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
  const db = getDb();
  const rows = opts.threadId
    ? (db
        .prepare("SELECT * FROM council_runs WHERE thread_id = ? ORDER BY started_at DESC LIMIT ?")
        .all(opts.threadId, limit) as RunRow[])
    : (db.prepare("SELECT * FROM council_runs ORDER BY started_at DESC LIMIT ?").all(limit) as RunRow[]);
  return rows.map(rowToRun);
}

export function getCouncilRun(id: string): CouncilRunRecord | null {
  const row = getDb().prepare("SELECT * FROM council_runs WHERE id = ?").get(id) as RunRow | undefined;
  return row ? rowToRun(row) : null;
}

export function getCouncilRunDetail(id: string): CouncilRunDetail | null {
  const run = getCouncilRun(id);
  if (!run) return null;
  const db = getDb();
  const usageRows = db
    .prepare("SELECT * FROM council_run_usage WHERE run_id = ? ORDER BY total_tokens DESC, label ASC")
    .all(id) as UsageRow[];
  const eventRows = db
    .prepare("SELECT seq, type, at, payload FROM council_run_events WHERE run_id = ? ORDER BY seq ASC")
    .all(id) as Array<{ seq: number; type: string; at: number; payload: string }>;
  return {
    run,
    usage: usageRows.map(rowToUsage),
    events: eventRows.map((row) => ({
      seq: row.seq,
      type: row.type,
      at: row.at,
      payload: parseJson<Record<string, unknown>>(row.payload) ?? {},
    })),
  };
}

export function deleteCouncilRun(id: string): boolean {
  const db = getDb();
  const transaction = db.transaction(() => {
    db.prepare("DELETE FROM council_run_events WHERE run_id = ?").run(id);
    db.prepare("DELETE FROM council_run_usage WHERE run_id = ?").run(id);
    return db.prepare("DELETE FROM council_runs WHERE id = ?").run(id).changes > 0;
  });
  return transaction();
}

export type StoredRunComparison = {
  a: CouncilRunRecord;
  b: CouncilRunRecord;
  comparison: RunComparison;
};

export function compareStoredCouncilRuns(aId: string, bId: string): StoredRunComparison | null {
  const a = getCouncilRun(aId);
  const b = getCouncilRun(bId);
  if (!a || !b) return null;
  return { a, b, comparison: compareCouncilRuns(a, b) };
}

/** Para tests: cuenta filas sin exponer SQL. */
export function countCouncilRuns(): number {
  const row = getDb().prepare("SELECT COUNT(*) as c FROM council_runs").get() as { c: number };
  return row.c;
}
