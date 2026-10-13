/**
 * Fase 7C — Configuración de resolución de módulos (única parte de 7C que
 * toca el disco).
 *
 * Carga `tsconfig.json` (o `jsconfig.json` como respaldo), SOLO de la raíz
 * del workspace, y la convierte en las opciones que usa
 * `ts.resolveModuleName` en `dependency-graph.ts`.
 *
 * - Qué archivo se intenta sale del INVENTARIO de 7A (no se descubre nada
 *   en el filesystem). Un `tsconfig.json` que existe en disco pero 7A no
 *   listó (p. ej. ignorado por git) no existe para el grafo.
 * - Toda lectura pasa por el patrón seguro de siempre: `resolveSafePath`
 *   (de `safe-path.ts`, sin duplicar su lógica) + `lstat` (archivo regular,
 *   no symlink) + tope de tamaño.
 * - `extends`: solo cadenas RELATIVAS dentro del workspace (máx. 5
 *   niveles, con detección de ciclos). Los textos se precargan acá y TS
 *   los procesa con `parseJsonConfigFileContent` sobre un host en memoria
 *   (`readDirectory` vacío): no se escribe ningún parser JSON propio y TS
 *   nunca toca el disco.
 * - Los problemas NO tiran: quedan como `warnings` (rutas relativas, sin
 *   rutas absolutas del sistema) y se sigue con lo que se pueda.
 */
import fs from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { resolveSafePath, UnsafePathError } from "./safe-path";
import type { RepoInventory } from "./repo-inventory";

/** Raíz VIRTUAL del resolver: nunca se usan rutas reales del sistema. */
export const VIRTUAL_ROOT = "/ws";
export const MAX_CONFIG_BYTES = 256 * 1024;
export const MAX_EXTENDS_DEPTH = 5;
const CONFIG_CANDIDATES = ["tsconfig.json", "jsconfig.json"] as const;
/**
 * Códigos de TS que NO reportamos: "sin inputs" (no usamos include/files) y los
 * que ya cubrimos con un warning propio al precargar el `extends` — archivo no
 * encontrado (6053), no se pudo leer (5083) y circularidad (18000).
 */
const IGNORED_TS_DIAGNOSTICS = new Set([18003, 6053, 5083, 18000]);

export type ResolutionConfigFile = (typeof CONFIG_CANDIDATES)[number];

export type ResolutionConfig = {
  /** Archivo efectivamente usado; `null` si no hubo ninguno utilizable. */
  file: ResolutionConfigFile | null;
  /** Opciones para `ts.resolveModuleName` (raíz virtual). No es JSON-serializable a propósito. */
  compilerOptions: ts.CompilerOptions;
  /** `baseUrl` relativo a la raíz del workspace (`"."`, `"src"`). */
  baseUrl?: string;
  /** `paths` tal como están declarados (para mostrar y para clasificar). */
  aliases: { pattern: string; targets: string[] }[];
  warnings: string[];
};

export class ResolutionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResolutionConfigError";
  }
}

export type LoadResolutionConfigOptions = { signal?: AbortSignal };

/** Opciones forzadas (el resolver se comporta como un bundler y es permisivo con las extensiones). */
function forcedOptions(): ts.CompilerOptions {
  return {
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    module: ts.ModuleKind.ESNext,
    allowJs: true,
    resolveJsonModule: true,
    allowArbitraryExtensions: true,
  };
}

export function defaultResolutionConfig(warnings: string[] = []): ResolutionConfig {
  return { file: null, compilerOptions: forcedOptions(), aliases: [], warnings };
}

