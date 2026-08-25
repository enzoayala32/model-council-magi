import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { tool } from "ai";

const execFileAsync = promisify(execFile);

const MAX_READ_BYTES = 200_000;
const MAX_SEARCH_RESULTS = 60;
const MAX_LIST_RESULTS = 300;
const MAX_TYPECHECK_OUTPUT = 20_000;
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build"]);

class UnsafePathError extends Error {}

/**
 * Resuelve `relativePath` dentro de `root` y valida que no se escape —
 * ni por `..`, ni por un symlink que apunte afuera. A diferencia de
 * `resolveSafePath` en `lib/fs-tools.ts` (que documenta esta validación
 * pero no la hace), acá el `fs.realpath` se ejecuta y se compara de
 * verdad contra la raíz real.
 */
async function resolveSafePath(root: string, relativePath: string): Promise<string> {
  if (path.isAbsolute(relativePath)) throw new UnsafePathError(`Ruta absoluta no permitida: ${relativePath}`);
  const joined = path.resolve(root, relativePath);
  const realRoot = await fs.realpath(root);
  if (joined !== realRoot && !joined.startsWith(realRoot + path.sep)) {
    throw new UnsafePathError(`La ruta se sale del workspace: ${relativePath}`);
  }

  // Si el archivo/directorio ya existe, resolvemos symlinks de verdad y
  // confirmamos que el destino real sigue adentro de la raíz real.
  try {
    const real = await fs.realpath(joined);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
      throw new UnsafePathError(`Symlink apunta afuera del workspace: ${relativePath}`);
    }
    return real;
  } catch (error) {
    if (error instanceof UnsafePathError) throw error;
    // No existe todavía (caso típico de write_file con archivo nuevo) —
    // validamos el ancestro existente más cercano en su lugar.
    let dir = path.dirname(joined);
    while (true) {
      try {
        const realDir = await fs.realpath(dir);
        if (realDir !== realRoot && !realDir.startsWith(realRoot + path.sep)) {
          throw new UnsafePathError(`Symlink de directorio apunta afuera del workspace: ${relativePath}`);
        }
        break;
      } catch (dirError) {
        if (dirError instanceof UnsafePathError) throw dirError;
        const parent = path.dirname(dir);
        if (parent === dir) break; // llegamos a la raíz del filesystem sin encontrar nada — dejamos que falle más adelante
        dir = parent;
      }
    }
    return joined;
  }
}

async function walkFiles(root: string, dir: string, onFile: (absPath: string) => Promise<boolean>) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walkFiles(root, path.join(dir, entry.name), onFile);
    } else if (entry.isFile()) {
      const keepGoing = await onFile(path.join(dir, entry.name));
      if (!keepGoing) return;
    }
  }
}

export type AgentToolEvent =
  | { type: "file_written"; relPath: string }
  | { type: "file_edited"; relPath: string };

/**
 * Arma el set de tools para una corrida puntual del agente, scopeadas a
 * `workspaceRoot` (el worktree aislado). `onEvent` deja que `loop.ts`
 * sepa, sin adivinar, cuándo un paso modificó contenido de verdad — es
 * la señal que usa la detección de "sin progreso".
 */
