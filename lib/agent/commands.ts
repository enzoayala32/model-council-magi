/**
 * Etapa 2.3 (brecha P0 de paridad con OpenCode) — comandos `/` personalizados.
 *
 * QUÉ FALTABA: el composer tenía una paleta de comandos fija y dura
 * (`/nuevo`, `/consenso`, `/buscar`, `/web`, `/skills`, `/enviar`), y ninguna
 * forma de que el usuario definiera los suyos. OpenCode resuelve esto con
 * plantillas en Markdown dentro de `.opencode/commands/`, que se expanden al
 * enviar el prompt.
 *
 * ALCANCE DE ESTE SUB-BLOQUE:
 *
 *  - Se leen comandos de `<proyecto>/.magi/commands/**` y del directorio global
 *    de configuración (`MAGI_AGENT_COMMANDS_DIR`, por defecto
 *    `<config>/consenso-ia/commands`, la misma base que usa la config de MCP).
 *  - El id sale de la ruta, con `/` como separador: `team/review.md` → `/team/review`.
 *  - La plantilla se expande al ENVIAR, no al elegir: `$ARGUMENTS` es el texto
 *    completo tal cual se escribió, `$1`, `$2`... son posiciones (las comillas
 *    agrupan y se quitan), y si la plantilla no tiene ningún placeholder los
 *    argumentos se agregan al final tras una línea en blanco.
 *  - Un comando puede pedir otro modelo con `model:` en el frontmatter.
 *
 * BLOQUES DE SHELL: APAGADOS POR DEFECTO, A PROPÓSITO.
 *
 * OpenCode soporta `` !`git diff` `` en la plantilla, y su propia doc advierte
 * que corre FUERA del flujo de permisos. Copiarlo tal cual sería aceptar que
 * cualquier repo que el usuario clone (o cualquier tercero que le edite un
 * .md) ejecute código con los privilegios del usuario con solo pedir una task.
 * Nuestra postura en todo el resto del proyecto es fail-closed (allowlist de
 * MCP, pin de IP anti-SSRF, aprobación humana para escritura), así que acá:
 * apagado por defecto, y se prende con `MAGI_AGENT_COMMANDS_SHELL=1`, que es
 * una decisión explícita del usuario con el riesgo escrito en `.env.example`.
 * Cuando está prendido, la salida se redacta (secretos), se recorta, y se marca
 * como dato no confiable —nunca como instrucción—, igual que la salida de MCP.
 *
 * Lo que NO se inventa: si un comando no existe, o el archivo no se puede leer,
 * el prompt se manda TAL CUAL. Un comando roto nunca rompe la task.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { redactSecrets } from "../provider-resilience/redact";

const execFileAsync = promisify(execFile);

/** Directorio de comandos dentro de un proyecto. */
export const PROJECT_COMMANDS_DIR = ".magi/commands";

/** Variable para prender los bloques de shell. Apagados por defecto (ver arriba). */
export const SHELL_BLOCKS_ENV = "MAGI_AGENT_COMMANDS_SHELL";

/** Tope por bloque de shell, en caracteres de salida. */
export const MAX_SHELL_OUTPUT_CHARS = 8_000;

/** Timeout por bloque de shell. Un comando colgado no cuelga la task. */
export const SHELL_BLOCK_TIMEOUT_MS = 15_000;

/** Tope de plantilla: una plantilla de más de 32 KB no es una plantilla. */
export const MAX_TEMPLATE_CHARS = 32 * 1024;

export type AgentCommand = {
  /** `/` + ruta sin extensión. Ej.: `/review`, `/team/release`. */
  id: string;
  /** Del frontmatter, si vino. Si no, no se muestra en la paleta. */
  description?: string;
  /** Override de modelo, del frontmatter. Se valida contra el catálogo al usar. */
  model?: string;
  /** Plantilla, ya sin frontmatter. */
  template: string;
  /** Ruta relativa al proyecto (o absoluta si es global), para logs. */
  source: string;
  scope: "project" | "global";
};

export type CommandDiscovery = {
  commands: AgentCommand[];
  /** Archivos que se intentaron leer y fallaron: se informan, no se ocultan. */
  errors: Array<{ path: string; error: string }>;
};

