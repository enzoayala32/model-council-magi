"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
  initialTaskStreamState,
  taskStreamReducer,
  type TaskStreamEvent,
  type TaskStreamState,
} from "@/lib/task-stream-reducer";

/**
 * Consumidor SSE de los eventos de una task, a prueba de moviles y tuneles.
 *
 * Problema: en un tunel (Tailscale, Cloudflare) o con una red movil que
 * cambia de Wi-Fi a datos, la conexion SSE se corta. `EventSource`
 * reconecta solo, pero reintenta inmediatamente y puede martillar el
 * server; ademas, si el servidor quedo atras, hay que pedir lo perdido.
 *
 * Lo que hace este hook:
 * - Reconecta con backoff exponencial (1s, 2s, 4s, 8s... tope 30s) con
 *   jitter, para no sincronizar los reintentos de todos los clientes.
 * - Al reconectar pide `?sinceSeq=<ultimo seq visto>`: el servidor reenvia
 *   SOLO lo nuevo en vez de todo el historial.
 * - El timeline no se borra al reconectar: solo cambia si cambia la task.
 *   (Ese era el bug: borrar en `onopen` + replay completo + dedup por seq
 *   dejaba el timeline vacio justo despues de un corte de red.)
 * - Desduplica por `seq <= lastSeq` y descarta eventos partidos.
 *
 * Toda la logica de estado vive en `lib/task-stream-reducer.ts` (pura y
 * testeable); aca solo esta la plomeria de `EventSource`.
 */

export type { TaskStreamEvent, TaskStreamState };

type Options = {
  taskId: string;
  /** Se llama con el snapshot mas reciente reportado por el servidor. */
  onTaskSnapshot?: (snapshot: { status: string; conflictedPaths: string[] | null }) => void;
};

const MAX_BACKOFF_MS = 30_000;

export function useTaskEventStream({ taskId, onTaskSnapshot }: Options) {
  const [state, dispatch] = useReducer(taskStreamReducer, taskId, initialTaskStreamState);
  const sourceRef = useRef<EventSource | null>(null);
  /** Numero de reconexion: cada corte lo incrementa y el effect de abajo se
   *  re-ejecuta con backoff. Asi la reconexion no necesita que `connect` se
   *  reference a si mismo. */
  const [attempt, setAttempt] = useState(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onSnapshotRef = useRef(onTaskSnapshot);

  // El ref se sincroniza en un effect, no durante el render (escribir un
  // ref en el cuerpo del componente es justo lo que prohibe la regla
  // `react-hooks/refs`).
  useEffect(() => {
    onSnapshotRef.current = onTaskSnapshot;
  }, [onTaskSnapshot]);

  // Espejo del estado para leerlo desde callbacks sin cerrarlos.
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const connect = useCallback(() => {
    if (sourceRef.current) {
      sourceRef.current.close();
      sourceRef.current = null;
    }

    // Reconexion con cursor: si ya se vieron eventos, se pide solo lo
    // posterior. Sin cursor el servidor manda todo el historial de nuevo.
    const lastSeq = stateRef.current.lastSeq;
    const url = `/api/agent/tasks/${encodeURIComponent(taskId)}/events${lastSeq !== null ? `?sinceSeq=${lastSeq}` : ""}`;
    const source = new EventSource(url, { withCredentials: true });
    sourceRef.current = source;

    source.onopen = () => {
      dispatch({ type: "opened" });
    };

    source.onmessage = (message) => {
      // Un comentario (heartbeat) no dispara `onmessage`; si por lo que sea
      // llega un mensaje sin datos, se ignora.
      if (!message.data) return;
      dispatch({ type: "message", raw: message.data });
    };

    // El snapshot llega con nombre de evento propio.
    source.addEventListener("task", (message) => {
      try {
        const data = JSON.parse((message as MessageEvent<string>).data) as {
          status: string;
          conflictedPaths: string[] | null;
        };
        dispatch({ type: "snapshot", status: data.status, conflictedPaths: data.conflictedPaths ?? null });
        onSnapshotRef.current?.(data);
      } catch {
        /* snapshot ilegible: se ignora */
      }
    });

    source.onerror = () => {
      source.close();
      sourceRef.current = null;
      dispatch({ type: "dropped" });
      // Pedir otro intento dispara el effect de reconexion de abajo, que
      // aplica el backoff. Con funcion para no necesitar el valor actual en
      // el closure.
      setAttempt((current) => current + 1);
    };
  }, [taskId]);

  // Conexion inicial (attempt=0) y reconexiones (attempt>0) con backoff
  // exponencial + jitter, para no sincronizar los reintentos de todos los
  // clientes contra el mismo tunel.
  useEffect(() => {
    if (attempt === 0) {
      connect();
      // El valor del ref se copia a una local: si no, el cleanup cerraría
      // sobre `timerRef.current` tal como quedó DESPUES de este effect.
      const pendingTimer = timerRef.current;
      return () => {
        if (pendingTimer) clearTimeout(pendingTimer);
        sourceRef.current?.close();
        sourceRef.current = null;
      };
    }
    const backoff = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (attempt - 1));
    const jitter = Math.random() * backoff * 0.25;
    const timer = setTimeout(() => connect(), backoff + jitter);
    return () => clearTimeout(timer);
  }, [connect, attempt]);

  // Cambio de task: reset del timeline. NO se resetea al (re)conectar --
  // esa es la regla que evita el timeline vacio tras un corte.
  useEffect(() => {
    dispatch({ type: "task-changed", taskId });
  }, [taskId]);

  return state;
}
