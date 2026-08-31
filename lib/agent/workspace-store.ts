import crypto from "node:crypto";
import { getDb } from "../db";

export type WorkspaceMode = "worktree" | "copy";

/** Registro persistido de un workspace del Coding Agent. Fase 3 (sección 5
 * del diseño) cambió esto de 1:1 con su `CodingTask` a 1:N — una task
 * puede acumular varios intentos de workspace a lo largo de su vida (uno
 * por cada restart automático), cada uno con su propio `id` (ya no
 * `id = task_id`). El workspace ACTIVO de una task es el que apunta
 * `agent_tasks.workspace_id` — no "el más reciente" ni ninguna otra
 * heurística basada en fechas. No confundir con `AgentWorkspace` de
 * `lib/agent/workspace.ts`, que es el objeto en memoria mientras el
 * workspace está vivo — este es el registro que sobrevive en SQLite
 * incluso después de destruido (`destroyedAt` no nulo). */
export type PersistedWorkspace = {
  id: string;
  taskId: string;
  projectId: string;
  mode: WorkspaceMode;
  basePath: string;
  worktreePath: string;
  branchName: string | null;
  baseCommit: string | null;
  /** Número de intento de esta task (1 = el original, 2 = tras el primer
   * restart automático, etc.) — informativo, Grupo B del diseño de Fase 3:
   * se podría derivar de `restart_retry_count+1` en el momento de crear el
   * workspace, pero es barato tenerlo acá para no recalcularlo en la UI. */
  attempt: number;
  createdAt: number;
  destroyedAt: number | null;
};

type PersistedWorkspaceRow = {
  id: string;
  task_id: string;
  project_id: string;
  mode: string;
  base_path: string;
  worktree_path: string;
  branch_name: string | null;
  base_commit: string | null;
  attempt: number;
  created_at: number;
  destroyed_at: number | null;
};

function rowToWorkspace(row: PersistedWorkspaceRow): PersistedWorkspace {
  return {
    id: row.id,
    taskId: row.task_id,
    projectId: row.project_id,
    mode: row.mode as WorkspaceMode,
    basePath: row.base_path,
    worktreePath: row.worktree_path,
    branchName: row.branch_name,
    baseCommit: row.base_commit,
    attempt: row.attempt,
    createdAt: row.created_at,
    destroyedAt: row.destroyed_at,
  };
}

export type RecordWorkspaceInput = {
  taskId: string;
  projectId: string;
  mode: WorkspaceMode;
  basePath: string;
  worktreePath: string;
  branchName: string | null;
  baseCommit: string | null;
};

/** Inserta el registro del workspace nuevo Y actualiza
 * `agent_tasks.workspace_id` para que apunte a él, en la MISMA transacción
 * — las dos escrituras son un solo hecho lógico ("esta task tiene un
 * workspace activo nuevo"), nunca deberían poder quedar desincronizadas
 * entre sí. `attempt` se calcula contando cuántos workspaces tuvo ya esta
 * task (1 si es el primero). */
export function recordWorkspaceCreated(input: RecordWorkspaceInput): PersistedWorkspace {
  const db = getDb();
  const create = db.transaction((): PersistedWorkspace => {
    const countRow = db.prepare("SELECT count(*) as c FROM agent_workspaces WHERE task_id = ?").get(input.taskId) as { c: number };
    const workspace: PersistedWorkspace = {
      id: crypto.randomUUID(),
      taskId: input.taskId,
      projectId: input.projectId,
      mode: input.mode,
      basePath: input.basePath,
      worktreePath: input.worktreePath,
      branchName: input.branchName,
      baseCommit: input.baseCommit,
      attempt: countRow.c + 1,
      createdAt: Date.now(),
      destroyedAt: null,
    };

    db.prepare(
      `INSERT INTO agent_workspaces (id, task_id, project_id, mode, base_path, worktree_path, branch_name, base_commit, attempt, created_at, destroyed_at)
       VALUES (@id, @taskId, @projectId, @mode, @basePath, @worktreePath, @branchName, @baseCommit, @attempt, @createdAt, @destroyedAt)`,
    ).run(workspace);

    db.prepare("UPDATE agent_tasks SET workspace_id = ? WHERE id = ?").run(workspace.id, workspace.taskId);

    return workspace;
  });

  return create();
}

/** Recibe el `id` PROPIO del workspace (ya no el `taskId` — desde que la
 * relación es 1:N, una task puede tener varios registros y hay que decir
 * cuál). NO limpia `agent_tasks.workspace_id` a `null` — lo deja apuntando
 * al registro histórico (que ya queda marcado con `destroyedAt`); es
 * información, no un puntero peligroso, y evita tener que manejar el caso
 * "task sin workspace_id" en el resto del código. */
export function recordWorkspaceDestroyed(workspaceId: string): void {
  getDb().prepare("UPDATE agent_workspaces SET destroyed_at = ? WHERE id = ?").run(Date.now(), workspaceId);
}

/** El workspace ACTIVO/actual de una task — sigue el puntero
 * `agent_tasks.workspace_id`, no infiere nada por fecha ni por
 * `destroyedAt`. Devuelve `null` si la task no tiene ningún workspace
 * todavía (nunca llegó a crear uno) o si el puntero no resuelve a ninguna
 * fila (no debería pasar en operación normal). */
export function getWorkspaceForTask(taskId: string): PersistedWorkspace | null {
  const row = getDb()
    .prepare(
      `SELECT w.* FROM agent_workspaces w
       JOIN agent_tasks t ON t.workspace_id = w.id
       WHERE t.id = ?`,
    )
    .get(taskId) as PersistedWorkspaceRow | undefined;
  return row ? rowToWorkspace(row) : null;
}

/** Todos los workspaces de una task a lo largo de su vida (incluidos los
 * ya destruidos), en el orden en que se crearon — el historial completo de
 * intentos. Fase 3, sección 5. */
export function listWorkspacesForTask(taskId: string): PersistedWorkspace[] {
  const rows = getDb().prepare("SELECT * FROM agent_workspaces WHERE task_id = ? ORDER BY created_at ASC").all(taskId) as PersistedWorkspaceRow[];
  return rows.map(rowToWorkspace);
}

/** Workspaces sin destruir — el candidato natural para un barrido de
 * arranque multi-proyecto (a diferencia del `sweepOrphanedWorkspaces` de
 * Fase 2A/2B, que solo conocía un `repoRoot` a la vez, este ya sabe a qué
 * proyecto pertenece cada uno). El barrido real que lo use es parte de la
 * Fase 2D (task runner) — acá solo se deja disponible el query. */
export function listLiveWorkspaces(): PersistedWorkspace[] {
  const rows = getDb().prepare("SELECT * FROM agent_workspaces WHERE destroyed_at IS NULL").all() as PersistedWorkspaceRow[];
  return rows.map(rowToWorkspace);
}
