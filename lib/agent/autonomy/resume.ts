/**
 * Fase 9E — reconciliación de workspace antes de reanudar una corrida.
 *
 * `evaluateResume` es PURA: recibe lo que ya se observó del filesystem/git y
 * devuelve un veredicto determinista. `inspectWorkspaceForResume` es la
 * única parte que toca disco/git, con dependencias inyectables para tests.
 *
 * Reglas del diseño §7.3:
 * - El worktree tiene que existir y ser el worktree esperado.
 * - `base_commit` tiene que ser ancestro de HEAD.
 * - Cada checkpoint se compara por sha256/tamaño; NUNCA se restaura ni se
 *   sobrescribe un archivo. Un hash distinto es drift; un archivo ausente
 *   es file_missing y su evidencia queda invalidada por el llamador.
 * - Los warnings solo llevan rutas relativas y hashes cortos: nunca
 *   contenido de archivos.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AutonomyBudget } from "./contract";
import type { FileCheckpoint } from "./ledger";

const execFileAsync = promisify(execFile);

/** Datos mínimos que el runner le pasa al dispatcher para reanudar. No
 * incluye mensajes, prompts ni contenido: solo ids, versión de plan,
 * HEAD verificado y warnings de reconciliación. */
export type ResumeContext = {
  ofRunId: string;
  planVersion: number;
  headCommit: string | null;
  attempt: number;
  warnings: string[];
  verifiedAt: number;
  /** Presupuesto consumido por la cadena de corridas anterior. La corrida
   * nueva lo continúa para que un restart no reinicie los límites. */
  budget: AutonomyBudget;
};

export type ResumeWarningCode = "workspace_drift" | "file_missing" | "head_commit_mismatch";

export type ResumeWarning = {
  code: ResumeWarningCode;
  message: string;
  path?: string;
};

export type ResumeFileStatus = "ok" | "drift" | "missing";

export type ResumeFileVerdict = {
  path: string;
  status: ResumeFileStatus;
  expectedSha256: string;
  actualSha256: string | null;
};

export type ResumeReason =
  | "ok"
  | "workspace_missing"
  | "workspace_mismatch"
  | "base_commit_mismatch";

export type ResumeVerdict = {
  resumable: boolean;
  reason: ResumeReason;
  warnings: ResumeWarning[];
  files: ResumeFileVerdict[];
  headCommit: string | null;
  verifiedAt: number;
};

export type ResumeProbeFile = {
  path: string;
  exists: boolean;
  isFile: boolean;
  sha256: string | null;
  size: number | null;
};

export type ResumeProbe = {
  worktreeExists: boolean;
  worktreeIsDirectory: boolean;
  worktreeToplevel: string | null;
  repoExists: boolean;
  repoIsDirectory: boolean;
  repoToplevel: string | null;
  head: string | null;
  /** `true`/`false` según `git merge-base --is-ancestor`; `null` si no se
   * pudo determinar (git falló, no hay base, etc.). */
  baseIsAncestor: boolean | null;
  files: ResumeProbeFile[];
};

export type EvaluateResumeInput = {
  worktreePath: string;
  repoRoot: string;
  baseCommit: string | null;
  checkpointHead: string | null;
  checkpoints: Array<Pick<FileCheckpoint, "path" | "sha256" | "size">>;
  probe: ResumeProbe;
  now?: () => number;
};

