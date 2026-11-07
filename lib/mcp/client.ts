/**
 * Fase 7 — cliente MCP (Model Context Protocol) de SOLO LECTURA.
 *
 * Habla JSON-RPC 2.0 por stdio (una petición por línea) con un proceso hijo.
 * No usa dependencias: el protocolo de la capa básica (`initialize`,
 * `tools/list`, `tools/call`, `ping`) es suficientemente simple.
 *
 * Las tres reglas de seguridad de la fase, y dónde están:
 *
 * 1. **Aislamiento del entorno.** El hijo NO hereda `process.env`: recibe un
 *    entorno armado por allowlist (`lib/mcp/config.ts`). Con el entorno
 *    completo, un servidor MCP comprometido se llevaba `NVIDIA_API_KEY`,
 *    `GEMINI_API_KEY` y `APP_ACCESS_TOKEN` leyendo su propio entorno.
 * 2. **Allowlist de herramientas.** `callTool` rechaza en el CLIENTE cualquier
 *    herramienta que no esté en la config, antes de hablar con el servidor. No
 *    se confía en que el servidor diga "no puedo".
 * 3. **La salida es contenido NO CONFIABLE.** Vuelve marcada como tal, con los
 *    secretos de la app redactados (`lib/provider-resilience/redact`). Lo que
 *    un servidor MCP devuelve se trata como texto de un extraño: nunca como
 *    instrucción.
 *
 * Timeout siempre: un servidor colgado no puede dejar al agente esperando para
 * siempre. Se mata por árbol de procesos (`exec-with-tree-kill`) para que no
 * queden huérfanos en Windows.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { redactSecrets } from "../provider-resilience/redact";
import { killProcessTree } from "../agent/exec-with-tree-kill";
import { childEnvFor, isToolAllowed, type McpServerConfig } from "./config";

/** Marca que se antepone a cualquier texto que venga de un servidor MCP. */
export const UNTRUSTED_PREAMBLE = "[contenido no confiable de MCP]";

export type McpToolInfo = { name: string; description?: string; writeCapable: boolean };

export type McpToolResult = {
  ok: boolean;
  /** Texto de la herramienta, ya redactado. Vacío si falló. */
  text: string;
  /** Si el servidor marcó error, acá viene el motivo (redactado). */
  error?: string;
  untrusted: true;
};

type JsonRpcRequest = { jsonrpc: "2.0"; id: number; method: string; params?: unknown };
type JsonRpcResponse = { jsonrpc: "2.0"; id: number; result?: unknown; error?: { code: number; message: string } };

const PROTOCOL_VERSION = "2024-11-05";

/** Nombres/descripciones que delatan una herramienta de escritura (para exigir
 *  aprobación). En inglés Y en español: el servidor MCP puede ser de cualquier
 *  lugar, y una herramienta que se llame "borrar_todo" es tan de escritura como
 *  "delete_all". Es una heurística a favor de la seguridad: si duda, se trata
 *  como de escritura (así pide aprobación y no pasa de largo). */
const WRITE_HINTS = [
  "write", "create", "update", "delete", "remove", "send", "push", "apply", "run", "exec", "modify", "insert",
  "borr", "elimin", "escrib", "crear", "enviar", "ejecut", "aplic", "modific", "actualiz", "subir",
];

function looksWriteCapable(toolName: string, description = ""): boolean {
  const haystack = (toolName + " " + description).toLowerCase();
  return WRITE_HINTS.some((hint) => haystack.includes(hint));
}

/**
 * Una conexión viva contra un servidor MCP.
 *
 * Ciclo de vida: `connect()` → usar → `close()`. Si el proceso muere solo, la
 * próxima llamada devuelve error en vez de colgarse (el stream se cierra).
 */
