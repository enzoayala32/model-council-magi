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
import { runAgentLoop, type AgentFileProposal, type AgentLoopResult, type RunAgentLoopOptions } from "./loop";
import {
  runAutonomousLoop,
  type AutonomousLoopResult,
  type RunAutonomousLoopOptions,
} from "./autonomy/dispatcher";
import { DEFAULT_AUTONOMY_LIMITS, type AutonomyTaskOutcome } from "./autonomy/contract";
import {
  cancelResumeRequest,
  closeRunForRestart,
  getActivePlan,
  getActiveRunForTask,
  getFileCheckpoints,
  getPlanVersion,
  getResumeChainLength,
  getResumeSourceForTask,
  getRun,
  getStepsForRun,
  invalidatePlanItemsForPaths,
  requestResumeAndClose,
  resetPlanForRestart,
} from "./autonomy/ledger";
import {
  inspectWorkspaceForResume,
  resumeAffectedPaths,
  type ResumeContext,
  type ResumeVerdict,
} from "./autonomy/resume";
import { appendEvent } from "./event-log";
import { persistProposals } from "./proposal-store";

type LoopRunner = (options: RunAgentLoopOptions) => Promise<AgentLoopResult>;
type AutonomyRunner = (options: RunAutonomousLoopOptions) => Promise<AutonomousLoopResult>;

/** Resultado normalizado de cualquiera de los dos loops. `outcome` solo
 * existe en la ruta autónoma (9C) y es la fuente de verdad del estado de
 * la task; el camino legacy sigue decidiendo por `error`/`proposals`. */
type TaskRunResult = {
  error?: string;
  stopReason: string | null;
  proposals: AgentFileProposal[];
  outcome?: AutonomyTaskOutcome;
};

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
  // Fase 9F: cancelar dos veces (o una task que ya terminó) es un no-op.
  // El primer abort dispara la cancelación con gracia del dispatcher; el
  // segundo no debe reportarse como una cancelación nueva.
  if (controller.signal.aborted) return false;
  controller.abort();
  return true;
}

export type RunTaskOptions = {
  /** Inyectable solo para pruebas — el default es el loop real. Correr una
   * task de verdad SIEMPRE debe usar `runAgentLoop`; nunca se pasa este
   * parámetro fuera de un test. */
  loopRunner?: LoopRunner;
  /** Fase 9C — inyectable solo para pruebas. Su presencia implica usar la
   * ruta autónoma (además del flag de entorno), para que un test no
   * dependa de variables globales. */
  autonomyRunner?: AutonomyRunner;
};

/** Fase 9C — la autonomía es opt-in. Sin `MAGI_AUTONOMOUS_LOOP=1` (o un
 * `autonomyRunner` inyectado por un test), el camino legacy queda
 * exactamente igual que en Fase 8. */
