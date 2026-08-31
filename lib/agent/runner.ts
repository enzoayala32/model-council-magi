import {
  getTask,
  transitionTask,
  updateTaskFields,
  listTasks,
  isTerminalStatus,
  deleteTaskRow,
  type CodingTask,
  type TaskStatus,
  type TransitionPatch,
} from "./task-store";
import { getProject } from "./project-store";
import { createWorkspaceForTask, destroyWorkspaceForTask, loadWorkspaceForTask, type TaskWorkspace } from "./workspace-manager";
import { runAgentLoop, type AgentLoopResult, type RunAgentLoopOptions } from "./loop";
import { appendEvent } from "./event-log";
import { persistProposals } from "./proposal-store";

type LoopRunner = (options: RunAgentLoopOptions) => Promise<AgentLoopResult>;

/** Tope de reintentos automáticos por restart antes de rendirse y dejar la
 * task en `INTERRUPTED` para que la mire un humano — ver diseño de Fase 3,
 * sección 4. 3 reintentos = hasta 4 intentos `RUNNING` totales. */
export const MAX_AUTO_RESTART_RETRIES = 3;

/** Envoltorio de `transitionTask` que además deja un evento `status_change`
 * en `agent_events` (Fase 2E, ver diseño de Fase 2, sección 12) — sin esto
 * no se puede reconstruir la línea de tiempo de estados de una task solo
 * mirando `agent_events` (que hoy solo tenía eventos del loop en sí). Lee
 * el `status` actual justo antes de transicionar para que `from` sea
 * siempre el real, no uno cacheado de más arriba en la función. Exportada
 * porque `apply.ts` (Fase 2G) también transiciona la task (READY_FOR_REVIEW
 * → APPLYING → APPLIED/READY_FOR_REVIEW) y necesita el mismo espejo en
 * `agent_events` — un solo lugar que hace "transicionar + loguear" evita
 * que las dos rutas de transición (runner y apply) diverjan con el tiempo. */
export function transitionAndLog(taskId: string, to: TaskStatus, patch?: TransitionPatch, reason?: string) {
  const from = getTask(taskId)?.status ?? "QUEUED";
  const next = transitionTask(taskId, to, patch);
  appendEvent(taskId, { type: "status_change", from, to, reason });
  return next;
}

/** Única fuente de "¿hay un proceso de verdad corriendo esta task ahora?" —
 * vive en memoria a propósito (ver diseño de Fase 2, sección 10/13): si el
 * proceso muere, este Map desaparece con él, y es exactamente lo que hace
 * que `reconcileOrphanedTasks` (llamada al boot) sea necesaria en vez de
 * intentar "revivir" nada. */
const activeRuns = new Map<string, AbortController>();

export function isTaskActive(taskId: string): boolean {
  return activeRuns.has(taskId);
}

/** Pide cancelar una task `RUNNING`. Best-effort: si el proceso que la
 * corría ya no existe (se reinició el server), no hay nada que cancelar acá
 * — esa task se resuelve reencolándose sola en el próximo boot (Fase 3),
 * no como `CANCELLED`. Devuelve `false` si no hay una corrida activa en
 * memoria para ese id. */
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
 * esperarla, el estado de la task siempre se puede consultar después vía
 * `getTask` — nunca depende de que este `await` en particular siga vivo.
 *
 * Fase 3: el primer paso (`QUEUED → RUNNING`) es un auto-claim protegido
 * por el compare-and-swap de `transitionTask` + el índice único parcial de
 * `agent_tasks` (una sola `RUNNING` por proyecto). Si esta task pierde la
 * carrera — porque el dispatcher (`dispatcher.ts`) llamó a otra task del
 * mismo proyecto casi al mismo tiempo, o porque ya había una `RUNNING` — el
 * claim falla, y eso NO es un error real de la task: se loguea y se
 * retorna sin tocar nada más, dejando la task como esté (`QUEUED`,
 * esperando su turno). Marcarla `FAILED` acá sería activamente incorrecto
 * — nunca llegó a correr.
 *
 * LIMITACIÓN CONOCIDA (Fase 2D): `runAgentLoop` arma el diff final
 * corriendo `git status`/`git show HEAD:` DENTRO del workspace — funciona
 * para modo `"worktree"` (comparte objetos/refs con el repo real) pero NO
 * para modo `"copy"` (no tiene `.git`). Por eso, hasta que exista el diff
 * por hashes de la sección 14 del diseño, `runTask` rechaza de entrada
 * cualquier task sobre un `Project` con `isGitRepo: false` — con un error
 * claro, en vez de dejarla correr y terminar con un resultado vacío o
 * incorrecto.
 *
 * Devuelve `true` si esta llamada llegó a tomar el turno de verdad
 * (`QUEUED → RUNNING`) y ejecutó el loop completo, `false` si el auto-claim
 * falló (perdió la carrera de dispatch) y no llegó a hacer nada. El
 * dispatcher (`dispatcher.ts`) usa este valor para decidir si tiene sentido
 * reintentar YA MISMO (algo cambió de verdad, vale la pena re-chequear la
 * cola) o si conviene esperar un poco (perder la carrera no cambia nada del
 * estado — reintentar sin pausa sería un busy-loop apretado hasta que la
 * que sí está corriendo termine).
 */
