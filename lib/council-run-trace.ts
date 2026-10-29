/**
 * Fase 7C/7D/7E — tipos y funciones puras de trazabilidad de una corrida.
 *
 * Este módulo NO toca SQLite ni HTTP: recibe eventos y filas de usage ya
 * persistidos y arma el timeline, las trazas por fase/modelo, la comparación
 * de dos corridas y el Markdown de export. Así se puede testear sin DB.
 */
import { formatUsd, type UsageLike } from "./model-pricing";

export type CouncilRunStatus = "running" | "complete" | "stopped" | "error";

export type CouncilRunEvent = {
  seq: number;
  type: string;
  /** epoch ms */
  at: number;
  payload: Record<string, unknown>;
};

export type CouncilUsageRow = {
  modelId: string;
  label: string;
  phase: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number | null;
  calls: number;
  latencyMs: number | null;
  fallbacks: number;
  retries: number;
};

export type CouncilRunRecord = {
  id: string;
  threadId: string | null;
  turnId: string | null;
  question: string;
  selectedModels: string[];
  status: CouncilRunStatus;
  startedAt: number;
  finishedAt: number | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number | null;
  synthesis: string | null;
  fusionJudge: unknown;
  trace: CouncilRunTrace | null;
  createdAt: number;
};

export type CouncilPhaseTrace = {
  phase: string;
  /** epoch ms */
  startedAt: number;
  endedAt: number;
  durationMs: number;
};

export type CouncilModelTrace = {
  modelId: string;
  label: string;
  calls: number;
  totalTokens: number;
  costUsd: number | null;
  latencyMs: number | null;
  fallbacks: number;
  retries: number;
};

export type CouncilRunTrace = {
  totalMs: number;
  phases: CouncilPhaseTrace[];
  models: CouncilModelTrace[];
  eventCount: number;
};

export type CouncilRunDetail = {
  run: CouncilRunRecord;
  usage: CouncilUsageRow[];
  events: CouncilRunEvent[];
};

export type RunComparison = {
  sameQuestion: boolean;
  a: {
    id: string;
    status: CouncilRunStatus;
    totalTokens: number;
    costUsd: number | null;
    durationMs: number;
    modelCount: number;
    eventCount: number;
  };
  b: {
    id: string;
    status: CouncilRunStatus;
    totalTokens: number;
    costUsd: number | null;
    durationMs: number;
    modelCount: number;
    eventCount: number;
  };
  deltas: {
    totalTokens: number;
    costUsd: number | null;
    durationMs: number;
  };
  /** Modelos que participaron en una corrida y no en la otra. */
  onlyInA: string[];
  onlyInB: string[];
};

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function buildRunTrace(input: {
  startedAt: number;
  finishedAt: number;
  events: CouncilRunEvent[];
  usage: CouncilUsageRow[];
}): CouncilRunTrace {
  const { startedAt, finishedAt, events, usage } = input;
  const phases: CouncilPhaseTrace[] = [];
  let current: { phase: string; startedAt: number } | null = null;

  for (const event of events) {
    if (event.type !== "phase") continue;
    const phase = typeof event.payload.phase === "string" ? event.payload.phase : "unknown";
    if (current) {
      phases.push({
        phase: current.phase,
        startedAt: current.startedAt,
        endedAt: event.at,
        durationMs: Math.max(0, event.at - current.startedAt),
      });
    }
    current = { phase, startedAt: event.at };
  }
  if (current) {
    const end = Math.max(finishedAt, current.startedAt);
    phases.push({ phase: current.phase, startedAt: current.startedAt, endedAt: end, durationMs: Math.max(0, end - current.startedAt) });
  }

  const byModel = new Map<string, CouncilModelTrace>();
  for (const row of usage) {
    const existing = byModel.get(row.modelId) ?? {
      modelId: row.modelId,
      label: row.label,
      calls: 0,
      totalTokens: 0,
      costUsd: 0,
      latencyMs: null,
      fallbacks: 0,
      retries: 0,
    };
    existing.calls += row.calls;
    existing.totalTokens += row.totalTokens;
    if (row.costUsd === null) existing.costUsd = null;
    else if (existing.costUsd !== null) existing.costUsd += row.costUsd;
    if (row.latencyMs !== null) existing.latencyMs = Math.max(existing.latencyMs ?? 0, row.latencyMs);
    existing.fallbacks += row.fallbacks;
    existing.retries += row.retries;
    existing.label = row.label || existing.label;
    byModel.set(row.modelId, existing);
  }

  return {
    totalMs: Math.max(0, finishedAt - startedAt),
    phases,
    models: [...byModel.values()].sort((a, b) => b.totalTokens - a.totalTokens),
    eventCount: events.length,
  };
}

