/**
 * Fase 8 — aprobación humana para herramientas MCP de escritura.
 *
 * Un servidor MCP puede ofrecer herramientas que MODIFICAN cosas (borrar
 * archivos, mandar mails, tocar un servicio). Esas no se ejecutan con que el
 * agente las pida: hace falta que un HUMANO las apruebe, una por una.
 *
 * El patrón es el mismo que el emparejamiento (`lib/auth/pairing.ts`), a
 * propósito:
 *
 * - El valor en claro (el código) se devuelve UNA sola vez, al crear la
 *   solicitud. En la DB se guarda el hash.
 * - Vence en 5 minutos y es de UN solo uso.
 * - Los errores son genéricos: no se filtra si la solicitud existía.
 *
 * Quién puede aprobar: un operador (token de la app o sesión) o un dispositivo
 * con scope `approve` y step-up vigente (`lib/auth/step-up.ts`). Lo resuelve la
 * ruta, no este módulo: acá se guarda y se cambia de estado.
 *
 * Una aprobación se refiere a (servidor, herramienta, argumentos). Si los
 * argumentos cambian, la aprobación no sirve: se comparan por hash.
 */

import crypto from "node:crypto";
import { getDb } from "../db";
import { recordAudit } from "../auth/audit";

export const DEFAULT_APPROVAL_TTL_MS = 5 * 60_000;

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "used";

export type McpApproval = {
  id: string;
  code: string;
  serverName: string;
  toolName: string;
  /** Hash SHA-256 de los argumentos canónicos: si cambian, no sirve. */
  argsHash: string;
  /** Resumen legible de los argumentos (recortado, sin secretos). */
  argsSummary: string;
  status: ApprovalStatus;
  createdAt: number;
  expiresAt: number;
  decidedAt: number | null;
  decidedBy: string | null;
};

/**
 * Hash estable de los argumentos: las CLAVES se ordenan antes de serializar.
 * Sin eso, `{a, b}` y `{b, a}` darían hashes distintos y la misma herramienta
 * con los mismos datos exigiría dos aprobaciones.
 */
export function hashArgs(args: unknown): string {
  const stable = stableStringify(args);
  return crypto.createHash("sha256").update(stable, "utf8").digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const inner = record[key];
    if (inner === undefined) continue;
    parts.push(JSON.stringify(key) + ":" + stableStringify(inner));
  }
  return "{" + parts.join(",") + "}";
}

/** Resumen corto y sin secretos, para que un humano pueda decidir. */
export function summarizeArgs(args: unknown): string {
  if (args === undefined || args === null) return "sin argumentos";
  let text: string;
  try {
    text = typeof args === "string" ? args : JSON.stringify(args);
  } catch {
    return "argumentos no serializables";
  }
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 200 ? flat.slice(0, 197) + "..." : flat;
}

function generateCode(): string {
  // Mismo formato que los códigos de emparejamiento: 128 bits en base36, en
  // grupos de 4, para que un humano pueda dictarlo sin equivocarse.
  const raw = crypto.randomBytes(16).toString("hex").toUpperCase();
  return [raw.slice(0, 4), raw.slice(4, 8), raw.slice(8, 12), raw.slice(12, 16)].join("-");
}

/**
 * Crea la solicitud. Devuelve el código EN CLARO una única vez.
 *
 * `reuseSeconds` permite que múltiples llamados de la misma herramienta con los
 * mismos argumentos durante una ventana corta devuelvan la MISMA solicitud
 * pendiente: si no, un agente que insiste 10 veces genera 10 aprobaciones y el
 * operador termina aprobando a lo pavote.
 */
export function requestApproval(input: {
  serverName: string;
  toolName: string;
  args: unknown;
  ttlMs?: number;
  reuseSeconds?: number;
}): McpApproval {
  const now = Date.now();
  const argsHash = hashArgs(input.args);
  const ttlMs = input.ttlMs ?? DEFAULT_APPROVAL_TTL_MS;
  const reuseWindow = now - (input.reuseSeconds ?? 10) * 1000;

  // Reuso: misma herramienta, mismos argumentos, dentro de la ventana -> la
  // MISMA solicitud pendiente. Si no, un agente que insiste genera 10
  // aprobaciones y el operador termina aprobando en masa.
  const existing = getDb()
    .prepare(
      `SELECT * FROM mcp_approvals
       WHERE server_name = ? AND tool_name = ? AND args_hash = ? AND status = 'pending'
         AND created_at >= ? AND expires_at > ?`,
    )
    .get(input.serverName, input.toolName, argsHash, reuseWindow, now) as Row | undefined;
  if (existing) return rowToApproval(existing);

  recordAudit({
    deviceId: null,
    action: "mcp_approval_requested",
    result: "ok",
    detail: input.serverName + "/" + input.toolName,
  });

  const id = crypto.randomUUID();
  const code = generateCode();
  getDb()
    .prepare(
      `INSERT INTO mcp_approvals (id, code_hash, server_name, tool_name, args_hash, args_summary,
         status, created_at, expires_at, decided_at, decided_by)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL, NULL)`,
    )
    .run(
      id,
      crypto.createHash("sha256").update(code, "utf8").digest("hex"),
      input.serverName,
      input.toolName,
      argsHash,
      summarizeArgs(input.args),
      now,
      now + ttlMs,
    );
  const row = getDb().prepare("SELECT * FROM mcp_approvals WHERE id = ?").get(id) as Row;
  return { ...rowToApproval(row), code };
}

