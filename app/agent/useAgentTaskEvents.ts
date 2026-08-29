"use client";

import { useEffect, useRef, useState } from "react";
// Solo tipos — se borran en compilación, no meten `better-sqlite3` (ni
// ningún código de servidor) en el bundle del cliente.
import type { AgentEvent } from "@/lib/agent/event-log";
import type { TaskStatus } from "@/lib/agent/task-store";

type TaskSnapshot = { status: TaskStatus; conflictedPaths: string[] | null };

const STREAMING_STATUSES: TaskStatus[] = ["QUEUED", "RUNNING"];

/**
 * Consume `GET /api/agent/tasks/[id]/events` (Fase 2H). El propio
 * `EventSource` del browser maneja los reconnects por corte de red
 * (reenvía `Last-Event-ID` solo) — acá además cerramos la conexión a mano
 * apenas la task deja de estar en un estado "en vivo" (`QUEUED`/`RUNNING`),
 * porque un stream que termina limpio (sin error HTTP) igual dispara un
 * reintento automático de `EventSource` por spec, y una task ya terminada
 * no va a tener eventos nuevos nunca — dejar la conexión abierta ahí sería
 * repreguntarle al server para siempre sin necesidad.
 */
export function useAgentTaskEvents(taskId: string | null) {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [status, setStatus] = useState<TaskStatus | null>(null);
  const [conflictedPaths, setConflictedPaths] = useState<string[] | null>(null);

  const seenIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    setEvents([]);
    setStatus(null);
    setConflictedPaths(null);
    seenIdsRef.current = new Set();

    if (!taskId) return;

    const source = new EventSource(`/api/agent/tasks/${taskId}/events`);

    source.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data) as AgentEvent;
        if (seenIdsRef.current.has(event.id)) return;
        seenIdsRef.current.add(event.id);
        setEvents((current) => [...current, event]);
      } catch {
        // Mensaje malformado — no debería pasar, se ignora sin romper el stream.
      }
    };

    source.addEventListener("task", (message) => {
      try {
        const snapshot = JSON.parse((message as MessageEvent).data) as TaskSnapshot;
        setStatus(snapshot.status);
        setConflictedPaths(snapshot.conflictedPaths);
        if (!STREAMING_STATUSES.includes(snapshot.status)) source.close();
      } catch {
        // Idem — se ignora.
      }
    });

    return () => source.close();
  }, [taskId]);

  return { events, status, conflictedPaths };
}
