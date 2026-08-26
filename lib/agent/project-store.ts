import { execFile } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import { getDb } from "../db";

const execFileAsync = promisify(execFile);

/**
 * Un proyecto externo sobre el que puede trabajar el Coding Agent.
 *
 * `sourceType` está tipado como unión con un solo valor hoy a propósito:
 * cuando se agregue soporte para repos Git remotos, se suma `"git-remote"`
 * acá (con sus propios campos, ej. `remoteUrl`) sin que `CodingTask`,
 * `AgentWorkspace` ni el loop del agente necesiten enterarse — todos reciben
 * un `localPath`/`repoRoot` ya resuelto, nunca les importa cuál `sourceType`
 * lo produjo. Ver diseño de Fase 2, sección 2.
 */
export type AgentProject = {
  id: string;
  name: string;
  sourceType: "local";
  localPath: string;
  /** Calculado una vez al agregar el proyecto (no lo declara el usuario) —
   * determina qué modo de workspace usa `createAgentWorkspace`: "worktree"
   * si es true, "copy" si es false (ver diseño de Fase 2, sección 14).
   * `true` exige no solo estar dentro de un working tree git sino que
   * además `HEAD` resuelva a un commit real — un repo con `git init` pero
   * sin ningún commit todavía cuenta como `false` (ver `detectIsGitRepo`). */
  isGitRepo: boolean;
  archived: boolean;
  createdAt: number;
  lastUsedAt: number;
};

type AgentProjectRow = {
  id: string;
  name: string;
  source_type: string;
  local_path: string;
  is_git_repo: number;
  archived: number;
  created_at: number;
  last_used_at: number;
};

function rowToProject(row: AgentProjectRow): AgentProject {
  return {
    id: row.id,
    name: row.name,
    sourceType: "local",
    localPath: row.local_path,
    isGitRepo: row.is_git_repo === 1,
    archived: row.archived === 1,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

/** Corre `git rev-parse --is-inside-work-tree` en `localPath`. No lanza si
 * no es un repo git (ni si `git` no está en el PATH) — en ambos casos el
 * proyecto simplemente no es un repo git válido para nuestros fines.
 *
 * También exige que `HEAD` resuelva a un commit real (`git rev-parse --verify
 * HEAD`): un repo recién creado con `git init` pero sin ningún commit
 * todavía SÍ es un working tree válido, pero no tiene un `HEAD` al que
 * `git worktree add ... HEAD` pueda apuntar — falla con "invalid reference:
 * HEAD". Para nuestros fines (armar un worktree en Fase 2A) eso no cuenta
 * como un repo git utilizable todavía. */
async function detectIsGitRepo(localPath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: localPath });
    if (stdout.trim() !== "true") return false;
    await execFileAsync("git", ["rev-parse", "--verify", "HEAD"], { cwd: localPath });
    return true;
  } catch {
    return false;
  }
}

/** Valida que `localPath` exista y sea un directorio antes de registrar el
 * proyecto — un `localPath` que no existe hoy va a fallar recién al primer
 * intento de crear un workspace, mucho más difícil de diagnosticar que un
 * error claro en el momento de agregarlo. */
async function assertIsDirectory(localPath: string): Promise<void> {
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(localPath);
  } catch {
    throw new Error(`La ruta no existe: ${localPath}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`La ruta no es una carpeta: ${localPath}`);
  }
}

export type CreateProjectInput = {
  name: string;
  localPath: string;
};

/** Registra un proyecto local nuevo. Calcula `isGitRepo` en el momento —
 * no se vuelve a preguntar en cada `CodingTask` posterior (se recalcula
 * solo si se llama `refreshIsGitRepo`, ej. si el usuario corre `git init`
 * después de agregar el proyecto). */
export async function createProject(input: CreateProjectInput): Promise<AgentProject> {
  const localPath = path.resolve(input.localPath);
  await assertIsDirectory(localPath);
  const isGitRepo = await detectIsGitRepo(localPath);

  const now = Date.now();
  const project: AgentProject = {
    id: crypto.randomUUID(),
    name: input.name.trim(),
    sourceType: "local",
    localPath,
    isGitRepo,
    archived: false,
    createdAt: now,
    lastUsedAt: now,
  };

  getDb()
    .prepare(
      `INSERT INTO agent_projects (id, name, source_type, local_path, is_git_repo, archived, created_at, last_used_at)
       VALUES (@id, @name, @sourceType, @localPath, @isGitRepo, @archived, @createdAt, @lastUsedAt)`,
    )
    .run({
      id: project.id,
      name: project.name,
      sourceType: project.sourceType,
      localPath: project.localPath,
      isGitRepo: project.isGitRepo ? 1 : 0,
      archived: project.archived ? 1 : 0,
      createdAt: project.createdAt,
      lastUsedAt: project.lastUsedAt,
    });

  return project;
}

export function getProject(id: string): AgentProject | null {
  const row = getDb().prepare("SELECT * FROM agent_projects WHERE id = ?").get(id) as AgentProjectRow | undefined;
  return row ? rowToProject(row) : null;
}

export function listProjects(opts?: { includeArchived?: boolean }): AgentProject[] {
  const where = opts?.includeArchived ? "" : "WHERE archived = 0";
  const rows = getDb()
    .prepare(`SELECT * FROM agent_projects ${where} ORDER BY last_used_at DESC`)
    .all() as AgentProjectRow[];
  return rows.map(rowToProject);
}

/** Se llama al arrancar una `CodingTask` sobre este proyecto — mantiene el
 * orden de "usados recientemente" en la futura UI de selección. */
export function touchProjectLastUsed(id: string): void {
  getDb().prepare("UPDATE agent_projects SET last_used_at = ? WHERE id = ?").run(Date.now(), id);
}

export function archiveProject(id: string): void {
  getDb().prepare("UPDATE agent_projects SET archived = 1 WHERE id = ?").run(id);
}

/** Recalcula `isGitRepo` contra el estado actual de `localPath` y lo
 * persiste. Útil si el usuario corrió `git init` en el proyecto después de
 * haberlo agregado a MAGI — `isGitRepo` no queda fijo para siempre. */
export async function refreshIsGitRepo(id: string): Promise<AgentProject | null> {
  const project = getProject(id);
  if (!project) return null;
  const isGitRepo = await detectIsGitRepo(project.localPath);
  getDb().prepare("UPDATE agent_projects SET is_git_repo = ? WHERE id = ?").run(isGitRepo ? 1 : 0, id);
  return { ...project, isGitRepo };
}
