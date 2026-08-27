import { getTask, transitionTask, updateTaskFields, listTasks, isTerminalStatus } from "./task-store";
import { getProject } from "./project-store";
import { createWorkspaceForTask, destroyWorkspaceForTask, loadWorkspaceForTask, type TaskWorkspace } from "./workspace-manager";
import { runAgentLoop, type AgentLoopResult, type RunAgentLoopOptions } from "./loop";

type LoopRunner = (options: RunAgentLoopOptions) => Promise<AgentLoopResult>;

/** Única fuente de "¿hay un proceso de verdad corriendo esta task ahora?" —
 * vive en memoria a propósito (ver diseño de Fase 2, sección 10/13): si el
 * proceso muere, este Map desaparece con él, y es exactamente lo que hace
 * que `reconcileInterruptedTasks` (llamada al boot) sea necesaria en vez de
 * intentar "revivir" nada. */
const activeRuns = new Map<string, AbortController>();

export function isTaskActive(taskId: string): boolean {
  return activeRuns.has(taskId);
}

/** Pide cancelar una task `RUNNING`. Best-effort: si el proceso que la
 * corría ya no existe (se reinició el server), no hay nada que cancelar acá
 * — esa task se resuelve como `INTERRUPTED` en el próximo boot, no como
 * `CANCELLED`. Devuelve `false` si no hay una corrida activa en memoria
 * para ese id. */
export function cancelTask(taskId: string): boolean {
  const controller = activeRuns.get(taskId);
  if (!controller) return false;
  controller.abort();
  return true;
}

export type RunTaskOptions = {
  /** Inyectable solo para pruebas — el default es el loop real. Correr una
   * task de verdad SIEMPRE debe usar `runAgentLoop`; nunca se pasa este
   * parámetro fuera de un test. */
  loopRunner?: LoopRunner;
};

/**
 * Ejecuta una `CodingTask` de punta a punta: `QUEUED → RUNNING` → crea el
 * workspace → corre el loop del agente → decide el estado final según el
 * resultado → limpia el workspace si el estado final ya no lo necesita.
 *
 * Deliberadamente fire-and-forget desde el punto de vista de quien la
 * invoca (ver diseño de Fase 2, sección 10): esta función se llama sin
 * esperarla (`runTask(id)` sin `await` desde el disparador real), el estado
 * de la task siempre se puede consultar después vía `getTask` — nunca
 * depende de que este `await` en particular siga vivo.
 *
 * LIMITACIÓN CONOCIDA (Fase 2D): `runAgentLoop` arma el diff final
 * corriendo `git status`/`git show HEAD:` DENTRO del workspace — funciona
 * para modo `"worktree"` (comparte objetos/refs con el repo real) pero NO
 * para modo `"copy"` (no tiene `.git`). Por eso, hasta que exista el diff
 * por hashes de la sección 14 del diseño, `runTask` rechaza de entrada
 * cualquier task sobre un `Project` con `isGitRepo: false` — con un error
 * claro, en vez de dejarla correr y terminar con un resultado vacío o
 * incorrecto.
 */
export async function runTask(taskId: string, opts: RunTaskOptions = {}): Promise<void> {
  const loopRunner = opts.loopRunner ?? runAgentLoop;

  const task = getTask(taskId);
  if (!task) throw new Error(`No existe la task ${taskId}`);
  if (task.status !== "QUEUED") throw new Error(`La task ${taskId} no está en QUEUED (está en ${task.status}).`);

  const project = getProject(task.projectId);
  if (!project) throw new Error(`No existe el Project ${task.projectId}`);

  if (!project.isGitRepo) {
    throw new Error(
      `El proyecto "${project.name}" no es un repo git (modo "copy"). El diff del Coding Agent todavía depende de ` +
        `git — correr tasks reales sobre proyectos sin git queda bloqueado hasta que se implemente el diff por ` +
        `hashes (ver diseño de Fase 2, sección 14). Es una limitación conocida de la Fase 2D, no un bug.`,
    );
  }

  const abortController = new AbortController();
  activeRuns.set(taskId, abortController);

  let workspace: TaskWorkspace | null = null;
  try {
    transitionTask(taskId, "RUNNING");
    workspace = await createWorkspaceForTask(task, project);
    updateTaskFields(taskId, { workspaceId: taskId, baseCommit: workspace.baseCommit });

    const result = await loopRunner({
      task: task.prompt,
      workspaceRoot: workspace.worktreePath,
      repoRoot: workspace.basePath,
      modelId: task.modelId,
      abortSignal: abortController.signal,
    });

    if (abortController.signal.aborted) {
      transitionTask(taskId, "CANCELLED");
    } else if (result.error) {
      transitionTask(taskId, "FAILED", { error: result.error, stopReason: result.stopReason });
    } else if (result.proposals.length > 0) {
      // Las propuestas en sí todavía no se persisten acá (eso es Fase 2F) —
      // 2D solo decide el estado final de la task a partir del resultado.
      transitionTask(taskId, "READY_FOR_REVIEW", { stopReason: result.stopReason });
    } else {
      transitionTask(taskId, "NO_CHANGES", { stopReason: result.stopReason });
    }
  } catch (error) {
    transitionTask(taskId, "FAILED", { error: error instanceof Error ? error.message : String(error) });
  } finally {
    activeRuns.delete(taskId);
    // READY_FOR_REVIEW deja el workspace vivo a propósito — el diff todavía
    // no se persistió (2F) y el usuario puede necesitar aplicar/descartar
    // más adelante (2G) sobre ESE mismo worktree. El resto de los estados
    // terminales de esta corrida (FAILED/NO_CHANGES/CANCELLED) no lo
    // necesitan más.
    const finalTask = getTask(taskId);
    if (workspace && finalTask && finalTask.status !== "READY_FOR_REVIEW" && isTerminalStatus(finalTask.status)) {
      await destroyWorkspaceForTask(workspace);
    }
  }
}

/**
 * Reconciliación al boot (ver diseño de Fase 2, sección 13): cualquier task
 * que haya quedado en `RUNNING` en SQLite sin que exista un proceso real
 * corriéndola (porque el server se reinició a mitad de una corrida) pasa a
 * `INTERRUPTED` — nunca se intenta "retomarla". Se llama una única vez al
 * arrancar el server, antes de aceptar cualquier `CodingTask` nueva.
 */
export async function reconcileInterruptedTasks(): Promise<{ interrupted: string[] }> {
  const interrupted: string[] = [];
  for (const task of listTasks({ status: "RUNNING" })) {
    // Si por algún motivo SÍ hay una corrida activa en memoria para esta
    // task (no debería pasar justo al boot, pero por las dudas), no la
    // tocamos — la reconciliación es solo para huérfanas de verdad.
    if (isTaskActive(task.id)) continue;

    transitionTask(task.id, "INTERRUPTED");
    const workspace = loadWorkspaceForTask(task.id);
    if (workspace) await destroyWorkspaceForTask(workspace);
    interrupted.push(task.id);
  }
  return { interrupted };
}
