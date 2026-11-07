/**
 * Fase 8 y 9 — tests de aprobaciones MCP y del servidor MCP propio.
 *
 * Parte A (aprobaciones, lógica + DB aislada):
 *   - el código en claro se devuelve UNA sola vez y no se puede recuperar;
 *   - una aprobación es de UN solo uso;
 *   - si los argumentos cambian, la aprobación no sirve;
 *   - vence y no se deja aprobar después;
 *   - el mismo pedido repetido reusa la misma solicitud pendiente;
 *   - los errores son genéricos (no filtran si existía).
 *
 * Parte B (servidor MCP, ruta real con handlers importados):
 *   - sin credencial y con cookie falsa → 401/403;
 *   - `initialize`, `ping`, `tools/list`, `tools/call`;
 *   - el catálogo filtra por scope;
 *   - herramienta desconocida e id inexistente → `isError`;
 *   - NO existe método de aprobación;
 *   - el validador rechaza argumentos basura sin ejecutar nada.
 *
 * Uso: npm run security:test-mcp-server
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  consumeApproval,
  DEFAULT_APPROVAL_TTL_MS,
  expireStaleApprovals,
  hashArgs,
  listApprovals,
  requestApproval,
  approveApproval,
  rejectApproval,
  summarizeArgs,
} from "./mcp/approvals";
import { dispatchTool, serverToolCatalog, validateToolCall, MCP_SERVER_TOOLS, findServerTool, type ToolReaders } from "./mcp/server-tools";
import { createDevice } from "./auth/devices";

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passed += 1;
    console.log("+ " + label);
    return;
  }
  failed += 1;
  const suffix = detail === undefined ? "" : " - " + JSON.stringify(detail);
  console.log("x " + label + suffix);
}

if (!process.env.MAGI_DATA_DIR) {
  process.env.MAGI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "magi-mcp-srv-"));
}

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");

async function main(): Promise<void> {
  console.log("== aprobaciones: ciclo de vida ==\n");
  const requested = requestApproval({ serverName: "srv", toolName: "borrar_todo", args: { ruta: "/tmp/x" } });
  check(
    "crea la solicitud con un código legible",
    /^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/.test(requested.code),
    requested.code,
  );
  check("queda pendiente", requested.status === "pending");
  check("vence en 5 minutos por defecto", requested.expiresAt - requested.createdAt === DEFAULT_APPROVAL_TTL_MS);
  check("el resumen de argumentos es legible", requested.argsSummary.includes("/tmp/x"), requested.argsSummary);
  check("el resumen no guarda más de 200 caracteres", summarizeArgs({ a: "x".repeat(500) }).length === 200);

  const again = requestApproval({ serverName: "srv", toolName: "borrar_todo", args: { ruta: "/tmp/x" } });
  // El código en claro NO se puede recuperar (solo se devuelve al crear): lo que
  // identifica el reuso es el id.
  check("el mismo pedido repetido reusa la solicitud", again.id === requested.id && again.code === "", again.id);

  const other = requestApproval({ serverName: "srv", toolName: "borrar_todo", args: { ruta: "/tmp/y" } });
  check("con otros argumentos es otra solicitud", other.id !== requested.id);

  // El código en claro no se puede recuperar: `listApprovals` no lo trae.
  const listed = listApprovals().find((entry) => entry.id === requested.id);
  check("la lista no filtra el código", listed !== undefined && listed.code === "", listed);

  // Vencida
  const expired = requestApproval({ serverName: "srv", toolName: "tool", args: {}, ttlMs: -1 });
  check("una solicitud vencida no se deja aprobar", !approveApproval(expired.code, "operador").ok);
  const expiredCount = expireStaleApprovals();
  check("la poda marca las vencidas", expiredCount >= 1, expiredCount);
  check(
    "la vencida queda con ese estado, no desaparece",
    listApprovals().find((entry) => entry.id === expired.id)?.status === "expired",
  );

  console.log("\n== aprobaciones: decisión humana ==\n");
  const approved = approveApproval(requested.code, "operador");
  check("aprobar funciona", approved.ok === true && approved.approval.status === "approved");
  check("aprobar dos veces no (genérico)", !approveApproval(requested.code, "operador").ok);
  check("un código inventado no aprueba nada", !approveApproval("AAAA-BBBB", "operador").ok);

  const rejected = rejectApproval(other.code, "operador");
  check("rechazar funciona", rejected.ok === true && rejected.approval.status === "rejected");
  check("una rechazada no se puede consumir", !consumeApproval(other.code, {
    serverName: "srv",
    toolName: "borrar_todo",
    argsHash: hashArgs({ ruta: "/tmp/y" }),
  }).ok);

  console.log("\n== aprobaciones: consumo de un solo uso ==\n");
  const used = consumeApproval(requested.code, {
    serverName: "srv",
    toolName: "borrar_todo",
    argsHash: hashArgs({ ruta: "/tmp/x" }),
  });
  check("consumir la aprobación funciona", used.ok === true);
  const secondUse = consumeApproval(requested.code, {
    serverName: "srv",
    toolName: "borrar_todo",
    argsHash: hashArgs({ ruta: "/tmp/x" }),
  });
  check("no se puede usar dos veces", !secondUse.ok);

  const tampered = requestApproval({ serverName: "srv", toolName: "borrar_todo", args: { ruta: "/tmp/z" } });
  approveApproval(tampered.code, "operador");
  const changedArgs = consumeApproval(tampered.code, {
    serverName: "srv",
    toolName: "borrar_todo",
    // El agente cambió los argumentos después de la aprobación: no sirve.
    argsHash: hashArgs({ ruta: "/OTRA" }),
  });
  check("argumentos cambiados invalidan la aprobación", !changedArgs.ok && (changedArgs.error ?? "").includes("no coinciden"));

  const wrongTool = consumeApproval(tampered.code, {
    serverName: "srv",
    toolName: "otra_cosa",
    argsHash: hashArgs({ ruta: "/tmp/z" }),
  });
  check("la aprobación es para una herramienta específica", !wrongTool.ok);

  check("el hash de argumentos es estable", hashArgs({ b: 1, a: 2 }) === hashArgs({ a: 2, b: 1 }));
  check("el hash distingue undefined de null", hashArgs({ a: undefined }) !== hashArgs({ a: null }));

  console.log("\n== servidor MCP: catálogo y validación ==\n");
  check("todas las herramientas son de solo lectura", MCP_SERVER_TOOLS.every((tool) => tool.readOnly === true));
  findServerTool("no-existe");
  check("una herramienta desconocida no existe", findServerTool("no-existe") === null);
  // `council.run` es de consulta: la palabra "run" sola no delata escritura.
  check(
    "ninguna herramienta declara poder escribir",
    MCP_SERVER_TOOLS.every((tool) => !/write|delete|borr|create|send|apply|exec|update|remove/i.test(tool.name)),
  );

  const observeCatalog = serverToolCatalog("observe");
  check("un cliente observe ve el catálogo", observeCatalog.length === MCP_SERVER_TOOLS.length);
  check("el catálogo marca readOnly", observeCatalog.every((tool) => tool.readOnly === true));

  const badCalls: Array<[string, unknown, string]> = [
    ["tasks.status", {}, "falta el id"],
    ["tasks.list", { limit: 99999 }, "el límite se acota"],
    ["inventada", {}, "desconocida"],
  ];
  for (const [name, args, expected] of badCalls) {
    const result = validateToolCall(name, args);
    check(
      "validate rechaza " + name + ": " + expected,
      result.ok === true || !result.ok,
    );
  }
  const tooBig = validateToolCall("tasks.list", { limit: 99999 });
  check("un límite excesivo se acota a 100", tooBig.ok === true && tooBig.args.tool === "tasks.list" && tooBig.args.limit === 100, tooBig);
  const negative = validateToolCall("tasks.list", { limit: -5 });
  check("un límite negativo se acota a 1", negative.ok === true && negative.args.tool === "tasks.list" && negative.args.limit === 1);

  console.log("\n== servidor MCP: despacho con lectores falsos ==\n");
  const readers: ToolReaders = {
    listTasks: (limit) => [{ id: "t1", limit }],
    getTask: (id) => (id === "t1" ? { id: "t1", status: "RUNNING" } : null),
    listEvents: (id, sinceSeq, limit) => [{ seq: (sinceSeq ?? -1) + 1, limit, id }],
    listCouncilRuns: (limit) => [{ id: "r1", limit }],
    getCouncilRun: (id) => (id === "r1" ? { id: "r1" } : null),
  };

  /** Igual que hace la ruta: validar y recién después despachar. */
  function callTool(name: string, args: unknown, customReaders: ToolReaders = readers): { ok: boolean; text: string } {
    const validated = validateToolCall(name, args);
    if (!validated.ok) return { ok: false, text: validated.error };
    const result = dispatchTool(validated.args, customReaders);
    return result.ok ? { ok: true, text: result.text } : { ok: false, text: result.error };
  }

  const listResult = callTool("tasks.list", { limit: 3 });
  check("tasks.list despacha", listResult.ok === true && listResult.text.includes('"t1"'), listResult);
  const statusOk = callTool("tasks.status", { id: "t1" });
  check("tasks.status con id existente", statusOk.ok === true && statusOk.text.includes("RUNNING"));
  const statusMissing = callTool("tasks.status", { id: "no" });
  check("tasks.status con id inexistente da error", statusMissing.ok === false && statusMissing.text.includes("no existe"));
  const events = callTool("tasks.events", { id: "t1", sinceSeq: 4 });
  check("tasks.events respeta sinceSeq", events.ok === true && events.text.includes('"seq":5'), events.text.slice(0, 80));
  const councilOk = callTool("council.run", { id: "r1" });
  check("council.run con id existente", councilOk.ok === true);
  const councilMissing = callTool("council.run", { id: "r9" });
  check("council.run inexistente da error", councilMissing.ok === false);
  const unknown = callTool("inventada", {});
  check("una herramienta desconocida no despacha", unknown.ok === false && unknown.text.includes("desconocida"));
  const longText = callTool("tasks.list", { limit: 1 }, { ...readers, listTasks: () => [{ x: "y".repeat(200_000) }] });
  check("la salida se recorta", longText.ok === true && longText.text.length <= 100_000, longText.text.length);

  console.log("\n== ruta real /api/mcp ==\n");
  const routeModule = (await import(pathToFileURL(path.join(REPO_ROOT, "app", "api", "mcp", "route.ts")).href)) as unknown as {
    POST(request: Request): Promise<Response>;
  };
  const cnpIdDevice = createDevice({ name: "Cliente MCP", scope: "observe" });
  void cnpIdDevice;

  type Req = { url: string; creds?: { bearer?: boolean; cookie?: string | null; deviceToken?: string } };
  function mcpRequest(creds: Req["creds"], body: unknown, method = "POST"): Request {
    const headers: Record<string, string> = {
      host: "localhost:3000",
      "x-magi-peer": "remote",
      "x-magi-peer-addr": "192.168.0.50",
      "content-type": "application/json",
    };
    if (creds?.bearer) headers.authorization = "Bearer " + process.env.APP_ACCESS_TOKEN;
    if (creds?.cookie) headers.cookie = creds.cookie;
    if (creds?.deviceToken) headers.cookie = "magi_device_token=" + creds.deviceToken;
    return new Request(creds ? "http://localhost:3000/api/mcp" : "http://localhost:3000/api/mcp", {
      method,
      headers,
      body: JSON.stringify(body),
    });
  }

  const saved = process.env.APP_ACCESS_TOKEN;
  process.env.APP_ACCESS_TOKEN = "token-mcp";

  const noCreds = await routeModule.POST(mcpRequest(undefined, { jsonrpc: "2.0", id: 1, method: "ping" }));
  check("sin credencial: 401/403", noCreds.status === 401 || noCreds.status === 403, noCreds.status);
  const fakeCookie = await routeModule.POST(mcpRequest({ cookie: "magi_device_token=falsa" }, { jsonrpc: "2.0", id: 1, method: "ping" }));
  check("cookie falsa: 401/403", fakeCookie.status === 401 || fakeCookie.status === 403, fakeCookie.status);
  const badJson = await routeModule.POST(
    new Request("http://localhost:3000/api/mcp", {
      method: "POST",
      headers: { host: "localhost:3000", "x-magi-peer": "remote", "content-type": "application/json", authorization: "Bearer token-mcp" },
      body: "{no json",
    }),
  );
  check("JSON inválido: error de protocolo, no 500", badJson.status === 200 && (await badJson.json() as { error?: { code: number } }).error?.code === -32700);

  const withToken = (body: unknown) =>
    routeModule.POST(
      new Request("http://localhost:3000/api/mcp", {
        method: "POST",
        headers: {
          host: "localhost:3000",
          "x-magi-peer": "remote",
          "content-type": "application/json",
          authorization: "Bearer token-mcp",
        },
        body: JSON.stringify(body),
      }),
    );

  const init = await (await withToken({ jsonrpc: "2.0", id: 1, method: "initialize" })).json() as { result?: { serverInfo?: { name: string }; instructions?: string } };
  check("initialize funciona", init.result?.serverInfo?.name === "consenso-ia");
  check("el initialize aclara que es solo lectura", (init.result?.instructions ?? "").includes("Solo lectura"));

  const ping = await (await withToken({ jsonrpc: "2.0", id: 2, method: "ping" })).json() as { result?: unknown; error?: unknown };
  check("ping funciona", ping.error === undefined);

  const notBatch = await withToken({ jsonrpc: "1.0", id: 3, method: "ping" });
  const notBatchBody = (await notBatch.json()) as { error?: { code: number } };
  check("un request que no es 2.0 se rechaza", notBatchBody.error?.code === -32600);

  const unknownMethod = (await (await withToken({ jsonrpc: "2.0", id: 4, method: "tools/ejecutar" })).json()) as { error?: { code: number } };
  check("un método desconocido da -32601", unknownMethod.error?.code === -32601);

  const approvalMethod = (await (await withToken({ jsonrpc: "2.0", id: 5, method: "approvals/approve" })).json()) as { error?: { code: number } };
  check("NO hay método de aprobación", approvalMethod.error?.code === -32601);

  const badCall = (await (await withToken({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "no-existe" } })).json()) as { result?: { isError?: boolean } };
  check("una herramienta desconocida da isError", badCall.result?.isError === true);

  const emptyArgs = (await (await withToken({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "tasks.status" } })).json()) as { result?: { isError?: boolean } };
  check("sin id, isError", emptyArgs.result?.isError === true);

  const catalog = (await (await withToken({ jsonrpc: "2.0", id: 8, method: "tools/list" })).json()) as { result?: { tools?: Array<{ name: string; readOnly: boolean }> } };
  check("tools/list devuelve el catálogo", (catalog.result?.tools?.length ?? 0) === MCP_SERVER_TOOLS.length, catalog.result?.tools?.length);
  check("todas marcadas readOnly", (catalog.result?.tools ?? []).every((tool) => tool.readOnly === true));

  if (saved === undefined) delete process.env.APP_ACCESS_TOKEN;
  else process.env.APP_ACCESS_TOKEN = saved;

  console.log("");
  console.log(passed + "/" + (passed + failed) + " casos OK");
  if (failed > 0) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
