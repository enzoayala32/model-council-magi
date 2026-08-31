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
 * atrás por conflicto de baseSHA, no un error).
 *
 * `RUNNING → QUEUED` es de Fase 3 (sección 3/11 del diseño): úsala
 * EXCLUSIVAMENTE la reconciliación de boot, cuando encuentra una task
 * `RUNNING` huérfana (el server se reinició a mitad de esa corrida) y la
 * reencola para reintentar desde cero. Ningún otro código debería llamar
 * `transitionTask(id, "QUEUED", ...)` — no es una transición que el
 * usuario o el loop disparen nunca. */
const ALLOWED_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  QUEUED: ["RUNNING"],
  RUNNING: ["READY_FOR_REVIEW", "NO_CHANGES", "FAILED", "CANCELLED", "INTERRUPTED", "QUEUED"],
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

export class TaskNotTerminalError extends Error {
  constructor(
    public readonly taskId: string,
    public readonly status: TaskStatus,
  ) {
    super(`No se puede eliminar la task ${taskId}: todavía está en ${status} (no es un estado terminal).`);
    this.name = "TaskNotTerminalError";
  }
}

/** Fase 3: `true` si `error` es el `SqliteError` que tira el índice único
 * parcial `idx_agent_tasks_one_running_per_project` (`agent_tasks.project_id
 * WHERE status='RUNNING'`) al intentar dejar una segunda task `RUNNING` del
 * mismo proyecto. Exportado porque tanto `transitionTask` como quien la
 * llama (`runTask`, al hacer su propio auto-claim QUEUED→RUNNING) necesitan
 * reconocer este caso puntual para tratarlo como "perdió la carrera del
 * dispatch", no como un error real de la task. */
