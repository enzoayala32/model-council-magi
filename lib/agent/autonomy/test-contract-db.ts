/**
 * Fase 9A — test de migración aditiva del schema.
 *
 * Corre en un cwd temporal (la DB real NUNCA se toca): `lib/db.ts` calcula
 * `data/council.db` desde `process.cwd()` al importarse, así que el import
 * dinámico ocurre después del `chdir`. Verifica tablas, índices, la
 * invariante de una sola corrida activa por task y las unicidades del
 * ledger.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let total = 0;
let failed = 0;

function check(condition: boolean, message: string, detail?: () => unknown): void {
  total += 1;
  if (condition) {
    console.log(`✅ ${message}`);
    return;
  }
  failed += 1;
  console.error(`❌ ${message}`);
  if (detail) console.error("   ", JSON.stringify(detail()));
}

function checkEq(actual: unknown, expected: unknown, message: string, detail?: () => unknown): void {
  check(JSON.stringify(actual) === JSON.stringify(expected), message, () => ({ esperado: expected, actual, ...(detail ? { detalle: detail() } : {}) }));
}

type SqliteDb = {
  prepare(sql: string): { run(...params: unknown[]): unknown; all(...params: unknown[]): Array<Record<string, unknown>>; get(...params: unknown[]): Record<string, unknown> };
  pragma(sql: string, options?: { simple?: boolean }): unknown;
  exec(sql: string): void;
  close(): void;
};

function uniqueError(run: () => void): unknown {
  try {
    run();
    return null;
  } catch (error) {
    return error;
  }
}

async function main(): Promise<void> {
  console.log("== Fase 9A — migración aditiva del schema ==\n");

  const originalCwd = process.cwd();
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "magi-autonomy-contract-db-"));
  let db: SqliteDb | null = null;

  try {
    process.chdir(temp);
    checkEq(process.cwd(), temp, "el test corre en un cwd temporal");

    const dbModule = (await import("../../db")) as { getDb(): SqliteDb };
    db = dbModule.getDb();
    db.pragma("foreign_keys = ON");

    const tableNames = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
      (row) => row.name,
    );
    const expectedTables = [
      "agent_runs",
      "agent_plans",
      "agent_plan_items",
      "agent_steps",
      "agent_file_checkpoints",
      "agent_verifications",
      "agent_final_reports",
    ];
    for (const table of expectedTables) {
      check(tableNames.includes(table), `existe la tabla ${table}`);
    }

    const indexNames = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>).map(
      (row) => row.name,
    );
    for (const index of [
      "idx_agent_runs_task",
      "idx_agent_runs_one_active",
      "idx_agent_plans_task",
      "idx_agent_plan_items_plan",
      "idx_agent_steps_run",
      "idx_agent_verifications_run",
      "idx_agent_final_reports_task",
    ]) {
      check(indexNames.includes(index), `existe el índice ${index}`);
    }

    checkEq(db.pragma("user_version", { simple: true }), 1, "SCHEMA_VERSION no cambió (migración aditiva)");

    const runColumns = (db.prepare("PRAGMA table_info(agent_runs)").all() as Array<{ name: string }>).map((row) => row.name);
    for (const column of ["state", "stop_reason", "plan_version", "budget_json", "finished_at", "resume_of_run_id"]) {
      check(runColumns.includes(column), `agent_runs tiene la columna ${column}`);
    }

    const now = Date.now();
    db.prepare(
      "INSERT INTO agent_projects (id, name, source_type, local_path, is_git_repo, archived, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("p1", "Proyecto", "local", "C:\\tmp\\proyecto", 1, 0, now, now);
    db.prepare(
      "INSERT INTO agent_tasks (id, project_id, model_id, prompt, status, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("t1", "p1", "modelo", "tarea", "RUNNING", now);

    const insertRun = db.prepare(
      "INSERT INTO agent_runs (id, task_id, attempt, state, budget_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    insertRun.run("r1", "t1", 1, "PLANNING", "{}", now, now);

    const secondActive = uniqueError(() => insertRun.run("r2", "t1", 2, "PLANNING", "{}", now, now));
    check(secondActive !== null, "no se puede tener dos corridas activas para la misma task", () => secondActive);
    check(
      secondActive instanceof Error && secondActive.message.includes("UNIQUE"),
      "el rechazo de la segunda corrida activa es por UNIQUE",
      () => (secondActive instanceof Error ? secondActive.message : secondActive),
    );

    db.prepare("UPDATE agent_runs SET finished_at = ? WHERE id = ?").run(now, "r1");
    const third = uniqueError(() => insertRun.run("r2", "t1", 2, "PLANNING", "{}", now, now));
    check(third === null, "una corrida terminada libera el slot activo", () => third);

    const missingTask = uniqueError(() => insertRun.run("r3", "no-existe", 1, "PLANNING", "{}", now, now));
    check(missingTask !== null, "la FK a una task inexistente se rechaza", () => missingTask);

    const insertPlan = db.prepare(
      "INSERT INTO agent_plans (id, task_id, version, objective, constraints_json, acceptance_json, status, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    insertPlan.run("pl1", "t1", 1, "objetivo", "[]", "[]", "ACTIVE", "model", now);
    const duplicatePlan = uniqueError(() =>
      insertPlan.run("pl2", "t1", 1, "objetivo", "[]", "[]", "ACTIVE", "model", now),
    );
    check(duplicatePlan !== null, "una task no puede tener dos planes con la misma versión", () => duplicatePlan);

    const insertItem = db.prepare(
      "INSERT INTO agent_plan_items (id, plan_id, seq, title, description, status, depends_on_json, acceptance_json, paths_json, evidence_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    insertItem.run("i1", "pl1", 1, "item", "desc", "PENDING", "[]", "[]", "[]", "[]");
    const duplicateSeq = uniqueError(() =>
      insertItem.run("i2", "pl1", 1, "item", "desc", "PENDING", "[]", "[]", "[]", "[]"),
    );
    check(duplicateSeq !== null, "un plan no puede tener dos items con el mismo seq", () => duplicateSeq);

    const insertStep = db.prepare(
      "INSERT INTO agent_steps (id, run_id, step_index, phase, ts, actions_json, results_json, progress_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    insertStep.run("s1", "r2", 0, "EXECUTING", now, "[]", "[]", "{}");
    const duplicateStep = uniqueError(() =>
      insertStep.run("s2", "r2", 0, "EXECUTING", now, "[]", "[]", "{}"),
    );
    check(duplicateStep !== null, "una corrida no puede tener dos pasos con el mismo índice", () => duplicateStep);

    const insertCheckpoint = db.prepare(
      "INSERT INTO agent_file_checkpoints (run_id, path, sha256, size, mtime_ms, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    insertCheckpoint.run("r2", "src/a.ts", "hash", 1, now, now);
    const duplicateCheckpoint = uniqueError(() =>
      insertCheckpoint.run("r2", "src/a.ts", "otro", 2, now, now),
    );
    check(duplicateCheckpoint !== null, "un checkpoint de archivo es único por corrida y path", () => duplicateCheckpoint);

    const insertReport = db.prepare(
      "INSERT INTO agent_final_reports (run_id, task_id, status, stop_reason, report_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    insertReport.run("r1", "t1", "done", "completed", "{}", now);
    const duplicateReport = uniqueError(() => insertReport.run("r1", "t1", "done", "completed", "{}", now));
    check(duplicateReport !== null, "el informe final es idempotente por run", () => duplicateReport);

    checkEq(
      (db.prepare("SELECT count(*) AS c FROM agent_runs").get() as { c: number }).c,
      2,
      "quedaron exactamente dos corridas",
    );
  } finally {
    try {
      db?.close();
    } catch {
      // best-effort
    }
    (globalThis as unknown as { __councilDb?: unknown }).__councilDb = undefined;
    process.chdir(originalCwd);
    await fs.rm(temp, { recursive: true, force: true }).catch(() => undefined);
  }

  console.log(`\n${total - failed}/${total} casos OK.`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error("Error inesperado en la prueba de schema:", error);
  process.exit(1);
});
