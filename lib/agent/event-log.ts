import crypto from "node:crypto";
import { getDb } from "../db";

/** Los 5 tipos mínimos para reconstruir el timeline completo de una task
 * sin necesitar nada más que `agent_events` (ver diseño de Fase 2, sección
 * 12). No hay un tipo por cada `stopReason` — eso vive en
 * `agent_tasks.stop_reason` y se comunica acá con un único `status_change`
 * al estado final. */
export type AgentEventType = "tool_call" | "tool_result" | "text" | "typecheck_result" | "status_change";

export type AgentEventPayload =
  | { type: "tool_call"; toolName: string; input: unknown }
  | { type: "tool_result"; toolName: string; ok: boolean; error?: string; summary: string }
  | { type: "text"; text: string }
  | { type: "typecheck_result"; success: boolean; outputExcerpt?: string }
  | { type: "status_change"; from: string; to: string; reason?: string };

export type AgentEvent = {
  id: string;
  taskId: string;
  seq: number;
  ts: number;
  type: AgentEventType;
  payload: AgentEventPayload;
};

type AgentEventRow = {
  id: string;
  task_id: string;
  seq: number;
  ts: number;
  type: string;
  payload: string;
};

function rowToEvent(row: AgentEventRow): AgentEvent {
  return {
    id: row.id,
    taskId: row.task_id,
    seq: row.seq,
    ts: row.ts,
    type: row.type as AgentEventType,
    payload: JSON.parse(row.payload) as AgentEventPayload,
  };
}

/** `seq` es incremental POR TASK, empieza en 0 — no es un autoincrement
 * global de SQLite a propósito: así el replay de SSE (Fase 2H) puede pedir
 * "eventos de esta task desde seq X" sin necesitar saber nada del resto de
 * las tasks. Calculado como MAX(seq)+1 dentro de la misma conexión — no
 * hay riesgo de carrera real porque el runner corre una sola task RUNNING
 * a la vez por proceso (ver diseño de Fase 2, sección 13). */
function nextSeq(taskId: string): number {
  const row = getDb().prepare("SELECT MAX(seq) as maxSeq FROM agent_events WHERE task_id = ?").get(taskId) as { maxSeq: number | null };
  return (row.maxSeq ?? -1) + 1;
}

export function appendEvent(taskId: string, payload: AgentEventPayload): AgentEvent {
  const event: AgentEvent = {
    id: crypto.randomUUID(),
    taskId,
    seq: nextSeq(taskId),
    ts: Date.now(),
    type: payload.type,
    payload,
  };

  getDb()
    .prepare(`INSERT INTO agent_events (id, task_id, seq, ts, type, payload) VALUES (@id, @taskId, @seq, @ts, @type, @payload)`)
    .run({
      id: event.id,
      taskId: event.taskId,
      seq: event.seq,
      ts: event.ts,
      type: event.type,
      payload: JSON.stringify(event.payload),
    });

  return event;
}

/** Lee todos los eventos de una task, en orden. `sinceSeq` (exclusive) es
 * para el replay de SSE de Fase 2H — un cliente que se reconecta a mitad de
 * una corrida pide "desde mi último seq visto" en vez de todo de nuevo. */
export function listEvents(taskId: string, opts?: { sinceSeq?: number }): AgentEvent[] {
  const sinceSeq = opts?.sinceSeq;
  const rows =
    sinceSeq === undefined
      ? (getDb().prepare("SELECT * FROM agent_events WHERE task_id = ? ORDER BY seq ASC").all(taskId) as AgentEventRow[])
      : (getDb().prepare("SELECT * FROM agent_events WHERE task_id = ? AND seq > ? ORDER BY seq ASC").all(taskId, sinceSeq) as AgentEventRow[]);
  return rows.map(rowToEvent);
}

/** Reconstruye el mismo shape de `transcript: string[]` que ya producía el
 * loop en memoria (Fase 1/1.5/2D) — para no romper nada que todavía espere
 * ese formato (ej. logs de debug, `test-run.ts`) mientras `agent_events` se
 * adopta como fuente de verdad. Puramente derivado, no se persiste. */
export function eventsToTranscript(events: AgentEvent[]): string[] {
  const lines: string[] = [];
  for (const event of events) {
    const p = event.payload;
    if (p.type === "text") lines.push(`💬 ${p.text}`);
    else if (p.type === "tool_call") lines.push(`🔧 ${p.toolName}(${JSON.stringify(p.input).slice(0, 200)})`);
    else if (p.type === "tool_result" && !p.ok) lines.push(`❌ ${p.toolName} falló: ${p.error ?? "sin detalle"}`);
    else if (p.type === "tool_result" && p.ok) lines.push(`✏️  ${p.summary}`);
    else if (p.type === "typecheck_result") {
      lines.push(p.success ? "✅ run_typecheck: compila limpio" : `❌ run_typecheck: hay errores —\n${p.outputExcerpt ?? ""}`);
    } else if (p.type === "status_change") lines.push(`↻ ${p.from} → ${p.to}${p.reason ? ` (${p.reason})` : ""}`);
  }
  return lines;
}
