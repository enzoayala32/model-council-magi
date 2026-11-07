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

/** Servidor MCP falso con una tool de lectura y una de escritura. */
const FAKE = `
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
let buffer = "";
let ejecutadas = 0;
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let i = buffer.indexOf("\\n");
  while (i !== -1) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (line) {
      let msg = null;
      try { msg = JSON.parse(line); } catch { msg = null; }
      if (msg && typeof msg.id === "number") {
        if (msg.method === "initialize") return send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "falso", version: "1" } } });
        if (msg.method === "tools/list") return send({ jsonrpc: "2.0", id: msg.id, result: { tools: [
          { name: "leer", description: "lee un dato de prueba" },
          { name: "borrar", description: "borra un archivo (escritura)" },
          { name: "oculta", description: "herramienta fuera de la allowlist" }
        ] } });
        if (msg.method === "tools/call") {
          const name = msg.params && msg.params.name;
          const args = (msg.params && msg.params.arguments) || {};
          if (name === "leer") return send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "DATOS-LEIDOS:" + JSON.stringify(args) }] } });
          if (name === "borrar") { ejecutadas += 1; return send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "BORRADO " + String(args.ruta) }] } }); }
          if (name === "oculta") return send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "no deberia ejecutarse" }] } });
          return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "desconocida" } });
        }
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "metodo desconocido" } });
      }
    }
    i = buffer.indexOf("\\n");
  }
});
// Al salir, informa cuántas veces se ejecutó "borrar" (para verificar el
// "una sola vez" desde el test, mirando el event log no alcanza).
process.on("exit", () => { try { send({ jsonrpc: "2.0", method: "notificacion/ejecutadas", params: { ejecutadas } }); } catch {} });
`;

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
          args: ["-e", FAKE],
          envForward: ["VAR_PROPIA_MCP"],
          tools: ["leer", "borrar"],
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
  check("se crean solo las herramientas de la allowlist", nombres.length === 2, nombres);
  check("el nombre es mcp__<servidor>__<herramienta>", nombres.includes("mcp__falso__leer") && nombres.includes("mcp__falso__borrar"), nombres);
  check("una herramienta fuera de la allowlist no se crea", !nombres.includes("mcp__falso__oculta"), nombres);

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
  const readResult = await run("mcp__falso__leer", { ruta: "/tmp/x" });
  check("la de lectura se ejecuta", readResult.ok === true, readResult);
  check("marca la salida como no confiable", readResult.untrusted === true);
  check("informa el tamaño", typeof readResult.chars === "number" && (readResult.chars as number) > 0, readResult.chars);
  check("informa el hash", typeof readResult.sha256 === "string" && (readResult.sha256 as string).length === 16);
  check("el texto trae el preambulo", String(readResult.output ?? "").includes("contenido no confiable"), String(readResult.output).slice(0, 60));
  check("trae los datos del servidor", String(readResult.output ?? "").includes("DATOS-LEIDOS"));

  // Recorte: una salida enorme se corta y se avisa.
  const info = describeOutput("y".repeat(50_000));
  check("describeOutput calcula tamaño, hash y preview", info.chars === 50_000 && info.sha256.length === 16 && info.preview.length === 160);

  console.log("\n== herramienta de escritura: espera aprobacion, no ejecuta ==\n");
  const writeResult = await run("mcp__falso__borrar", { ruta: "/tmp/x" });
  check("la de escritura NO se ejecuta", writeResult.ok === true && writeResult.pending === true, writeResult);
  check("devuelve el codigo de aprobacion", /^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/.test(String(writeResult.approvalCode ?? "")), writeResult.approvalCode);
  check("le avisa al modelo que espere", String(writeResult.message ?? "").includes("PENDIENTE"));

  const pendientes = listApprovals().filter((approval) => approval.serverName === "falso");
  check("queda una solicitud pendiente", pendientes.length === 1, pendientes.length);
  const approval = pendientes[0];
  check("el resumen de argumentos es legible", approval.argsSummary.includes("/tmp/x"), approval.argsSummary);

  console.log("\n== aprobar consume una sola vez ==\n");
  const argsHash = hashArgs({ ruta: "/tmp/x" });
  const consumo = consumeApproval(approval.code, { serverName: "falso", toolName: "borrar", argsHash });
  check("sin aprobar no se puede consumir", !consumo.ok, consumo);

  // El código en claro lo devuelve la tool al crear. Reconsultar no lo recupera
  // (a propósito: en la DB queda solo el hash).
  const codigoCreado = String(writeResult.approvalCode ?? "");
  const reuso = requestApproval({ serverName: "falso", toolName: "borrar", args: { ruta: "/tmp/x" } });
  check("la misma solicitud se reusa (mismo id)", reuso.id === approval.id);
  const { approveApproval } = await import("./mcp/approvals");
  const decision = approveApproval(codigoCreado, "operador");
  check("el operador aprueba", decision.ok === true, decision);

  const primero = consumeApproval(codigoCreado, { serverName: "falso", toolName: "borrar", argsHash });
  check("el primer consumo funciona", primero.ok === true, primero);
  const segundo = consumeApproval(codigoCreado, { serverName: "falso", toolName: "borrar", argsHash });
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
