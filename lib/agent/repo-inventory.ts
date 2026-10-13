/**
 * Fase 7A — Repository Map, capa 1: INVENTARIO determinista del worktree.
 *
 * Responde únicamente "qué archivos existen y de qué tipo son", más la
 * metadata básica del `package.json` raíz. NO parsea código (símbolos,
 * imports y exports son 7B), NO resuelve dependencias (7C) y todavía NO
 * es una tool del Agent ni tiene cache (7D). Sin LLM, sin SQLite, sin
 * dependencias nuevas.
 *
 * Fuente de verdad: Git, no un recorrido del filesystem.
 * - `git ls-files -s`: archivos versionados (con su modo, para distinguir
 *   symlinks y submódulos sin tocar el disco).
 * - `git ls-files --others --exclude-standard`: archivos nuevos todavía no
 *   versionados que `.gitignore` NO excluye. Sin esto, un archivo que el
 *   Agent acaba de crear con `write_file` (el worktree no hace `git add`
 *   hasta el apply — ver 4D) no existiría para el mapa. Respeta
 *   `.gitignore`, así que `node_modules`/`.next`/etc. quedan afuera sin
 *   necesidad de un `SKIP_DIRS` fijo.
 *
 * Seguridad: todo acceso físico pasa por `resolveSafePath` (el helper real
 * de `safe-path.ts`, el que sí valida symlinks con `fs.realpath`) — nada se
 * duplica ni se saltea. Los paths que devuelve Git igual se validan
 * sintácticamente antes de tocar el disco.
 *
 * Robustez: un archivo problemático NUNCA rompe el inventario — queda
 * representado como entrada `skipped` con su razón y el resto sigue.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveSafePath, UnsafePathError } from "./safe-path";

const execFileAsync = promisify(execFile);

/** Por encima de esto un archivo no se considera analizable (queda como
 * `skipped: too_large`). 1 MB: el código fuente escrito a mano casi nunca
 * llega ahí, y 7B no debería parsear bundles/lockfiles/dumps. */
export const MAX_INVENTORY_FILE_BYTES = 1_000_000;
/** Tope de entradas del inventario (monorepos enormes). Se recorta
 * DESPUÉS de ordenar por path, así que el recorte es determinista. */
export const MAX_INVENTORY_FILES = 20_000;
/** Cuántos bytes iniciales se leen para detectar binarios (mismo criterio
 * que git: un byte NUL en los primeros 8000). */
const BINARY_SNIFF_BYTES = 8_000;
const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const PROBE_CONCURRENCY = 32;

export type InventoryLanguage =
  | "typescript"
  | "tsx"
  | "javascript"
  | "jsx"
  | "json"
  | "markdown"
  | "css"
  | "html"
  | "yaml"
  | "shell"
  | "python"
  | "sql"
  | "other";

export type SkipReason = "too_large" | "binary" | "symlink" | "submodule" | "unsafe_path" | "not_file" | "unreadable";

export type InventoryFile = {
  /** Ruta relativa a la raíz del workspace, con `/` (así la entrega Git). */
  path: string;
  /** Extensión en minúscula con punto (`".ts"`), o `""` si no tiene. */
  extension: string;
  language: InventoryLanguage;
  /** Tamaño en bytes; `null` si no se pudo/debió determinar. */
  size: number | null;
  /** `true` si está en el índice de Git; `false` si es nuevo y no ignorado. */
  tracked: boolean;
  /** Presente solo si el archivo NO es contenido analizable. */
  skipped?: { reason: SkipReason; detail?: string };
};

export type FrameworkInfo = {
  name: "next";
  /** Rango declarado en `package.json` (ej. `"^16.2.4"`), si hay. */
  version: string | null;
  /** Por qué se detectó, ej. `["dependency:next","config:next.config.ts"]`. */
  evidence: string[];
};

export type ProjectPackageInfo = {
  name: string | null;
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

export type RepoInventory = {
  /** Ordenado por `path` (comparación por unidades de código, no por locale). */
  files: InventoryFile[];
  /** `null` si no hay `package.json` raíz en el inventario o no se pudo leer. */
  package: ProjectPackageInfo | null;
  /** Motivo si el `package.json` existe pero no se pudo leer/parsear. */
  packageError?: string;
  frameworks: FrameworkInfo[];
  /** `true` si hubo más archivos que `maxFiles` y se recortó. */
  truncated: boolean;
  stats: {
    /** Entradas en `files`. */
    files: number;
    /** Entradas SIN `skipped` (contenido analizable). */
    analyzable: number;
    skipped: number;
    /** Archivos en el índice de Git que ya no existen en el worktree (se omiten). */
    deletedInWorktree: number;
  };
};

export type RepoInventoryOptions = {
  maxFileBytes?: number;
  maxFiles?: number;
  signal?: AbortSignal;
  /** SOLO tests (mismo criterio que otros overrides inyectables del
   * proyecto): reemplaza la lectura del prefijo usado para detectar
   * binarios, para poder simular un error de I/O de un archivo puntual
   * sin depender de permisos del SO. */
  readFilePrefix?: (absPath: string, bytes: number) => Promise<Buffer>;
};

export class RepoInventoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepoInventoryError";
  }
}