export class McpStdioConnection {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: JsonRpcResponse) => void; reject: (error: Error) => void }>();
  private closed = false;
  private readonly timeoutMs: number;

  constructor(private readonly config: McpServerConfig) {
    this.timeoutMs = config.timeoutMs;
  }

  /** Arranca el proceso y hace el handshake `initialize`. */
  async connect(): Promise<{ ok: true; tools: McpToolInfo[] } | { ok: false; error: string }> {
    if (!this.config.command) return { ok: false, error: "servidor stdio sin comando." };

    try {
      const child = spawn(this.config.command, this.config.args ?? [], {
        cwd: this.config.cwd ?? process.cwd(),
        // CLAVE: entorno por allowlist, no `process.env`.
        // El entorno armado por allowlist: sin esto, un servidor MCP
        // comprometido leería las API keys de la app desde su entorno.
        env: { ...childEnvFor(this.config), NODE_ENV: process.env.NODE_ENV ?? "production" },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      }) as ChildProcessWithoutNullStreams;
      this.child = child;

      child.stderr.on("data", () => {
        /* se descarta: no se loggea salida de terceros en la consola */
      });
      child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
      child.on("error", (error: Error) => this.failAll(new Error("no se pudo lanzar el servidor: " + error.message)));
      child.on("exit", () => {
        this.closed = true;
        for (const entry of this.pending.values()) {
          entry.reject(new Error("el servidor MCP terminó."));
        }
        this.pending.clear();
      });

      const init = await this.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        clientInfo: { name: "consenso-ia", version: "1.0.0" },
      });
      if (init.error) return { ok: false, error: "initialize falló: " + init.error.message };
      await this.notify("notifications/initialized");

      const list = await this.request("tools/list", {});
      if (list.error) return { ok: false, error: "tools/list falló: " + list.error.message };
      const tools = this.parseTools(list.result);
      return { ok: true, tools };
    } catch (error: unknown) {
      await this.close();
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Lista de herramientas del servidor, cruzada con la allowlist de config. */
  async listTools(): Promise<McpToolInfo[]> {
    const response = await this.request("tools/list", {});
    if (response.error) throw new Error("tools/list falló: " + response.error.message);
    return this.parseTools(response.result);
  }

  /**
   * Llama una herramienta. Rechaza ANTES de hablar con el servidor si no está
   * en la allowlist, o si el servidor es read-only y la herramienta parece de
   * escritura (eso es Fase 8 y exige aprobación humana).
   */
  async callTool(name: string, args: unknown, opts: { approved?: boolean } = {}): Promise<McpToolResult> {
    if (!isToolAllowed(this.config, name)) {
      return { ok: false, text: "", error: "herramienta no permitida por la config: " + name, untrusted: true };
    }
    const tool = (await this.safeListTools()).find((entry) => entry.name === name);
    if (tool?.writeCapable && !opts.approved) {
      return {
        ok: false,
        text: "",
        error: "la herramienta " + name + " puede escribir: requiere aprobación humana (Fase 8).",
        untrusted: true,
      };
    }

    const response = await this.request("tools/call", { name, arguments: args ?? {} });
    if (response.error) {
      return { ok: false, text: "", error: response.error.message, untrusted: true };
    }
    return this.parseResult(response.result);
  }

  /** Latido: sirve para detectar un servidor colgado antes de usarlo. */
  async ping(): Promise<boolean> {
    const response = await this.request("ping", {});
    return response.error === undefined;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const entry of this.pending.values()) {
      entry.reject(new Error("conexión cerrada."));
    }
    this.pending.clear();
    const child = this.child;
    this.child = null;
    if (!child) return;
    try {
      // Por árbol: en Windows un `spawn` puede dejar procesos nieto vivos.
      if (typeof child.pid === "number") killProcessTree(child.pid);
    } catch {
      /* killProcessTree es best-effort */
    }
    try {
      child.kill("SIGKILL");
    } catch {
      /* ya estaba muerto */
    }
  }

  // ---------- interno ----------

  private parseTools(result: unknown): McpToolInfo[] {
    const tools = (result as { tools?: unknown })?.tools;
    if (!Array.isArray(tools)) return [];
    const out: McpToolInfo[] = [];
    for (const entry of tools) {
      if (typeof entry !== "object" || entry === null) continue;
      const tool = entry as Record<string, unknown>;
      const name = typeof tool.name === "string" ? tool.name : "";
      if (!name) continue;
      const description = typeof tool.description === "string" ? tool.description : "";
      out.push({
        name,
        description: description.slice(0, 200),
        writeCapable: looksWriteCapable(name, description) || (tool.readOnlyHint === false),
      });
    }
    return out;
  }

  private parseResult(result: unknown): McpToolResult {
    const content = (result as { content?: unknown })?.content;
    const pieces: string[] = [];
    if (Array.isArray(content)) {
      for (const entry of content) {
        if (typeof entry === "object" && entry !== null && typeof (entry as { text?: unknown }).text === "string") {
          pieces.push((entry as { text: string }).text);
          continue;
        }
        pieces.push(JSON.stringify(entry));
      }
    } else if (typeof result === "string") {
      pieces.push(result);
    } else if (result !== undefined) {
      pieces.push(JSON.stringify(result));
    }

    const isError = (result as { isError?: unknown })?.isError === true;
    // Recorte y redacción: la salida de un servidor MCP puede ser enorme y
    // puede contrir material sensible.
    const text = redactSecrets(UNTRUSTED_PREAMBLE + " " + pieces.join("\n").slice(0, 100_000));
    return isError
      ? { ok: false, text, error: text.slice(0, 200), untrusted: true }
      : { ok: true, text, untrusted: true };
  }

  private async safeListTools(): Promise<McpToolInfo[]> {
    try {
      return await this.listTools();
    } catch {
      return [];
    }
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    let index = this.buffer.indexOf("\n");
    while (index !== -1) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line !== "") this.handleLine(line);
      index = this.buffer.indexOf("\n");
    }
  }

  private handleLine(line: string): void {
    let message: JsonRpcResponse;
    try {
      message = JSON.parse(line) as JsonRpcResponse;
    } catch {
      return; // línea no-JSON: se ignora (un servidor puede loggear por stdout)
    }
    if (typeof message.id !== "number") return;
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    entry.resolve(message);
  }

  private request(method: string, params: unknown): Promise<JsonRpcResponse> {
    if (this.closed || !this.child) {
      return Promise.reject(new Error("la conexión MCP está cerrada."));
    }
    const id = this.nextId;
    this.nextId += 1;
    const payload: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("timeout de " + this.timeoutMs + "ms esperando " + method + "."));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        this.child?.stdin.write(JSON.stringify(payload) + "\n");
      } catch (error: unknown) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private notify(method: string): void {
    try {
      this.child?.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
    } catch {
      /* el servidor ya se fue; no hay nada que avisar */
    }
  }

  private failAll(error: Error): void {
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
  }
}
