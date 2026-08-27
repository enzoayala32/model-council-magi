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

    -- Fase 2B: CodingTask — una corrida puntual del Coding Agent sobre un
    -- Project. Ver diseño de Fase 2, secciones 3, 7 y 8 (máquina de estados).
    CREATE TABLE IF NOT EXISTS agent_tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES agent_projects(id),
      model_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER,
      base_commit TEXT,
      workspace_id TEXT,
      stop_reason TEXT,
      error TEXT,
      discard_reason TEXT,
      conflicted_paths TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_agent_tasks_project ON agent_tasks(project_id);
    CREATE INDEX IF NOT EXISTS idx_agent_tasks_status ON agent_tasks(status);

    -- Fase 2C: registro persistido de cada AgentWorkspace (worktree o copia
    -- física) creado para una CodingTask. Relación 1:1 con agent_tasks
    -- (id = task_id, sin id separado) — ver diseño de Fase 2, sección 4.
    CREATE TABLE IF NOT EXISTS agent_workspaces (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES agent_tasks(id),
      project_id TEXT NOT NULL REFERENCES agent_projects(id),
      mode TEXT NOT NULL,
      base_path TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      branch_name TEXT,
      base_commit TEXT,
      created_at INTEGER NOT NULL,
      destroyed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_agent_workspaces_task ON agent_workspaces(task_id);

    -- Fase 2E: log de eventos de una CodingTask (tool_call/tool_result/
    -- text/typecheck_result/status_change), reemplaza el "transcript" en
    -- memoria de loop.ts como fuente de verdad persistida — permite
    -- reconstruir el timeline completo de una corrida vieja aunque el
    -- proceso que la corrió ya no exista. "seq" (no "ts") es la clave de
    -- reanudación: dos eventos pueden compartir milisegundo, nunca seq.
    -- Ver diseño de Fase 2, secciones 5, 7 y 12.
    CREATE TABLE IF NOT EXISTS agent_events (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES agent_tasks(id),
      seq INTEGER NOT NULL,
      ts INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      UNIQUE (task_id, seq)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_events_task ON agent_events(task_id, seq);
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