export async function runTask(taskId: string, opts: RunTaskOptions = {}): Promise<boolean> {
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

  try {
    transitionAndLog(taskId, "RUNNING");
  } catch (claimError) {
    // Perdió la carrera de dispatch (índice único de agent_tasks, o el
    // status ya había cambiado por otra llamada concurrente) — no es un
    // error de la task en sí, así que no se toca su estado ni se registra
    // como FAILED. Simplemente no había turno para ella todavía.
    console.warn(
      `[Coding Agent] runTask(${taskId}) no pudo tomar el turno de RUNNING ` +
        `(probablemente ya hay otra task RUNNING del mismo proyecto):`,
      claimError instanceof Error ? claimError.message : claimError,
    );
    return false;
  }

  const abortController = new AbortController();
  activeRuns.set(taskId, abortController);

  let workspace: TaskWorkspace | null = null;
  try {
    workspace = await createWorkspaceForTask(task, project);
    // Fase 3: `workspaceId` YA quedó apuntado correctamente por
    // `recordWorkspaceCreated` (dentro de createWorkspaceForTask), en la
    // misma transacción que crea el registro — acá solo hace falta
    // guardar `baseCommit`, que es un dato propio de la task, no del
    // workspace en sí.
    updateTaskFields(taskId, { baseCommit: workspace.baseCommit });

    const result = await loopRunner({
      task: task.prompt,
      workspaceRoot: workspace.worktreePath,
      repoRoot: workspace.basePath,
      modelId: task.modelId,
      abortSignal: abortController.signal,
      taskId,
    });

    if (abortController.signal.aborted) {
      transitionAndLog(taskId, "CANCELLED");
    } else if (result.error) {
      transitionAndLog(taskId, "FAILED", { error: result.error, stopReason: result.stopReason }, result.error);
    } else if (result.proposals.length > 0) {
      // Fase 2F: se persisten ANTES de transicionar — si `persistProposals`
      // tirara, la task no debe quedar en READY_FOR_REVIEW prometiendo un
      // diff que no llegó a guardarse (cae al catch de abajo → FAILED).
      persistProposals(taskId, result.proposals);
      transitionAndLog(taskId, "READY_FOR_REVIEW", { stopReason: result.stopReason });
    } else {
      transitionAndLog(taskId, "NO_CHANGES", { stopReason: result.stopReason });
    }
  } catch (error) {
    try {
      transitionAndLog(taskId, "FAILED", { error: error instanceof Error ? error.message : String(error) });
    } catch (transitionError) {
      // Fase 3, sección 12 del diseño: si ni siquiera se puede dejar la
      // task en FAILED (por ejemplo porque ya no está en RUNNING por algún
      // motivo), no dejamos que esto escale a una excepción sin capturar
      // — se loguea y se sigue, la task queda en el estado que tenga.
      console.error(`[Coding Agent] no se pudo transicionar la task ${taskId} a FAILED tras un error:`, transitionError);
    }
  } finally {
    activeRuns.delete(taskId);
    // READY_FOR_REVIEW deja el workspace vivo a propósito — el usuario
    // puede necesitar aplicar/descartar más adelante (2G) sobre ESE mismo
    // worktree. El resto de los estados terminales de esta corrida
    // (FAILED/NO_CHANGES/CANCELLED) no lo necesitan más.
    const finalTask = getTask(taskId);
    if (workspace && finalTask && finalTask.status !== "READY_FOR_REVIEW" && isTerminalStatus(finalTask.status)) {
      await destroyWorkspaceForTask(workspace);
    }
  }

  return true;
}

/**
 * Fase 2H: descarta una task en `READY_FOR_REVIEW` — el usuario mira el
 * diff y decide que no quiere aplicarlo. `transitionTask` ya rechaza sola
 * cualquier estado que no sea `READY_FOR_REVIEW` (única transición
 * permitida a `DISCARDED`, ver `task-store.ts`), así que no hace falta
 * duplicar esa validación acá. Destruye el workspace igual que hace
 * `applyTask` cuando termina sin conflictos — ya no hace falta.
 */
export async function discardTask(taskId: string, reason: CodingTask["discardReason"] = "user"): Promise<CodingTask> {
  const next = transitionAndLog(
    taskId,
    "DISCARDED",
    { discardReason: reason },
    reason === "expired" ? "TTL venció sin decisión" : "descartada por el usuario",
  );
  const workspace = loadWorkspaceForTask(taskId);
  if (workspace) await destroyWorkspaceForTask(workspace);
  return next;
}

