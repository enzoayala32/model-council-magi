import crypto from "node:crypto";
import { getDb } from "../db";
import type { AgentFileProposal, TypeCheckResult } from "./loop";

/** Registro persistido de una `AgentFileProposal` (Fase 2F, ver diseño de
 * Fase 2, secciones 6 y 7). Nota deliberada: solo se persiste
 * `typecheckStatus` ("skipped" | "ok" | "error"), no el detalle
 * `errors: string[]` que sí trae `AgentFileProposal.typeCheck` en memoria —
 * así lo define el schema aprobado. Si hace falta mostrar los errores de
 * tipo después de un restart del server, hay que agregar una columna nueva;
 * hoy esa info solo sobrevive dentro de `agent_events` (evento
 * `typecheck_result`, con `outputExcerpt`), no acá. */
export type PersistedProposal = {
  id: string;
  taskId: string;
  kind: "write" | "edit";
  relPath: string;
  diff: string;
  nextContent: string;
  baselineHash: string;
  typecheckStatus: TypeCheckResult["status"];
  applied: boolean;
  conflict: boolean;
};

type PersistedProposalRow = {
  id: string;
  task_id: string;
  kind: string;
  rel_path: string;
  diff: string;
  next_content: string;
  baseline_hash: string;
  typecheck_status: string;
  applied: number;
  conflict: number;
};

function rowToProposal(row: PersistedProposalRow): PersistedProposal {
  return {
    id: row.id,
    taskId: row.task_id,
    kind: row.kind as "write" | "edit",
    relPath: row.rel_path,
    diff: row.diff,
    nextContent: row.next_content,
    baselineHash: row.baseline_hash,
    typecheckStatus: row.typecheck_status as TypeCheckResult["status"],
    applied: row.applied === 1,
    conflict: row.conflict === 1,
  };
}

/**
 * Persiste TODAS las `AgentFileProposal` de una task de una sola vez —
 * se llama una única vez, desde `runner.ts`, justo antes de transicionar a
 * `READY_FOR_REVIEW` (ver diseño de Fase 2, sección 9, paso 4). No hay
 * upsert ni update parcial a propósito: una task que ya llegó a
 * `READY_FOR_REVIEW` no vuelve a correr el loop ni a generar proposals
 * nuevas, así que esto es create-only. Transacción única para que, si algo
 * falla a mitad de camino, no quede la task en `READY_FOR_REVIEW` con solo
 * la mitad de sus archivos persistidos.
 */
export function persistProposals(taskId: string, proposals: AgentFileProposal[]): PersistedProposal[] {
  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO agent_proposals (id, task_id, kind, rel_path, diff, next_content, baseline_hash, typecheck_status, applied, conflict)
     VALUES (@id, @taskId, @kind, @relPath, @diff, @nextContent, @baselineHash, @typecheckStatus, 0, 0)`,
  );

  const persisted: PersistedProposal[] = [];
  const insertAll = db.transaction((items: AgentFileProposal[]) => {
    for (const item of items) {
      const row: PersistedProposal = {
        id: crypto.randomUUID(),
        taskId,
        kind: item.kind,
        relPath: item.relPath,
        diff: item.diff,
        nextContent: item.nextContent,
        baselineHash: item.baselineHash,
        typecheckStatus: item.typeCheck.status,
        applied: false,
        conflict: false,
      };
      insert.run(row);
      persisted.push(row);
    }
  });
  insertAll(proposals);

  return persisted;
}

/** Todas las proposals de una task, en el orden en que se persistieron
 * (`rowid` implícito de SQLite basta acá, no hace falta un `seq` propio
 * como en `agent_events` — a diferencia de los eventos, las proposals de
 * una task se escriben todas juntas en una sola transacción, no una por
 * una a lo largo del tiempo). */
export function getProposalsForTask(taskId: string): PersistedProposal[] {
  const rows = getDb().prepare("SELECT * FROM agent_proposals WHERE task_id = ? ORDER BY rowid ASC").all(taskId) as PersistedProposalRow[];
  return rows.map(rowToProposal);
}

export function getProposal(id: string): PersistedProposal | null {
  const row = getDb().prepare("SELECT * FROM agent_proposals WHERE id = ?").get(id) as PersistedProposalRow | undefined;
  return row ? rowToProposal(row) : null;
}

/** Fase 2G: marca una proposal como aplicada al `Project` real. Limpia
 * `conflict` a la vez (0) — cubre el caso de un reintento de APPLY sobre
 * una proposal que había quedado en conflicto y esta vez sí matcheó (ej. el
 * usuario revirtió a mano el cambio ajeno). */
export function markProposalApplied(id: string): void {
  getDb().prepare("UPDATE agent_proposals SET applied = 1, conflict = 0 WHERE id = ?").run(id);
}

/** Fase 2G: marca una proposal en conflicto (su `baseline_hash` ya no
 * coincide con el contenido real del proyecto al momento de aplicar) — NO
 * se escribe nada a disco para esta proposal puntual. No toca `applied`. */
export function markProposalConflict(id: string): void {
  getDb().prepare("UPDATE agent_proposals SET conflict = 1 WHERE id = ?").run(id);
}
