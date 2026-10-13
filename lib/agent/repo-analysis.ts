/**
 * Fase 7B — Repository Map, capa 2 (orquestador): consume el inventario de
 * 7A y produce un `FileAnalysis` por cada archivo TS/TSX/JS/JSX analizable.
 *
 * - NO descubre archivos: ni vuelve a llamar a Git ni recorre el filesystem.
 *   Solo mira `inventory.files` (los `skipped` de 7A no se leen).
 * - Seguridad: cada archivo pasa DE NUEVO por `resolveSafePath` (el
 *   inventario puede estar viejo: en 7D se va a cachear) y por un `lstat`
 *   (regular, no symlink). Un symlink externo da `unsafe_path` y su destino
 *   NUNCA se lee.
 * - Un problema de UN archivo queda en su `parse: { status: "failed" }`; nunca
 *   rompe el resto. Solo una cancelación (`signal`) corta el análisis entero,
 *   de forma explícita (`RepoAnalysisError`).
 * - Sin cache, sin tool, sin SQLite: eso es 7D.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { resolveSafePath, UnsafePathError } from "./safe-path";
import { MAX_INVENTORY_FILE_BYTES, mapWithLimit, type InventoryFile, type RepoInventory } from "./repo-inventory";
import { analyzeSourceText, failedAnalysis, isParseableLanguage, type FileAnalysis, type ParseableLanguage } from "./repo-symbols";
import { detectNextRole } from "./next-roles";

const ANALYSIS_CONCURRENCY = 16;
/** Mismo criterio que 7A para detectar que un archivo pasó a ser binario. */
const BINARY_SNIFF_BYTES = 8_000;

export type RepoAnalysis = {
  /** Ordenado por `path` (comparación por unidades de código). */
  files: FileAnalysis[];
  stats: { analyzed: number; ok: number; withDiagnostics: number; failed: number };
};

export type RepoAnalysisOptions = {
  /** Debe coincidir con el límite usado al construir el inventario (default: el de 7A). */
  maxFileBytes?: number;
  signal?: AbortSignal;
  /** SOLO tests (mismo criterio que `readFilePrefix` en 7A): reemplaza la lectura del archivo. */
  readFile?: (absPath: string) => Promise<Buffer>;
};

export type AnalyzeInventoryFileOptions = Omit<RepoAnalysisOptions, "signal"> & {
  /** `inventory.frameworks`: habilita los roles de Next.js. */
  frameworks?: readonly { name: string }[];
};

export class RepoAnalysisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepoAnalysisError";
  }
}

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (typeof code === "string") return code;
  return error instanceof Error ? error.name : "UNKNOWN";
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Analiza UN archivo del inventario. Exportada como interfaz para que 7D
 * pueda re-analizar un solo archivo tras una edición (sin implementar cache
 * acá). Nunca lanza por problemas del archivo.
 */
export async function analyzeInventoryFile(
  workspaceRoot: string,
  file: Pick<InventoryFile, "path" | "language">,
  options: AnalyzeInventoryFileOptions = {},
): Promise<FileAnalysis> {
  const language = file.language as ParseableLanguage;
  const fail = (code: Parameters<typeof failedAnalysis>[2], detail?: string) => failedAnalysis(file.path, language, code, detail);
  const maxFileBytes = options.maxFileBytes ?? MAX_INVENTORY_FILE_BYTES;
  const readFile = options.readFile ?? ((absPath: string) => fs.readFile(absPath));

  try {
    if (!isParseableLanguage(file.language)) return fail("read_failed", "language_not_parseable");

    let real: string;
    try {
      real = await resolveSafePath(workspaceRoot, file.path);
    } catch (error) {
      if (error instanceof UnsafePathError) return fail("unsafe_path", error.message);
      return fail("read_failed", errorCode(error));
    }

    let size: number;
    try {
      // lstat sobre la ruta SIN resolver: un symlink (aunque apunte adentro) no es un archivo regular.
      const stat = await fs.lstat(path.resolve(workspaceRoot, file.path));
      if (stat.isSymbolicLink() || !stat.isFile()) return fail("not_regular_file");
      size = stat.size;
    } catch (error) {
      const code = errorCode(error);
      return code === "ENOENT" || code === "ENOTDIR" ? fail("changed_since_inventory", code) : fail("read_failed", code);
    }
    if (size > maxFileBytes) return fail("changed_since_inventory", `size ${size} > ${maxFileBytes}`);

    let buffer: Buffer;
    try {
      buffer = await readFile(real);
    } catch (error) {
      return fail("read_failed", errorCode(error));
    }
    // El archivo pudo crecer o volverse binario entre el lstat y la lectura.
    if (buffer.length > maxFileBytes) return fail("changed_since_inventory", `size ${buffer.length} > ${maxFileBytes}`);
    if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return fail("changed_since_inventory", "binary");

    const analysis = analyzeSourceText(file.path, file.language, buffer.toString("utf-8"));
    if (options.frameworks && analysis.parse.status !== "failed") {
      const next = detectNextRole(file.path, analysis.exports, options.frameworks);
      if (next) analysis.next = next;
    }
    return analysis;
  } catch (error) {
    // Defensa en profundidad: ningún error individual se propaga.
    return fail("read_failed", error instanceof Error ? error.name : "UNKNOWN");
  }
}

/**
 * Analiza todos los archivos analizables de un inventario de 7A
 * (`language ∈ typescript|tsx|javascript|jsx` y sin `skipped`).
 */
export async function analyzeRepoInventory(workspaceRoot: string, inventory: RepoInventory, options: RepoAnalysisOptions = {}): Promise<RepoAnalysis> {
  const { signal } = options;
  const aborted = () => new RepoAnalysisError("El análisis del repositorio fue cancelado.");
  if (signal?.aborted) throw aborted();

  const candidates = inventory.files.filter((file) => !file.skipped && isParseableLanguage(file.language));
  const results = await mapWithLimit(candidates, ANALYSIS_CONCURRENCY, async (file) => {
    if (signal?.aborted) throw aborted();
    return analyzeInventoryFile(workspaceRoot, file, { maxFileBytes: options.maxFileBytes, readFile: options.readFile, frameworks: inventory.frameworks });
  });
  if (signal?.aborted) throw aborted();

  const files = [...results].sort((a, b) => compareCodeUnits(a.path, b.path));
  const failed = files.filter((file) => file.parse.status === "failed").length;
  const withDiagnostics = files.filter((file) => file.parse.status === "diagnostics").length;
  return { files, stats: { analyzed: files.length, ok: files.length - failed - withDiagnostics, withDiagnostics, failed } };
}
