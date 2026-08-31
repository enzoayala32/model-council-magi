/**
 * Hook de arranque oficial de Next.js (estable desde Next 15, sin flag de
 * config). Fase 3 (sección 11 del diseño): acá corre la reconciliación de
 * tasks huérfanas (`reconcileOrphanedTasks`, reencola o interrumpe según
 * `restart_retry_count`) y, después, se dispara el dispatcher
 * (`maybeDispatchNext`) por cada proyecto que haya quedado con alguna
 * `QUEUED` pendiente — tanto las recién reencoladas como las que ya
 * estaban esperando su turno antes del restart.
 *
 * Todo el cuerpo está envuelto en try/catch: una excepción acá impediría
 * que el server termine de arrancar, que es exactamente lo opuesto de lo
 * que esta fase busca (ver diseño de Fase 3, secciones 11 y 12).
 *
 * Guardado con `NEXT_RUNTIME === "nodejs"` porque `register()` también se
 * invoca en el runtime `edge` si existiera alguna ruta edge — `better-sqlite3`
 * (vía `lib/db.ts`) es nativo y no corre ahí. Este proyecto no tiene rutas
 * edge hoy, pero el check es gratis y evita un crash silencioso el día que
 * se agregue una.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  try {
    const { reconcileOrphanedTasks } = await import("./lib/agent/runner");
    const { listTasks } = await import("./lib/agent/task-store");
    const { maybeDispatchNext } = await import("./lib/agent/dispatcher");

    const { requeued, interrupted } = await reconcileOrphanedTasks();
    if (requeued.length > 0) {
      console.log(`[Coding Agent] ${requeued.length} task(s) reencolada(s) tras un reinicio: ${requeued.join(", ")}`);
    }
    if (interrupted.length > 0) {
      console.log(`[Coding Agent] ${interrupted.length} task(s) quedaron INTERRUPTED (agotaron los reintentos automáticos): ${interrupted.join(", ")}`);
    }

    const projectIds = new Set(listTasks({ status: "QUEUED" }).map((t) => t.projectId));
    for (const projectId of projectIds) {
      maybeDispatchNext(projectId);
    }
  } catch (error) {
    console.error("[Coding Agent] la reconciliación/dispatch de arranque falló — el server sigue levantando igual:", error);
  }
}
