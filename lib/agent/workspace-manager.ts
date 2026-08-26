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
  taskId: string;
  projectId: string;
  mode: WorkspaceMode;
  basePath: string;
  worktreePath: string;
  branchName: string | null;
  baseCommit: string | null;
};

/**
 * Crea el workspace real para una `CodingTask`, eligiendo el modo según
 * `project.isGitRepo` (ver diseño de Fase 2, sección 14):
 * - `isGitRepo: true`  → `"worktree"` (git worktree real, rama descartable)
 * - `isGitRepo: false` → `"copy"` (copia física aislada, sin git de por medio)
 *
 * Persiste el registro en `agent_workspaces` antes de devolver el
 * resultado — si el proceso muere justo después de crear el directorio
 * físico pero antes de persistir, quedaría un huérfano sin registro; el
 * orden inverso (persistir y recién después crear el directorio) sería
 * peor: un registro que promete un workspace que nunca llegó a existir.
 * Se acepta el primer riesgo como el menor de los dos — el barrido de
 * arranque de 2D igual puede encontrar directorios sin registro por TTL.
 */
export async function createWorkspaceForTask(task: CodingTask, project: AgentProject): Promise<TaskWorkspace> {
  if (project.isGitRepo) {
    const baseCommit = await getHeadCommit(project.localPath);
    const workspace = await createAgentWorkspace(task.id, project.localPath);

    recordWorkspaceCreated({
      taskId: task.id,
      projectId: project.id,
      mode: "worktree",
      basePath: project.localPath,
      worktreePath: workspace.worktreePath,
      branchName: workspace.branchName,
      baseCommit,
    });

    return {
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

  recordWorkspaceCreated({
    taskId: task.id,
    projectId: project.id,
    mode: "copy",
    basePath: project.localPath,
    worktreePath: workspace.worktreePath,
    branchName: null,
    baseCommit: null,
  });

  return {
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
 * `TaskWorkspace`. Marca `destroyedAt` en el registro persistido incluso si
 * la limpieza física falla parcialmente (best-effort, igual que las
 * funciones de bajo nivel que envuelve). */
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
  recordWorkspaceDestroyed(workspace.taskId);
}

/** Reconstruye un `TaskWorkspace` a partir del registro persistido — útil
 * para que un proceso que no fue el que creó el workspace (ej. un endpoint
 * de "descartar" corriendo en otro request) pueda destruirlo sin tener el
 * objeto en memoria original. */
export function loadWorkspaceForTask(taskId: string): TaskWorkspace | null {
  const persisted = getWorkspaceForTask(taskId);
  if (!persisted) return null;
  return {
    taskId: persisted.taskId,
    projectId: persisted.projectId,
    mode: persisted.mode,
    basePath: persisted.basePath,
    worktreePath: persisted.worktreePath,
    branchName: persisted.branchName,
    baseCommit: persisted.baseCommit,
  };
}
