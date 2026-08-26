import { getDb } from "../db";

export type WorkspaceMode = "worktree" | "copy";

/** Registro persistido de un workspace del Coding Agent — relación 1:1 con
 * su `CodingTask` (`id` = `taskId`, ver diseño de Fase 2, sección 4). No
 * confundir con `AgentWorkspace` de `lib/agent/workspace.ts`, que es el
 * objeto en memoria devuelto por `createAgentWorkspace`/`createCopyWorkspace`
 * mientras el workspace está vivo — este es el registro que sobrevive en
 * SQLite incluso después de destruido (`destroyedAt` no nulo). */
export type PersistedWorkspace = {
  id: string;
  taskId: string;
  projectId: string;
  mode: WorkspaceMode;
  basePath: string;
  worktreePath: string;
  branchName: string | null;
  baseCommit: string | null;
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

export function recordWorkspaceCreated(input: RecordWorkspaceInput): PersistedWorkspace {
  const workspace: PersistedWorkspace = {
    id: input.taskId,
    taskId: input.taskId,
    projectId: input.projectId,
    mode: input.mode,
    basePath: input.basePath,
    worktreePath: input.worktreePath,
    branchName: input.branchName,
    baseCommit: input.baseCommit,
    createdAt: Date.now(),
    destroyedAt: null,
  };

  getDb()
    .prepare(
      `INSERT INTO agent_workspaces (id, task_id, project_id, mode, base_path, worktree_path, branch_name, base_commit, created_at, destroyed_at)
       VALUES (@id, @taskId, @projectId, @mode, @basePath, @worktreePath, @branchName, @baseCommit, @createdAt, @destroyedAt)`,
    )
    .run(workspace);

  return workspace;
}

export function recordWorkspaceDestroyed(taskId: string): void {
  getDb().prepare("UPDATE agent_workspaces SET destroyed_at = ? WHERE id = ?").run(Date.now(), taskId);
}

export function getWorkspaceForTask(taskId: string): PersistedWorkspace | null {
  const row = getDb().prepare("SELECT * FROM agent_workspaces WHERE task_id = ?").get(taskId) as
    | PersistedWorkspaceRow
    | undefined;
  return row ? rowToWorkspace(row) : null;
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