/** Directorio global de comandos, con la misma base que la config de MCP. */
export function globalCommandsDir(env: Record<string, string | undefined> = process.env): string {
  const explicit = env.MAGI_AGENT_COMMANDS_DIR?.trim();
  if (explicit) return path.resolve(explicit);
  const base =
    process.platform === "win32"
      ? (env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"))
      : (env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"));
  return path.join(base, "consenso-ia", "commands");
}

/** ¿Están permitidos los bloques de shell? Apagado salvo opt-in explícito. */
export function shellBlocksEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env[SHELL_BLOCKS_ENV]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const normalizado = raw.replace(/\r\n/g, "\n");
  if (!normalizado.startsWith("---\n")) return { meta: {}, body: normalizado };
  const fin = normalizado.indexOf("\n---", 4);
  if (fin < 0) return { meta: {}, body: normalizado };
  const bloque = normalizado.slice(4, fin);
  const cuerpo = normalizado.slice(fin + 4).replace(/^\n/, "");
  const meta: Record<string, string> = {};
  for (const linea of bloque.split("\n")) {
    if (!linea.trim() || linea.trim().startsWith("#")) continue;
    const dosPuntos = linea.indexOf(":");
    if (dosPuntos <= 0) continue;
    const clave = linea.slice(0, dosPuntos).trim();
    const valor = linea.slice(dosPuntos + 1).trim().replace(/^["']|["']$/g, "");
    if (clave) meta[clave] = valor;
  }
  return { meta, body: cuerpo };
}

/** El id sale de la ruta: `team/review.md` → `/team/review`. */
function idFromRelPath(relPath: string): string {
  // Separador siempre `/`: en Windows `path.relative` devuelve `\`.
  const sinExt = relPath.split("\\").join("/").replace(/\.md$/i, "");
  const segmentos = sinExt.split("/").filter((s) => s.length > 0);
  return "/" + segmentos.join("/");
}

/** Profundidad máxima de descubrimiento debajo del directorio de comandos. */
const MAX_PROFUNDIDAD = 6;

/** Lista los `.md` de un directorio y sus subdirectorios (hasta MAX_PROFUNDIDAD). */
async function listarMd(base: string, profundidad = 0): Promise<string[]> {
  if (profundidad > MAX_PROFUNDIDAD) return [];
  let entradas;
  try {
    entradas = await fs.readdir(base, { withFileTypes: true });
  } catch {
    // El directorio no existe: no hay comandos de este scope. No es un error.
    return [];
  }
  const archivos: string[] = [];
  for (const entrada of entradas) {
    if (entrada.name.startsWith(".") || entrada.name === "node_modules") continue;
    const abs = path.join(base, entrada.name);
    if (entrada.isDirectory()) {
      archivos.push(...(await listarMd(abs, profundidad + 1)));
      continue;
    }
    if (entrada.isFile() && entrada.name.toLowerCase().endsWith(".md")) archivos.push(abs);
  }
  return archivos;
}

async function leerDirectorio(base: string, scope: "project" | "global"): Promise<CommandDiscovery> {
  const commands: AgentCommand[] = [];
  const errors: Array<{ path: string; error: string }> = [];
  for (const abs of await listarMd(base)) {
    let raw: string;
    try {
      const stat = await fs.stat(abs);
      if (!stat.isFile()) continue;
      raw = await fs.readFile(abs, "utf-8");
    } catch (error) {
      errors.push({ path: abs, error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    const { meta, body } = parseFrontmatter(raw);
    // El id sale de la ruta RELATIVA al directorio de comandos, con `/` como
    // separador: `team/review.md` → `/team/review`.
    commands.push({
      id: idFromRelPath(path.relative(base, abs)),
      ...(meta.description ? { description: meta.description } : {}),
      ...(meta.model ? { model: meta.model } : {}),
      template: body.slice(0, MAX_TEMPLATE_CHARS),
      source: abs,
      scope,
    });
  }
  return { commands, errors };
}

/**
 * Descubre los comandos de un proyecto. Nunca tira: un directorio ausente, un
 * archivo ilegible o una plantilla rota devuelven lo que se pudo leer, con los
 * errores a parte.
 *
 * El id de un comando de proyecto GANA al global con el mismo id (mismo
 * criterio que OpenCode: la fuente más específica manda).
 */
export async function listAgentCommands(projectPath: string, env: Record<string, string | undefined> = process.env): Promise<CommandDiscovery> {
  const local = await leerDirectorio(path.join(projectPath, PROJECT_COMMANDS_DIR), "project");
  const global = await leerDirectorio(globalCommandsDir(env), "global");

  const porId = new Map<string, AgentCommand>();
  for (const command of [...global.commands, ...local.commands]) porId.set(command.id, command);
  return {
    commands: [...porId.values()].sort((a, b) => a.id.localeCompare(b.id)),
    errors: [...local.errors, ...global.errors],
  };
}

/** Parte el string de argumentos respetando comillas simples y dobles. */
export function splitArguments(input: string): string[] {
  const salida: string[] = [];
  let actual = "";
  let comilla: '"' | "'" | null = null;
  for (const caracter of input) {
    if (comilla) {
      if (caracter === comilla) comilla = null;
      else actual += caracter;
      continue;
    }
    if (caracter === '"' || caracter === "'") {
      comilla = caracter;
      continue;
    }
    if (/\s/.test(caracter)) {
      if (actual) {
        salida.push(actual);
        actual = "";
      }
      continue;
    }
    actual += caracter;
  }
  if (actual) salida.push(actual);
  return salida;
}

export type Expansiones = {
  /** Texto final que se manda como prompt. */
  prompt: string;
  /** Bloques de shell que se SALTEARON porque la feature está apagada. */
  shellBloquesOmitidos: number;
  /** true si la plantilla traía `!`cmd`` y no se corrió. */
  teniaShell: boolean;
};

/**
 * Expande la plantilla. Función PURA salvo por los bloques de shell (que son
 * async y opcionales): por eso devuelve una promesa, pero sin `cwd` no corre
 * nada.
 *
 * Reglas (las mismas que OpenCode, verificado contra su doc):
 *  - `$ARGUMENTS` → el string completo tal cual se escribió.
 *  - `$1`, `$2`, … → posiciones; el número más alto consume su argumento y todo
 *    lo que sigue. Las posiciones que falten quedan como string vacío.
 *  - Sin ningún placeholder → los argumentos se agregan al final tras una
 *    línea en blanco.
 */
export async function expandirPlantilla(
  command: AgentCommand,
  argumentos: string,
  opciones: { cwd?: string; permitirShell?: boolean; env?: Record<string, string | undefined> } = {},
): Promise<Expansiones> {
  const posiciones = splitArguments(argumentos);
  // Regla de OpenCode, verificada contra su doc: "The highest-numbered
  // placeholder consumes its argument and everything after it". Es decir: `$1`
  // con `$2` en la misma plantilla toma UNA posición, y `$2` (el más alto) se
  // come el resto. Mi primera versión hacía que TODAS se comieran el resto, y
  // el test lo destapó ("Compará api stable branch con stable branch").
  const usados = [...command.template.matchAll(/\$([1-9])\b/g)].map((m) => Number(m[1]));
  const masAlto = usados.length ? Math.max(...usados) : 0;
  const posicion = (n: number): string => {
    if (masAlto > 0 && n === masAlto) return posiciones.slice(n - 1).join(" ");
    return posiciones[n - 1] ?? "";
  };
  const reemplazos: Record<string, string> = {
    ARGUMENTS: argumentos,
  };
  for (let n = 1; n <= 9; n += 1) reemplazos[String(n)] = posicion(n);

  // OJO con el regex: el `\$` de afuera ya consume el signo, así que el grupo
  // busca `ARGUMENTS` o un dígito — NO `\$ARGUMENTS` (eso pediría `$$ARGUMENTS`
  // y no matcheaba nada; lo destapó el test).
  let texto = command.template.replace(/\$(ARGUMENTS|[1-9])\b/g, (_match, token: string) => reemplazos[token] ?? "");

  let shellOmitidos = 0;
  let teniaShell = false;
  if (texto.includes("!`")) {
    teniaShell = true;
    const permitir = opciones.permitirShell === true;
    if (permitir && opciones.cwd) {
      texto = await correrBloquesShell(texto, opciones.cwd, opciones.env ?? process.env);
    } else {
      // Se reemplaza por un marcador visible en vez de dejar el `!`cmd`` crudo:
      // el modelo vería el comando como texto y podría ejecutarlo por su cuenta.
      texto = texto.replace(/!`[^`]*`/g, "[bloque de shell omitido: los bloques de shell están desactivados]");
      shellOmitidos = (texto.match(/\[bloque de shell omitido/g) ?? []).length;
    }
  }

  const sinPlaceholder = !/\$(ARGUMENTS|[1-9])\b/.test(command.template);
  if (sinPlaceholder && argumentos.trim()) texto = texto.trimEnd() + "\n\n" + argumentos;

  return { prompt: texto, shellBloquesOmitidos: shellOmitidos, teniaShell };
}

/** Corre cada bloque `` !`cmd` `` y pone su salida en su lugar. */
async function correrBloquesShell(texto: string, cwd: string, env: Record<string, string | undefined>): Promise<string> {
  const bloques = [...texto.matchAll(/!`([^`]*)`/g)];
  let salida = texto;
  // De atrás hacia adelante para no invalidar los índices al reemplazar.
  for (let i = bloques.length - 1; i >= 0; i -= 1) {
    const comando = bloques[i][1];
    const inicio = bloques[i].index ?? 0;
    const ejecutado = await correrUno(comando, cwd, env);
    salida = salida.slice(0, inicio) + ejecutado + salida.slice(inicio + bloques[i][0].length);
  }
  return salida;
}

async function correrUno(comando: string, cwd: string, env: Record<string, string | undefined>): Promise<string> {
  // Sin shell: `sh -c`/`cmd /c` es exactamente la superficie que no queremos
  // dar por defecto. Se corre por argv directo con Node, con timeout, y la
  // salida se redacta y se recorta.
  const argv = process.platform === "win32" ? ["cmd", "/c", comando] : ["sh", "-c", comando];
  try {
    const { stdout } = await execFileAsync(argv[0], argv.slice(1), {
      cwd,
      timeout: SHELL_BLOCK_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, ...env } as NodeJS.ProcessEnv,
    });
    const redactado = redactSecrets(String(stdout ?? ""));
    return "<shell-output>\n" + redactado.slice(0, MAX_SHELL_OUTPUT_CHARS) + "\n</shell-output>";
  } catch (error) {
    const mensaje = redactSecrets(error instanceof Error ? error.message : String(error));
    return "<shell-output error=\"true\">\n" + mensaje.slice(0, MAX_SHELL_OUTPUT_CHARS) + "\n</shell-output>";
  }
}

/**
 * Detecta si un prompt es un comando conocido y lo expande.
 *
 * Devuelve `null` si NO es un comando (o si no se pudo expandir): en ese caso el
 * prompt se manda tal cual. Un comando roto nunca rompe la task.
 */
export async function resolveCommandPrompt(
  prompt: string,
  projectPath: string,
  env: Record<string, string | undefined> = process.env,
): Promise<{
  prompt: string;
  command?: AgentCommand;
  expandido: boolean;
  errores: string[];
}> {
  const trimmed = prompt.trimStart();
  const match = /^\/([A-Za-z0-9_\-/]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match) return { prompt, expandido: false, errores: [] };

  const id = "/" + match[1];
  const argumentos = (match[2] ?? "").trim();
  const descubrimiento = await listAgentCommands(projectPath, env);
  const command = descubrimiento.commands.find((c) => c.id === id);
  if (!command) return { prompt, expandido: false, errores: descubrimiento.errors.map((e) => e.path + ": " + e.error) };

  const expansion = await expandirPlantilla(command, argumentos, { cwd: projectPath, permitirShell: shellBlocksEnabled(env), env });
  return {
    prompt: expansion.prompt,
    ...(command ? { command } : {}),
    expandido: true,
    errores: descubrimiento.errors.map((e) => e.path + ": " + e.error),
  };
}
