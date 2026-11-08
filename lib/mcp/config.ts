/**
 * Fase 7 — configuración de servidores MCP, FUERA del repo.
 *
 * Dónde vive el archivo y por qué:
 *
 * - **Fuera del repo**, no dentro. La config dice "ejecutá este comando con
 *   estos argumentos": si viviera en el repo, alcanzaría con un pull o con que
 *   el agente toque un archivo para que la PC ejecutara lo que fuera. Además,
 *   no se puede commitear por accidente (y el repo ya corre sobre un workspace
 *   que el propio agente puede modificar).
 * - **Validada con un esquema cerrado**: una config inválida no se "ignora a
 *   medias", se rechaza entera con el motivo. Nunca fail-open.
 * - **Con allowlist de herramientas por servidor**: un servidor MCP puede
 *   exponer 40 herramientas; acá solo se pueden llamar las que están escritas
 *   una por una. Si la lista está vacía, no se puede llamar NINGUNA.
 *
 * Orden de búsqueda:
 *   1. `MAGI_MCP_CONFIG` (ruta explícita, para tests y para varios perfiles).
 *   2. `<config del usuario>/consenso-ia/mcp.json`.
 *
 * Formato (JSON):
 * {
 *   "version": 1,
 *   "servers": [
 *     {
 *       "name": "mi-servidor",
 *       "transport": "stdio",
 *       "command": "npx",
 *       "args": ["-y", "algun-mcp"],
 *       "envForward": ["MI_TOKEN"],
 *       "tools": ["leer_cosa"],
 *       "readOnly": true,
 *       "timeoutMs": 60000
 *     },
 *     {
 *       "name": "http-remoto",
 *       "transport": "http",
 *       "url": "https://mcp.ejemplo.com/mcp",
 *       "headersForward": ["AUTORIZACION_MCP"],
 *       "tools": ["listar"],
 *       "readOnly": true
 *     }
 *   ]
 * }
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type McpServerConfig = {
  name: string;
  transport: "stdio" | "http";
  /** stdio: comando a ejecutar. http: no se usa. */
  command?: string;
  args?: string[];
  cwd?: string;
  /** Variables del entorno del PADRE que se le pasan al hijo. allowlist. */
  envForward?: string[];
  /** http: URL del endpoint MCP. */
  url?: string;
  /** Headers cuyos VALORES salen de variables de entorno del padre. */
  headersForward?: string[];
  /** Herramientas permitidas. Vacío = ninguna. */
  tools: string[];
  /**
   * FAIL-CLOSED (corrección de la revisión): las ÚNICAS herramientas que se
   * ejecutan sin aprobación humana. Todo lo que no esté acá —aunque el
   * servidor diga que es de solo lectura— exige aprobación.
   *
   * Tiene que ser subconjunto de `tools`. Omitida = ninguna herramienta es de
   * solo lectura: todo pide aprobación.
   */
  readOnlyTools: string[];
  /**
   * Declaración del SERVIDOR sobre sí mismo. No se usa para autorizar: el
   * servidor es el no confiable. Solo para mostrarlo en la UI como dato.
   */
  readOnly: boolean;
  timeoutMs: number;
  /** Nota libre para el operador: por qué este servidor está de confianza. */
  note?: string;
};

export type McpConfig = {
  version: number;
  servers: McpServerConfig[];
  /** De dónde se leyó (para que el operador sepa qué archivo editar). */
  source: string;
};

export type ConfigError = { ok: false; error: string; source: string | null };
export type ConfigResult = { ok: true; config: McpConfig } | ConfigError;

/** Variables que NUNCA se forwardean, aunque estén en la allowlist: son los
 *  secretos de la app y no tienen por qué llegar a un proceso hijo. */
const NEVER_FORWARD = new Set([
  "APP_ACCESS_TOKEN",
  "MAGI_TOTP_KEY",
  "OPENROUTER_API_KEY",
  "NVIDIA_API_KEY",
  "GEMINI_API_KEY",
  "GITHUB_TOKEN",
  "TAVILY_API_KEY",
]);

export const MCP_CONFIG_VERSION = 1;

const MAX_TIMEOUT_MS = 15 * 60_000;

