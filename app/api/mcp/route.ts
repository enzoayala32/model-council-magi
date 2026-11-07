import { NextResponse } from "next/server";
import { guardRequest } from "@/lib/auth/guard";
import { requireScope } from "@/lib/auth/authorize";
import { recordAudit } from "@/lib/auth/audit";
import { getTask, listTasks } from "@/lib/agent/task-store";
import { listEvents } from "@/lib/agent/event-log";
import { listCouncilRuns, getCouncilRun } from "@/lib/council-run-store";
import { dispatchTool, serverToolCatalog, validateToolCall, type ToolReaders } from "@/lib/mcp/server-tools";

/**
 * Fase 9 — la app como servidor MCP (`/api/mcp`).
 *
 * JSON-RPC 2.0 sobre POST, con el mismo criterio de autorización que cualquier
 * otra ruta: `guardRequest()` como primera sentencia, scope declarado en
 * `lib/auth/scopes.ts`, y un cliente emparejado es un dispositivo más.
 *
 * Métodos: `initialize`, `tools/list`, `tools/call`, `ping`.
 *
 * Deliberadamente NO hay método de aprobación: aprobar es un acto HUMANO con
 * segundo factor (Fase 8), no algo que un cliente MCP pueda pedir por protocolo.
 * Las herramientas expuestas son todas de solo lectura.
 *
 * Lo que ve un cliente depende de su scope: `tools/list` filtra el catálogo.
 */

const READERS: ToolReaders = {
  listTasks: (limit) =>
    listTasks({})
      .slice(0, limit)
      .map((task) => ({
        id: task.id,
        status: task.status,
        projectId: task.projectId,
        prompt: task.prompt.slice(0, 200),
        createdAt: task.createdAt,
        finishedAt: task.finishedAt,
      })),
  getTask: (id) => {
    const task = getTask(id);
    return task
      ? {
          id: task.id,
          status: task.status,
          projectId: task.projectId,
          prompt: task.prompt.slice(0, 200),
          error: task.error,
          conflictedPaths: task.conflictedPaths,
          createdAt: task.createdAt,
          startedAt: task.startedAt,
          finishedAt: task.finishedAt,
        }
      : null;
  },
  // `listEvents` no acepta límite: se recorta acá, que es donde se conoce el
  // pedido del cliente. El campo de tiempo se llama `ts`, no `at`.
  listEvents: (id, sinceSeq, limit) =>
    listEvents(id, { sinceSeq })
      .slice(0, limit ?? 50)
      .map((event) => ({ seq: event.seq, type: event.type, ts: event.ts })),
  listCouncilRuns: (limit) => listCouncilRuns({ limit }),
  getCouncilRun: (id) => getCouncilRun(id),
};

type RpcRequest = { jsonrpc?: "2.0"; id?: number | string | null; method?: string; params?: unknown };

function rpc(id: number | string | null, result: unknown): Response {
  return NextResponse.json({ jsonrpc: "2.0", id, result });
}

function rpcError(id: number | string | null, code: number, message: string): Response {
  // El error va con HTTP 200: es lo que manda JSON-RPC. El rechazo de
  // autorización (403) ya volvió antes, con su propio status.
  return NextResponse.json({ jsonrpc: "2.0", id, error: { code, message } }, { status: 200 });
}

export async function POST(request: Request) {
  const denied = guardRequest(request);
  if (denied) return denied;

  const authorized = requireScope({ method: "POST", pathname: "/api/mcp", request });
  if (!authorized.ok) {
    return NextResponse.json({ ok: false, error: authorized.error }, { status: authorized.status });
  }
  const { context } = authorized;

  let payload: RpcRequest;
  try {
    payload = (await request.json()) as RpcRequest;
  } catch {
    return rpcError(null, -32700, "JSON inválido.");
  }
  if (payload?.jsonrpc !== "2.0" || typeof payload.method !== "string") {
    return rpcError(payload?.id ?? null, -32600, "No es un request JSON-RPC 2.0.");
  }
  const id = payload.id ?? null;
  const params = (typeof payload.params === "object" && payload.params !== null ? payload.params : {}) as Record<string, unknown>;

  switch (payload.method) {
    case "initialize":
      return rpc(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "consenso-ia", version: "1.0.0" },
        // Las dos restricciones, dichas por protocolo, para que un cliente no
        // tenga que adivinarlas.
        instructions:
          "Servidor MCP de Consenso IA. Solo lectura: no hay herramientas que escriban ni que aprueben. " +
          "Las aprobaciones se hacen desde la app, con segundo factor.",
      });

    case "ping":
      return rpc(id, {});

    case "tools/list": {
      const scope = context.operator ? "approve" : context.device?.scope ?? "observe";
      return rpc(id, { tools: serverToolCatalog(scope) });
    }

    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      const validated = validateToolCall(name, params.arguments);
      if (!validated.ok) {
        return rpc(id, { content: [{ type: "text", text: validated.error }], isError: true });
      }
      const result = dispatchTool(validated.args, READERS);
      recordAudit({
        deviceId: context.device?.id ?? null,
        action: "mcp_tool_called",
        result: result.ok ? "ok" : "error",
        targetId: name,
      });
      return rpc(
        id,
        result.ok
          ? { content: [{ type: "text", text: result.text }] }
          : { content: [{ type: "text", text: result.error }], isError: true },
      );
    }

    default:
      return rpcError(id, -32601, "Método no soportado: " + payload.method);
  }
}