function runSummary(run: CouncilRunRecord) {
  return {
    id: run.id,
    status: run.status,
    totalTokens: run.totalTokens,
    costUsd: run.costUsd,
    durationMs: run.finishedAt ? Math.max(0, run.finishedAt - run.startedAt) : 0,
    modelCount: run.selectedModels.length,
    eventCount: run.trace?.eventCount ?? 0,
  };
}

export function compareCouncilRuns(a: CouncilRunRecord, b: CouncilRunRecord): RunComparison {
  const summaryA = runSummary(a);
  const summaryB = runSummary(b);
  const onlyInA = a.selectedModels.filter((id) => !b.selectedModels.includes(id));
  const onlyInB = b.selectedModels.filter((id) => !a.selectedModels.includes(id));

  let costDelta: number | null = null;
  if (summaryA.costUsd !== null && summaryB.costUsd !== null) {
    costDelta = Math.round((summaryB.costUsd - summaryA.costUsd) * 1e6) / 1e6;
  }

  return {
    sameQuestion: a.question.trim() === b.question.trim(),
    a: summaryA,
    b: summaryB,
    deltas: {
      totalTokens: summaryB.totalTokens - summaryA.totalTokens,
      costUsd: costDelta,
      durationMs: summaryB.durationMs - summaryA.durationMs,
    },
    onlyInA,
    onlyInB,
  };
}

export function describeEvent(event: CouncilRunEvent): string {
  const p = event.payload;
  switch (event.type) {
    case "run_started":
      return `Corrida iniciada · ${num(p.selectedModels ? (p.selectedModels as unknown[]).length : 0)} modelos`;
    case "phase":
      return `Fase: ${String(p.phase ?? "?")}`;
    case "model_step":
      return `${String(p.label ?? p.modelId ?? "modelo")}: ${String(p.step ?? "")}`;
    case "model_complete":
      return `Borrador completo: ${String(p.label ?? p.modelId ?? "modelo")}${p.viaFallbackFrom ? ` (vía fallback: ${String(p.viaFallbackFrom)})` : ""}`;
    case "model_debate_complete":
      return `Debate ronda ${num(p.round)}: ${String(p.label ?? p.modelId ?? "modelo")}`;
    case "model_error":
      return `Error: ${String(p.label ?? p.modelId ?? "modelo")} — ${String(p.error ?? "")}`;
    case "debate_round_complete":
      return `Ronda ${num(p.round)} completa · convergencia ${(num(p.convergence) * 100).toFixed(0)}%`;
    case "debate_skipped":
      return `Debate salteado (adaptativo) · acuerdo ${(num(p.score) * 100).toFixed(0)}%`;
    case "vote_cast":
      return `Voto: ${String(p.label ?? p.modelId ?? "modelo")} → ${String(p.votedForLabel ?? "nadie")}`;
    case "vote_tally_complete":
      return `Recuento: ${num(p.totalVotes)} votos · gana ${String(p.winnerLabel ?? "sin ganador")}`;
    case "fusion_judge_complete":
      return "Reporte del juez de fusión listo";
    case "synthesis_started":
      return `Síntesis: ${String(p.step ?? "")}`;
    case "synthesis_complete":
      return "Síntesis completa";
    case "image_started":
      return `Imagen: ${String(p.model ?? "")}`;
    case "image_complete":
      return "Imagen generada";
    case "image_error":
      return `Error de imagen: ${String(p.error ?? "")}`;
    case "followups_complete":
      return `Follow-ups: ${num(p.questions ? (p.questions as unknown[]).length : 0)}`;
    case "model_mind_change":
      return `Cambio de opinión: ${String(p.label ?? p.modelId ?? "modelo")} (${p.changed ? "sí" : "no"})`;
    case "personas_assigned":
      return `Personas asignadas: ${String(p.presetLabel ?? p.presetId ?? "")}`;
    case "file_proposal":
      return `Propuesta de archivo: ${String((p.proposal as Record<string, unknown> | undefined)?.path ?? "")}`;
    case "run_complete":
      return "Corrida completa";
    case "error":
      return `Error de la corrida: ${String(p.error ?? "")}`;
    default:
      return event.type;
  }
}

