/**
 * Fase 9 — la app como SERVIDOR MCP: herramientas expuestas.
 *
 * Se expone lo que un cliente MCP emparejado puede necesitar para observar:
 * estado del consejo y de las tareas del agente. Nada de escritura, y NADA de
 * aprobaciones: un cliente MCP nunca puede aprobar en nombre de un humano (eso
 * es Fase 8 y vive en la UI, con segundo factor).
 *
 * La lógica es pura (`dispatchTool` recibe funciones lectoras inyectadas), así
 * los tests no levantan nada: la ruta solo traduce HTTP ↔ JSON-RPC.
 *
 * Cada herramienta declara el scope mínimo que exige. Queda enforceado por
 * `lib/auth/scopes.ts` como cualquier otra ruta.
 */

import { isDeviceScope, type DeviceScope } from "../auth/devices";

export type McpServerTool = {
  name: string;
  description: string;
  /** Scope mínimo: un cliente con scope mayor también puede. */
  scope: DeviceScope;
  /** true = no modifica nada. Todas las de acá lo son. */
  readOnly: true;
};

export const MCP_SERVER_TOOLS: readonly McpServerTool[] = [
  {
    name: "tasks.list",
    description: "Lista las tareas del agente (id, estado, proyecto). Solo lectura.",
    scope: "observe",
    readOnly: true,
  },
  {
    name: "tasks.status",
    description: "Estado detallado de una tarea por id. Solo lectura.",
    scope: "observe",
    readOnly: true,
  },
  {
    name: "tasks.events",
    description: "Eventos recientes de una tarea (con su seq). Solo lectura.",
    scope: "observe",
    readOnly: true,
  },
  {
    name: "council.runs",
    description: "Últimas corridas del consejo. Solo lectura.",
    scope: "observe",
    readOnly: true,
  },
  {
    name: "council.run",
    description: "Detalle de una corrida del consejo por id. Solo lectura.",
    scope: "observe",
    readOnly: true,
  },
];

export function findServerTool(name: string): McpServerTool | null {
  return MCP_SERVER_TOOLS.find((tool) => tool.name === name) ?? null;
}

/** Argumentos que se aceptan, validados a mano: nada de "cualquier cosa". */
export type ToolArgs =
  | { tool: "tasks.list"; limit?: number }
  | { tool: "tasks.status"; id: string }
  | { tool: "tasks.events"; id: string; sinceSeq?: number; limit?: number }
  | { tool: "council.runs"; limit?: number }
  | { tool: "council.run"; id: string };

type ArgCheck = { ok: true; args: ToolArgs } | { ok: false; error: string };

function boundedLimit(value: unknown, fallback: number, max: number): number {
  const parsed = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.max(1, Math.min(max, parsed));
}

function requireId(value: unknown): { ok: true; id: string } | { ok: false; error: string } {
  if (typeof value !== "string" || value.trim() === "") return { ok: false, error: "falta el id." };
  return { ok: true, id: value.trim().slice(0, 100) };
}

/** Valida nombre y argumentos. No ejecuta nada. */
export function validateToolCall(name: string, rawArgs: unknown): ArgCheck {
  const tool = findServerTool(name);
  if (!tool) return { ok: false, error: "herramienta desconocida: " + name };
  const args = (typeof rawArgs === "object" && rawArgs !== null ? rawArgs : {}) as Record<string, unknown>;

  switch (tool.name) {
    case "tasks.list":
      return { ok: true, args: { tool: "tasks.list", limit: boundedLimit(args.limit, 20, 100) } };
    case "tasks.status": {
      const id = requireId(args.id);
      return id.ok ? { ok: true, args: { tool: "tasks.status", id: id.id } } : { ok: false, error: id.error };
    }
    case "tasks.events": {
      const id = requireId(args.id);
      if (!id.ok) return { ok: false, error: id.error };
      const sinceSeq = typeof args.sinceSeq === "number" && Number.isFinite(args.sinceSeq) ? Math.floor(args.sinceSeq) : undefined;
      return {
        ok: true,
        args: { tool: "tasks.events", id: id.id, sinceSeq, limit: boundedLimit(args.limit, 50, 200) },
      };
    }
    case "council.runs":
      return { ok: true, args: { tool: "council.runs", limit: boundedLimit(args.limit, 20, 100) } };
    case "council.run": {
      const id = requireId(args.id);
      return id.ok ? { ok: true, args: { tool: "council.run", id: id.id } } : { ok: false, error: id.error };
    }
    default:
      return { ok: false, error: "herramienta no implementada: " + name };
  }
}

/** Lectores inyectados: los tests pasan los suyos, la ruta los reales. */
export type ToolReaders = {
  listTasks: (limit: number) => unknown[];
  getTask: (id: string) => unknown | null;
  listEvents: (id: string, sinceSeq: number | undefined, limit: number) => unknown[];
  listCouncilRuns: (limit: number) => unknown[];
  getCouncilRun: (id: string) => unknown | null;
};

/** Texto que se devuelve al cliente: JSON compacto y recortado. */
function toText(value: unknown): string {
  const text = JSON.stringify(value);
  return text.length > 100_000 ? text.slice(0, 99_997) + "..." : text;
}

export function dispatchTool(args: ToolArgs, readers: ToolReaders): { ok: true; text: string } | { ok: false; error: string } {
  switch (args.tool) {
    case "tasks.list":
      return { ok: true, text: toText(readers.listTasks(args.limit ?? 20)) };
    case "tasks.status": {
      const task = readers.getTask(args.id);
      return task ? { ok: true, text: toText(task) } : { ok: false, error: "no existe la tarea " + args.id };
    }
    case "tasks.events":
      return { ok: true, text: toText(readers.listEvents(args.id, args.sinceSeq, args.limit ?? 50)) };
    case "council.runs":
      return { ok: true, text: toText(readers.listCouncilRuns(args.limit ?? 20)) };
    case "council.run": {
      const run = readers.getCouncilRun(args.id);
      return run ? { ok: true, text: toText(run) } : { ok: false, error: "no existe la corrida " + args.id };
    }
    default:
      return { ok: false, error: "herramienta no implementada" };
  }
}

/** Catálogo en el formato que espera un cliente MCP (tools/list). */
export function serverToolCatalog(scope: DeviceScope): Array<{ name: string; description: string; readOnly: true }> {
  const level = scope === "approve" ? 3 : scope === "operate" ? 2 : 1;
  return MCP_SERVER_TOOLS.filter((tool) => {
    const required = tool.scope === "approve" ? 3 : tool.scope === "operate" ? 2 : 1;
    return level >= required;
  }).map((tool) => ({ name: tool.name, description: tool.description, readOnly: true as const }));
}

/** Por si algún día se agregan scopes nuevos: el chequeo no puede quedar flojo. */
export function scopeAllowed(granted: string, required: DeviceScope): boolean {
  return isDeviceScope(granted) && serverToolCatalog(granted).length > 0 ? true : required === "observe";
}
