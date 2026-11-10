/**
 * Cola de prompts de una CodingTask — pedido de Enzo (2026-11-10).
 *
 * QUÉ PIDE: "Guardar un prompt hasta que termine un bucle completo y dé el
 * resumen el agente; cuando el agente da el resumen de las tareas, que le pase
 * el prompt que está en cola" y "se deben poder dejar varios prompts
 * consecutivos".
 *
 * QUÉ SIGNIFICA ACÁ, en concreto: el agente atiende un prompt por ciclo y
 * termina con un resumen. Si el usuario escribe otro prompt mientras el agente
 * trabaja, hoy se pierde (o hay que crear otra task a mano, con workspace nuevo
 * y contexto nuevo). Con este módulo el prompt se GUARDA y, cuando el ciclo en
 * curso termina y da su resumen, el runner toma el siguiente de la cola y se lo
 * pasa al agente —misma task, mismo workspace, mismo contexto de trabajo— sin
 * que el usuario tenga que hacer nada. Los prompts encolados se atienden EN
 * ORDEN, uno por ciclo.
 *
 * DISEÑO:
 *
 *  - Tabla propia (`agent_prompt_queue`), no una columna JSON en `agent_tasks`:
 *    el encolado es una escritura CONCURRENTE (el usuario encola mientras el
 *    runner lee y marca), y con una tabla cada INSERT es atómico. Con un JSON
 *    habría que leer-modificar-escribir la fila, y dos encolados simultáneos se
 *    pisarían.
 *  - `position` es un entero denso por task que se recalcula al encolar: es lo
 *    que define el orden, y al reencolar después de un `cancel` no quedan
 *    huecos. La UI lo usa tal cual, sin reordenar de su lado.
 *  - El ciclo que está corriendo se marca `running`. No se borra al terminar:
 *    queda `done` para que la UI pueda mostrar "este prompt ya se ejecutó", y
 *    para no perder el rastro si algo falla a mitad.
 *  - Nada de esto se borra nunca salvo `cancelQueuedPrompt` (el usuario) y
 *    `clearFinishedPrompts` (limpieza explícita). La tarea se referencia con
 *    ON DELETE CASCADE, así que borrar la task se lleva la cola.
 */

import crypto from "node:crypto";
import { getDb } from "../db";

export type QueuedPromptState = "waiting" | "running" | "done" | "cancelled";

export type QueuedPrompt = {
  id: string;
  taskId: string;
  prompt: string;
  position: number;
  createdAt: number;
  startedAt: number | null;
  state: QueuedPromptState;
};

/** Tope de prompts en cola: evita que un usuario (o un cliente roto) encole
 *  miles y el agente se pase horas drenando sin que nadie los mire. No es un
 *  límite de seguridad: es uno de cordialidad, con un mensaje claro. */
export const MAX_QUEUED_PROMPTS = 50;

/** Etiquetas en español para la UI. En un solo lugar para que la API y la
 *  pantalla no inventen cada una la suya. */
export const QUEUE_STATE_LABELS: Record<QueuedPromptState, string> = {
  waiting: "en cola",
  running: "en ejecución",
  done: "hecho",
  cancelled: "cancelado",
};

type Row = {
  id: string;
  task_id: string;
  prompt: string;
  position: number;
  created_at: number;
  started_at: number | null;
  state: string;
};

function rowToQueued(row: Row): QueuedPrompt {
  const estado: QueuedPromptState =
    row.state === "waiting" || row.state === "running" || row.state === "done" || row.state === "cancelled" ? row.state : "waiting";
  return {
    id: row.id,
    taskId: row.task_id,
    prompt: row.prompt,
    position: row.position,
    createdAt: row.created_at,
    startedAt: row.started_at,
    state: estado,
  };
}

export class QueueLlenaError extends Error {
  constructor(readonly max: number) {
    super(`La cola está llena: ya hay ${max} prompts esperando. Esperá a que el agente avance o cancelá alguno.`);
    this.name = "QueueLlenaError";
  }
}

/**
 * Encola un prompt al FINAL de la cola de la task.
 *
 * No valida el estado de la task: encolar sobre una task terminal es legal (el
 * usuario puede estar preparando lo próximo) y quien decide qué hacer con eso es
 * el runner, no el store. Devuelve el prompt con su posición.
 */
