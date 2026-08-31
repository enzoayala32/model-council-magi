import { getOldestQueuedTaskForProject } from "./task-store";
import { runTask } from "./runner";

/**
 * Fase 3 (sección 3 del diseño): mapa en memoria de qué task está
 * `RUNNING` ahora mismo en ESTE proceso, por proyecto — es una
 * OPTIMIZACIÓN (evita pegarle a la DB en cada creación/finalización de
 * task para chequear si ya hay algo corriendo), NO la garantía de
 * seguridad. La garantía real de "una sola RUNNING por proyecto" la da el
 * índice único parcial de `agent_tasks` + el compare-and-swap de
 * `transitionTask` (ver `task-store.ts`) — este Map puede estar
 * desactualizado (por ejemplo, recién reiniciado el proceso) sin que eso
 * comprometa la seguridad: en el peor caso, `runTask` intenta arrancar una
 * task que en realidad no puede, y su propio auto-claim lo rechaza limpio.
 */
const activeTaskByProject = new Map<string, string>();

/**
 * Si no hay ya una task corriendo para `projectId` (según el Map), busca
 * la `QUEUED` más vieja de ese proyecto y la dispara. Idempotente: llamarla
 * de más no hace nada raro — si ya hay algo en el Map, no hace ni una
 * query.
 *
 * Al terminar esa corrida, se vuelve a llamar sola para avanzar la cola —
 * pero SOLO inmediatamente si esa corrida realmente ocupó el turno de
 * verdad (`runTask` devolvió `true`). Si `runTask` devolvió `false` (la
 * task eligió perdió la carrera de dispatch contra otra ya `RUNNING` del
 * mismo proyecto — ver `runner.ts`), nada cambió en el estado real, así
 * que reintentar de inmediato sería un busy-loop síncrono apretado hasta
 * que la que sí está corriendo termine. En ese caso se reintenta con un
 * pequeño respiro (`RETRY_AFTER_LOST_RACE_MS`) en vez de encadenar sin
 * pausa — encontrado corriendo la prueba de aceptación de esta misma fase
 * (caso "doble dispatch"), no es un caso hipotético.
 *
 * Fase 3, sección 12 del diseño: el cuerpo entero está envuelto en su
 * propio try/catch — si `getOldestQueuedTaskForProject` o cualquier otra
 * llamada síncrona de acá tira, NO puede escapar como una excepción sin
 * capturar. Esto importa particularmente para el ciclo async de abajo: un
 * throw sin capturar ahí sería una unhandled promise rejection que en
 * Node 15+ termina el proceso por default — exactamente lo opuesto de lo
 * que esta fase busca (robustez ante fallas).
 */
const RETRY_AFTER_LOST_RACE_MS = 200;

export function maybeDispatchNext(projectId: string): void {
  try {
    if (activeTaskByProject.has(projectId)) return;

    const next = getOldestQueuedTaskForProject(projectId);
    if (!next) return;

    activeTaskByProject.set(projectId, next.id);

    (async () => {
      let claimedTheRun = false;
      try {
        claimedTheRun = await runTask(next.id);
      } catch (error) {
        // `runTask` ya maneja sus propios errores internamente (los deja
        // en `task.error` + status `FAILED`) — esto es una red de
        // seguridad para el caso, no esperado, de que algo reviente ANTES
        // de ese manejo interno.
        console.error(`[Coding Agent] runTask(${next.id}) tiró sin que runner.ts lo haya capturado internamente:`, error);
      } finally {
        activeTaskByProject.delete(projectId);
      }

      if (claimedTheRun) {
        maybeDispatchNext(projectId);
      } else {
        setTimeout(() => maybeDispatchNext(projectId), RETRY_AFTER_LOST_RACE_MS);
      }
    })().catch((error) => {
      console.error(`[Coding Agent] maybeDispatchNext(${projectId}) falló de forma inesperada en su ciclo async:`, error);
    });
  } catch (error) {
    console.error(`[Coding Agent] maybeDispatchNext(${projectId}) falló de forma inesperada (no se propaga, para no tirar abajo el proceso):`, error);
  }
}

/** Solo para pruebas — inspeccionar/limpiar el estado del dispatcher entre
 * casos sin depender de que cada test corra en su propio proceso. */
export function __resetDispatcherForTests(): void {
  activeTaskByProject.clear();
}
