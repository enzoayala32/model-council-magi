import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

// Un único archivo .db local en data/. Nada de servicios externos.
const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "council.db");

/** Fase 3, sección 7 del diseño: versión de schema trackeada vía
 * `PRAGMA user_version` (nativo de SQLite, sin tabla extra). No es un
 * sistema de migraciones — es una alarma barata para que el PRÓXIMO
 * cambio de schema rompedor no pase desapercibido en silencio como casi
 * pasó con este (`agent_workspaces` de 1:1 a 1:N). Se sube cada vez que
 * haya un cambio de forma incompatible con `CREATE TABLE IF NOT EXISTS`. */
const SCHEMA_VERSION = 1;

declare global {
  // eslint-disable-next-line no-var
  var __councilDb: Database.Database | undefined;
}

function tableExists(db: Database.Database, table: string): boolean {
  const row = db.prepare("SELECT count(*) as c FROM sqlite_master WHERE type='table' AND name = ?").get(table) as { c: number };
  return row.c > 0;
}

function columnExists(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.some((r) => r.name === column);
}

/**
 * Fase 3: detecta específicamente el caso peligroso — un `council.db` de
 * ANTES de este cambio, con filas reales en `agent_workspaces` donde
 * `id = task_id` (la firma inequívoca del schema 1:1 viejo). No basta con
 * mirar si la tabla existe: una DB que nunca usó el Coding Agent, o que lo
 * usó pero nunca llegó a crear un workspace, no tiene ningún dato que se
 * pueda malinterpretar, y no hace falta molestar a nadie por eso. Si hay
 * datos reales en la forma vieja, `CREATE TABLE IF NOT EXISTS` los dejaría
 * conviviendo en silencio con código que ya asume 1:N — mejor cortar acá
 * con un mensaje claro que dejar que aparezcan errores raros más adelante.
 */
function assertNoIncompatibleLegacySchema(db: Database.Database): void {
  if (!tableExists(db, "agent_workspaces")) return;
  if (!columnExists(db, "agent_workspaces", "task_id")) return; // no debería pasar, pero no es este chequeo el que lo valida

  const legacyRows = db.prepare("SELECT count(*) as c FROM agent_workspaces WHERE id = task_id").get() as { c: number };
  if (legacyRows.c > 0) {
    throw new Error(
      "data/council.db tiene datos de agent_workspaces con el schema 1:1 anterior a la Fase 3 " +
        "(id = task_id). Ese schema ya no es compatible con el código actual (agent_workspaces " +
        "ahora es 1:N, ver diseño de Fase 3). Borrá data/council.db y reiniciá el server para " +
        "recrearlo desde cero — es la decisión ya tomada para este cambio puntual (dato de " +
        "desarrollo, sin costo real de perder el historial de tasks/proyectos de prueba).",
    );
  }
}

function createConnection(): Database.Database {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");

  assertNoIncompatibleLegacySchema(db);

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
    -- Fase 3 agregó restart_retry_count (ver más abajo, vía ALTER TABLE
    -- guardado, no acá, para no romper una DB ya creada con CREATE TABLE
    -- IF NOT EXISTS).
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
      conflicted_paths TEXT,
      restart_retry_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_agent_tasks_project ON agent_tasks(project_id);
    CREATE INDEX IF NOT EXISTS idx_agent_tasks_status ON agent_tasks(status);

    -- Fase 3, sección 3.1: garantía real (a nivel SQLite, no solo en
    -- memoria) de "máximo una task RUNNING a la vez por Project". Un
    -- índice único PARCIAL — solo aplica a filas con status='RUNNING' — es
    -- el mecanismo mínimo que da esta propiedad sin importar cuántos
    -- procesos Node le pegan al mismo archivo. Cualquier intento de dejar
    -- una segunda RUNNING del mismo proyecto revienta con
    -- "UNIQUE constraint failed", sin que la lógica de aplicación tenga
    -- que acordarse de chequear nada.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_tasks_one_running_per_project
      ON agent_tasks(project_id) WHERE status = 'RUNNING';

    -- Fase 2C, corregida en Fase 3 (sección 5): registro persistido de cada
    -- AgentWorkspace (worktree o copia física) creado para una CodingTask.
    -- Pasó de 1:1 (id=task_id) a 1:N — una task puede acumular varios
    -- intentos de workspace a lo largo de su vida (uno por cada restart
    -- automático). "attempt" es informativo (Grupo B del diseño de Fase 3,
    -- se puede derivar de restart_retry_count+1, pero es barato tenerlo
    -- para no tener que recalcularlo en la UI). El workspace ACTIVO de una
    -- task es el que apunta agent_tasks.workspace_id (FK), no "el más
    -- reciente" ni ninguna otra heurística.
    CREATE TABLE IF NOT EXISTS agent_workspaces (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES agent_tasks(id),
      project_id TEXT NOT NULL REFERENCES agent_projects(id),
      mode TEXT NOT NULL,
      base_path TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      branch_name TEXT,
      base_commit TEXT,
      attempt INTEGER NOT NULL DEFAULT 1,
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
    -- Ver diseño de Fase 2, secciones 5, 7 y 12. Fase 3 no le agrega nada
    -- (ver diseño de Fase 3, sección 6: seq + status_change ya alcanza
    -- para distinguir intentos sin agregar attempt/workspaceId/runId acá).
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

    -- Fase 2F: propuestas de archivo de una CodingTask terminada, persistidas
    -- tal cual salen de AgentFileProposal (loop.ts) al aterrizar en
    -- READY_FOR_REVIEW — antes vivían solo en memoria durante el loop y se
    -- perdían si el server se reiniciaba. "applied"/"conflict" quedan en 0
    -- acá; los actualiza el endpoint de APPLY de la Fase 2G, no esta fase.
    -- Ver diseño de Fase 2, secciones 6 y 7.
    CREATE TABLE IF NOT EXISTS agent_proposals (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES agent_tasks(id),
      kind TEXT NOT NULL,
      rel_path TEXT NOT NULL,
      diff TEXT NOT NULL,
      next_content TEXT NOT NULL,
      baseline_hash TEXT NOT NULL,
      typecheck_status TEXT NOT NULL,
      applied INTEGER NOT NULL DEFAULT 0,
      conflict INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_agent_proposals_task ON agent_proposals(task_id);
  `);

  // `restart_retry_count` puede faltar en una DB creada por una versión
  // ligeramente anterior a este cambio (que ya tenía agent_tasks pero no
  // esta columna) — CREATE TABLE IF NOT EXISTS no la agrega sola.
  if (!columnExists(db, "agent_tasks", "restart_retry_count")) {
    db.exec("ALTER TABLE agent_tasks ADD COLUMN restart_retry_count INTEGER NOT NULL DEFAULT 0");
  }

  const currentVersion = db.pragma("user_version", { simple: true }) as number;
  if (currentVersion !== SCHEMA_VERSION) {
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }

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

