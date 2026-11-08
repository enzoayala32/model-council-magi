/**
 * Fase 7.4 / 8.3 — de punta a punta: agente ↔ MCP ↔ aprobación humana.
 *
 * Levanta un servidor MCP DE VERDAD (un proceso Node que habla JSON-RPC por
 * stdio) con una herramienta de solo lectura y una de escritura, y verifica la
 * cadena completa:
 *
 *  - la herramienta de solo lectura se ejecuta y su salida viene marcada como
 *    no confiable, recortada y con tamaño/hash;
 *  - la de escritura NO se ejecuta: crea una aprobación y devuelve el código;
 *  - aprobar y consumir ejecuta UNA sola vez;
 *  - con argumentos distintos, la aprobación no sirve;
 *  - la aprobación vence y el rechazo la cierra;
 *  - un servidor que no está en la config no expone ninguna herramienta;
 *  - un cliente MCP externo (observe) NO puede aprobar: 403;
 *  - la salida se registra con metadato (tamaño, hash, preview), no contenido.
 *
 * Uso: npm run security:test-mcp-loop
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { McpToolRegistry } from "./agent/mcp-tools";
import { createMcpTools, describeOutput } from "./agent/mcp-tools";
import { loadMcpConfig, childEnvFor } from "./mcp/config";
import { consumeApproval, hashArgs, listApprovals, requestApproval } from "./mcp/approvals";
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

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");

if (!process.env.MAGI_DATA_DIR) {
  process.env.MAGI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "magi-mcp-loop-"));
}

/** Servidor MCP falso reusable (mismo que usan los demas tests de MCP). */
const FAKE_PATH = path.join(REPO_ROOT, "lib", "test", "fixtures", "fake-mcp-server.js");