/** Ruta por defecto: fuera del repo, en el directorio de configuración del usuario. */
export function defaultConfigPath(): string {
  const explicit = process.env.MAGI_MCP_CONFIG?.trim();
  if (explicit) return path.resolve(explicit);
  const base =
    process.platform === "win32"
      ? (process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"))
      : (process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"));
  return path.join(base, "consenso-ia", "mcp.json");
}

function fail(source: string | null, error: string): ConfigError {
  return { ok: false, error, source };
}

function asStringArray(value: unknown, field: string, where: string): string[] | { error: string } {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return { error: where + ": " + field + " tiene que ser una lista." };
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim() === "") {
      return { error: where + ": " + field + " solo admite strings no vacíos." };
    }
  }
  return value as string[];
}

/**
 * Valida un objeto ya parseado. Devuelve el error o la config normalizada.
 * No lanza: el llamador decide qué hacer (una config rota = MCP desactivado,
 * nunca media config cargada a medias).
 */
export function validateConfig(raw: unknown, source: string): { ok: true; config: McpConfig } | ConfigError {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return fail(source, "la config tiene que ser un objeto JSON.");
  }
  const record = raw as Record<string, unknown>;

  const version = typeof record.version === "number" ? record.version : MCP_CONFIG_VERSION;
  if (version !== MCP_CONFIG_VERSION) {
    return fail(source, "versión de config no soportada: " + String(version) + " (se esperaba " + MCP_CONFIG_VERSION + ").");
  }
  if (!Array.isArray(record.servers)) {
    return fail(source, "falta la lista \"servers\".");
  }

  const servers: McpServerConfig[] = [];
  const names = new Set<string>();
  for (let index = 0; index < record.servers.length; index += 1) {
    const where = "servers[" + index + "]";
    const entry = record.servers[index];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return fail(source, where + " tiene que ser un objeto.");
    }
    const server = entry as Record<string, unknown>;

    const name = typeof server.name === "string" ? server.name.trim() : "";
    if (!name || !/^[a-z0-9][a-z0-9_-]*$/i.test(name)) {
      return fail(source, where + ": \"name\" falta o no es válido (letras, números, - y _).");
    }
    if (names.has(name)) {
      return fail(source, where + ": el nombre \"" + name + "\" está repetido.");
    }
    names.add(name);

    const transport = server.transport === "http" ? "http" : server.transport === "stdio" ? "stdio" : null;
    if (!transport) {
      return fail(source, where + ": \"transport\" tiene que ser \"stdio\" o \"http\".");
    }

    const args = asStringArray(server.args, "args", where);
    if (typeof args !== "object" || "error" in args) return fail(source, (args as { error: string }).error);
    const envForward = asStringArray(server.envForward, "envForward", where);
    if (typeof envForward !== "object" || "error" in envForward) return fail(source, (envForward as { error: string }).error);
    const headersForward = asStringArray(server.headersForward, "headersForward", where);
    if (typeof headersForward !== "object" || "error" in headersForward) {
      return fail(source, (headersForward as { error: string }).error);
    }
    const tools = asStringArray(server.tools, "tools", where);
    if (typeof tools !== "object" || "error" in tools) return fail(source, (tools as { error: string }).error);

    const timeoutMs = typeof server.timeoutMs === "number" && Number.isFinite(server.timeoutMs) ? Math.floor(server.timeoutMs) : 60_000;
    if (timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
      return fail(source, where + ": \"timeoutMs\" fuera de rango (1.." + MAX_TIMEOUT_MS + ").");
    }

    if (transport === "stdio") {
      const command = typeof server.command === "string" ? server.command.trim() : "";
      if (!command) return fail(source, where + ": falta \"command\" para un servidor stdio.");
    } else {
      const url = typeof server.url === "string" ? server.url.trim() : "";
      if (!url) return fail(source, where + ": falta \"url\" para un servidor http.");
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return fail(source, where + ": \"url\" no es una URL válida.");
      }
      if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1" && parsed.hostname !== "::1") {
        // HTTP a un host remoto manda los headers (que suelen ser credenciales)
        // en claro por la red.
        return fail(source, where + ": un servidor http remoto tiene que ser HTTPS.");
      }
    }

    if (server.cwd !== undefined && typeof server.cwd !== "string") {
      return fail(source, where + ": \"cwd\" tiene que ser un string.");
    }

    // FAIL-CLOSED: sin `readOnlyTools` explícita, NINGUNA herramienta queda
    // eximida de aprobación. Una entrada en `readOnlyTools` que no esté en
    // `tools` es error: el operador creyó eximir algo que no se puede llamar.
    const readOnlyToolsRaw = asStringArray(server.readOnlyTools, "readOnlyTools", where);
    if (typeof readOnlyToolsRaw !== "object" || "error" in readOnlyToolsRaw) {
      return fail(source, (readOnlyToolsRaw as { error: string }).error);
    }
    const readOnlyTools = [...new Set(readOnlyToolsRaw as string[])];
    const toolsList = tools as string[];
    const fuera = readOnlyTools.filter((toolName) => !toolsList.includes(toolName));
    if (fuera.length > 0) {
      return fail(
        source,
        where + ': "' + fuera.join('", "') + '" está en readOnlyTools pero no en tools (no se podría llamar).',
      );
    }

    const readOnly = server.readOnly === false ? false : true;

    servers.push({
      name,
      transport,
      command: typeof server.command === "string" ? server.command.trim() : undefined,
      args: (args as string[]).length > 0 ? (args as string[]) : undefined,
      cwd: typeof server.cwd === "string" ? server.cwd : undefined,
      envForward: (envForward as string[]).length > 0 ? (envForward as string[]) : undefined,
      url: typeof server.url === "string" ? server.url.trim() : undefined,
      headersForward: (headersForward as string[]).length > 0 ? (headersForward as string[]) : undefined,
      tools: toolsList,
      readOnlyTools,
      readOnly,
      timeoutMs,
      note: typeof server.note === "string" ? server.note.slice(0, 300) : undefined,
    });
  }

  return { ok: true, config: { version, servers, source } };
}