/** Aprueba. `decidedBy` es libre: "operador" o el id del dispositivo. */
export function approveApproval(code: string, decidedBy: string): { ok: true; approval: McpApproval } | { ok: false; error: string } {
  return decide(code, "approved", decidedBy);
}

/** Rechaza. */
export function rejectApproval(code: string, decidedBy: string): { ok: true; approval: McpApproval } | { ok: false; error: string } {
  return decide(code, "rejected", decidedBy);
}

const GENERIC_ERROR = "Solicitud de aprobación inválida o vencida.";

function decide(code: string, status: "approved" | "rejected", decidedBy: string): { ok: true; approval: McpApproval } | { ok: false; error: string } {
  const trimmed = code.trim().toUpperCase();
  const hash = crypto.createHash("sha256").update(trimmed, "utf8").digest("hex");
  const row = getDb().prepare("SELECT * FROM mcp_approvals WHERE code_hash = ?").get(hash) as Row | undefined;
  // Genérico a propósito: no se filtra si existía, si ya estaba usada o si venció.
  if (!row || row.status !== "pending" || row.expires_at <= Date.now()) {
    return { ok: false, error: GENERIC_ERROR };
  }
  getDb()
    .prepare("UPDATE mcp_approvals SET status = ?, decided_at = ?, decided_by = ? WHERE id = ?")
    .run(status, Date.now(), decidedBy, row.id);
  recordAudit({
    deviceId: null,
    action: "mcp_approval_decided",
    result: status === "approved" ? "ok" : "denied",
    targetId: row.id,
    detail: "mcp " + row.server_name + "/" + row.tool_name + " " + status,
  });
  const updated = getDb().prepare("SELECT * FROM mcp_approvals WHERE id = ?").get(row.id) as Row;
  return { ok: true, approval: rowToApproval(updated) };
}

/**
 * Consume una aprobación: es de UN solo uso y además tiene que coincidir con
 * los argumentos exactos. Si todo cierra, queda marcada como `used`.
 */
export function consumeApproval(
  code: string,
  expected: { serverName: string; toolName: string; argsHash: string },
): { ok: true; approvalId: string } | { ok: false; error: string } {
  const trimmed = code.trim().toUpperCase();
  const hash = crypto.createHash("sha256").update(trimmed, "utf8").digest("hex");
  const row = getDb().prepare("SELECT * FROM mcp_approvals WHERE code_hash = ?").get(hash) as Row | undefined;
  if (!row || row.status !== "approved") {
    return { ok: false, error: GENERIC_ERROR };
  }
  if (row.args_hash !== expected.argsHash) {
    return { ok: false, error: "Los argumentos no coinciden con lo aprobado." };
  }
  if (row.server_name !== expected.serverName || row.tool_name !== expected.toolName) {
    return { ok: false, error: "La aprobación es para otra herramienta." };
  }
  const result = getDb()
    .prepare("UPDATE mcp_approvals SET status = 'used' WHERE id = ? AND status = 'approved'")
    .run(row.id);
  if (result.changes === 0) return { ok: false, error: GENERIC_ERROR };
  return { ok: true, approvalId: row.id };
}

export function listApprovals(limit = 100): McpApproval[] {
  const rows = getDb()
    .prepare("SELECT * FROM mcp_approvals ORDER BY created_at DESC LIMIT ?")
    .all(limit) as Row[];
  return rows.map(rowToApproval);
}

/** Marca como vencidas las que ya pasaron su plazo. Devuelve cuántas. */
export function expireStaleApprovals(): number {
  const result = getDb()
    .prepare("UPDATE mcp_approvals SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?")
    .run(Date.now());
  return result.changes;
}

/** Poda de las ya decididas, para que la tabla no crezca sin límite. */
export function pruneApprovals(olderThanMs = 7 * 24 * 60 * 60_000): number {
  const result = getDb()
    .prepare("DELETE FROM mcp_approvals WHERE status IN ('used', 'rejected', 'expired') AND created_at < ?")
    .run(Date.now() - olderThanMs);
  return result.changes;
}

type Row = {
  id: string;
  code_hash: string;
  server_name: string;
  tool_name: string;
  args_hash: string;
  args_summary: string;
  status: string;
  created_at: number;
  expires_at: number;
  decided_at: number | null;
  decided_by: string | null;
};

function rowToApproval(row: Row): McpApproval {
  return {
    id: row.id,
    // El código en claro NO se puede recuperar: solo existe al crear. Se
    // devuelve vacío para que nadie lo confunda con el valor real.
    code: "",
    serverName: row.server_name,
    toolName: row.tool_name,
    argsHash: row.args_hash,
    argsSummary: row.args_summary,
    status: row.status as ApprovalStatus,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
  };
}

