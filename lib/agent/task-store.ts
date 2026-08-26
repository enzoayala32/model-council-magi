import crypto from "node:crypto";
import { getDb } from "../db";

/**
 * Máquina de estados cerrada en el diseño de Fase 2 (sección 8). Notas
 * respecto a la primera lista que se barajó:
 * - No existe un estado `COMPLETED` separado: toda corrida terminada
 *   aterriza en `READY_FOR_REVIEW` (hubo propuestas), `NO_CHANGES` (el loop
 *   terminó limpio pero no propuso nada) o `FAILED` (error/excepción).
 * - `EXPIRED` no es un estado propio — es un `DISCARDED` con
 *   `discardReason: "expired"` en vez de `"user"`.
 */
export type TaskStatus =
  | "QUEUED"
  | "RUNNING"
  | "READY_FOR_REVIEW"
  | "APPLYING"
  | "APPLIED"
  | "DISCARDED"
  | "FAILED"
  | "NO_CHANGES"
  | "CANCELLED"
  | "INTERRUPTED";

export const TERMINAL_STATUSES: readonly TaskStatus[] = [
  "APPLIED",
  "DISCARDED",
  "FAILED",
  "NO_CHANGES",
  "CANCELLED",
  "INTERRUPTED",
];

export function isTerminalStatus(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** Transiciones válidas — tabla explícita, no una convención implícita.
 * `transitionTask` rechaza cualquier `to` que no esté en la lista del
 * `from` actual. Ver diseño de Fase 2, sección 8, para la justificación de
 * cada una (incluida la de `APPLYING → READY_FOR_REVIEW`, que es la vuelta
 * atrás por conflicto de baseSHA, no un error). */
const ALLOWED_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  QUEUED: ["RUNNING"],
  RUNNING: ["READY_FOR_REVIEW", "NO_CHANGES", "FAILED", "CANCELLED", "INTERRUPTED"],
  READY_FOR_REVIEW: ["APPLYING", "DISCARDED"],
  APPLYING: ["APPLIED", "READY_FOR_REVIEW"],
  APPLIED: [],
  DISCARDED: [],
  FAILED: [],
  NO_CHANGES: [],
  CANCELLED: [],
  INTERRUPTED: [],
};

export class InvalidTaskTransitionError extends Error {
  constructor(
    public readonly taskId: string,
    public readonly from: TaskStatus,
    public readonly to: TaskStatus,
  ) {
    super(`Transición inválida para la task ${taskId}: ${from} → ${to} no está permitida.`);
    this.name = "InvalidTaskTransitionError";
  }
}

export type CodingTask = {
  id: string;
  projectId: string;
  modelId: string;
  prompt: string;
  status: TaskStatus;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  baseCommit: string | null;
  workspaceId: string | null;
  stopReason: string | null;
  error: string | null;
  discardReason: "user" | "expired" | null;
  conflictedPaths: string[] | null;
};

type CodingTaskRow = {
  id: string;
  project_id: string;
  model_id: string;
  prompt: string;
  status: string;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  base_commit: string | null;
  workspace_id: string | null;
  stop_reason: string | null;
  error: string | null;
  discard_reason: string | null;
  conflicted_paths: string | null;
};

function rowToTask(row: CodingTaskRow): CodingTask {
  return {
    id: row.id,
    projectId: row.project_id,
    modelId: row.model_id,
    prompt: row.prompt,
    status: row.status as TaskStatus,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    baseCommit: row.base_commit,
    workspaceId: row.workspace_id,
    stopReason: row.stop_reason,
    error: row.error,
    discardReason: row.discard_reason as CodingTask["discardReason"],
    conflictedPaths: row.conflicted_paths ? JSON.parse(row.conflicted_paths) : null,
  };
}

export type CreateTaskInput = {
  projectId: string;
  modelId: string;
  prompt: string;
};

/** Crea una task nueva en `QUEUED`. No hace una validación propia de que
 * `projectId` exista (eso queda para el futuro endpoint de creación, que
 * puede dar un mensaje más específico antes de llegar acá) — pero la FK a
 * `agent_projects` SÍ está activa a nivel de SQLite (`better-sqlite3` trae
 * `foreign_keys = ON` por default, a diferencia de otros drivers), así que
 * un `projectId` inexistente falla igual, solo que con un mensaje más claro
 * que el `SqliteError` crudo. */