/** Best-effort: destruye el workspace actual de una task sin dejar que
 * ningún error (directorio ya borrado a mano, fila sin workspace, lo que
 * sea) se propague. Fase 3, sección 11 del diseño: la reconciliación de
 * boot corre desde `instrumentation.ts` — una excepción sin capturar acá
 * podría impedir que el server termine de arrancar, que es exactamente lo
 * opuesto de lo que esta fase busca. Perder una carpeta huérfana en disco
 * es un problema muchísimo más chico que un server que no arranca. */
async function destroyWorkspaceBestEffort(taskId: string): Promise<void> {
  try {
    const workspace = loadWorkspaceForTask(taskId);
    if (workspace) await destroyWorkspaceForTask(workspace);
  } catch (error) {
    console.warn(`[Coding Agent] no se pudo limpiar el workspace de la task ${taskId} durante la reconciliación (se ignora, no bloquea el boot):`, error);
  }
}

/**
 * Reconciliación al boot (Fase 3, sección 11 del diseño — reemplaza a
 * `reconcileInterruptedTasks` de la Fase 2D): cualquier task que haya
 * quedado en `RUNNING` en SQLite sin que exista un proceso real
 * corriéndola (porque el server se reinició a mitad de una corrida) se
 * reencola desde cero — el restart es invisible, no requiere que un
 * humano la vuelva a crear a mano — SALVO que ya haya agotado
 * `MAX_AUTO_RESTART_RETRIES` reintentos automáticos, en cuyo caso recién
 * ahí pasa a `INTERRUPTED`.
 *
 * Se llama una única vez al arrancar el server (`instrumentation.ts`),
 * antes de aceptar cualquier `CodingTask` nueva. El incremento/reset de
 * `restart_retry_count` sigue la regla exacta de la sección 4 del diseño:
 * acá SOLO se incrementa (nunca se resetea) — el reset ocurre del otro
 * lado, en `transitionAndLog`, cuando una task sale de `RUNNING` por el
 * camino normal.
 */
export async function reconcileOrphanedTasks(): Promise<{ requeued: string[]; interrupted: string[] }> {
  const requeued: string[] = [];
  const interrupted: string[] = [];

  for (const task of listTasks({ status: "RUNNING" })) {
    // Si por algún motivo SÍ hay una corrida activa en memoria para esta
    // task (no debería pasar justo al boot, pero por las dudas), no la
    // tocamos — la reconciliación es solo para huérfanas de verdad.
    if (isTaskActive(task.id)) continue;

    // Best-effort ANTES de decidir el destino — un workspace a medio
    // terminar (o ya borrado a mano) nunca debe impedir la transición.
    await destroyWorkspaceBestEffort(task.id);

    if (task.restartRetryCount >= MAX_AUTO_RESTART_RETRIES) {
      transitionAndLog(
        task.id,
        "INTERRUPTED",
        undefined,
        `${MAX_AUTO_RESTART_RETRIES} reintentos automáticos agotados sin llegar a un estado estable`,
      );
      interrupted.push(task.id);
      continue;
    }

    try {
      transitionAndLog(
        task.id,
        "QUEUED",
        { restartRetryCount: task.restartRetryCount + 1 },
        `reencolada tras reinicio del servidor (intento ${task.restartRetryCount + 1}/${MAX_AUTO_RESTART_RETRIES})`,
      );
      requeued.push(task.id);
    } catch (error) {
      // No debería pasar (venimos de leer RUNNING recién), pero si pasa
      // (otro proceso la tocó justo en el medio), se loguea y se sigue con
      // las demás — un fallo puntual acá no puede tirar todo el boot abajo.
      console.error(`[Coding Agent] no se pudo reencolar la task huérfana ${task.id} durante la reconciliación:`, error);
    }
  }

  return { requeued, interrupted };
}

/**
 * Borra definitivamente una task terminada (ver `TERMINAL_STATUSES` en
 * `task-store.ts`) — pensada para el botón "eliminar" de tasks viejas en
 * la UI. Antes de borrar el registro, limpia best-effort cualquier
 * workspace que pudiera haber quedado vivo en disco (no debería pasar en
 * operación normal — todo estado terminal ya destruye su workspace al
 * llegar ahí — pero es más seguro no asumirlo). `deleteTaskRow` es quien
 * realmente valida que el estado sea terminal y tira `TaskNotTerminalError`
 * si no lo es; acá no se duplica esa validación.
 */
export async function deleteTask(taskId: string): Promise<void> {
  const workspace = loadWorkspaceForTask(taskId);
  if (workspace) {
    try {
      await destroyWorkspaceForTask(workspace);
    } catch (error) {
      console.warn(`[Coding Agent] no se pudo destruir el workspace de la task ${taskId} antes de borrarla (se continúa igual):`, error);
    }
  }
  deleteTaskRow(taskId);
}
