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
  error?: string;
  activityLog: string[];
};

export type StoredTurn = {
  id: string;
  question: string;
  synthesis: string;
  followUps?: string[];
  models: StoredModelTurn[];
  createdAt: number;
  status: "complete" | "stopped" | "errored";
};

export type StoredThread = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
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