export function isRunningSlotConflictError(error: unknown): boolean {
  const e = error as { code?: string; message?: string } | null;
  if (!e) return false;
  return e.code === "SQLITE_CONSTRAINT_UNIQUE" || (typeof e.message === "string" && e.message.includes("UNIQUE constraint failed"));
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
  /** Fase 3: cuántas veces esta task puntual fue reencolada por un restart
   * del server (no cuántas veces se reinició el server en general). Ver
   * diseño de Fase 3, sección 4 — incrementa SOLO en la reconciliación de
   * boot, resetea a 0 SOLO al salir de RUNNING por el camino normal
   * (READY_FOR_REVIEW/NO_CHANGES/FAILED real/CANCELLED). Nunca al volver a
   * arrancar — resetearlo ahí rompería el tope de reintentos. */
  restartRetryCount: number;
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
  restart_retry_count: number;
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
    restartRetryCount: row.restart_retry_count,
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
    restartRetryCount: 0,
  };

  try {
    getDb()
      .prepare(
        `INSERT INTO agent_tasks (id, project_id, model_id, prompt, status, created_at, started_at, finished_at, base_commit, workspace_id, stop_reason, error, discard_reason, conflicted_paths, restart_retry_count)
         VALUES (@id, @projectId, @modelId, @prompt, @status, @createdAt, @startedAt, @finishedAt, @baseCommit, @workspaceId, @stopReason, @error, @discardReason, @conflictedPaths, @restartRetryCount)`,
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
        restartRetryCount: task.restartRetryCount,
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
  Pick<CodingTask, "baseCommit" | "workspaceId" | "stopReason" | "error" | "discardReason" | "conflictedPaths" | "restartRetryCount">
>;

/** Actualiza campos de una task SIN cambiar su `status` — para datos que se
 * conocen a mitad de una corrida (ej. `workspaceId`/`baseCommit`, apenas se
 * crea el workspace, todavía en `RUNNING`) y que no corresponden a ninguna
 * transición de estado. `transitionTask` es el único lugar que cambia
 * `status`; esta función nunca lo toca. */
export function updateTaskFields(id: string, patch: TransitionPatch): CodingTask {
  const task = getTask(id);
  if (!task) throw new Error(`No existe la task ${id}`);

  const next: CodingTask = { ...task, ...patch };

  getDb()
    .prepare(
      `UPDATE agent_tasks
       SET base_commit = @baseCommit, workspace_id = @workspaceId, stop_reason = @stopReason,
           error = @error, discard_reason = @discardReason, conflicted_paths = @conflictedPaths
       WHERE id = @id`,
    )
    .run({
      id: next.id,
      baseCommit: next.baseCommit,
      workspaceId: next.workspaceId,
      stopReason: next.stopReason,
      error: next.error,
      discardReason: next.discardReason,
      conflictedPaths: next.conflictedPaths ? JSON.stringify(next.conflictedPaths) : null,
    });

  return next;
}

/** Estados a los que `RUNNING` puede llegar por el camino NORMAL de
 * `runner.ts` (el proceso seguía vivo, el loop llegó a una conclusión por
 * sí mismo — sea cual sea el motivo puntual). Fase 3, sección 4: salir de
 * `RUNNING` hacia cualquiera de estos resetea `restart_retry_count` a 0
 * automáticamente, sin que cada call site tenga que acordarse de pasarlo.
 * Deliberadamente NO incluye `QUEUED` (reencolado por la reconciliación de
 * boot, prueba de que el proceso NO siguió vivo) ni `INTERRUPTED` (el
 * valor con el que llegó ahí es justamente la evidencia de por qué se
 * interrumpió — resetearlo a 0 borraría esa información). */
const NATURAL_RUNNING_EXITS: readonly TaskStatus[] = ["READY_FOR_REVIEW", "NO_CHANGES", "FAILED", "CANCELLED"];

/** Único punto de escritura del `status` de una task. Rechaza cualquier
 * transición que no esté en `ALLOWED_TRANSITIONS` — quien quiera saltear la
 * máquina de estados (ej. escribir `status` directo con SQL a mano) se está
 * saliendo a propósito de la garantía que esta función existe para dar.
 *
 * Pone `startedAt`/`finishedAt` automáticamente según corresponda: entrar a
 * `RUNNING` marca `startedAt`; entrar a cualquier estado terminal marca
 * `finishedAt` (si no lo tenía ya — una `APPLYING → READY_FOR_REVIEW` por
 * conflicto no es terminal, así que no toca `finishedAt`).
 *
 * Fase 3, sección 3.2: el `UPDATE` está condicionado al status que
 * acabamos de leer (`WHERE id = ? AND status = ?`), no solo `WHERE id = ?`
 * como antes. Si `changes === 0`, alguien más ya movió esta task entre que
 * la leímos y que escribimos — se trata exactamente igual que un salto de
 * estado inválido (`InvalidTaskTransitionError`), porque desde el punto de
 * vista de quien llamó, es indistinguible: la transición que pidió ya no
 * es válida sobre el estado real. Esto es lo que convierte cada transición
 * en un compare-and-swap atómico — necesario para que el índice único
 * parcial de `agent_tasks` (una sola RUNNING por proyecto) sea la garantía
 * real, no una esperanza basada en que nadie corra dos requests a la vez. */
export function transitionTask(id: string, to: TaskStatus, patch?: TransitionPatch): CodingTask {
  const task = getTask(id);
  if (!task) throw new Error(`No existe la task ${id}`);

  const allowed = ALLOWED_TRANSITIONS[task.status];
  if (!allowed.includes(to)) {
    throw new InvalidTaskTransitionError(id, task.status, to);
  }

  const now = Date.now();
  const autoResetRestartCount = task.status === "RUNNING" && NATURAL_RUNNING_EXITS.includes(to);
  const next: CodingTask = {
    ...task,
    ...patch,
    status: to,
    startedAt: to === "RUNNING" ? now : task.startedAt,
    finishedAt: isTerminalStatus(to) ? now : task.finishedAt,
    restartRetryCount: patch?.restartRetryCount ?? (autoResetRestartCount ? 0 : task.restartRetryCount),
  };

  const result = getDb()
    .prepare(
      `UPDATE agent_tasks
       SET status = @status, started_at = @startedAt, finished_at = @finishedAt,
           base_commit = @baseCommit, workspace_id = @workspaceId, stop_reason = @stopReason,
           error = @error, discard_reason = @discardReason, conflicted_paths = @conflictedPaths,
           restart_retry_count = @restartRetryCount
       WHERE id = @id AND status = @expectedFrom`,
    )
    .run({
      id: next.id,
      expectedFrom: task.status,
      status: next.status,
      startedAt: next.startedAt,
      finishedAt: next.finishedAt,
      baseCommit: next.baseCommit,
      workspaceId: next.workspaceId,
      stopReason: next.stopReason,
      error: next.error,
      discardReason: next.discardReason,
      conflictedPaths: next.conflictedPaths ? JSON.stringify(next.conflictedPaths) : null,
      restartRetryCount: next.restartRetryCount,
    });

  if (result.changes === 0) {
    // El status cambió entre el getTask() de arriba y este UPDATE — otra
    // llamada concurrente (u otro proceso) ya la movió. Misma semántica
    // que un salto de estado inválido: la transición pedida ya no aplica.
    throw new InvalidTaskTransitionError(id, task.status, to);
  }

  return next;
}

/** Fase 3: la `QUEUED` más vieja de un proyecto — lectura simple, sin
 * reservar nada. La protección real contra que dos tasks del mismo
 * proyecto terminen `RUNNING` a la vez no vive acá: vive en el índice
 * único parcial de `agent_tasks` + en que `transitionTask` (llamado
 * después, dentro de `runTask`) hace un compare-and-swap real. Esta
 * función solo decide POR CUÁL empezar si hay más de una esperando. */
export function getOldestQueuedTaskForProject(projectId: string): CodingTask | null {
  const row = getDb()
    .prepare("SELECT * FROM agent_tasks WHERE project_id = ? AND status = 'QUEUED' ORDER BY created_at ASC LIMIT 1")
    .get(projectId) as CodingTaskRow | undefined;
  return row ? rowToTask(row) : null;
}

/**
 * Borra una `CodingTask` y todo su rastro (`agent_events`,
 * `agent_proposals`, `agent_workspaces`) de una sola vez, en una
 * transacción — nunca deja un registro huérfano de estas tablas hijas si
 * algo falla a mitad de camino. Solo permite borrar tasks en un estado
 * TERMINAL (ver `TERMINAL_STATUSES`) — nunca una `QUEUED`/`RUNNING`/
 * `READY_FOR_REVIEW`/`APPLYING`, para no perder el rastro de algo que
 * todavía puede necesitar revisión o que un proceso real puede estar
 * tocando ahora mismo.
 *
 * Deliberadamente NO se encarga de destruir un workspace físico que
 * pudiera seguir vivo en disco — eso es responsabilidad de quien llama
 * (`deleteTask` en `runner.ts`), para mantener `task-store.ts` como capa
 * pura de DB, sin depender de `workspace-manager.ts` (que sí hace I/O de
 * filesystem). En operación normal, para cualquier estado terminal el
 * workspace ya se destruyó antes de llegar acá — este chequeo es
 * defensivo, no el camino esperado.
 */
export function deleteTaskRow(taskId: string): void {
  const task = getTask(taskId);
  if (!task) throw new Error(`No existe la task ${taskId}.`);
  if (!isTerminalStatus(task.status)) {
    throw new TaskNotTerminalError(taskId, task.status);
  }

  const db = getDb();
  const run = db.transaction(() => {
    db.prepare("DELETE FROM agent_events WHERE task_id = ?").run(taskId);
    db.prepare("DELETE FROM agent_proposals WHERE task_id = ?").run(taskId);
    db.prepare("DELETE FROM agent_workspaces WHERE task_id = ?").run(taskId);
    db.prepare("DELETE FROM agent_tasks WHERE id = ?").run(taskId);
  });
  run();
}