export function createAgentTools(workspaceRoot: string, onEvent: (event: AgentToolEvent) => void) {
  return {
    list_files: tool({
      description:
        "Lista los archivos del proyecto (rutas relativas), para orientarse antes de buscar o editar. No busca texto adentro de los archivos — para eso usá search_files. Podés filtrar por extensión o por un fragmento del nombre.",
      inputSchema: z.object({
        subPath: z.string().optional().describe("Subcarpeta relativa donde listar (opcional, por default toda la raíz del workspace)."),
        extension: z.string().optional().describe("Filtrar solo archivos con esta extensión, por ejemplo 'ts' o '.tsx' (opcional)."),
        nameContains: z.string().optional().describe("Filtrar solo archivos cuyo nombre contenga este texto (opcional)."),
      }),
      execute: async ({ subPath, extension, nameContains }) => {
        try {
          const listRoot = subPath ? await resolveSafePath(workspaceRoot, subPath) : workspaceRoot;
          const ext = extension ? (extension.startsWith(".") ? extension : `.${extension}`) : undefined;
          const files: string[] = [];
          await walkFiles(workspaceRoot, listRoot, async (absPath) => {
            const rel = path.relative(workspaceRoot, absPath);
            if (ext && !rel.endsWith(ext)) return true;
            if (nameContains && !path.basename(rel).toLowerCase().includes(nameContains.toLowerCase())) return true;
            files.push(rel);
            return files.length < MAX_LIST_RESULTS;
          });
          return { ok: true, files, truncated: files.length >= MAX_LIST_RESULTS };
        } catch (error) {
          return { ok: false, error: describeError(error, subPath ?? "") };
        }
      },
    }),

    read_file: tool({
      description: "Lee el contenido de un archivo de texto dentro del workspace. Devuelve un error legible si el archivo no existe.",
      inputSchema: z.object({
        path: z.string().describe("Ruta relativa al workspace, por ejemplo 'lib/models.ts'."),
      }),
      execute: async ({ path: relPath }) => {
        try {
          const abs = await resolveSafePath(workspaceRoot, relPath);
          const stat = await fs.stat(abs);
          if (!stat.isFile()) return { ok: false, error: `${relPath} no es un archivo.` };
          const buf = await fs.readFile(abs);
          const truncated = buf.length > MAX_READ_BYTES;
          const content = buf.subarray(0, MAX_READ_BYTES).toString("utf-8");
          return { ok: true, content, truncated, sizeBytes: buf.length };
        } catch (error) {
          return { ok: false, error: describeError(error, relPath) };
        }
      },
    }),

    write_file: tool({
      description: "Crea un archivo nuevo o reemplaza su contenido completo. Usar edit_file en cambios chicos a un archivo existente — write_file pisa todo el archivo.",
      inputSchema: z.object({
        path: z.string().describe("Ruta relativa al workspace."),
        content: z.string().describe("Contenido completo del archivo."),
      }),
      execute: async ({ path: relPath, content }) => {
        try {
          const abs = await resolveSafePath(workspaceRoot, relPath);
          await fs.mkdir(path.dirname(abs), { recursive: true });
          await fs.writeFile(abs, content, "utf-8");
          onEvent({ type: "file_written", relPath });
          return { ok: true, bytesWritten: Buffer.byteLength(content, "utf-8") };
        } catch (error) {
          return { ok: false, error: describeError(error, relPath) };
        }
      },
    }),

    edit_file: tool({
      description:
        "Reemplaza una porción exacta de un archivo existente. `oldStr` debe aparecer exactamente una vez en el archivo — si aparece cero o varias veces, la tool devuelve un error para que puedas ajustar el texto y reintentar.",
      inputSchema: z.object({
        path: z.string().describe("Ruta relativa al workspace."),
        oldStr: z.string().describe("Texto exacto a reemplazar (con contexto suficiente para ser único en el archivo)."),
        newStr: z.string().describe("Texto de reemplazo. Vacío para borrar oldStr."),
      }),
      execute: async ({ path: relPath, oldStr, newStr }) => {
        try {
          const abs = await resolveSafePath(workspaceRoot, relPath);
          const original = await fs.readFile(abs, "utf-8");

          // El modelo siempre escribe oldStr/newStr con \n puro — nunca \r\n,
          // ni aunque el archivo real lo tenga. En Windows (core.autocrlf)
          // el checkout real suele tener CRLF, así que cualquier oldStr que
          // cruce un salto de línea nunca matchearía comparando tal cual.
          // Matcheamos sobre versiones normalizadas a LF, y si el archivo
          // original era CRLF, devolvemos el resultado a CRLF al guardar —
          // así no cambiamos el estilo de fin de línea del archivo.
          const isCRLF = original.includes("\r\n");
          const normalizedOriginal = isCRLF ? original.replace(/\r\n/g, "\n") : original;
          const normalizedOldStr = oldStr.replace(/\r\n/g, "\n");
          const normalizedNewStr = newStr.replace(/\r\n/g, "\n");

          const occurrences = normalizedOriginal.split(normalizedOldStr).length - 1;
          if (occurrences === 0) {
            return { ok: false, error: `oldStr no se encontró en ${relPath}. Releé el archivo con read_file y ajustá el texto.` };
          }
          if (occurrences > 1) {
            return { ok: false, error: `oldStr aparece ${occurrences} veces en ${relPath} — agregá más contexto para que sea único.` };
          }
          const normalizedUpdated = normalizedOriginal.replace(normalizedOldStr, normalizedNewStr);
          const updated = isCRLF ? normalizedUpdated.replace(/\n/g, "\r\n") : normalizedUpdated;
          await fs.writeFile(abs, updated, "utf-8");
          onEvent({ type: "file_edited", relPath });
          return { ok: true };
        } catch (error) {
          return { ok: false, error: describeError(error, relPath) };
        }
      },
    }),

    search_files: tool({
      description: "Busca un texto literal (sin regex) en todos los archivos de texto del workspace. Devuelve hasta 60 coincidencias con archivo:línea y el texto de esa línea.",
      inputSchema: z.object({
        query: z.string().describe("Texto a buscar."),
        subPath: z.string().optional().describe("Limitar la búsqueda a esta subcarpeta relativa (opcional)."),
      }),
      execute: async ({ query, subPath }) => {
        try {
          const searchRoot = subPath ? await resolveSafePath(workspaceRoot, subPath) : workspaceRoot;
          const needle = query.toLowerCase();
          const matches: Array<{ path: string; line: number; text: string }> = [];
          await walkFiles(workspaceRoot, searchRoot, async (absPath) => {
            let text: string;
            try {
              const buf = await fs.readFile(absPath);
              if (buf.length > 1_000_000) return true; // saltamos archivos gigantes
              text = buf.toString("utf-8");
            } catch {
              return true;
            }
            const lines = text.split("\n");
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].toLowerCase().includes(needle)) {
                matches.push({ path: path.relative(workspaceRoot, absPath), line: i + 1, text: lines[i].trim().slice(0, 200) });
                if (matches.length >= MAX_SEARCH_RESULTS) return false;
              }
            }
            return true;
          });
          return { ok: true, matches, truncated: matches.length >= MAX_SEARCH_RESULTS };
        } catch (error) {
          return { ok: false, error: describeError(error, subPath ?? "") };
        }
      },
    }),

    run_typecheck: tool({
      description: "Corre `tsc --noEmit` sobre todo el workspace y devuelve si compila limpio o la lista de errores. Tarda unos segundos — usalo después de terminar los cambios, no en cada paso.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const { stdout, stderr } = await execFileAsync("npx", ["tsc", "--noEmit"], {
            cwd: workspaceRoot,
            maxBuffer: 16 * 1024 * 1024,
            timeout: 120_000,
          });
          const output = (stdout + stderr).trim();
          return { ok: true, success: true, output: output.slice(0, MAX_TYPECHECK_OUTPUT) };
        } catch (error) {
          const output = errorOutput(error).slice(0, MAX_TYPECHECK_OUTPUT);
          return { ok: true, success: false, output };
        }
      },
    }),
  };
}

function describeError(error: unknown, relPath: string): string {
  if (error instanceof UnsafePathError) return error.message;
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT") return `${relPath} no existe.`;
    if (code === "EISDIR") return `${relPath} es un directorio, no un archivo.`;
  }
  return error instanceof Error ? error.message : `Error desconocido al operar sobre ${relPath}.`;
}

function errorOutput(error: unknown): string {
  if (error && typeof error === "object") {
    const e = error as { stdout?: string; stderr?: string; message?: string };
    const combined = [e.stdout, e.stderr].filter(Boolean).join("\n").trim();
    if (combined) return combined;
    if (e.message) return e.message;
  }
  return "tsc falló sin salida capturable.";
}
