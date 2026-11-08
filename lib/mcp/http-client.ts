/**
 * Fase 7 (pendiente) — cliente MCP por HTTP.
 *
 * Mismo contrato que `McpStdioConnection`: `connect()`, `listTools()`,
 * `callTool()`, `ping()`, `close()`. Así el registro de tools del agente no
 * tiene que distinguir el transporte.
 *
 * Garantías, iguales a stdio y a `lib/push/endpoint.ts`:
 *
 * 1. **Anti-SSRF**: HTTPS siempre (HTTP solo loopback y con
 *    `allowInsecureLocal: true` en la config), sin credenciales en la URL, sin
 *    redirects, IPs privadas/link-local/metadata rechazadas (también por DNS,
 *    con resolutor inyectable), timeout, y revalidación en cada conexión.
 * 2. **Fail-closed**: la decisión de solo lectura vive en `readOnlyTools`, no
 *    acá.
 * 3. **Salida no confiable**: mismo preámbulo, mismo recorte, misma redacción.
 * 4. **Tope de tamaño**: la respuesta se lee con un límite duro; si se pasa, se
 *    aborta y se corta, en vez de cargar 200 MB en memoria.
 */

import { readFile } from "node:fs/promises";
import { validateHttpTransport, resolveHeaderTemplates, type HttpTransportOptions } from "./http-transport";
import { isToolAllowed, type McpServerConfig } from "./config";
import { redactSecrets } from "../provider-resilience/redact";
import { UNTRUSTED_PREAMBLE } from "./client";

/** Tope de respuesta: 8 MB. Un servidor que devuelve más, se corta. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export type McpToolInfo = { name: string; description?: string; writeCapable: boolean };

export type McpToolResult = {
  ok: boolean;
  text: string;
  error?: string;
  untrusted: true;
};

type JsonRpcRequest = { jsonrpc: "2.0"; id: number; method: string; params?: unknown };
type JsonRpcResponse = { jsonrpc: "2.0"; id: number; result?: unknown; error?: { code: number; message: string } };

function preambleFor(label?: string): string {
  return label ? "[contenido no confiable del servidor MCP " + label + "]" : UNTRUSTED_PREAMBLE;
}

export class McpHttpConnection {
  private nextId = 1;
  private lastUrl = "";
  private closed = false;

  constructor(
    private readonly config: McpServerConfig,
    private readonly options: {
      untrustedLabel?: string;
      /** Inyección para tests: en vez de fetch de verdad. */
      fetchImpl?: typeof fetch;
      /** Resolución inyectable para las validaciones anti-SSRF. */
      transportOptions?: HttpTransportOptions;
    } = {},
  ) {}

  /** Valida la URL y resuelve los headers. Se llama en cada conexión. */
  async connect(): Promise<{ ok: true; tools: McpToolInfo[] } | { ok: false; error: string }> {
    if (!this.config.url) return { ok: false, error: "servidor http sin url." };
    const check = await validateHttpTransport(this.config.url, this.options.transportOptions);
    if (!check.ok) return { ok: false, error: "url rechazada (" + check.reason + ")." };
    this.lastUrl = check.url.toString();

    // Headers por referencia a entorno. Si falta una variable, se informa (no se
    // manda el texto literal ni un header vacío).
    const resolved = resolveHeaderTemplates(this.config.httpHeaders ?? {});
    if (resolved.missing.length > 0) {
      return { ok: false, error: "faltan variables de entorno: " + resolved.missing.join(", ") };
    }

    const init = await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      clientInfo: { name: "consenso-ia", version: "1.0.0" },
    });
    if (init.error) return { ok: false, error: "initialize falló: " + init.error.message };
    const list = await this.request("tools/list", {});
    if (list.error) return { ok: false, error: "tools/list falló: " + list.error.message };
    return { ok: true, tools: this.parseTools(list.result) };
  }

  async listTools(): Promise<McpToolInfo[]> {
    const response = await this.request("tools/list", {});
    if (response.error) throw new Error("tools/list falló: " + response.error.message);
    return this.parseTools(response.result);
  }

  async ping(): Promise<boolean> {
    const response = await this.request("ping", {});
    return response.error === undefined;
  }

  /**
   * Igual que stdio: la allowlist se verifica acá. La aprobación NO: la decide
   * `readOnlyTools`, y la aplica el loop. Quien use la librería en forma directa
   * pone su propia barrera (igual que `McpStdioConnection`).
   */
  async callTool(name: string, args: unknown): Promise<McpToolResult> {
    if (!isToolAllowed(this.config, name)) {
      return { ok: false, text: "", error: "herramienta no permitida por la config: " + name, untrusted: true };
    }
    const response = await this.request("tools/call", { name, arguments: args ?? {} });
    if (response.error) return { ok: false, text: "", error: response.error.message, untrusted: true };
    return this.parseResult(response.result);
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  // ---------- interno ----------

  private async request(method: string, params: unknown): Promise<JsonRpcResponse> {
    if (this.closed) return { jsonrpc: "2.0", id: 0, error: { code: -1, message: "conexión cerrada" } };
    const id = this.nextId;
    this.nextId += 1;
    const payload: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    const doFetch = this.options.fetchImpl ?? fetch;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await doFetch(this.lastUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...resolveHeaderTemplates(this.config.httpHeaders ?? {}).headers,
        },
        body: JSON.stringify(payload),
        // Sin seguir redirects: un 302 a una IP privada sería el SSRF.
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) {
        // El cuerpo NO se guarda ni se devuelve: solo el status.
        await response.arrayBuffer().catch(() => undefined);
        return { jsonrpc: "2.0", id, error: { code: response.status, message: "el servidor respondió " + response.status } };
      }
      let text: string;
      try {
        text = await this.readLimited(response);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.startsWith("RESPUESTA_DEMASIADO_GRANDE:")) {
          const limite = Number(message.split(":")[1]);
          return {
            jsonrpc: "2.0",
            id,
            error: { code: -1, message: "respuesta demasiado grande (limite " + Math.round(limite / 1024 / 1024) + " MB)" },
          };
        }
        throw error;
      }
      try {
        return JSON.parse(text) as JsonRpcResponse;
      } catch {
        return { jsonrpc: "2.0", id, error: { code: -1, message: "respuesta no-JSON" } };
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const timedOut = /timeout|abort/i.test(message);
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -1, message: timedOut ? "timeout de " + this.config.timeoutMs + "ms" : "error de red" },
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Lee el cuerpo con tope duro. Si se pasa, CANCELA la lectura y avisa: cortar
   * a mitad daría un JSON inválido que parecería un server roto, cuando en
   * realidad devolvió más de lo que corresponde.
   */
  private async readLimited(response: Response): Promise<string> {
    const body = response.body;
    if (!body) return "";
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let out = "";
    let bytes = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("RESPUESTA_DEMASIADO_GRANDE:" + MAX_RESPONSE_BYTES);
      }
      out += decoder.decode(chunk.value, { stream: true });
    }
    return out;
  }

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
      out.push({ name, description: description.slice(0, 200), writeCapable: tool.readOnlyHint === false });
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
    } else if (result !== undefined) {
      pieces.push(JSON.stringify(result));
    }
    const isError = (result as { isError?: unknown })?.isError === true;
    const text = redactSecrets(preambleFor(this.options.untrustedLabel) + " " + pieces.join("\n").slice(0, 100_000));
    return isError
      ? { ok: false, text, error: text.slice(0, 200), untrusted: true }
      : { ok: true, text, untrusted: true };
  }
}

void readFile;