const LANGUAGE_BY_EXTENSION: Record<string, InventoryLanguage> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "jsx",
  ".json": "json",
  ".md": "markdown",
  ".mdx": "markdown",
  ".css": "css",
  ".html": "html",
  ".yml": "yaml",
  ".yaml": "yaml",
  ".sh": "shell",
  ".py": "python",
  ".sql": "sql",
};

/** Extensiones que son binarias sin necesidad de leer el archivo. */
const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp", ".ico",
  ".pdf", ".zip", ".gz", ".tgz", ".tar", ".7z", ".rar",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".mp3", ".mp4", ".mov", ".webm", ".wav", ".ogg",
  ".exe", ".dll", ".so", ".dylib", ".wasm", ".node", ".class", ".jar",
  ".sqlite", ".db", ".bin",
]);

/** Archivos de config de Next.js en la raíz (evidencia adicional). */
const NEXT_CONFIG_FILES = ["next.config.js", "next.config.mjs", "next.config.cjs", "next.config.ts", "next.config.mts"];

export function detectLanguage(filePath: string): { extension: string; language: InventoryLanguage } {
  const extension = path.posix.extname(filePath).toLowerCase();
  return { extension, language: LANGUAGE_BY_EXTENSION[extension] ?? "other" };
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Validación sintáctica de un path que viene de Git, ANTES de tocar el
 * disco. `resolveSafePath` es la barrera real; esto evita siquiera
 * intentarlo con algo que no puede ser un path relativo normal. */
export function isSyntacticallySafe(relPath: string): boolean {
  if (relPath.length === 0 || relPath.includes("\0")) return false;
  if (path.isAbsolute(relPath) || path.win32.isAbsolute(relPath)) return false;
  return !relPath.split(/[\\/]/).some((segment) => segment === "..");
}

async function runGitLsFiles(workspaceRoot: string, args: string[], signal?: AbortSignal): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["ls-files", "-z", ...args], {
      cwd: workspaceRoot,
      maxBuffer: GIT_MAX_BUFFER,
      timeout: GIT_TIMEOUT_MS,
      signal,
      windowsHide: true,
    });
    return stdout.split("\0").filter((entry) => entry.length > 0);
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
    throw new RepoInventoryError(`No se pudo listar los archivos con git ls-files: ${reason}`);
  }
}

type GitEntry = { path: string; tracked: boolean; mode: string | null };

async function listGitEntries(workspaceRoot: string, signal?: AbortSignal): Promise<GitEntry[]> {
  const entries = new Map<string, GitEntry>();
  // `-s`: "<modo> <objeto> <stage>\t<path>". Un path en conflicto de merge
  // aparece una vez por stage — el Map lo deduplica.
  for (const line of await runGitLsFiles(workspaceRoot, ["-s"], signal)) {
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    const mode = line.slice(0, tab).split(" ")[0] ?? null;
    const filePath = line.slice(tab + 1);
    if (!entries.has(filePath)) entries.set(filePath, { path: filePath, tracked: true, mode });
  }
  for (const filePath of await runGitLsFiles(workspaceRoot, ["--others", "--exclude-standard"], signal)) {
    if (!entries.has(filePath)) entries.set(filePath, { path: filePath, tracked: false, mode: null });
  }
  return [...entries.values()];
}