function sanitizeMessage(messageText: string | ts.DiagnosticMessageChain): string {
  const flat = ts.flattenDiagnosticMessageText(messageText, " ").replace(/\s+/g, " ").trim();
  // Los mensajes de TS mencionan la raíz virtual: se quita (queda una ruta relativa).
  return flat.replace(/\/ws\//g, "").slice(0, 200);
}

function toWorkspaceRelative(virtualPath: string): string {
  return virtualPath === VIRTUAL_ROOT ? "." : path.posix.relative(VIRTUAL_ROOT, virtualPath) || ".";
}

function insideVirtualRoot(virtualPath: string): boolean {
  return virtualPath === VIRTUAL_ROOT || virtualPath.startsWith(`${VIRTUAL_ROOT}/`);
}

/**
 * Parte PURA: convierte textos de config ya cargados (clave = ruta relativa
 * al workspace) en un `ResolutionConfig`. `null` si el archivo raíz no es
 * JSON válido (el motivo queda en `warnings`).
 */
export function parseResolutionConfig(file: ResolutionConfigFile, texts: ReadonlyMap<string, string>): { config: ResolutionConfig | null; warnings: string[] } {
  const warnings: string[] = [];
  const rootAbs = `${VIRTUAL_ROOT}/${file}`;
  const rootText = texts.get(file);
  if (rootText === undefined) {
    warnings.push(`${file}: no se pudo leer.`);
    return { config: null, warnings };
  }

  const json = ts.parseConfigFileTextToJson(rootAbs, rootText);
  if (json.error || typeof json.config !== "object" || json.config === null || Array.isArray(json.config)) {
    warnings.push(`${file}: no es JSON válido${json.error ? ` (${sanitizeMessage(json.error.messageText)})` : ""}.`);
    return { config: null, warnings };
  }

  const readVirtual = (p: string): string | undefined => (p.startsWith(`${VIRTUAL_ROOT}/`) ? texts.get(p.slice(VIRTUAL_ROOT.length + 1)) : undefined);
  const host: ts.ParseConfigHost = {
    useCaseSensitiveFileNames: true,
    readDirectory: () => [], // no usamos include/exclude/files: nada de recorrer directorios
    fileExists: (p) => readVirtual(p) !== undefined,
    readFile: (p) => readVirtual(p),
  };
  const parsed = ts.parseJsonConfigFileContent(json.config, host, VIRTUAL_ROOT, undefined, rootAbs);
  for (const diagnostic of parsed.errors) {
    if (IGNORED_TS_DIAGNOSTICS.has(diagnostic.code)) continue;
    warnings.push(`${file}: ${sanitizeMessage(diagnostic.messageText)}`);
  }

  // Se conservan SOLO baseUrl / paths / rootDirs (+ `pathsBasePath`, el dato interno que TS
  // calcula junto con `paths` y que hace falta cuando no hay baseUrl).
  const source = parsed.options as ts.CompilerOptions & { pathsBasePath?: string };
  const options: ts.CompilerOptions & { pathsBasePath?: string } = forcedOptions();
  if (source.baseUrl !== undefined) options.baseUrl = source.baseUrl;
  if (source.paths) options.paths = source.paths;
  if (source.pathsBasePath !== undefined) options.pathsBasePath = source.pathsBasePath;
  if (source.rootDirs) options.rootDirs = source.rootDirs;

  const config: ResolutionConfig = { file, compilerOptions: options, aliases: [], warnings: [] };
  if (source.baseUrl !== undefined) {
    config.baseUrl = toWorkspaceRelative(source.baseUrl);
    if (!insideVirtualRoot(source.baseUrl)) warnings.push(`${file}: baseUrl "${config.baseUrl}" sale del workspace (no se sigue).`);
  }
  const pathsBase = source.baseUrl ?? source.pathsBasePath ?? VIRTUAL_ROOT;
  for (const [pattern, targets] of Object.entries(source.paths ?? {})) {
    config.aliases.push({ pattern, targets: [...targets] });
    for (const target of targets) {
      const probe = target.replace(/\*/g, "x");
      const resolved = probe.startsWith("/") ? path.posix.normalize(probe) : path.posix.normalize(path.posix.join(pathsBase, probe));
      if (!insideVirtualRoot(resolved)) warnings.push(`${file}: el alias "${pattern}" apunta a "${target}", fuera del workspace (no se sigue).`);
    }
  }
  return { config, warnings };
}

type ReadResult = { kind: "ok"; text: string } | { kind: "missing" } | { kind: "refused"; warning: string };

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code;
  return typeof code === "string" ? code : error instanceof Error ? error.name : "UNKNOWN";
}

/** Lectura segura de UN archivo de config: resolveSafePath + lstat regular + tope de tamaño. */
async function readConfigText(workspaceRoot: string, relPath: string): Promise<ReadResult> {
  let real: string;
  try {
    real = await resolveSafePath(workspaceRoot, relPath);
  } catch (error) {
    if (error instanceof UnsafePathError) return { kind: "refused", warning: `${relPath}: ruta no permitida (${error.message}).` };
    return { kind: "refused", warning: `${relPath}: no se pudo resolver (${errorCode(error)}).` };
  }
  try {
    // lstat sobre la ruta SIN resolver: un symlink (aunque apunte adentro) no se lee.
    const stat = await fs.lstat(path.resolve(workspaceRoot, relPath));
    if (stat.isSymbolicLink() || !stat.isFile()) return { kind: "refused", warning: `${relPath}: no es un archivo regular (symlink o directorio); se ignora.` };
    if (stat.size > MAX_CONFIG_BYTES) return { kind: "refused", warning: `${relPath}: demasiado grande (${stat.size} bytes > ${MAX_CONFIG_BYTES}); se ignora.` };
    const buffer = await fs.readFile(real);
    if (buffer.length > MAX_CONFIG_BYTES) return { kind: "refused", warning: `${relPath}: demasiado grande; se ignora.` };
    return { kind: "ok", text: buffer.toString("utf-8").replace(/^\uFEFF/, "") };
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "missing" };
    return { kind: "refused", warning: `${relPath}: no se pudo leer (${code}).` };
  }
}

