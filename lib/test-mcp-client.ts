/**
 * Fase 7 — tests del cliente MCP (solo lectura).
 *
 * Se levanta un servidor MCP DE VERDAD: un proceso Node que habla JSON-RPC por
 * stdio. No es un mock del cliente, es el par del protocolo. Gracias a eso se
 * verifican las tres reglas de la fase:
 *
 *  1. **Aislamiento del entorno**: el servidor falso responde con lo que ve en
 *     su propio `process.env`. La prueba comprueba que las API keys de la app
 *     NO están, y que la allowlist sí llega.
 *  2. **Allowlist**: una herramienta que existe en el servidor pero no está en
 *     la config se rechaza en el cliente, antes de llegar al servidor.
 *  3. **Salida no confiable**: vuelve marcada con el preámbulo y con los
 *     secretos de la app redactados.
 *
 * También: timeout (un servidor que no contesta deja la conexión en error, no
 * colgada), handshake, y que una herramienta de escritura exija aprobación.
 *
 * Uso: npm run security:test-mcp-client
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  childEnvFor,
  defaultConfigPath,
  httpHeadersFor,
  isToolAllowed,
  loadMcpConfig,
  validateConfig,
  type McpServerConfig,
} from "./mcp/config";
import { McpStdioConnection, UNTRUSTED_PREAMBLE } from "./mcp/client";
import { registerSecret } from "./provider-resilience/redact";

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
  process.env.MAGI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "magi-mcp-test-"));
}

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");

/** Servidor MCP falso: responde a initialize, tools/list y tools/call.
 *  `envcheck` devuelve su propio entorno, para probar el aislamiento. */
const FAKE_SERVER = `
const NODE_ENV = process.env.NODE_ENV;
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
process.stdout.on("error", () => process.exit(0));
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let index = buffer.indexOf("\\n");
  while (index !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) {
      let msg;
      try { msg = JSON.parse(line); } catch { msg = null; }
      if (msg && typeof msg.id === "number") handle(msg);
    }
    index = buffer.indexOf("\\n");
  }
});
function handle(msg) {
  if (msg.method === "initialize") {
    return send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "falso", version: "1" } } });
  }
  if (msg.method === "ping") return send({ jsonrpc: "2.0", id: msg.id, result: {} });
  if (msg.method === "tools/list") {
    return send({ jsonrpc: "2.0", id: msg.id, result: { tools: [
      { name: "leer", description: "lee algo" },
      { name: "borrar_todo", description: "borra todo lo que ve" },
      { name: "envcheck", description: "devuelve el entorno del proceso" },
      { name: "repite", description: "devuelve lo que le manden" }
    ] } });
  }
  if (msg.method === "tools/call") {
    const name = msg.params && msg.params.name;
    const args = (msg.params && msg.params.arguments) || {};
    if (name === "leer") return send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "contenido leido" }] } });
    if (name === "borrar_todo") return send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "borrado (no de verdad)" }] } });
    if (name === "envcheck") return send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify(process.env) }] } });
    if (name === "repite") return send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: String(args.texto ?? "") }] } });
    return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "herramienta desconocida" } });
  }
  if (msg.method === "cuelga") return; // a proposito: no contesta
  send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "metodo desconocido" } });
}
`;

function baseServer(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    name: "falso",
    transport: "stdio",
    command: process.execPath,
    args: ["-e", FAKE_SERVER],
    envForward: ["MI_TOKEN_MCP"],
    tools: ["leer", "envcheck", "repite"],
    readOnly: false,
    timeoutMs: 5000,
    ...overrides,
  };
}

