"use client";

import { type MutableRefObject, type Dispatch, type SetStateAction, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchThreadsFromServer,
  loadThreads,
  migrateLocalThreadsToServerOnce,
  saveThreads,
  setThreadFavoriteOnServer,
  syncThreadToServer,
  type StoredGeneratedImage,
  type StoredModelTurn,
  type StoredThread,
  type StoredTurn,
} from "@/lib/threads";
import type { Phase, RunModel } from "../lib/client-types";
import type { FusionJudgeReport } from "../lib/client-types";

type LiveState = {
  models: RunModel[];
  synthesis: string;
  followUps: string[];
  generatedImages: StoredGeneratedImage[];
  fusionJudge: FusionJudgeReport | null;
  question: string;
};

/**
 * Estado y persistencia de los hilos guardados y las funciones para
 * hidratar/snapshotear el turno activo. La fuente de verdad es el
 * server (SQLite, vía /api/threads) — localStorage sigue actuando
 * como caché instantánea para el primer render y respaldo si el
 * server no responde. `liveStateRef` y `setModels` se pasan desde el
 * motor de la corrida en Home() para mantener exactamente el mismo
 * acoplamiento que existía antes de extraer este hook —
 * snapshotModelsForTurn/commitActiveTurn siguen leyendo el estado más
 * reciente de la corrida en curso.
 */
export function useThreads({
  liveStateRef,
  setModels,
  phase,
}: {
  liveStateRef: MutableRefObject<LiveState>;
  setModels: Dispatch<SetStateAction<RunModel[]>>;
  phase: Phase;
}) {
  const [threads, setThreads] = useState<StoredThread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [serverError, setServerError] = useState(false);

  // Ref para que callbacks async (streaming) siempre lean el hilo activo más reciente.
  const activeThreadIdRef = useRef<string | null>(null);
  useEffect(() => {
    activeThreadIdRef.current = activeThreadId;
  }, [activeThreadId]);

  useEffect(() => {
    const local = loadThreads();
    // Caché local instantánea mientras llega la respuesta del server.
    if (local.length) setThreads(local);

    (async () => {
      try {
        await migrateLocalThreadsToServerOnce(local);
        const serverThreads = await fetchThreadsFromServer();
        setThreads(serverThreads);
        setServerError(false);
      } catch {
        // Sin server disponible, seguimos con lo que había en localStorage.
        setServerError(true);
      } finally {
        setHydrated(true);
      }
    })();
  }, []);

  // localStorage sigue actualizándose como respaldo offline, pero ya no es la fuente de verdad.
  useEffect(() => {
    if (!hydrated) return;
    saveThreads(threads);
  }, [threads, hydrated]);

  const activeThread = useMemo(
    () => threads.find((thread) => thread.id === activeThreadId) ?? null,
    [threads, activeThreadId],
  );

  const pastTurns = useMemo(() => {
    if (!activeThread) return [] as StoredTurn[];
    // While streaming the latest turn, show all earlier turns above.
    if (phase === "thinking") return activeThread.turns.slice(0, -1);
    // When viewing results, show all turns except the active (last) one.
    if (phase === "results") return activeThread.turns.slice(0, -1);
    return activeThread.turns;
  }, [activeThread, phase]);

  function hydrateModelsFromTurn(turn: StoredTurn) {
    setModels((current) =>
      current.map((base) => {
        const stored = turn.models.find((m) => m.id === base.id);
        if (!stored) {
          return { ...base, selected: false, status: "queued", debateStatus: "queued", response: undefined, critique: undefined, revisedAnswer: undefined, debateHistory: undefined, error: undefined, steps: 0, activityLog: [] };
        }
        return {
          ...base,
          selected: true,
          status: "complete",
          debateStatus: stored.critique || stored.revisedAnswer ? "complete" : "queued",
          steps: stored.steps,
          response: stored.response,
          critique: stored.critique,
          revisedAnswer: stored.revisedAnswer,
          debateHistory: stored.debateHistory,
          error: stored.error,
          activityLog: stored.activityLog ?? [],
        };
      }),
    );
  }

  function snapshotModelsForTurn(modelIds: string[]): StoredModelTurn[] {
    return liveStateRef.current.models
      .filter((m) => modelIds.includes(m.id))
      .map((m) => ({
        id: m.id,
        label: m.label,
        maker: m.maker,
        badge: m.badge,
        accent: m.accent,
        logoUrl: m.logoUrl,
        steps: m.steps,
        response: m.response,
        critique: m.critique,
        revisedAnswer: m.revisedAnswer,
        debateHistory: m.debateHistory,
        error: m.error,
        activityLog: m.activityLog,
      }));
  }

  function commitActiveTurn(status: StoredTurn["status"]) {
    let updated: StoredThread | null = null;
    setThreads((current) =>
      current.map((thread) => {
        if (thread.id !== activeThreadIdRef.current) return thread;
        const turns = [...thread.turns];
        const last = turns[turns.length - 1];
        if (!last) return thread;
        turns[turns.length - 1] = {
          ...last,
          synthesis: liveStateRef.current.synthesis || last.synthesis,
          followUps: liveStateRef.current.followUps.length ? liveStateRef.current.followUps : last.followUps,
          generatedImages: liveStateRef.current.generatedImages.length
            ? liveStateRef.current.generatedImages
            : last.generatedImages,
          fusionJudge: liveStateRef.current.fusionJudge ?? last.fusionJudge,
          models: snapshotModelsForTurn(last.models.map((m) => m.id)),
          status,
        };
        updated = { ...thread, updatedAt: Date.now(), turns };
        return updated;
      }),
    );
    if (updated) syncThreadToServer(updated).catch(() => setServerError(true));
  }

  /** Sube al server el hilo recién creado o el que acaba de sumar un turno nuevo (ver runCouncil). */
  function syncThread(thread: StoredThread) {
    syncThreadToServer(thread).catch(() => setServerError(true));
  }

  function toggleFavorite(threadId: string) {
    setThreads((current) =>
      current.map((thread) => (thread.id === threadId ? { ...thread, favorite: !thread.favorite } : thread)),
    );
    const thread = threads.find((t) => t.id === threadId);
    const nextFavorite = !thread?.favorite;
    setThreadFavoriteOnServer(threadId, nextFavorite).catch(() => setServerError(true));
  }

  return {
    threads,
    setThreads,
    activeThreadId,
    setActiveThreadId,
    activeThread,
    pastTurns,
    activeThreadIdRef,
    hydrateModelsFromTurn,
    snapshotModelsForTurn,
    commitActiveTurn,
    syncThread,
    toggleFavorite,
    serverError,
  };
}

