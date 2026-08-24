import { getDb } from "./db";
import type { StoredThread } from "./threads";

const MAX_THREADS = 500;

type ThreadRow = {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  favorite: number;
  data: string;
};

function rowToThread(row: ThreadRow): StoredThread {
  const thread = JSON.parse(row.data) as StoredThread;
  return { ...thread, favorite: row.favorite === 1 };
}

function buildSearchText(thread: StoredThread): string {
  const parts = [thread.title];
  for (const turn of thread.turns) {
    parts.push(turn.question, turn.synthesis);
  }
  return parts.join(" \n ").toLowerCase();
}

export function listThreads(opts?: { query?: string; favoriteOnly?: boolean }): StoredThread[] {
  const db = getDb();
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};
  if (opts?.query) {
    clauses.push("search_text LIKE @q");
    params.q = `%${opts.query.toLowerCase()}%`;
  }
  if (opts?.favoriteOnly) {
    clauses.push("favorite = 1");
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .prepare(`SELECT * FROM threads ${where} ORDER BY updated_at DESC LIMIT ${MAX_THREADS}`)
    .all(params) as ThreadRow[];
  return rows.map(rowToThread);
}

export function getThread(id: string): StoredThread | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM threads WHERE id = ?").get(id) as ThreadRow | undefined;
  return row ? rowToThread(row) : null;
}

/** Crea o reemplaza un hilo completo. Usado tanto al crear un hilo nuevo como al agregar/cerrar un turno. */
export function upsertThread(thread: StoredThread): StoredThread {
  const db = getDb();
  const favorite = thread.favorite ? 1 : 0;
  const { favorite: _favorite, ...withoutFavorite } = thread;
  const data = JSON.stringify(withoutFavorite);
  const searchText = buildSearchText(thread);
  db.prepare(
    `INSERT INTO threads (id, title, created_at, updated_at, favorite, search_text, data)
     VALUES (@id, @title, @createdAt, @updatedAt, @favorite, @searchText, @data)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       updated_at = excluded.updated_at,
       favorite = excluded.favorite,
       search_text = excluded.search_text,
       data = excluded.data`,
  ).run({
    id: thread.id,
    title: thread.title,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    favorite,
    searchText,
    data,
  });
  return thread;
}

export function deleteThread(id: string): void {
  getDb().prepare("DELETE FROM threads WHERE id = ?").run(id);
}

export function setThreadFavorite(id: string, favorite: boolean): StoredThread | null {
  const db = getDb();
  const result = db.prepare("UPDATE threads SET favorite = ? WHERE id = ?").run(favorite ? 1 : 0, id);
  if (result.changes === 0) return null;
  return getThread(id);
}

/** Importación masiva usada una sola vez para migrar el historial que ya vivía en localStorage. */
export function importThreads(threads: StoredThread[]): number {
  const db = getDb();
  const insertMany = db.transaction((items: StoredThread[]) => {
    for (const thread of items) upsertThread(thread);
  });
  insertMany(threads);
  return threads.length;
}

export function countThreads(): number {
  const db = getDb();
  const row = db.prepare("SELECT COUNT(*) as c FROM threads").get() as { c: number };
  return row.c;
}
