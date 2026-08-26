import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

// Un único archivo .db local en data/. Nada de servicios externos.
const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "council.db");

declare global {
  // eslint-disable-next-line no-var
  var __councilDb: Database.Database | undefined;
}

function createConnection(): Database.Database {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      favorite INTEGER NOT NULL DEFAULT 0,
      search_text TEXT NOT NULL DEFAULT '',
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_threads_updated_at ON threads(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_threads_favorite ON threads(favorite);

    -- Fase 2A del Coding Agent: proyectos externos sobre los que puede
    -- trabajar el agente. Separada conceptualmente de "threads" (que es el
    -- historial del Council) aunque comparta el mismo archivo .db — ver
    -- diseño de Fase 2 (persistencia, decisión 4).
    CREATE TABLE IF NOT EXISTS agent_projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      source_type TEXT NOT NULL,
      local_path TEXT NOT NULL,
      is_git_repo INTEGER NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_projects_archived ON agent_projects(archived);
  `);
  return db;
}

/**
 * Conexión singleton. En dev, Next.js recarga módulos con cada cambio de
 * archivo (HMR) — sin este patrón de global, cada recarga abriría un
 * nuevo file handle sobre el mismo .db.
 */
export function getDb(): Database.Database {
  if (!globalThis.__councilDb) {
    globalThis.__councilDb = createConnection();
  }
  return globalThis.__councilDb;
}
