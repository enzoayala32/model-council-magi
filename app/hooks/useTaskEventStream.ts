"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Fase 3.3 — consumidor SSE de los eventos de una task, a prueba de
 * móviles y túneles.
 *
 * Problema: en un túnel (Tailscale, Cloudflare) o con una red móvil que
 * cambia de Wi-Fi a datos, la conexión SSE se corta. `EventSource`
 * reconecta solo, pero reintenta inmediatamente y puede martillar el
 * server; además, si el servidor quedó atrás, hay que pedir lo perdido.
 *
 * Lo que hace este hook:
 * - Reconecta con backoff exponencial (1s, 2s, 4s, 8s… tope 30s) con
 *   jitter, para no sincronizar los reintentos de todos los clientes.
 * - Reanuda con `Last-Event-ID`: el servidor reenvía desde ahí. Si el
 *   corte fue largo y el evento ya no está, el servidor manda igual el
 *   snapshot de la task, así que el cliente no queda con data vieja.
 * - Desduplica por `seq`: un reintento que llegó viejo no pisa el estado
 *   con un evento atrasado.
 */

export type TaskStreamEvent = {
  seq: number;
  ts: number;
  kind: string;
  [key: string]: unknown;
};

export type TaskStreamState = {
  status: "connecting" | "open" | "closed";
  events: TaskStreamEvent[];
};

type Options = {
  taskId: string;
  /** Se llama con el status más reciente reportado por el servidor. */
  onTaskSnapshot?: (snapshot: { status: string; conflictedPaths: string[] | null }) => void;
};

const MAX_BACKOFF_MS = 30_000;

export function useTaskEventStream({ taskId, onTaskSnapshot }: Options) {
  const [state, setState] = useState<TaskStreamState>({ status: "connecting", events: [] });
  const sourceRef = useRef<EventSource | null>(null);
  // La reconexión se hace desde `onerror`, dentro del callback que define
  // el propio `connect`: usar la variable dentro de su propia inicialización
  // es un "access before declare". Un ref evita el ciclo y mantiene el
  // backoff intacto.
  const reconnectRef = useRef<() => void>(() => {});
  const attemptRef = useRef(0);
  const seenRef = useRef(new Set<number>());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Se sincroniza en un effect, no durante el render: escribir un ref en
  // el cuerpo del componente es exactamente lo que la regla
  // `react-hooks/refs` prohíbe (rompe el modelo de render puro).
  const onSnapshotRef = useRef(onTaskSnapshot);
  useEffect(() => {
    onSnapshotRef.current = onTaskSnapshot;
  }, [onTaskSnapshot]);

  const connect = useCallback(() => {
    if (sourceRef.current) {
      sourceRef.current.close();
      sourceRef.current = null;
    }

    // No hace falta un setState("connecting") acá: el estado inicial ya es
    // "connecting", y cuando se reconecta tras un error lo pone `onerror`
    // (que corre en un callback, no en el cuerpo del effect). Escribirlo
    // acá era justo el setState sincrónico que la regla marca.
    const source = new EventSource(`/api/agent/tasks/${taskId}/events`, { withCredentials: true });
    sourceRef.current = source;

    source.onopen = () => {
      attemptRef.current = 0;
      // Al abrir una conexión nueva se descarta lo viejo: los eventos que
      // lleguen después son de esta task. Se hace acá (callback asincrónico)
      // y no en el cuerpo del effect, que es justamente lo que la regla
      // `react-hooks/set-state-in-effect` prohíbe.
      setState({ status: "open", events: [] });
    };

    source.onmessage = (message) => {
      // El heartbeat llega como mensaje sin datos parseables: se ignora.
      if (!message.data) return;
      try {
        const parsed = JSON.parse(message.data) as { seq?: number; snapshot?: boolean };
        if (parsed.snapshot) {
          onSnapshotRef.current?.(parsed as unknown as { status: string; conflictedPaths: string[] | null });
          return;
        }
        if (typeof parsed.seq !== "number") return;
        if (seenRef.current.has(parsed.seq)) return;
        seenRef.current.add(parsed.seq);
        setState((current) => ({ ...current, events: [...current.events, parsed as TaskStreamEvent] }));
      } catch {
        // Evento partido por el corte: se descarta y el replay del
        // `Last-Event-ID` lo vuelve a mandar.
      }
    };

    // El servidor manda el snapshot con `event: task`.
    source.addEventListener("task", (message) => {
      try {
        const data = JSON.parse((message as MessageEvent<string>).data) as {
          status: string;
          conflictedPaths: string[] | null;
        };
        onSnapshotRef.current?.(data);
      } catch {
        /* snapshot ilegible: se ignora */
      }
    });

    source.onerror = () => {
      source.close();
      sourceRef.current = null;
      attemptRef.current += 1;
      const backoff = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (attemptRef.current - 1));
      const jitter = Math.random() * backoff * 0.25;
      setState((current) => ({ ...current, status: "connecting" }));
      timerRef.current = setTimeout(() => reconnectRef.current(), backoff + jitter);
    };
  }, [taskId]);

  // Escribir el ref en un effect (no en el cuerpo del componente): durante
  // el render, los refs no deben tocarse.
  useEffect(() => {
    reconnectRef.current = connect;
  }, [connect]);

  useEffect(() => {
    // El reset de `seenRef` es un ref (permitido en el effect). El reset del
    // estado visible pasa en `onopen` — ver el comentario de arriba.
    seenRef.current = new Set<number>();
    connect();
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      sourceRef.current?.close();
      sourceRef.current = null;
    };
  }, [connect]);

  return state;
}
