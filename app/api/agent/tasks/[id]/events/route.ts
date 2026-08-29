import { getTask, type TaskStatus } from "@/lib/agent/task-store";
import { listEvents } from "@/lib/agent/event-log";

export const dynamic = "force-dynamic";

const POLL_INTERVAL_MS = 400;

/** Mientras la task está en uno de estos estados puede seguir llegando
 * eventos nuevos — el stream se mantiene abierto. Cualquier otro estado
 * (terminal, o `READY_FOR_REVIEW`/`APPLYING` que ya no emiten eventos de
 * *loop*, solo un `status_change` puntual que igual queda cubierto por el
 * último snapshot) cierra el stream apenas se detecta. */
function isStreaming(status: TaskStatus): boolean {
  return status === "QUEUED" || status === "RUNNING";
}

/**
 * Fase 2H — SSE con replay desde `seq` (ver diseño de Fase 2, sección 12 y
 * la prueba de aceptación de 2H): un cliente que se conecta (por primera
 * vez, o reconectando tras cerrar/reabrir el navegador) pide "eventos desde
 * seq X" y los recibe TODOS antes de empezar a recibir los nuevos en vivo —
 * nunca hay una ventana en la que se pierda un evento entre el replay y el
 * live tail, porque ambos leen de la misma tabla `agent_events` con la
 * misma condición `seq > lastSeq`, sea la primera lectura o la enésima.
 *
 * Implementado con polling (cada 400ms) sobre SQLite, no con un
 * `EventEmitter` en memoria — ver diseño de Fase 2, sección 13: la
 * arquitectura ya es "un solo proceso Node, SQLite como fuente de verdad",
 * y polling sobre una tabla local es sencillo, no le suma superficie de
 * bugs nueva (nada de listeners que limpiar, nada que se pierda si el
 * cliente se reconecta a mitad de un evento), y a esta escala (una task
 * emitiendo unos pocos eventos por segundo como mucho) el costo es
 * irrelevante. Es exactamente el tipo de solución que pide la sección 13:
 * ni sub-diseñada ni sobre-ingenierizada para el caso de uso real.
 *
 * Replay: acepta `sinceSeq` tanto por query param (`?sinceSeq=N`, para un
 * cliente que arranca de cero sabiendo su último seq visto, ej. guardado en
 * el propio estado de React) como por el header estándar `Last-Event-ID`
 * (que el propio `EventSource` del browser reenvía solo en un reconnect
 * automático tras un corte de red — sin que el cliente tenga que manejarlo
 * a mano). Sin ninguno de los dos, manda el historial completo desde el
 * principio — el caso de "abrí la task por primera vez" o "cerré y reabrí
 * el navegador" (sección 20, prueba de aceptación de 2H): SQLite ya tiene
 * todo, no hace falta que el cliente recuerde nada para no perder eventos.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: taskId } = await params;

  const task = getTask(taskId);
  if (!task) return new Response(`No existe la task ${taskId}.`, { status: 404 });

  const url = new URL(request.url);
  const headerSinceSeq = request.headers.get("last-event-id");
  const querySinceSeq = url.searchParams.get("sinceSeq");
  const rawSinceSeq = headerSinceSeq ?? querySinceSeq;
  const parsedSinceSeq = rawSinceSeq !== null ? Number(rawSinceSeq) : NaN;
  const sinceSeq = Number.isFinite(parsedSinceSeq) ? parsedSinceSeq : undefined;

  const encoder = new TextEncoder();
  let closed = false;
  let intervalHandle: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream({
    start(controller) {
      const safeEnqueue = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // El cliente ya cortó la conexión — el listener de "abort" de
          // abajo se encarga de limpiar el interval; acá solo evitamos que
          // un enqueue tardío tire una excepción no manejada.
        }
      };
      const sendTaskSnapshot = (status: TaskStatus, conflictedPaths: string[] | null) => {
        safeEnqueue(`event: task\ndata: ${JSON.stringify({ status, conflictedPaths })}\n\n`);
      };
      const closeStream = () => {
        if (closed) return;
        closed = true;
        if (intervalHandle) clearInterval(intervalHandle);
        try {
          controller.close();
        } catch {
          // Ya cerrado por el otro lado — no pasa nada.
        }
      };

      let lastSeq = sinceSeq ?? -1;
      for (const event of listEvents(taskId, { sinceSeq })) {
        safeEnqueue(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
        lastSeq = event.seq;
      }

      const initialTask = getTask(taskId);
      if (!initialTask) {
        closeStream();
        return;
      }
      sendTaskSnapshot(initialTask.status, initialTask.conflictedPaths);
      if (!isStreaming(initialTask.status)) {
        closeStream();
        return;
      }

      intervalHandle = setInterval(() => {
        if (closed) return;
        const fresh = listEvents(taskId, { sinceSeq: lastSeq });
        for (const event of fresh) {
          safeEnqueue(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
          lastSeq = event.seq;
        }
        const current = getTask(taskId);
        if (!current) {
          closeStream();
          return;
        }
        sendTaskSnapshot(current.status, current.conflictedPaths);
        if (!isStreaming(current.status)) closeStream();
      }, POLL_INTERVAL_MS);

      request.signal.addEventListener("abort", closeStream);
    },
    cancel() {
      closed = true;
      if (intervalHandle) clearInterval(intervalHandle);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
