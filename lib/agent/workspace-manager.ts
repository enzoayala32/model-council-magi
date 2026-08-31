import {
  createAgentWorkspace,
  destroyAgentWorkspace,
  createCopyWorkspace,
  destroyCopyWorkspace,
  getHeadCommit,
} from "./workspace";
import { recordWorkspaceCreated, recordWorkspaceDestroyed, getWorkspaceForTask, type WorkspaceMode } from "./workspace-store";
import type { AgentProject } from "./project-store";
import type { CodingTask } from "./task-store";

/**
 * Workspace unificado para una `CodingTask`, ya persistido en
 * `agent_workspaces`. A diferencia de `AgentWorkspace` (el tipo de bajo
 * nivel en `workspace.ts`, específico de worktree), este es agnóstico al
 * modo — `mode` es lo único que un consumidor (el futuro loop del agente,
 * en 2D) necesita mirar para saber cómo se armó `worktreePath`.
 */
export type TaskWorkspace = {
  id: string;
  taskId: string;
  projectId: string;
  mode: WorkspaceMode;
  basePath: string;
  worktreePath: string;
  branchName: string | null;
  baseCommit: string | null;
};

/**
 * Workspace unificado para una `CodingTask`, ya persistido en
 * `agent_workspaces`. A diferencia de `AgentWorkspace` (el tipo de bajo
 * nivel en `workspace.ts`, específico de worktree), este es agnóstico al
 * modo — `mode` es lo único que un consumidor (el futuro loop del agente,
 * en 2D) necesita mirar para saber cómo se armó `worktreePath`.
 *
 * `id` (Fase 3) es el `id` PROPIO del registro en `agent_workspaces` — ya
 * no es lo mismo que `taskId` (esa relación era 1:1 antes de Fase 3, ahora
 * es 1:N: una task puede tener varios workspaces a lo largo de su vida,
 * uno por cada restart automático). Hace falta guardarlo acá porque
 * `destroyWorkspaceForTask` lo necesita para saber CUÁL de los posibles
 * varios registros de esa task es el que hay que marcar destruido.
 */
export async function createWorkspaceForTask(task: CodingTask, project: AgentProject): Promise<TaskWorkspace> {
  if (project.isGitRepo) {
    const baseCommit = await getHeadCommit(project.localPath);
    const workspace = await createAgentWorkspace(task.id, project.localPath);

    const persisted = recordWorkspaceCreated({
      taskId: task.id,
      projectId: project.id,
      mode: "worktree",
      basePath: project.localPath,
      worktreePath: workspace.worktreePath,
      branchName: workspace.branchName,
      baseCommit,
    });

    return {
      id: persisted.id,
      taskId: task.id,
      projectId: project.id,
      mode: "worktree",
      basePath: project.localPath,
      worktreePath: workspace.worktreePath,
      branchName: workspace.branchName,
      baseCommit,
    };
  }

  const workspace = await createCopyWorkspace(task.id, project.localPath);

  const persisted = recordWorkspaceCreated({
    taskId: task.id,
    projectId: project.id,
    mode: "copy",
    basePath: project.localPath,
    worktreePath: workspace.worktreePath,
    branchName: null,
    baseCommit: null,
  });

  return {
    id: persisted.id,
    taskId: task.id,
    projectId: project.id,
    mode: "copy",
    basePath: project.localPath,
    worktreePath: workspace.worktreePath,
    branchName: null,
    baseCommit: null,
  };
}

/** Destruye el workspace de una task, sin importar en qué modo se creó —
 * el llamador no necesita saber si era worktree o copy, `mode` ya viene en
 * `TaskWorkspace`. Marca `destroyedAt` en el registro persistido (por su
 * `id` PROPIO, Fase 3 — ya no alcanza con el `taskId` porque puede haber
 * más de un registro por task) incluso si la limpieza física falla
 * parcialmente (best-effort, igual que las funciones de bajo nivel que
 * envuelve). */
export async function destroyWorkspaceForTask(workspace: TaskWorkspace): Promise<void> {
  if (workspace.mode === "worktree") {
    await destroyAgentWorkspace({
      worktreePath: workspace.worktreePath,
      branchName: workspace.branchName ?? "",
      repoRoot: workspace.basePath,
    });
  } else {
    await destroyCopyWorkspace({ worktreePath: workspace.worktreePath });
  }
  recordWorkspaceDestroyed(workspace.id);
}

/** Reconstruye un `TaskWorkspace` a partir del registro persistido — útil
 * para que un proceso que no fue el que creó el workspace (ej. un endpoint
 * de "descartar" corriendo en otro request) pueda destruirlo sin tener el
 * objeto en memoria original. Fase 3: `getWorkspaceForTask` ahora resuelve
 * el workspace ACTIVO siguiendo el puntero `agent_tasks.workspace_id`, no
 * "el más reciente" — sigue devolviendo como mucho un resultado, igual que
 * antes, solo que ahora sin ambigüedad si alguna vez hubiera dos filas sin
 * `destroyedAt` por algún bug. */
export function loadWorkspaceForTask(taskId: string): TaskWorkspace | null {
  const persisted = getWorkspaceForTask(taskId);
  if (!persisted) return null;
  return {
    id: persisted.id,
    taskId: persisted.taskId,
    projectId: persisted.projectId,
    mode: persisted.mode,
    basePath: persisted.basePath,
    worktreePath: persisted.worktreePath,
    branchName: persisted.branchName,
    baseCommit: persisted.baseCommit,
  };
}