export function formatDurationMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes} min ${rest} s`;
}

function usageTable(usage: CouncilUsageRow[]): string[] {
  const lines = [
    "| Modelo | Fase | Llamadas | Prompt | Completion | Total | Costo | Latencia | Fallbacks | Reintentos |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const row of usage) {
    lines.push(
      `| ${row.label} | ${row.phase} | ${row.calls} | ${row.promptTokens} | ${row.completionTokens} | ${row.totalTokens} | ${formatUsd(row.costUsd)} | ${formatDurationMs(row.latencyMs)} | ${row.fallbacks} | ${row.retries} |`,
    );
  }
  return lines;
}

function timeline(events: CouncilRunEvent[], startedAt: number): string[] {
  return events.map((event) => {
    const offset = Math.max(0, event.at - startedAt);
    return `- \`+${formatDurationMs(offset)}\` **${event.type}** — ${describeEvent(event)}`;
  });
}

export function renderRunMarkdown(detail: CouncilRunDetail): string {
  const { run, usage, events } = detail;
  const lines: string[] = [];
  lines.push("# Corrida del consejo", "");
  lines.push(`**Pregunta:** ${run.question || "(vacía)"}`, "");
  lines.push(
    `**Estado:** ${run.status} · **Inicio:** ${new Date(run.startedAt).toISOString()} · **Duración:** ${formatDurationMs(run.finishedAt ? run.finishedAt - run.startedAt : null)} · **Tokens:** ${run.totalTokens} · **Costo estimado:** ${formatUsd(run.costUsd)}`,
    "",
  );
  lines.push(`**Modelos:** ${run.selectedModels.join(", ") || "(ninguno)"}`, "");

  if (run.synthesis) {
    lines.push("## Respuesta sintetizada", "", run.synthesis.trim(), "");
  }

  const judge = run.fusionJudge as { panelVerdict?: string } | null;
  if (judge?.panelVerdict) {
    lines.push("## Veredicto del juez", "", judge.panelVerdict.trim(), "");
  }

  if (usage.length) {
    lines.push("## Tokens y costo por modelo", "", ...usageTable(usage), "");
  }

  if (run.trace?.phases.length) {
    lines.push("## Fases", "");
    for (const phase of run.trace.phases) {
      lines.push(`- **${phase.phase}** — ${formatDurationMs(phase.durationMs)}`);
    }
    lines.push("");
  }

  if (run.trace?.models.length) {
    lines.push("## Trazas por modelo", "");
    lines.push("| Modelo | Llamadas | Tokens | Costo | Latencia máx. | Fallbacks | Reintentos |", "|---|---:|---:|---:|---:|---:|---:|");
    for (const model of run.trace.models) {
      lines.push(
        `| ${model.label} | ${model.calls} | ${model.totalTokens} | ${formatUsd(model.costUsd)} | ${formatDurationMs(model.latencyMs)} | ${model.fallbacks} | ${model.retries} |`,
      );
    }
    lines.push("");
  }

  if (events.length) {
    lines.push("## Timeline", "", ...timeline(events, run.startedAt), "");
  }

  return lines.join("\n").trimEnd() + "\n";
}

export function usageFromUnknown(value: unknown): UsageLike | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const prompt = typeof record.prompt_tokens === "number" ? record.prompt_tokens : undefined;
  const completion = typeof record.completion_tokens === "number" ? record.completion_tokens : undefined;
  const total = typeof record.total_tokens === "number" ? record.total_tokens : undefined;
  if (prompt === undefined && completion === undefined && total === undefined) return undefined;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total };
}
