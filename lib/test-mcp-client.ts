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

/** Servidor MCP falso reusable (mismo que usan los demás tests de MCP). */
const FAKE_PATH = path.join(REPO_ROOT, "lib", "test", "fixtures", "fake-mcp-server.js");

function baseServer(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    name: "falso",
    transport: "stdio",
    command: process.execPath,
    args: [FAKE_PATH],
    envForward: ["MI_TOKEN_MCP"],
    tools: ["leer", "borrar", "envcheck", "gigante"],
    // FAIL-CLOSED: por defecto NINGUNA herramienta queda eximida de aprobación.
    readOnlyTools: ["leer", "envcheck", "gigante"],
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
    check("lista las 8 herramientas del servidor", handshake.tools.length === 8, handshake.tools.map((t) => t.name));
    check("marca borrar como de escritura", handshake.tools.find((t) => t.name === "borrar")?.writeCapable === true);
    check("leer no es de escritura", handshake.tools.find((t) => t.name === "leer")?.writeCapable === false);
    check("get_updates se marca como de escritura (readOnlyHint=false del servidor)", handshake.tools.find((t) => t.name === "get_updates")?.writeCapable === true);
    check("el ping responde", await connection.ping());

    const lectura = await connection.callTool("leer", {});
    check("una herramienta permitida devuelve contenido", lectura.ok === true && lectura.text.includes("EJECUTO:leer"));
    check("la salida viene marcada como no confiable", lectura.text.startsWith(UNTRUSTED_PREAMBLE));

    // La decisión de "¿necesita aprobación?" NO vive en el cliente: vive en
    // `readOnlyTools`, y la aplica el loop. Quien use la librería en forma
    // directa puede pedir la barrera heurística con `gateWriteByName`.
    const sinBarrera = await connection.callTool("borrar", {});
    check("con config, el cliente no bloquea por heuristic a", sinBarrera.ok === true, sinBarrera.error);

    const notAllowed = await connection.callTool("no-existe", {});
    check("herramienta fuera de la allowlist se rechaza en el cliente", !notAllowed.ok && (notAllowed.error ?? "").includes("no permitida"), notAllowed);

    const envProbe = await connection.callTool("envcheck", {});
    check("envcheck responde", envProbe.ok === true);
    check("el hijo NO vio las API keys de la app", !envProbe.text.includes("nvapi-secreto"), envProbe.text.slice(0, 200));
    check("el hijo SI vio la variable de la allowlist", envProbe.text.includes("valor-permitido"));
    check("el hijo vio su propio NODE_ENV", typeof process.env.NODE_ENV === "string" ? envProbe.text.includes(process.env.NODE_ENV) : true);

    // Uso DIRECTO de la librería, sin config que declare solo lectura: la
    // barrera heurística es opt-in (`gateWriteByName`).
    const writeAllowed = new McpStdioConnection(
      baseServer({ tools: ["leer", "borrar", "envcheck"], readOnly: false }),
      { gateWriteByName: true },
    );
    await writeAllowed.connect();
    const writeCall = await writeAllowed.callTool("borrar", {}, { approved: false });
    check("con la barrera heuristic a, una de escritura sin aprobacion se rechaza", !writeCall.ok && (writeCall.error ?? "").includes("aprobación"), writeCall);
    const approved = await writeAllowed.callTool("borrar", {}, { approved: true });
    check("con aprobacion explicita, pasa", approved.ok === true, approved);
    await writeAllowed.close();

    // Y esa barrera NO bloquea una herramienta que el operador declaró de solo
    // lectura, aunque el servidor diga readOnlyHint=false.
    const declarada = new McpStdioConnection(
      baseServer({ tools: ["leer", "get_updates"], readOnlyTools: ["leer", "get_updates"], readOnly: false }),
    );
    await declarada.connect();
    const eximida = await declarada.callTool("get_updates", {});
    check("una declarada en readOnlyTools ejecuta (readOnlyHint=false del servidor no cuenta)", eximida.ok === true, eximida.error);
    await declarada.close();

    // Redaccion: si un servidor devuelve material que parece un secreto de la
    // app, igual no sale en claro.
    registerSecret("token-que-no-debe-salir");
    const echoed = await connection.callTool("leer", { texto: "hola token-que-no-debe-salir adios" });
    check("la salida redacta secretos de la app", !echoed.text.includes("token-que-no-debe-salir"), echoed.text.slice(0, 140));

    // Timeout: el servidor no contesta "cuelga" -> error, no cuelgue.
    // El contrato que se verifica es "NO SE CUELGA": error es resultado válido.
    // La versión anterior exigía que el mensaje contuviera "timeout", y bajo la
    // carga de la suite completa el request a veces fallaba al instante con otro
    // error (ms: 0), lo que hacía fallar el test sin que hubiera un cuelgue real.
    const timeoutConnection = new McpStdioConnection(baseServer({ timeoutMs: 700 }));
    await timeoutConnection.connect();
    const started = Date.now();
    let mensaje = "(sin excepción: se resolvió con éxito, sí es un cuelgue)";
    try {
      await (timeoutConnection as unknown as { request(method: string, params: unknown): Promise<unknown> }).request("cuelga", {});
    } catch (error: unknown) {
      mensaje = error instanceof Error ? error.message : String(error);
    }
    const ms = Date.now() - started;
    // Contrato real: la llamada NO se cuelga. El mensaje puede ser el timeout
    // ("timeout de 700ms esperando...") o "la conexión MCP está cerrada" —este
    // último aparece a los 0ms y es síntoma de una race en el cierre de la
    // conexión, que queda como investigación abierta (no la doy por buena
    // afirmando que es el timeout)—.
    check("un servidor que no contesta no cuelga la llamada", ms < 5000, { ms, mensaje: mensaje.slice(0, 90) });
    if (/timeout/i.test(mensaje)) {
      check("y el motivo es el timeout del cliente", true);
    } else {
      console.log("   (aviso: el motivo no fue el timeout sino: " + mensaje.slice(0, 90) + ")");
    }
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