export async function mapWithLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function defaultReadFilePrefix(absPath: string, bytes: number): Promise<Buffer> {
  const handle = await fs.open(absPath, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Devuelve `null` si el archivo ya no existe en el worktree (borrado sin
 * stagear); cualquier otro problema queda como entrada `skipped`. */
async function probeEntry(workspaceRoot: string, entry: GitEntry, maxFileBytes: number, readPrefix: NonNullable<RepoInventoryOptions["readFilePrefix"]>): Promise<InventoryFile | null> {
  const { extension, language } = detectLanguage(entry.path);
  const base = { path: entry.path, extension, language, tracked: entry.tracked };
  const skip = (reason: SkipReason, size: number | null, detail?: string): InventoryFile => ({ ...base, size, skipped: detail ? { reason, detail } : { reason } });

  if (entry.mode === "160000") return skip("submodule", null);
  if (!isSyntacticallySafe(entry.path)) return skip("unsafe_path", null, "Ruta no permitida (vacía, absoluta o con '..').");

  let real: string;
  try {
    real = await resolveSafePath(workspaceRoot, entry.path);
  } catch (error) {
    if (error instanceof UnsafePathError) return skip("unsafe_path", null, error.message);
    return skip("unreadable", null, errorCode(error));
  }

  try {
    // lstat sobre la ruta SIN resolver: si el archivo es un symlink (aunque
    // apunte adentro del workspace) no lo seguimos ni lo tratamos como código.
    const stat = await fs.lstat(path.resolve(workspaceRoot, entry.path));
    if (stat.isSymbolicLink() || entry.mode === "120000") return skip("symlink", null);
    if (!stat.isFile()) return skip("not_file", null);
    if (BINARY_EXTENSIONS.has(extension)) return skip("binary", stat.size);
    if (stat.size > maxFileBytes) return skip("too_large", stat.size, `${stat.size} bytes > ${maxFileBytes}`);
    if (stat.size > 0) {
      const prefix = await readPrefix(real, BINARY_SNIFF_BYTES);
      if (prefix.includes(0)) return skip("binary", stat.size);
    }
    return { ...base, size: stat.size };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    return skip("unreadable", null, errorCode(error));
  }
}

/** Solo el código de error del SO — los mensajes de `fs` incluyen rutas absolutas. */
function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (typeof code === "string") return code;
  return error instanceof Error ? error.name : "UNKNOWN";
}

function stringRecord(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}

async function readPackageInfo(workspaceRoot: string, file: InventoryFile | undefined): Promise<{ info: ProjectPackageInfo | null; error?: string }> {
  if (!file) return { info: null };
  if (file.skipped) return { info: null, error: `package.json no analizable (${file.skipped.reason}).` };
  try {
    const real = await resolveSafePath(workspaceRoot, file.path);
    const parsed: unknown = JSON.parse(await fs.readFile(real, "utf-8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { info: null, error: "package.json no es un objeto JSON." };
    const record = parsed as Record<string, unknown>;
    return {
      info: {
        name: typeof record.name === "string" ? record.name : null,
        scripts: stringRecord(record.scripts),
        dependencies: stringRecord(record.dependencies),
        devDependencies: stringRecord(record.devDependencies),
      },
    };
  } catch (error) {
    return { info: null, error: error instanceof SyntaxError ? "package.json no es JSON válido." : `package.json no se pudo leer (${errorCode(error)}).` };
  }
}

function detectFrameworks(info: ProjectPackageInfo | null, filePaths: Set<string>): FrameworkInfo[] {
  const frameworks: FrameworkInfo[] = [];
  const evidence: string[] = [];
  const declared = info?.dependencies.next ?? info?.devDependencies.next ?? null;
  if (declared !== null) evidence.push("dependency:next");
  for (const configFile of NEXT_CONFIG_FILES) if (filePaths.has(configFile)) evidence.push(`config:${configFile}`);
  if (evidence.length > 0) frameworks.push({ name: "next", version: declared, evidence });
  return frameworks;
}

/**
 * Construye el inventario del worktree en `workspaceRoot`. Lanza
 * `RepoInventoryError` solo si Git mismo falla (4A garantiza que todo
 * proyecto real tiene git); cualquier problema por archivo queda dentro
 * del resultado como entrada `skipped`.
 */
export async function buildRepoInventory(workspaceRoot: string, options: RepoInventoryOptions = {}): Promise<RepoInventory> {
  const maxFileBytes = options.maxFileBytes ?? MAX_INVENTORY_FILE_BYTES;
  const maxFiles = options.maxFiles ?? MAX_INVENTORY_FILES;
  const readPrefix = options.readFilePrefix ?? defaultReadFilePrefix;

  const entries = await listGitEntries(workspaceRoot, options.signal);
  const probed = await mapWithLimit(entries, PROBE_CONCURRENCY, (entry) => probeEntry(workspaceRoot, entry, maxFileBytes, readPrefix));

  const present = probed.filter((file): file is InventoryFile => file !== null);
  const deletedInWorktree = probed.length - present.length;
  present.sort((a, b) => compareCodeUnits(a.path, b.path));

  const truncated = present.length > maxFiles;
  const files = truncated ? present.slice(0, maxFiles) : present;

  const { info, error } = await readPackageInfo(
    workspaceRoot,
    files.find((file) => file.path === "package.json"),
  );
  const skipped = files.filter((file) => file.skipped).length;

  return {
    files,
    package: info,
    ...(error ? { packageError: error } : {}),
    frameworks: detectFrameworks(info, new Set(files.map((file) => file.path))),
    truncated,
    stats: { files: files.length, analyzable: files.length - skipped, skipped, deletedInWorktree },
  };
}