export function enqueuePrompt(taskId: string, prompt: string): QueuedPrompt {
  const texto = prompt.trim();
  if (!texto) throw new Error("El prompt a encolar no puede estar vacío.");

  const esperando = getDb().prepare("SELECT COUNT(*) AS n FROM agent_prompt_queue WHERE task_id = ? AND state = 'waiting'").get(taskId) as { n: number };
  if (esperando.n >= MAX_QUEUED_PROMPTS) throw new QueueLlenaError(MAX_QUEUED_PROMPTS);

  // Posición siguiente: una más que la máxima actual de la task (cualquier
  // estado), para que un `cancel` no deje huecos que rompan el orden visual.
  const maxRow = getDb().prepare("SELECT COALESCE(MAX(position), -1) AS max FROM agent_prompt_queue WHERE task_id = ?").get(taskId) as { max: number };
  const entrada: QueuedPrompt = {
    id: crypto.randomUUID(),
    taskId,
    prompt: texto,
    position: maxRow.max + 1,
    createdAt: Date.now(),
    startedAt: null,
    state: "waiting",
  };
  getDb()
    .prepare(
      `INSERT INTO agent_prompt_queue (id, task_id, prompt, position, created_at, started_at, state)
       VALUES (@id, @taskId, @prompt, @position, @createdAt, @startedAt, @state)`,
    )
    .run({
      id: entrada.id,
      taskId: entrada.taskId,
      prompt: entrada.prompt,
      position: entrada.position,
      createdAt: entrada.createdAt,
      startedAt: entrada.startedAt,
      state: entrada.state,
    });
  return entrada;
}

/** La cola completa de una task, en orden de atención. */
export function listQueuedPrompts(taskId: string): QueuedPrompt[] {
  const rows = getDb().prepare("SELECT * FROM agent_prompt_queue WHERE task_id = ? ORDER BY position ASC").all(taskId) as Row[];
  return rows.map(rowToQueued);
}

/** Los que están esperando, en orden. Es lo que el runner va a drenar. */
export function listWaitingPrompts(taskId: string): QueuedPrompt[] {
  return listQueuedPrompts(taskId).filter((p) => p.state === "waiting");
}

/** Cuántos hay esperando — para el badge de la UI, sin traer la lista. */
export function countWaitingPrompts(taskId: string): number {
  const row = getDb().prepare("SELECT COUNT(*) AS n FROM agent_prompt_queue WHERE task_id = ? AND state = 'waiting'").get(taskId) as { n: number };
  return row.n;
}

/** El más viejo de los que esperan, o null si no hay nada. */
export function nextWaitingPrompt(taskId: string): QueuedPrompt | null {
  const row = getDb()
    .prepare("SELECT * FROM agent_prompt_queue WHERE task_id = ? AND state = 'waiting' ORDER BY position ASC LIMIT 1")
    .get(taskId) as Row | undefined;
  return row ? rowToQueued(row) : null;
}

/**
 * Marca un prompt como `running`. Devuelve false si ya no estaba `waiting`
 * (otro proceso lo tomó primero): el runner lo usa para no hacer dos ciclos con
 * el mismo prompt.
 */
export function markPromptRunning(id: string): boolean {
  const res = getDb()
    .prepare("UPDATE agent_prompt_queue SET state = 'running', started_at = ? WHERE id = ? AND state = 'waiting'")
    .run(Date.now(), id);
  return res.changes > 0;
}

/** Marca un prompt como terminado (el ciclo completó su resumen). */
export function markPromptDone(id: string): void {
  getDb().prepare("UPDATE agent_prompt_queue SET state = 'done' WHERE id = ?").run(id);
}

/**
 * Saca de la cola un prompt que todavía no empezó. Devuelve false si ya estaba
 * corriendo o terminado: no se puede cancelar lo que el agente está atendiendo
 * ( para eso está el botón de cancelar la task).
 */
export function cancelQueuedPrompt(id: string): boolean {
  const res = getDb().prepare("UPDATE agent_prompt_queue SET state = 'cancelled' WHERE id = ? AND state = 'waiting'").run(id);
  return res.changes > 0;
}

/** Borra los prompts ya resueltos (done/cancelled) de una task. Limpieza
 *  explícita, no algo que pase solo: la UI quiere poder mostrar el historial. */
export function clearFinishedPrompts(taskId: string): number {
  const res = getDb().prepare("DELETE FROM agent_prompt_queue WHERE task_id = ? AND state IN ('done', 'cancelled')").run(taskId);
  return res.changes;
}
