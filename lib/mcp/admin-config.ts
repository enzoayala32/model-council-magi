/**
 * Fase 8 (pendiente) — administración de la config de servidores MCP.
 *
 * La config sigue viviendo FUERA del repo. Acá está la escritura, con tres
 * garantías:
 *
 * 1. **Escritura atómica con respaldo**: se escribe a un temporal, se renombra,
 *    y antes se guarda una copia `.bak` de la versión anterior. Si algo falla a
 *    mitad, la config válida sigue en su lugar.
 * 2. **Validación antes y después**: lo que se va a escribir se valida con el
 *    mismo `validateConfig` que usa la lectura. Una config inválida no se
 *    escribe.
 * 3. **Nunca valores de variables de entorno**: lo que se muestra y se guarda
 *    son REFERENCIAS (`${VAR}`), no valores.
 *
 * Las rutas que llaman acá hacen la parte de autorización (`requireLocalAccess`
 * + token de operador), no este módulo.
 */

import fs from "node:fs";
import path from "node:path";
import {
  MCP_CONFIG_VERSION,
  defaultConfigPath,
  validateConfig,
  type McpConfig,
  type McpServerConfig,
} from "./config";

export type ConfigWriteResult = { ok: true; config: McpConfig; backup?: string } | { ok: false; error: string };

/** Lee y valida. Si no existe, devuelve una config vacía (no es un error). */
export function readManagedConfig(explicitPath?: string): { ok: true; config: McpConfig; exists: boolean } | { ok: false; error: string; source: string } {
  const source = explicitPath ? path.resolve(explicitPath) : defaultConfigPath();
  if (!fs.existsSync(source)) {
    return {
      ok: true,
      config: { version: MCP_CONFIG_VERSION, servers: [], source },
      exists: false,
    };
  }
  let raw: string;
  try {
    raw = fs.readFileSync(source, "utf8");
  } catch (error: unknown) {
    return { ok: false, error: "no se pudo leer: " + (error instanceof Error ? error.message : String(error)), source };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    return { ok: false, error: "JSON inválido: " + (error instanceof Error ? error.message : String(error)), source };
  }
  const validated = validateConfig(parsed, source);
  if (!validated.ok) return { ok: false, error: validated.error, source };
  return { ok: true, config: validated.config, exists: true };
}

/** Escritura atómica: temporal + rename, con copia `.bak` de la anterior. */
export function writeManagedConfig(
  servers: McpServerConfig[],
  explicitPath?: string,
): ConfigWriteResult {
  const source = explicitPath ? path.resolve(explicitPath) : defaultConfigPath();
  const payload = { version: MCP_CONFIG_VERSION, servers };

  // Se valida lo que se va a escribir: una config inválida no toca el disco.
  const validated = validateConfig(payload, source);
  if (!validated.ok) return { ok: false, error: validated.error };

  const directory = path.dirname(source);
  try {
    fs.mkdirSync(directory, { recursive: true });
  } catch (error: unknown) {
    return { ok: false, error: "no se pudo crear el directorio: " + (error instanceof Error ? error.message : String(error)) };
  }

  let backup: string | undefined;
  if (fs.existsSync(source)) {
    backup = source + ".bak";
    try {
      fs.copyFileSync(source, backup);
    } catch (error: unknown) {
      return { ok: false, error: "no se pudo guardar el respaldo: " + (error instanceof Error ? error.message : String(error)) };
    }
  }

  const temporal = source + ".tmp-" + process.pid + "-" + Date.now();
  try {
    fs.writeFileSync(temporal, JSON.stringify(payload, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporal, source);
  } catch (error: unknown) {
    try {
      if (fs.existsSync(temporal)) fs.rmSync(temporal, { force: true });
    } catch {
      /* el temporal ya no está: no pasa nada */
    }
    return { ok: false, error: "no se pudo escribir: " + (error instanceof Error ? error.message : String(error)) };
  }
  return { ok: true, config: validated.config, backup };
}

/** Vista segura para la UI: sin valores de credenciales, solo su forma. */
export function describeServerForUi(server: McpServerConfig): {
  name: string;
  transport: string;
  target: string;
  tools: string[];
  readOnlyTools: string[];
  headers: Record<string, string>;
  hasCredentials: boolean;
  note?: string;
} {
  return {
    name: server.name,
    transport: server.transport,
    target: server.transport === "http" ? (server.url ?? "") : [server.command ?? "", ...(server.args ?? [])].join(" "),
    tools: [...server.tools],
    readOnlyTools: [...server.readOnlyTools],
    headers: { ...(server.httpHeaders ?? {}) },
    hasCredentials: Object.values(server.httpHeaders ?? {}).some((value) => /^\$\{/.test(value)),
    note: server.note,
  };
}