function normalizeForCompare(value: string): string {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function samePath(a: string, b: string): boolean {
  return normalizeForCompare(a) === normalizeForCompare(b);
}

function shortSha(value: string | null): string {
  return value ? value.slice(0, 12) : "(desconocido)";
}

/**
 * Evalúa si un workspace es reanudable. No hace I/O: todo viene en `probe`.
 * Un workspace con drift sigue siendo reanudable (con warnings) para que el
 * modelo inspeccione/replanifique; un workspace ausente o con otra línea
 * base no lo es.
 */
export function evaluateResume(input: EvaluateResumeInput): ResumeVerdict {
  const verifiedAt = input.now ? input.now() : Date.now();
  const warnings: ResumeWarning[] = [];
  const files: ResumeFileVerdict[] = [];
  const fail = (reason: ResumeReason): ResumeVerdict => ({
    resumable: false,
    reason,
    warnings,
    files,
    headCommit: input.probe.head,
    verifiedAt,
  });

  if (!input.probe.worktreeExists || !input.probe.worktreeIsDirectory) {
    return fail("workspace_missing");
  }

  if (!input.probe.worktreeToplevel || !samePath(input.probe.worktreeToplevel, input.worktreePath)) {
    return fail("workspace_mismatch");
  }

  // El repo base tiene que seguir siendo el mismo. Si el proyecto se movió
  // o el worktree quedó apuntando a otro repo, reanudar sería peligroso.
  if (!input.probe.repoExists || !input.probe.repoIsDirectory) {
    return fail("workspace_mismatch");
  }
  if (!input.probe.repoToplevel || !samePath(input.probe.repoToplevel, input.repoRoot)) {
    return fail("workspace_mismatch");
  }

  if (!input.probe.head) return fail("workspace_mismatch");

  if (input.baseCommit && input.probe.baseIsAncestor !== true) {
    return fail("base_commit_mismatch");
  }

  if (input.checkpointHead && input.probe.head !== input.checkpointHead) {
    warnings.push({
      code: "head_commit_mismatch",
      message: `HEAD del workspace (${shortSha(input.probe.head)}) no coincide con el checkpoint (${shortSha(input.checkpointHead)}); revisá si hubo cambios externos.`,
    });
  }

  for (const checkpoint of input.checkpoints) {
    const observed = input.probe.files.find((file) => file.path === checkpoint.path);
    if (!observed || !observed.exists || !observed.isFile) {
      files.push({
        path: checkpoint.path,
        status: "missing",
        expectedSha256: checkpoint.sha256,
        actualSha256: null,
      });
      warnings.push({
        code: "file_missing",
        path: checkpoint.path,
        message: `El archivo ${checkpoint.path} ya no existe; la evidencia que lo referencia queda invalidada.`,
      });
      continue;
    }

    if (observed.sha256 !== checkpoint.sha256 || observed.size !== checkpoint.size) {
      files.push({
        path: checkpoint.path,
        status: "drift",
        expectedSha256: checkpoint.sha256,
        actualSha256: observed.sha256,
      });
      warnings.push({
        code: "workspace_drift",
        path: checkpoint.path,
        message: `El archivo ${checkpoint.path} cambió desde el checkpoint (hash/tamaño distinto); no se sobrescribe.`,
      });
      continue;
    }

    files.push({
      path: checkpoint.path,
      status: "ok",
      expectedSha256: checkpoint.sha256,
      actualSha256: observed.sha256,
    });
  }

  return {
    resumable: true,
    reason: "ok",
    warnings,
    files,
    headCommit: input.probe.head,
    verifiedAt,
  };
}

export type ResumeIo = {
  stat(target: string): Promise<{ isDirectory: boolean; isFile: boolean; size: number } | null>;
  readFile(target: string): Promise<Buffer>;
  git(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string; code: number | null }>;
  now?: () => number;
};

const defaultIo: ResumeIo = {
  async stat(target) {
    try {
      const stat = await fs.stat(target);
      return { isDirectory: stat.isDirectory(), isFile: stat.isFile(), size: stat.size };
    } catch {
      return null;
    }
  },
  async readFile(target) {
    return fs.readFile(target);
  },
  async git(cwd, args) {
    try {
      const { stdout } = await execFileAsync("git", args, { cwd, timeout: 5_000, maxBuffer: 4 * 1024 * 1024 });
      return { ok: true, stdout: stdout.trim(), code: 0 };
    } catch (error) {
      const code = (error as { code?: number | string }).code;
      return {
        ok: false,
        stdout: "",
        code: typeof code === "number" ? code : typeof code === "string" && /^\d+$/.test(code) ? Number(code) : null,
      };
    }
  },
};

function resolveInside(root: string, relPath: string): string | null {
  const absoluteRoot = path.resolve(root);
  const absolute = path.resolve(absoluteRoot, relPath);
  const relative = path.relative(absoluteRoot, absolute);
  if (relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return absolute;
}

async function hashFile(io: ResumeIo, target: string): Promise<{ sha256: string; size: number } | null> {
  try {
    const buffer = await io.readFile(target);
    return {
      sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
      size: buffer.length,
    };
  } catch {
    return null;
  }
}

/**
 * Observa el filesystem/git real y devuelve el veredicto. Best-effort: un
 * error de git no se propaga como excepción, se traduce a un veredicto no
 * reanudable (salvo que el worktree no exista, que tiene su propio motivo).
 */
export async function inspectWorkspaceForResume(input: {
  worktreePath: string;
  repoRoot: string;
  baseCommit: string | null;
  checkpointHead: string | null;
  checkpoints: Array<Pick<FileCheckpoint, "path" | "sha256" | "size">>;
  io?: Partial<ResumeIo>;
}): Promise<ResumeVerdict> {
  const io: ResumeIo = { ...defaultIo, ...input.io };
  const worktreeStat = await io.stat(input.worktreePath);
  const repoStat = await io.stat(input.repoRoot);

  let worktreeToplevel: string | null = null;
  let repoToplevel: string | null = null;
  let head: string | null = null;
  let baseIsAncestor: boolean | null = null;

  if (worktreeStat?.isDirectory) {
    const top = await io.git(input.worktreePath, ["rev-parse", "--show-toplevel"]);
    if (top.ok && top.stdout) worktreeToplevel = top.stdout;

    const headResult = await io.git(input.worktreePath, ["rev-parse", "HEAD"]);
    if (headResult.ok && headResult.stdout) head = headResult.stdout;

    if (input.baseCommit && head) {
      const ancestor = await io.git(input.worktreePath, ["merge-base", "--is-ancestor", input.baseCommit, head]);
      if (ancestor.ok) baseIsAncestor = true;
      else if (ancestor.code === 1) baseIsAncestor = false;
    }
  }

  if (repoStat?.isDirectory) {
    const top = await io.git(input.repoRoot, ["rev-parse", "--show-toplevel"]);
    if (top.ok && top.stdout) repoToplevel = top.stdout;
  }

  const files: ResumeProbeFile[] = [];
  for (const checkpoint of input.checkpoints) {
    const absolute = resolveInside(input.worktreePath, checkpoint.path);
    if (!absolute) {
      files.push({ path: checkpoint.path, exists: false, isFile: false, sha256: null, size: null });
      continue;
    }
    const stat = await io.stat(absolute);
    if (!stat || !stat.isFile) {
      files.push({ path: checkpoint.path, exists: Boolean(stat), isFile: false, sha256: null, size: stat?.size ?? null });
      continue;
    }
    const hashed = await hashFile(io, absolute);
    files.push({
      path: checkpoint.path,
      exists: true,
      isFile: true,
      sha256: hashed?.sha256 ?? null,
      size: hashed?.size ?? stat.size,
    });
  }

  return evaluateResume({
    worktreePath: input.worktreePath,
    repoRoot: input.repoRoot,
    baseCommit: input.baseCommit,
    checkpointHead: input.checkpointHead,
    checkpoints: input.checkpoints,
    probe: {
      worktreeExists: Boolean(worktreeStat),
      worktreeIsDirectory: Boolean(worktreeStat?.isDirectory),
      worktreeToplevel,
      repoExists: Boolean(repoStat),
      repoIsDirectory: Boolean(repoStat?.isDirectory),
      repoToplevel,
      head,
      baseIsAncestor,
      files,
    },
    now: io.now,
  });
}

/** Rutas con drift o ausentes — el llamador las usa para invalidar
 * evidencia de items DONE sin tocar el contenido del archivo. */
export function resumeAffectedPaths(verdict: ResumeVerdict): { drifted: string[]; missing: string[] } {
  return {
    drifted: verdict.files.filter((file) => file.status === "drift").map((file) => file.path).sort(),
    missing: verdict.files.filter((file) => file.status === "missing").map((file) => file.path).sort(),
  };
}