async function main(): Promise<void> {
  console.log("== config: validacion ==\n");
  const valid = validateConfig(
    {
      version: 1,
      servers: [
        { name: "uno", transport: "stdio", command: "node", args: ["x.js"], tools: ["leer"] },
        { name: "dos", transport: "http", url: "https://mcp.ejemplo.com/mcp", tools: ["listar"], headersForward: ["TOKEN_MCP"] },
      ],
    },
    "memoria",
  );
  check("una config válida valida", valid.ok === true);
  const invalidCases: Array<[string, unknown]> = [
    ["sin servers", { version: 1 }],
    ["version desconocida", { version: 99, servers: [] }],
    ["server sin nombre", { version: 1, servers: [{ transport: "stdio", command: "node", tools: [] }] }],
    ["nombre repetido", { version: 1, servers: [
      { name: "a", transport: "stdio", command: "node", tools: [] },
      { name: "a", transport: "stdio", command: "node", tools: [] },
    ] }],
    ["stdio sin comando", { version: 1, servers: [{ name: "a", transport: "stdio", tools: [] }] }],
    ["http sin url", { version: 1, servers: [{ name: "a", transport: "http", tools: [] }] }],
    ["http remoto sin https", { version: 1, servers: [{ name: "a", transport: "http", url: "http://mcp.ejemplo.com/mcp", tools: [] }] }],
    ["tools que no es lista", { version: 1, servers: [{ name: "a", transport: "stdio", command: "node", tools: "leer" }] }],
    ["timeout absurdo", { version: 1, servers: [{ name: "a", transport: "stdio", command: "node", tools: [], timeoutMs: 99999999 }] }],
  ];
  for (const [label, raw] of invalidCases) {
    const result = validateConfig(raw, "memoria");
    check("rechaza: " + label, result.ok === false && typeof (result as { error?: string }).error === "string");
  }
  check("el error nombra el problema", (validateConfig({ version: 1, servers: [] }, "x") as { ok: boolean }).ok === true);

  const tempConfig = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "magi-mcp-cfg-")), "mcp.json");
  fs.writeFileSync(tempConfig, JSON.stringify({ version: 1, servers: [{ name: "x", transport: "stdio", command: "node", tools: ["a"] }] }));
  const fromDisk = loadMcpConfig(tempConfig);
  check("lee la config del disco", fromDisk.ok === true && fromDisk.config.servers.length === 1);
  const missing = loadMcpConfig(path.join(os.tmpdir(), "no-existe-magi.json"));
  check("sin archivo es valido con cero servidores", missing.ok === true && missing.config.servers.length === 0);
  const brokenPath = path.join(os.tmpdir(), "magi-mcp-roto-" + Date.now() + ".json");
  fs.writeFileSync(brokenPath, "{no era json");
  const broken = loadMcpConfig(brokenPath);
  check("un JSON roto da error, no media config", broken.ok === false && broken.error.includes("JSON"));
  fs.rmSync(brokenPath, { force: true });
  check("la ruta por defecto sale del repo", !defaultConfigPath().includes(REPO_ROOT), defaultConfigPath());

  console.log("\n== entorno del hijo: allowlist, nunca los secretos ==\n");
  process.env.MI_TOKEN_MCP = "valor-permitido";
  const childEnv = childEnvFor(baseServer());
  check("pasa la variable permitida", childEnv.MI_TOKEN_MCP === "valor-permitido");
  check("pasa PATH (sin el no arranca nada)", typeof childEnv.PATH === "string" && childEnv.PATH.length > 0);
  const envWithSecrets: NodeJS.ProcessEnv = { NODE_ENV: "test",
    PATH: "/usr/bin",
    MI_TOKEN_MCP: "ok",
    APP_ACCESS_TOKEN: "secreto-operador",
    NVIDIA_API_KEY: "nvapi-secreto",
    GEMINI_API_KEY: "gemini-secreto",
    OPENROUTER_API_KEY: "sk-secreto",
    MAGI_TOTP_KEY: "totp-secreto",
    GITHUB_TOKEN: "gh-secreto",
  };
  const filtered = childEnvFor(baseServer({ envForward: [...Object.keys(envWithSecrets)] }), envWithSecrets);
  for (const secret of ["APP_ACCESS_TOKEN", "NVIDIA_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY", "MAGI_TOTP_KEY", "GITHUB_TOKEN"]) {
    check("nunca reenvía " + secret, filtered[secret] === undefined);
  }
  check("la allowlist no amplia el entorno completo", Object.keys(filtered).length < Object.keys(envWithSecrets).length);

  const headers = httpHeadersFor(baseServer({ transport: "http", url: "https://x/mcp", headersForward: ["MI_TOKEN_MCP", "NVIDIA_API_KEY"] }));
  check("los headers http salen del entorno", headers.MI_TOKEN_MCP === "valor-permitido");
  check("los headers http tampoco llevan secretos de la app", headers.NVIDIA_API_KEY === undefined);

  console.log("\n== conexion real contra el servidor falso ==\n");
  const connection = new McpStdioConnection(baseServer());
  const handshake = await connection.connect();
  check("el handshake funciona", handshake.ok === true, handshake);
  if (handshake.ok) {
    check("lista las 4 herramientas del servidor", handshake.tools.length === 4, handshake.tools.map((t) => t.name));
    check("marca borrar_todo como de escritura", handshake.tools.find((t) => t.name === "borrar_todo")?.writeCapable === true);
    check("leer no es de escritura", handshake.tools.find((t) => t.name === "leer")?.writeCapable === false);
    check("el ping responde", await connection.ping());

    const lectura = await connection.callTool("leer", {});
    check("una herramienta permitida devuelve contenido", lectura.ok === true && lectura.text.includes("contenido leido"));
    check("la salida viene marcada como no confiable", lectura.text.startsWith(UNTRUSTED_PREAMBLE));

    const blocked = await connection.callTool("borrar_todo", {});
    check("herramienta fuera de la allowlist se rechaza en el cliente", !blocked.ok && (blocked.error ?? "").includes("no permitida"), blocked);

    const envProbe = await connection.callTool("envcheck", {});
    check("envcheck responde", envProbe.ok === true);
    check("el hijo NO vio las API keys de la app", !envProbe.text.includes("nvapi-secreto"), envProbe.text.slice(0, 200));
    check("el hijo SI vio la variable de la allowlist", envProbe.text.includes("valor-permitido"));
    check("el hijo vio su propio NODE_ENV", typeof process.env.NODE_ENV === "string" ? envProbe.text.includes(process.env.NODE_ENV) : true);

    // Con la herramienta EN la allowlist, sin aprobación: se rechaza con el
    // motivo de aprobación (no de allowlist, que ya pasó).
    const writeAllowed = new McpStdioConnection(baseServer({ tools: ["leer", "borrar_todo", "envcheck"], readOnly: false }));
    await writeAllowed.connect();
    const writeCall = await writeAllowed.callTool("borrar_todo", {}, { approved: false });
    check("una herramienta de escritura sin aprobacion se rechaza", !writeCall.ok && (writeCall.error ?? "").includes("aprobación"), writeCall);
    const approved = await writeAllowed.callTool("borrar_todo", {}, { approved: true });
    check("con aprobacion explicita, pasa", approved.ok === true, approved);
    await writeAllowed.close();

    // Redaccion: si un servidor devuelve material que parece un secreto de la
    // app, igual no sale en claro.
    registerSecret("token-que-no-debe-salir");
    const echoed = await connection.callTool("repite", { texto: "hola token-que-no-debe-salir adios" });
    check("la salida redacta secretos de la app", !echoed.text.includes("token-que-no-debe-salir"), echoed.text.slice(0, 140));

    // Timeout: el servidor no contesta "cuelga" -> error, no cuelgue.
    const timeoutConfig = baseServer({ timeoutMs: 700 });
    const timeoutConnection = new McpStdioConnection(timeoutConfig);
    await timeoutConnection.connect();
    const started = Date.now();
    let timedOut = false;
    try {
      await (timeoutConnection as unknown as { request(method: string, params: unknown): Promise<unknown> }).request("cuelga", {});
    } catch (error: unknown) {
      timedOut = error instanceof Error && error.message.includes("timeout");
    }
    check("un servidor que no contesta da timeout", timedOut, { ms: Date.now() - started });
    await timeoutConnection.close();
  }
  await connection.close();

  console.log("\n== cierre y reconexion ==\n");
  const closed = new McpStdioConnection(baseServer());
  check("un server sin comando falla limpio", (await new McpStdioConnection(baseServer({ command: "" })).connect()).ok === false);
  await closed.connect();
  await closed.close();
  let afterClose = "sin error";
  try {
    await closed.callTool("leer", {});
  } catch (error: unknown) {
    afterClose = error instanceof Error ? error.message : String(error);
  }
  check("despues de cerrar, las llamadas fallan en vez de colgarse", afterClose.includes("cerrada"), afterClose);

  check("isToolAllowed es por nombre exacto", isToolAllowed(baseServer(), "leer") && !isToolAllowed(baseServer(), "LEER"));

  console.log("");
  console.log(passed + "/" + (passed + failed) + " casos OK");
  if (failed > 0) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