function isRelativeExtends(spec: string): boolean {
  return spec === "." || spec === ".." || spec.startsWith("./") || spec.startsWith("../");
}

function extendsList(config: unknown): string[] {
  const value = (config as { extends?: unknown } | null)?.extends;
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return [];
}

type PreloadContext = { workspaceRoot: string; texts: Map<string, string>; warnings: string[]; signal?: AbortSignal };

function throwIfAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw new ResolutionConfigError("La carga de la configuración de resolución fue cancelada.");
}

/** Precarga la cadena de `extends` RELATIVOS (máx. MAX_EXTENDS_DEPTH, sin ciclos) en `texts`. */
async function preloadExtends(ctx: PreloadContext, relPath: string, depth: number, stack: string[]): Promise<void> {
  const text = ctx.texts.get(relPath);
  if (text === undefined) return;
  const json = ts.parseConfigFileTextToJson(`${VIRTUAL_ROOT}/${relPath}`, text);
  if (json.error) return; // el JSON inválido se reporta al parsear
  for (const spec of extendsList(json.config)) {
    throwIfAborted(ctx.signal);
    if (!isRelativeExtends(spec)) {
      ctx.warnings.push(`${relPath}: extends "${spec}" apunta a un paquete o ruta absoluta: no se resuelve (se ignora).`);
      continue;
    }
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(relPath), spec));
    if (target === ".." || target.startsWith("../")) {
      ctx.warnings.push(`${relPath}: extends "${spec}" sale del workspace; se ignora.`);
      continue;
    }
    if (depth + 1 > MAX_EXTENDS_DEPTH) {
      ctx.warnings.push(`${relPath}: extends "${spec}" supera la profundidad máxima (${MAX_EXTENDS_DEPTH}); se ignora.`);
      continue;
    }
    // Igual que TS: primero la ruta exacta y, si no termina en .json, con .json agregado.
    const candidates = target.endsWith(".json") ? [target] : [target, `${target}.json`];
    let loaded: string | null = null;
    let refused = false;
    for (const candidate of candidates) {
      if (stack.includes(candidate)) {
        ctx.warnings.push(`${relPath}: ciclo de extends (${[...stack, candidate].join(" → ")}); se ignora.`);
        refused = true;
        break;
      }
      if (ctx.texts.has(candidate)) {
        loaded = candidate;
        break;
      }
      const result = await readConfigText(ctx.workspaceRoot, candidate);
      if (result.kind === "ok") {
        ctx.texts.set(candidate, result.text);
        loaded = candidate;
        await preloadExtends(ctx, candidate, depth + 1, [...stack, candidate]);
        break;
      }
      if (result.kind === "refused") {
        ctx.warnings.push(result.warning);
        refused = true;
        break;
      }
    }
    if (loaded === null && !refused) ctx.warnings.push(`${relPath}: extends "${spec}" no existe.`);
  }
}

/**
 * Carga la configuración de resolución del workspace. Prueba `tsconfig.json`
 * y después `jsconfig.json` (solo si el inventario de 7A los lista). Si
 * ninguno es utilizable: opciones por defecto, `file: null`, y los motivos
 * en `warnings`. Solo una cancelación (`signal`) lanza.
 */
export async function loadResolutionConfig(workspaceRoot: string, inventory: Pick<RepoInventory, "files">, options: LoadResolutionConfigOptions = {}): Promise<ResolutionConfig> {
  const warnings: string[] = [];
  throwIfAborted(options.signal);
  for (const candidate of CONFIG_CANDIDATES) {
    const entry = inventory.files.find((file) => file.path === candidate);
    if (!entry) continue;
    if (entry.skipped) {
      warnings.push(`${candidate}: no analizable (${entry.skipped.reason}); se ignora.`);
      continue;
    }
    const rootRead = await readConfigText(workspaceRoot, candidate);
    if (rootRead.kind === "missing") {
      warnings.push(`${candidate}: ya no existe en el disco; se ignora.`);
      continue;
    }
    if (rootRead.kind === "refused") {
      warnings.push(rootRead.warning);
      continue;
    }
    const texts = new Map<string, string>([[candidate, rootRead.text]]);
    const preloadWarnings: string[] = [];
    await preloadExtends({ workspaceRoot, texts, warnings: preloadWarnings, signal: options.signal }, candidate, 0, [candidate]);
    const parsed = parseResolutionConfig(candidate, texts);
    warnings.push(...preloadWarnings, ...parsed.warnings);
    if (!parsed.config) continue;
    parsed.config.warnings = warnings;
    return parsed.config;
  }
  return defaultResolutionConfig(warnings);
}
