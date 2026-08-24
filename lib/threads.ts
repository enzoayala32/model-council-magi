export type StoredDebateRoundEntry = { round: number; maxRounds: number; critique: string; revisedAnswer?: string };

export type StoredModelTurn = {
  id: string;
  label: string;
  maker: string;
  badge: string;
  accent: string;
  logoUrl?: string;
  steps: number;
  response?: string;
  critique?: string;
  revisedAnswer?: string;
  debateHistory?: StoredDebateRoundEntry[];
  error?: string;
  activityLog: string[];
};

export type StoredTurn = {
  id: string;
  question: string;
  synthesis: string;
  followUps?: string[];
  generatedImages?: StoredGeneratedImage[];
  fusionJudge?: {
    panelVerdict: string;
    consensus: Array<{ finding: string; models: string[]; evidence: string }>;
    contradictions: Array<{ topic: string; positions: Record<string, string>; judgment: string }>;
    uniqueInsights: Array<{ model: string; insight: string; whyItMatters: string }>;
    coverageGaps: string[];
  } | null;
  fusionPanelId?: string | null;
  models: StoredModelTurn[];
  createdAt: number;
  status: "complete" | "stopped" | "errored";
};

export type StoredGeneratedImage = {
  id: string;
  model: string;
  prompt: string;
  url: string;
  createdAt: number;
};

export type StoredThread = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  favorite?: boolean;
  turns: StoredTurn[];
};

export type ConversationHistoryEntry = {
  question: string;
  synthesis: string;
};

const STORAGE_KEY = "council:threads:v1";
const MAX_THREADS = 100;

export function loadThreads(): StoredThread[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as StoredThread[];
  } catch {
    return [];
  }
}

export function saveThreads(threads: StoredThread[]) {
  if (typeof window === "undefined") return;
  const trimmed = [...threads]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_THREADS);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    try {
      const lean = trimmed.slice(0, 25);
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(lean));
    } catch {
      /* give up silently */
    }
  }
}

export function deleteThread(threads: StoredThread[], threadId: string) {
  return threads.filter((thread) => thread.id !== threadId);
}

export function makeThreadTitle(question: string) {
  const trimmed = question.replace(/\s+/g, " ").trim();
  return trimmed.length > 64 ? `${trimmed.slice(0, 64)}…` : trimmed;
}

export function newId(prefix = "id") {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

export function buildHistory(thread: StoredThread | null | undefined): ConversationHistoryEntry[] {
  if (!thread) return [];
  return thread.turns
    .filter((turn) => turn.synthesis)
    .map((turn) => ({ question: turn.question, synthesis: turn.synthesis }));
}

/* =========================================================
   Persistencia server-side (SQLite vía /api/threads).
   localStorage sigue funcionando como caché local instantánea
   y respaldo offline; el server es la fuente de verdad para
   historial buscable, favoritos y comparar corridas entre días.
   ========================================================= */

const MIGRATION_FLAG_KEY = "council:threads:migrated-to-server:v1";

export async function fetchThreadsFromServer(query?: string): Promise<StoredThread[]> {
  const url = query ? `/api/threads?q=${encodeURIComponent(query)}` : "/api/threads";
  const res = await fetch(url);
  if (!res.ok) throw new Error("No se pudo cargar el historial del servidor.");
  const data = (await res.json()) as { threads: StoredThread[] };
  return data.threads;
}

export async function syncThreadToServer(thread: StoredThread): Promise<void> {
  await fetch("/api/threads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(thread),
  });
}

export async function deleteThreadOnServer(id: string): Promise<void> {
  await fetch(`/api/threads/${id}`, { method: "DELETE" });
}

export async function setThreadFavoriteOnServer(id: string, favorite: boolean): Promise<void> {
  await fetch(`/api/threads/${id}/favorite`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ favorite }),
  });
}

/**
 * Corre una sola vez por navegador: si el server no tiene hilos todavía
 * pero localStorage sí, sube ese historial existente para no perderlo
 * al pasar a persistencia server-side.
 */
export async function migrateLocalThreadsToServerOnce(localThreads: StoredThread[]): Promise<void> {
  if (typeof window === "undefined") return;
  if (window.localStorage.getItem(MIGRATION_FLAG_KEY)) return;
  if (!localThreads.length) {
    window.localStorage.setItem(MIGRATION_FLAG_KEY, "1");
    return;
  }
  try {
    await fetch("/api/threads/migrate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threads: localThreads }),
    });
  } finally {
    // Marcamos el flag incluso si falló: evita reintentar en cada carga
    // de página. Si de verdad falló, el historial local sigue intacto
    // en localStorage como respaldo — no se pierde nada.
    window.localStorage.setItem(MIGRATION_FLAG_KEY, "1");
  }
}
