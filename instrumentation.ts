/**
 * Hook de arranque oficial de Next.js (estable desde Next 15, sin flag de
 * config). Fase 2H: es el único lugar donde se llama
 * `reconcileInterruptedTasks()` (ver diseño de Fase 2, sección 13) — corre
 * una única vez por proceso, antes de que el server acepte tráfico.
 *
 * Guardado con `NEXT_RUNTIME === "nodejs"` porque `register()` también se
 * invoca en el runtime `edge` si existiera alguna ruta edge — `better-sqlite3`
 * (vía `lib/db.ts`) es nativo y no corre ahí. Este proyecto no tiene rutas
 * edge hoy, pero el check es gratis y evita un crash silencioso el día que
 * se agregue una.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { reconcileInterruptedTasks } = await import("./lib/agent/runner");
  const { interrupted } = await reconcileInterruptedTasks();
  if (interrupted.length > 0) {
    console.log(`[Coding Agent] ${interrupted.length} task(s) quedaron INTERRUPTED tras un reinicio: ${interrupted.join(", ")}`);
  }
}
