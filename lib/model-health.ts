/**
 * In-memory model health tracker — no DB, just a rolling window per model
 * kept in the Node process running `next dev`/`next start`. Resets on
 * server restart, which is fine: this is meant to answer "has this model
 * been flaky in my last few runs", not to be a durable analytics log.
 */

const WINDOW_SIZE = 8;

type Outcome = { ts: number; ok: boolean; reason?: string };

const history = new Map<string, Outcome[]>();

export function recordModelOutcome(modelId: string, ok: boolean, reason?: string) {
  const entries = history.get(modelId) ?? [];
  entries.push({ ts: Date.now(), ok, reason: ok ? undefined : reason });
  if (entries.length > WINDOW_SIZE) entries.shift();
  history.set(modelId, entries);
}

export type ModelHealthSnapshot = {
  modelId: string;
  attempts: number;
  failures: number;
  lastFailureReason?: string;
  lastOk: boolean;
};

export function getModelHealthSnapshot(): ModelHealthSnapshot[] {
  const out: ModelHealthSnapshot[] = [];
  for (const [modelId, entries] of history) {
    if (!entries.length) continue;
    const failures = entries.filter((e) => !e.ok).length;
    const lastFailure = [...entries].reverse().find((e) => !e.ok);
    out.push({
      modelId,
      attempts: entries.length,
      failures,
      lastFailureReason: lastFailure?.reason,
      lastOk: entries[entries.length - 1].ok,
    });
  }
  return out;
}