export function createTask(input: CreateTaskInput): CodingTask {
  const now = Date.now();
  const task: CodingTask = {
    id: crypto.randomUUID(),
    projectId: input.projectId,
    modelId: input.modelId,
    prompt: input.prompt,
    status: "QUEUED",
    createdAt: now,
    startedAt: null,
    finishedAt: null,
    baseCommit: null,
    workspaceId: null,
    stopReason: null,
    error: null,
    discardReason: null,
    conflictedPaths: null,
  };

  try {
    getDb()
      .prepare(
        `INSERT INTO agent_tasks (id, project_id, model_id, prompt, status, created_at, started_at, finished_at, base_commit, workspace_id, stop_reason, error, discard_reason, conflicted_paths)
         VALUES (@id, @projectId, @modelId, @prompt, @status, @createdAt, @startedAt, @finishedAt, @baseCommit, @workspaceId, @stopReason, @error, @discardReason, @conflictedPaths)`,
      )
      .run({
        id: task.id,
        projectId: task.projectId,
        modelId: task.modelId,
        prompt: task.prompt,
        status: task.status,
        createdAt: task.createdAt,
        startedAt: task.startedAt,
        finishedAt: task.finishedAt,
        baseCommit: task.baseCommit,
        workspaceId: task.workspaceId,
        stopReason: task.stopReason,
        error: task.error,
        discardReason: task.discardReason,
        conflictedPaths: task.conflictedPaths,
      });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message.includes("FOREIGN KEY constraint failed")) {
      throw new Error(`No existe un Project con id "${input.projectId}" (agent_projects) — registralo antes de crear una CodingTask.`);
    }
    throw e;
  }

  return task;
}

export function getTask(id: string): CodingTask | null {
  const row = getDb().prepare("SELECT * FROM agent_tasks WHERE id = ?").get(id) as CodingTaskRow | undefined;
  return row ? rowToTask(row) : null;
}

export function listTasks(opts?: { projectId?: string; status?: TaskStatus }): CodingTask[] {
  const conditions: string[] = [];
  const params: Record<string, string> = {};
  if (opts?.projectId) {
    conditions.push("project_id = @projectId");
    params.projectId = opts.projectId;
  }
  if (opts?.status) {
    conditions.push("status = @status");
    params.status = opts.status;
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = getDb()
    .prepare(`SELECT * FROM agent_tasks ${where} ORDER BY created_at DESC`)
    .all(params) as CodingTaskRow[];
  return rows.map(rowToTask);
}

export type TransitionPatch = Partial<
  Pick<CodingTask, "baseCommit" | "workspaceId" | "stopReason" | "error" | "discardReason" | "conflictedPaths">
>;

/** Único punto de escritura del `status` de una task. Rechaza cualquier
 * transición que no esté en `ALLOWED_TRANSITIONS` — quien quiera saltear la
 * máquina de estados (ej. escribir `status` directo con SQL a mano) se está
 * saliendo a propósito de la garantía que esta función existe para dar.
 *
 * Pone `startedAt`/`finishedAt` automáticamente según corresponda: entrar a
 * `RUNNING` marca `startedAt`; entrar a cualquier estado terminal marca
 * `finishedAt` (si no lo tenía ya — una `APPLYING → READY_FOR_REVIEW` por
 * conflicto no es terminal, así que no toca `finishedAt`). */
export function transitionTask(id: string, to: TaskStatus, patch?: TransitionPatch): CodingTask {
  const task = getTask(id);
  if (!task) throw new Error(`No existe la task ${id}`);

  const allowed = ALLOWED_TRANSITIONS[task.status];
  if (!allowed.includes(to)) {
    throw new InvalidTaskTransitionError(id, task.status, to);
  }

  const now = Date.now();
  const next: CodingTask = {
    ...task,
    ...patch,
    status: to,
    startedAt: to === "RUNNING" ? now : task.startedAt,
    finishedAt: isTerminalStatus(to) ? now : task.finishedAt,
  };

  getDb()
    .prepare(
      `UPDATE agent_tasks
       SET status = @status, started_at = @startedAt, finished_at = @finishedAt,
           base_commit = @baseCommit, workspace_id = @workspaceId, stop_reason = @stopReason,
           error = @error, discard_reason = @discardReason, conflicted_paths = @conflictedPaths
       WHERE id = @id`,
    )
    .run({
      id: next.id,
      status: next.status,
      startedAt: next.startedAt,
      finishedAt: next.finishedAt,
      baseCommit: next.baseCommit,
      workspaceId: next.workspaceId,
      stopReason: next.stopReason,
      error: next.error,
      discardReason: next.discardReason,
      conflictedPaths: next.conflictedPaths ? JSON.stringify(next.conflictedPaths) : null,
    });

  return next;
}