/**
 * Lee y valida la config. Si no existe el archivo, es resultado VÁLIDO con
 * cero servidores: MCP es opcional y su ausencia no es un error.
 */
export function loadMcpConfig(explicitPath?: string): ConfigResult {
  const source = explicitPath ? path.resolve(explicitPath) : defaultConfigPath();
  if (!fs.existsSync(source)) {
    return { ok: true, config: { version: MCP_CONFIG_VERSION, servers: [], source } };
  }
  let raw: string;
  try {
    raw = fs.readFileSync(source, "utf8");
  } catch (error: unknown) {
    return fail(source, "no se pudo leer el archivo: " + (error instanceof Error ? error.message : String(error)));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    return fail(source, "JSON inválido: " + (error instanceof Error ? error.message : String(error)));
  }
  return validateConfig(parsed, source);
}

/** Entorno que se le pasa a un proceso stdio: allowlist, y nunca los secretos
 *  de la app. El hijo no necesita nada más, y si un servidor MCP está
 *  comprometido, con el entorno completo se llevaría las API keys. */
export function childEnvFor(config: McpServerConfig, parentEnv: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  // Lo mínimo para que un comando funcione en Windows y en Linux.
  for (const key of ["PATH", "SystemRoot", "windir", "TEMP", "TMP", "HOME", "LANG"]) {
    const value = parentEnv[key];
    if (typeof value === "string" && value !== "") out[key] = value;
  }
  for (const key of config.envForward ?? []) {
    const normalized = key.trim();
    if (!normalized || NEVER_FORWARD.has(normalized)) continue;
    const value = parentEnv[normalized];
    if (typeof value === "string" && value !== "") out[normalized] = value;
  }
  return out;
}

/** Headers de un servidor http, con los valores saliendo del entorno. */
export function httpHeadersFor(config: McpServerConfig, parentEnv: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of config.headersForward ?? []) {
    const normalized = key.trim();
    if (!normalized || NEVER_FORWARD.has(normalized)) continue;
    const value = parentEnv[normalized];
    if (typeof value === "string" && value !== "") out[normalized] = value;
  }
  return out;
}

/** ¿El servidor permite esta herramienta? Lista cerrada, por nombre exacto. */
export function isToolAllowed(config: McpServerConfig, toolName: string): boolean {
  return config.tools.includes(toolName);
}

/**
 * FAIL-CLOSED: ¿la herramienta queda eximida de aprobación humana?
 *
 * SOLO si el operador la listó en `readOnlyTools`. El `readOnlyHint` del
 * servidor NO cuenta (el servidor es el no confiable), y una heurística de
 * nombres tampoco puede eximir: solo endurece.
 */
export function isDeclaredReadOnly(config: McpServerConfig, toolName: string): boolean {
  return config.readOnlyTools.includes(toolName);
}