export function autonomousLoopEnabled(): boolean {
  const raw = process.env.MAGI_AUTONOMOUS_LOOP?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export function resolveRunnerKind(opts: Pick<RunTaskOptions, "autonomyRunner"> = {}): "autonomy" | "legacy" {
  if (opts.autonomyRunner) return "autonomy";
  return autonomousLoopEnabled() ? "autonomy" : "legacy";
}

/** Fase 8D — el motor de contexto se enciende en producción (tasks reales
 * del Agent) y se puede apagar con `MAGI_CONTEXT_ENGINE_DISABLED=1` sin
 * tocar código. Una llamada DIRECTA a `runAgentLoop` (tests, scripts,
 * consumidores viejos) sigue apagada por defecto: solo `runner.ts` opta
 * explícitamente por encenderla. El governor del historial (8E) NO se
 * enciende acá: requiere aprobación explícita y sigue apagado. */
function contextEngineEnabled(): boolean {
  const raw = process.env.MAGI_CONTEXT_ENGINE_DISABLED?.trim().toLowerCase();
  return !(raw === "1" || raw === "true" || raw === "yes" || raw === "on");
}

/** Fase 9C — adapta el resultado autónomo al mismo shape que consume el
 * mapeo de estados de `runTask`. El estado de la task lo decide
 * `outcome.status` (contrato 9A), no la mera presencia de `error`: un
 * `BLOCKED`/`STALLED` con proposals debe poder ir a `READY_FOR_REVIEW`. */
async function runAutonomyForTask(
  task: CodingTask,
  workspace: TaskWorkspace,
  signal: AbortSignal,
  runner: AutonomyRunner,
  resume?: ResumeContext,
): Promise<TaskRunResult> {
  const result = await runner({
    taskId: task.id,
    task: task.prompt,
    workspaceRoot: workspace.worktreePath,
    repoRoot: workspace.basePath,
    modelId: task.modelId,
    workspaceId: workspace.id,
    baseCommit: workspace.baseCommit,
    resume,
    abortSignal: signal,
    contextEngine: { enabled: contextEngineEnabled() },
  });

  // Un FAILED puede venir de un `state` STALLED/BUDGET_EXHAUSTED/BLOCKED
  // sin proposals: en ese caso el loop no trae `error`, así que se sintetiza
  // uno con el estado real para que la task no quede FAILED sin diagnóstico.
  const error =
    result.outcome.status === "FAILED"
      ? result.error ?? `La corrida autónoma terminó ${result.state} (${result.outcome.stopReason}).`
      : undefined;

  return {
    error,
    stopReason: result.outcome.stopReason,
    proposals: result.proposals,
    outcome: result.outcome,
  };
}

function resumePlanForTask(taskId: string, runId: string) {
  const run = getRun(runId);
  if (!run) return null;
  return run.planVersion > 0 ? getPlanVersion(taskId, run.planVersion) : getActivePlan(taskId);
}

/** Fase 9E — abandona un pedido de reanudación: cancela el flag, marca el
 * plan como historial y destruye el workspace viejo. Se usa cuando el
 * runner decide que no puede reanudar (workspace ausente/drift de base) o
 * cuando la autonomía está apagada. */
async function abandonResumeForTask(taskId: string, sourceRunId: string, reason: string): Promise<void> {
  const plan = resumePlanForTask(taskId, sourceRunId);
  if (plan) {
    try {
      resetPlanForRestart(plan.id, reason);
    } catch (error) {
      console.warn(`[Coding Agent] no se pudo resetear el plan de la task ${taskId} al abandonar la reanudación:`, error);
    }
  }
  try {
    cancelResumeRequest(sourceRunId);
  } catch (error) {
    console.warn(`[Coding Agent] no se pudo cancelar el pedido de reanudación ${sourceRunId}:`, error);
  }
  await destroyWorkspaceBestEffort(taskId);
}

function resumeWarningText(verdict: ResumeVerdict): string[] {
  return verdict.warnings.map((warning) => warning.message);
}

/** Fase 9E — revalida el workspace contra el último checkpoint y arma el
 * `ResumeContext` que consume el dispatcher. Devuelve `null` si no hay
 * pedido pendiente o si el workspace ya no es reanudable; en ese caso deja
 * todo listo para un restart desde cero. */
async function prepareResumeForTask(
  task: CodingTask,
): Promise<{ workspace: TaskWorkspace; resume: ResumeContext } | null> {
  const source = getResumeSourceForTask(task.id);
  if (!source) return null;

  const workspace = loadWorkspaceForTask(task.id);
  if (!workspace) {
    await abandonResumeForTask(task.id, source.id, "Workspace ausente al reanudar; se reinicia desde cero.");
    return null;
  }

  const plan = resumePlanForTask(task.id, source.id);
  const checkpoints = getFileCheckpoints(source.id);
  let verdict: ResumeVerdict;
  try {
    verdict = await inspectWorkspaceForResume({
      worktreePath: workspace.worktreePath,
      repoRoot: workspace.basePath,
      baseCommit: workspace.baseCommit ?? task.baseCommit ?? source.baseCommit,
      checkpointHead: source.headCommit ?? workspace.baseCommit ?? task.baseCommit,
      checkpoints,
    });
  } catch (error) {
    console.warn(`[Coding Agent] la verificación de reanudación de ${task.id} falló (se reinicia desde cero):`, error);
    await abandonResumeForTask(task.id, source.id, "No se pudo verificar el workspace; se reinicia desde cero.");
    return null;
  }

  if (!verdict.resumable) {
    await abandonResumeForTask(
      task.id,
      source.id,
      `Workspace no reanudable (${verdict.reason}); se reinicia desde cero.`,
    );
    return null;
  }

  const affected = resumeAffectedPaths(verdict);
  if (plan && (affected.drifted.length > 0 || affected.missing.length > 0)) {
    try {
      invalidatePlanItemsForPaths(
        plan.id,
        [...affected.drifted, ...affected.missing],
        "Evidencia invalidada por drift/archivo ausente durante la reanudación.",
      );
    } catch (error) {
      console.warn(`[Coding Agent] no se pudo invalidar evidencia drift de ${task.id}:`, error);
    }
  }

  const planValid = Boolean(plan && plan.items.length > 0);
  const warnings = resumeWarningText(verdict);
  if (!planValid) {
    warnings.push("El plan persistido no es utilizable; se replanifica desde el estado actual del workspace.");
  }

  return {
    workspace,
    resume: {
      ofRunId: source.id,
      planVersion: planValid ? source.planVersion : 0,
      headCommit: verdict.headCommit ?? source.headCommit ?? workspace.baseCommit,
      attempt: getResumeChainLength(source.id) + 1,
      warnings,
      verifiedAt: verdict.verifiedAt,
      budget: source.budget,
    },
  };
}

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
 * por hashes de la sección 14 del diseño, `runTask` rechaza cualquier task
 * sobre un `Project` con `isGitRepo: false` — con un error claro, en vez
 * de dejarla correr y terminar con un resultado vacío o incorrecto.
 *
 * Fase 4A: el chequeo de `isGitRepo` vive DENTRO del try principal (abajo,
 * después del claim a `RUNNING`), no antes — es la capa DEFENSIVA de una
 * validación de dos capas (la primaria está en `POST /api/agent/tasks`,
 * que rechaza la creación de la task de entrada). Antes de este fix, el
 * chequeo estaba ACÁ ARRIBA, antes del claim, y tirar una excepción en ese
 * punto escapaba de `runTask` por completo — el `dispatcher.ts` la
 * atrapaba, pero como `runTask` nunca llegaba a `return false` (la
 * excepción cortaba antes), la task nunca salía de `QUEUED`, y el
 * dispatcher reintentaba cada `RETRY_AFTER_LOST_RACE_MS` para siempre,
 * bloqueando la cola de ese proyecto. Moviéndolo adentro del try principal,
 * cualquier fallo acá cae en el mismo `catch` que ya lleva a `FAILED` —
 * la task llega a un estado terminal real, libera el slot, y `runTask`
 * devuelve `true` (llegó a "correr" en el sentido de haber tomado el turno
 * y resuelto algo, aunque ese algo haya sido fallar).
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
  const useAutonomy = resolveRunnerKind(opts) === "autonomy";

  const task = getTask(taskId);
  if (!task) throw new Error(`No existe la task ${taskId}`);
  if (task.status !== "QUEUED") throw new Error(`La task ${taskId} no está en QUEUED (está en ${task.status}).`);

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
    const project = getProject(task.projectId);
    if (!project) throw new Error(`No existe el Project ${task.projectId}`);

    if (!project.isGitRepo) {
      throw new Error(
        "Este proyecto no es un repositorio git — el Coding Agent todavía no puede ejecutar tareas reales ahí. Convertilo en un repo git (`git init`) para poder usarlo.",
      );
    }

    // Fase 9E: si la reconciliación de boot dejó un pedido de reanudación,
    // se revalida el workspace y se reutiliza. Si no es reanudable, el
    // helper ya lo destruyó y dejó el plan como historial: se crea uno
    // nuevo abajo, exactamente como un restart desde cero.
    let resume: ResumeContext | null = null;
    const pendingResume = getResumeSourceForTask(taskId);
    if (pendingResume) {
      if (useAutonomy) {
        const prepared = await prepareResumeForTask(task);
        if (prepared) {
          workspace = prepared.workspace;
          resume = prepared.resume;
        }
      } else {
        // La autonomía se apagó entre el crash y el claim: el loop legacy
        // no entiende el plan/ledger, así que se reencola desde cero.
        await abandonResumeForTask(taskId, pendingResume.id, "Autonomía desactivada; se reinicia desde cero.");
      }
    }

    if (!workspace) {
      workspace = await createWorkspaceForTask(task, project);
    }
    // Fase 3: `workspaceId` YA quedó apuntado correctamente por
    // `recordWorkspaceCreated` (dentro de createWorkspaceForTask), en la
    // misma transacción que crea el registro — acá solo hace falta
    // guardar `baseCommit`, que es un dato propio de la task, no del
    // workspace en sí.
    updateTaskFields(taskId, { baseCommit: workspace.baseCommit });

    const result: TaskRunResult = useAutonomy
      ? await runAutonomyForTask(task, workspace, abortController.signal, opts.autonomyRunner ?? runAutonomousLoop, resume ?? undefined)
      : await loopRunner({
          task: task.prompt,
          workspaceRoot: workspace.worktreePath,
          repoRoot: workspace.basePath,
          modelId: task.modelId,
          abortSignal: abortController.signal,
          taskId,
          // Fase 8D: encendido para tasks reales; `MAGI_CONTEXT_ENGINE_DISABLED=1`
          // restaura el comportamiento previo sin recompilar. El governor sigue
          // apagado (8E) hasta que se apruebe explícitamente.
          contextEngine: { enabled: contextEngineEnabled() },
        });

    if (abortController.signal.aborted) {
      transitionAndLog(taskId, "CANCELLED");
    } else if (result.outcome) {
      // Fase 9C: el contrato autónomo ya resolvió el estado real de la
      // task (incluido BLOCKED/STALLED/BUDGET_EXHAUSTED con trabajo
      // parcial). No se reinterpreta a partir de `error`.
      switch (result.outcome.status) {
        case "FAILED":
          transitionAndLog(taskId, "FAILED", { error: result.error, stopReason: result.stopReason }, result.error);
          break;
        case "CANCELLED":
          transitionAndLog(taskId, "CANCELLED");
          break;
        case "READY_FOR_REVIEW":
          // Fase 2F: persistir ANTES de transicionar, por la misma razón
          // que en el camino legacy.
          persistProposals(taskId, result.proposals);
          transitionAndLog(taskId, "READY_FOR_REVIEW", { stopReason: result.stopReason });
          break;
        case "NO_CHANGES":
          transitionAndLog(taskId, "NO_CHANGES", { stopReason: result.stopReason });
          break;
      }
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
  // Fase 4D: la regla es sobre `gitCommitStatus`, nunca sobre el status
  // final de la task — un apply parcial (algunos archivos aplicados,
  // otros en conflicto) puede haber commiteado con éxito antes de que el
  // usuario decida descartar el resto; ese commit real no se pierde.
  if (workspace) await destroyWorkspaceForTask(workspace, { keepBranch: next.gitCommitStatus === "success" });
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
    const task = getTask(taskId);
    if (workspace) await destroyWorkspaceForTask(workspace, { keepBranch: task?.gitCommitStatus === "success" });
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
 *
 * Fase 4D (hallazgo de v3): `applyTask` solo mira tasks `RUNNING`
 * huérfanas — una task que quedó a mitad de `APPLYING` (el server se cayó
 * justo durante un apply) nunca pasa por acá y queda atascada para
 * siempre, porque `APPLYING` no es un estado que ningún dispatcher vuelva
 * a tocar solo. La transición `APPLYING → READY_FOR_REVIEW` YA es legal
 * (es la misma que usa `apply.ts` para el rollback por conflicto), así que
 * alcanza con dispararla acá sin reintentar el apply por sí sola — el
 * usuario decide desde ahí si reintentar o descartar. No toca
 * `restart_retry_count` (ese contador es específico de `RUNNING`, no
 * aplica a este caso) ni destruye el workspace (puede seguir siendo
 * necesario para terminar de aplicar a mano).
 */
export async function reconcileOrphanedTasks(): Promise<{
  requeued: string[];
  interrupted: string[];
  recoveredApplying: string[];
  resumed: string[];
}> {
  const requeued: string[] = [];
  const interrupted: string[] = [];
  const recoveredApplying: string[] = [];
  const resumed: string[] = [];

  for (const task of listTasks({ status: "RUNNING" })) {
    // Si por algún motivo SÍ hay una corrida activa en memoria para esta
    // task (no debería pasar justo al boot, pero por las dudas), no la
    // tocamos — la reconciliación es solo para huérfanas de verdad.
    if (isTaskActive(task.id)) continue;

    const activeRun = getActiveRunForTask(task.id);

    // Sin corrida de Fase 9: comportamiento legacy exacto (restart desde
    // cero, con el workspace destruido antes de reencolar).
    if (!activeRun) {
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
      continue;
    }

    // Fase 9E: a partir de acá hay una corrida autónoma huérfana. Primero
    // los topes duros; después la verificación real del workspace.
    if (task.restartRetryCount >= MAX_AUTO_RESTART_RETRIES) {
      try {
        closeRunForRestart(activeRun.id, "retries_exhausted", "Reintentos automáticos agotados.");
      } catch (error) {
        console.error(`[Coding Agent] no se pudo cerrar la corrida ${activeRun.id} al agotar reintentos:`, error);
      }
      await destroyWorkspaceBestEffort(task.id);
      try {
        transitionAndLog(
          task.id,
          "INTERRUPTED",
          { stopReason: "retries_exhausted" },
          `${MAX_AUTO_RESTART_RETRIES} reintentos automáticos agotados sin llegar a un estado estable`,
        );
      } catch (error) {
        console.error(`[Coding Agent] no se pudo interrumpir la task ${task.id} al agotar reintentos:`, error);
      }
      interrupted.push(task.id);
      continue;
    }

    if (getResumeChainLength(activeRun.id) >= DEFAULT_AUTONOMY_LIMITS.maxResumeAttempts) {
      try {
        closeRunForRestart(activeRun.id, "resume_exhausted", "Se agotaron los intentos de reanudación.");
      } catch (error) {
        console.error(`[Coding Agent] no se pudo cerrar la corrida ${activeRun.id} al agotar reanudaciones:`, error);
      }
      await destroyWorkspaceBestEffort(task.id);
      try {
        transitionAndLog(
          task.id,
          "INTERRUPTED",
          { stopReason: "resume_exhausted" },
          `${DEFAULT_AUTONOMY_LIMITS.maxResumeAttempts} intentos de reanudación agotados`,
        );
      } catch (error) {
        console.error(`[Coding Agent] no se pudo interrumpir la task ${task.id} al agotar reanudaciones:`, error);
      }
      interrupted.push(task.id);
      continue;
    }

    const workspace = loadWorkspaceForTask(task.id);
    const plan = resumePlanForTask(task.id, activeRun.id);
    const checkpoints = getFileCheckpoints(activeRun.id);
    const hasSteps = getStepsForRun(activeRun.id, 1).length > 0;
    const hasProgress = Boolean(plan && plan.items.length > 0) || checkpoints.length > 0 || hasSteps;

    let verdict: ResumeVerdict | null = null;
    if (workspace && hasProgress) {
      try {
        verdict = await inspectWorkspaceForResume({
          worktreePath: workspace.worktreePath,
          repoRoot: workspace.basePath,
          baseCommit: workspace.baseCommit ?? task.baseCommit ?? activeRun.baseCommit,
          checkpointHead: activeRun.headCommit ?? workspace.baseCommit ?? task.baseCommit,
          checkpoints,
        });
      } catch (error) {
        console.warn(`[Coding Agent] no se pudo verificar el workspace de ${task.id} para reanudar:`, error);
        verdict = null;
      }
    }

    if (workspace && hasProgress && verdict?.resumable) {
      try {
        requestResumeAndClose(activeRun.id, "Corrida interrumpida por reinicio del servidor; se reanuda.");
        const affected = resumeAffectedPaths(verdict);
        if (plan && (affected.drifted.length > 0 || affected.missing.length > 0)) {
          invalidatePlanItemsForPaths(
            plan.id,
            [...affected.drifted, ...affected.missing],
            "Evidencia invalidada por drift/archivo ausente durante la reanudación.",
          );
        }
        const warningCount = verdict.warnings.length;
        const detail =
          warningCount > 0
            ? `reanudación verificada con ${warningCount} advertencia(s) (${affected.drifted.length} drift, ${affected.missing.length} ausente(s))`
            : "reanudación verificada sin drift";
        transitionAndLog(
          task.id,
          "QUEUED",
          { restartRetryCount: task.restartRetryCount + 1 },
          `${detail}; intento ${task.restartRetryCount + 1}/${MAX_AUTO_RESTART_RETRIES}`,
        );
        requeued.push(task.id);
        resumed.push(task.id);
        continue;
      } catch (error) {
        // Si algo falló después de marcar el pedido, se limpia para no
        // dejar una reanudación fantasma y se cae al restart desde cero.
        console.error(`[Coding Agent] no se pudo preparar la reanudación de ${task.id} (se reinicia desde cero):`, error);
        try {
          closeRunForRestart(activeRun.id, "error", "No se pudo preparar la reanudación; se reinicia desde cero.");
        } catch {
          // best-effort
        }
      }
    }

    // Restart desde cero: el workspace y el plan viejo quedan solo como
    // historial. Nunca se pisa un archivo con drift.
    const restartReason = workspace
      ? hasProgress
        ? `workspace no reanudable (${verdict?.reason ?? "verificación fallida"})`
        : "sin checkpoint utilizable"
      : "workspace ausente";
    try {
      closeRunForRestart(activeRun.id, "error", `Corrida no reanudable: ${restartReason}.`);
    } catch (error) {
      console.error(`[Coding Agent] no se pudo cerrar la corrida ${activeRun.id} antes del restart:`, error);
    }
    if (plan) {
      try {
        resetPlanForRestart(plan.id, `Plan anterior abandonado: ${restartReason}.`);
      } catch (error) {
        console.warn(`[Coding Agent] no se pudo resetear el plan ${plan.id} para restart:`, error);
      }
    }
    await destroyWorkspaceBestEffort(task.id);

    try {
      transitionAndLog(
        task.id,
        "QUEUED",
        { restartRetryCount: task.restartRetryCount + 1 },
        `reencolada desde cero (${restartReason}); intento ${task.restartRetryCount + 1}/${MAX_AUTO_RESTART_RETRIES}`,
      );
      requeued.push(task.id);
    } catch (error) {
      console.error(`[Coding Agent] no se pudo reencolar la task huérfana ${task.id} durante la reconciliación:`, error);
    }
  }

  for (const task of listTasks({ status: "APPLYING" })) {
    if (isTaskActive(task.id)) continue;
    try {
      transitionAndLog(task.id, "READY_FOR_REVIEW", undefined, "apply interrumpido por un reinicio del servidor — revisar antes de reintentar");
      recoveredApplying.push(task.id);
    } catch (error) {
      console.error(`[Coding Agent] no se pudo recuperar la task ${task.id} atascada en APPLYING durante la reconciliación:`, error);
    }
  }

  return { requeued, interrupted, recoveredApplying, resumed };
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
      const task = getTask(taskId);
      await destroyWorkspaceForTask(workspace, { keepBranch: task?.gitCommitStatus === "success" });
    } catch (error) {
      console.warn(`[Coding Agent] no se pudo destruir el workspace de la task ${taskId} antes de borrarla (se continúa igual):`, error);
    }
  }
  deleteTaskRow(taskId);
}