async function main(): Promise<void> {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "magi-mcp-loop-cfg-"));
  const configPath = path.join(tempDir, "mcp.json");

  console.log("== el agente solo ve lo que declara la config ==\n");
  const sinConfig = process.env.MAGI_MCP_CONFIG;
  delete process.env.MAGI_MCP_CONFIG;
  const vacio = loadMcpConfig(path.join(tempDir, "no-existe.json"));
  check("sin archivo de config no hay servidores", vacio.ok === true && vacio.config.servers.length === 0);
  const registryVacio = new McpToolRegistry({ approvalsEnabled: true });
  const sinTools = createMcpTools(registryVacio);
  check("sin config no se crea ninguna herramienta", Object.keys(sinTools).length === 0);
  await registryVacio.close();

  fs.writeFileSync(
    configPath,
    JSON.stringify({
      version: 1,
      servers: [
        {
          name: "falso",
          transport: "stdio",
          command: process.execPath,
          args: [FAKE_PATH],
          envForward: ["VAR_PROPIA_MCP"],
          tools: ["leer", "list_files", "get_updates", "search_created_issues", "borrar"],
          // FAIL-CLOSED: las cuatro primeras quedan eximidas (incluidas las que
          // el servidor declara readOnlyHint=false y las que la heuristica vieja
          // bloqueaba). "borrar" NO: exige aprobacion.
          readOnlyTools: ["leer", "list_files", "get_updates", "search_created_issues"],
          readOnly: false,
          timeoutMs: 8000,
          note: "servidor de prueba",
        },
      ],
    }),
  );
  process.env.MAGI_MCP_CONFIG = configPath;

  const config = loadMcpConfig();
  check("la config se carga", config.ok === true && config.config.servers.length === 1);
  if (!config.ok) throw new Error("config invalida");
  const server = config.config.servers[0];
  check(
    "el entorno del hijo es por allowlist",
    childEnvFor(server, { NODE_ENV: "test", PATH: "/x", VAR_PROPIA_MCP: "v", APP_ACCESS_TOKEN: "secreto" }).APP_ACCESS_TOKEN === undefined,
  );

  const registry = new McpToolRegistry({ approvalsEnabled: true });
  const tools = createMcpTools(registry);
  const nombres = Object.keys(tools);
  check("se crean solo las herramientas de la allowlist", nombres.length === 5, nombres);
  check("el nombre es mcp__<servidor>__<herramienta>", nombres.includes("mcp__falso__leer") && nombres.includes("mcp__falso__borrar"), nombres);
  check("una herramienta fuera de la allowlist no se crea", !nombres.includes("mcp__falso__envcheck"), nombres);

  console.log("\n== herramienta de solo lectura: ejecuta y viene marcada ==\n");
  // Las tools se arman en forma dinamica, asi que el tipo del `execute` se
  // recupera acá (lo mismo hace el runner del agente cuando las invoca).
  type RunnableTool = { execute?: (input: unknown, options: unknown) => Promise<unknown> };
  const run = async (name: string, input: unknown): Promise<Record<string, unknown>> => {
    const selected = tools[name] as unknown as RunnableTool;
    if (typeof selected.execute !== "function") throw new Error("la tool " + name + " no expone execute");
    const out = await selected.execute(input, { abortSignal: undefined, toolCallId: "test", messages: [] });
    return (out ?? {}) as Record<string, unknown>;
  };
  // Las cuatro declaradas de solo lectura ejecutan, INCLUDIDA get_updates (que el
  // servidor declara readOnlyHint=false) y search_created_issues (que la
  // heuristica vieja bloqueaba).
  for (const name of ["leer", "list_files", "get_updates", "search_created_issues"]) {
    const salida = await run("mcp__falso__" + name, {});
    check("ejecuta sin aprobacion (esta en readOnlyTools): " + name, salida.ok === true && salida.untrusted === true, salida);
    check("trae el contenido del servidor: " + name, String(salida.output ?? "").includes("EJECUTO:" + name));
  }
  const readResult = await run("mcp__falso__leer", { ruta: "/tmp/x" });
  check("la de lectura se ejecuta", readResult.ok === true, readResult);
  check("marca la salida como no confiable", readResult.untrusted === true);
  check("informa el tamaño", typeof readResult.chars === "number" && (readResult.chars as number) > 0, readResult.chars);
  check("informa el hash", typeof readResult.sha256 === "string" && (readResult.sha256 as string).length === 16);
  check("el texto trae el preambulo", String(readResult.output ?? "").includes("contenido no confiable"), String(readResult.output).slice(0, 60));
  check("trae los datos del servidor", String(readResult.output ?? "").includes("EJECUTO:leer"));

  // Recorte: una salida enorme se corta y se avisa.
  const info = describeOutput("y".repeat(50_000));
  check("describeOutput calcula tamaño, hash y preview", info.chars === 50_000 && info.sha256.length === 16 && info.preview.length === 160);

  console.log("\n== herramienta de escritura: espera aprobacion, no ejecuta ==\n");
  const writeResult = await run("mcp__falso__borrar", { ruta: "/tmp/x" });
  check("la de escritura NO se ejecuta", writeResult.ok === true && writeResult.pending === true, writeResult);
  check("le avisa al modelo que espere", String(writeResult.message ?? "").includes("PENDIENTE"));
  // El código de un solo uso NO puede viajar al modelo: si viajara, quedaría en
  // el historial de mensajes, en el event log y en el transcript.
  check("el resultado no lleva el codigo de aprobacion", writeResult.approvalCode === undefined, Object.keys(writeResult));
  check("el resultado no lleva ningun campo que parezca un codigo", !JSON.stringify(writeResult).match(/[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}/), JSON.stringify(writeResult));
  check("si trae id, es el id de la aprobacion (no el codigo)", typeof writeResult.approvalId === "string" && writeResult.approvalId.length > 10, writeResult.approvalId);
  check("el mensaje no contiene el codigo", !/[0-9A-F]{4}-[0-9A-F]{4}-/.test(String(writeResult.message ?? "")));

  const pendientes = listApprovals().filter((approval) => approval.serverName === "falso");
  check("queda una solicitud pendiente", pendientes.length === 1, pendientes.length);
  const approval = pendientes[0];
  check("el resumen de argumentos es legible", approval.argsSummary.includes("/tmp/x"), approval.argsSummary);

  console.log("\n== aprobar consume una sola vez ==\n");
  const argsHash = hashArgs({ ruta: "/tmp/x" });
  const consumo = consumeApproval(approval.code, { serverName: "falso", toolName: "borrar", argsHash });
  check("sin aprobar no se puede consumir", !consumo.ok, consumo);

  // El código en claro solo lo ve el humano (lo crea la ruta y lo muestra la
  // UI). Acá se simula esa creación para probar el consumo.
  const { approveApproval } = await import("./mcp/approvals");
  const reuso = requestApproval({ serverName: "falso", toolName: "borrar", args: { ruta: "/tmp/x" } });
  check("el mismo pedido reusa la misma solicitud (mismo id)", reuso.id === approval.id);
  // Con argumentos distintos se crea una nueva, y ESA sí devuelve el código en
  // claro (única vez): es lo que vería el humano en la UI.
  const creada = requestApproval({ serverName: "falso", toolName: "borrar", args: { ruta: "/tmp/consumo" } });
  check("argumentos distintos crean otra solicitud", creada.id !== approval.id && creada.code.length > 0);
  const decision = approveApproval(creada.code, "operador");
  check("el operador aprueba", decision.ok === true, decision);

  const hashConsumo = hashArgs({ ruta: "/tmp/consumo" });
  const primero = consumeApproval(creada.code, { serverName: "falso", toolName: "borrar", argsHash: hashConsumo });
  check("el primer consumo funciona", primero.ok === true, primero);
  const segundo = consumeApproval(creada.code, { serverName: "falso", toolName: "borrar", argsHash: hashConsumo });
  check("el segundo consumo falla (un solo uso)", !segundo.ok, segundo);

  const otrosArgs = requestApproval({ serverName: "falso", toolName: "borrar", args: { ruta: "/OTRO" } });
  approveApproval(otrosArgs.code, "operador");
  const conOtrosArgs = consumeApproval(otrosArgs.code, { serverName: "falso", toolName: "borrar", argsHash: hashArgs({ ruta: "/tmp/x" }) });
  check("argumentos distintos invalidan la aprobacion", !conOtrosArgs.ok && (conOtrosArgs.error ?? "").includes("no coinciden"), conOtrosArgs);

  console.log("\n== vencimiento y rechazo ==\n");
  const { rejectApproval } = await import("./mcp/approvals");
  const rechazada = requestApproval({ serverName: "falso", toolName: "borrar", args: { ruta: "/tmp/y" } });
  check("rechazar la cierra", rejectApproval(rechazada.code, "operador").ok === true);
  check("una rechazada no se consume", !consumeApproval(rechazada.code, {
    serverName: "falso",
    toolName: "borrar",
    argsHash: hashArgs({ ruta: "/tmp/y" }),
  }).ok);
  const vencida = requestApproval({ serverName: "falso", toolName: "borrar", args: {}, ttlMs: -1 });
  check("una vencida no se aprueba", !approveApproval(vencida.code, "operador").ok);

  console.log("\n== el loop registra la salida como metadato ==\n");
  const linea = await run("mcp__falso__leer", { ruta: "/tmp/z" });
  check("el registro trae chars y sha256", typeof linea.chars === "number" && typeof linea.sha256 === "string");
  check("el preview es corto", describeOutput(String(linea.output ?? "")).preview.length <= 160);

  await registry.close();

  console.log("\n== rutas de aprobacion: barrera de scopes ==\n");
  const aprobacionesModule = (await import(pathToFileURL(path.join(REPO_ROOT, "app", "api", "mcp", "approvals", "route.ts")).href)) as unknown as {
    GET(request: Request): Promise<Response>;
    POST(request: Request): Promise<Response>;
  };
  const mcpModule = (await import(pathToFileURL(path.join(REPO_ROOT, "app", "api", "mcp", "route.ts")).href)) as unknown as {
    POST(request: Request): Promise<Response>;
  };

  const observador = createDevice({ name: "Observador MCP", scope: "observe" });
  const operadorDispositivo = createDevice({ name: "Operador MCP", scope: "operate" });
  const aprobador = createDevice({ name: "Aprobador MCP", scope: "approve" });

  const req = (creds: { token?: string; device?: string }, body: unknown, url: string) =>
    new Request(url, {
      method: "POST",
      headers: {
        host: "localhost:3000",
        "x-magi-peer": "remote",
        "content-type": "application/json",
        ...(creds.token ? { authorization: "Bearer " + creds.token } : {}),
        ...(creds.device ? { cookie: "magi_device_token=" + creds.device } : {}),
      },
      body: JSON.stringify(body),
    });

  const pendienteReal = requestApproval({ serverName: "falso", toolName: "borrar", args: { ruta: "/tmp/para-ruta" } });

  // El cliente MCP externo con observe NO puede aprobar.
  const viaMcp = await mcpModule.POST(
    req({ device: observador.token }, { jsonrpc: "2.0", id: 9, method: "approvals/approve", params: { code: pendienteReal.code } }, "http://localhost/api/mcp"),
  );
  const viaMcpBody = (await viaMcp.json()) as { error?: { code: number } };
  check("desde /api/mcp no existe metodo de aprobacion", viaMcpBody.error?.code === -32601, viaMcpBody);

  const aprobarConObserve = await aprobacionesModule.POST(req({ device: observador.token }, { code: pendienteReal.code }, "http://localhost/api/mcp/approvals/approve"));
  check("un dispositivo observe no puede aprobar (403)", aprobarConObserve.status === 403, aprobarConObserve.status);

  const aprobarConOperate = await aprobacionesModule.POST(req({ device: operadorDispositivo.token }, { code: pendienteReal.code }, "http://localhost/api/mcp/approvals/approve"));
  check("un dispositivo operate tampoco (403)", aprobarConOperate.status === 403, aprobarConOperate.status);

  const listarSinCredencial = await aprobacionesModule.GET(new Request("http://localhost/api/mcp/approvals", {
    headers: { host: "localhost:3000", "x-magi-peer": "remote" },
  }));
  check("sin credencial no se listan aprobaciones (401/403)", listarSinCredencial.status === 401 || listarSinCredencial.status === 403, listarSinCredencial.status);

  const listarConApprove = await aprobacionesModule.GET(new Request("http://localhost/api/mcp/approvals", {
    headers: { host: "localhost:3000", "x-magi-peer": "remote", cookie: "magi_device_token=" + aprobador.token },
  }));
  check("un dispositivo approve si puede listar", listarConApprove.status === 200, listarConApprove.status);
  const listado = (await listarConApprove.json()) as { approvals?: Array<{ code?: string; serverName: string }> };
  check("la lista no filtra codigos de las pendientes", (listado.approvals ?? []).every((item) => item.code === undefined));
  check("la lista trae el servidor y la herramienta", (listado.approvals ?? []).some((item) => item.serverName === "falso"), listado.approvals?.length);

  // Aprobar con cookie falsa: rechazado.
  const falsa = await aprobacionesModule.POST(req({ device: "cookie-falsa" }, { code: pendienteReal.code }, "http://localhost/api/mcp/approvals/approve"));
  check("cookie falsa no aprueba (401/403)", falsa.status === 401 || falsa.status === 403, falsa.status);

  // Y el pendiente sigue pendiente (nadie lo tocó).
  check("la solicitud sigue pendiente tras los intentos fallidos", listApprovals().some((item) => item.id === pendienteReal.id && item.status === "pending"));

  await fs.promises.rm(tempDir, { recursive: true, force: true });
  if (sinConfig === undefined) delete process.env.MAGI_MCP_CONFIG;
  else process.env.MAGI_MCP_CONFIG = sinConfig;

  console.log("");
  console.log(passed + "/" + (passed + failed) + " casos OK");
  if (failed > 0) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
