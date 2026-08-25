import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const execFileAsync = promisify(execFile);

/** Mismo TTL que usa `lib/fs-tools.ts` para propuestas de archivo — un
 * workspace huérfano (crash del server, cliente que nunca aplicó/descartó)
 * se limpia solo después de este tiempo. */
export const WORKSPACE_TTL_MS = 30 * 60_000;

const WORKSPACE_ROOT = path.join(os.tmpdir(), "consenso-ia-agent-workspaces");

export type AgentWorkspace = {
  taskId: string;
  worktreePath: string;
  branchName: string;
  repoRoot: string;
  createdAt: number;
};

async function run(cwd: string, command: string, args: string[]) {
  return execFileAsync(command, args, { cwd, maxBuffer: 16 * 1024 * 1024 });
}

/** Raíz del repo git real (donde vive `.git`), no `AGENT_FS_ROOT`. */
export async function getRepoRoot(): Promise<string> {
  const { stdout } = await run(process.cwd(), "git", ["rev-parse", "--show-toplevel"]);
  return stdout.trim();
}

/**
 * Crea un worktree git nuevo y aislado, en una rama descartable
 * (`agent/<taskId>`), a partir de HEAD. El Coding Agent trabaja
 * exclusivamente dentro de `worktreePath` — nunca toca el checkout
 * principal del usuario mientras itera.
 */
export async function createAgentWorkspace(taskId: string): Promise<AgentWorkspace> {
  const repoRoot = await getRepoRoot();
  const worktreePath = path.join(WORKSPACE_ROOT, taskId);
  const branchName = `agent/${taskId}`;

  await fs.mkdir(WORKSPACE_ROOT, { recursive: true });
  await run(repoRoot, "git", ["worktree", "add", "-b", branchName, worktreePath, "HEAD"]);

  // `git worktree` no copia node_modules (está en .gitignore) — sin esto,
  // `run_typecheck` correría contra un tsc "pelado" sin @types/* ni el
  // resto de las dependencias, y el veredicto no serviría de nada.
  // Symlink, no copia: son las mismas dependencias, no hace falta duplicar.
  const nodeModulesPath = path.join(repoRoot, "node_modules");
  const hasNodeModules = await fs.stat(nodeModulesPath).then(() => true).catch(() => false);
  if (hasNodeModules) {
    await fs.symlink(nodeModulesPath, path.join(worktreePath, "node_modules"), "dir").catch(() => {
      // Best-effort — si falla (ej. ya existe), run_typecheck simplemente va a fallar más claro después.
    });
  }

  return { taskId, worktreePath, branchName, repoRoot, createdAt: Date.now() };
}

/** Elimina el worktree y su rama descartable. Best-effort: si `git worktree
 * remove` falla (por ej. el directorio ya no existe), cae a un `rm -rf`
 * directo para no dejar basura en el temp dir. */
export async function destroyAgentWorkspace(workspace: Pick<AgentWorkspace, "worktreePath" | "branchName" | "repoRoot">): Promise<void> {
  try {
    await run(workspace.repoRoot, "git", ["worktree", "remove", "--force", workspace.worktreePath]);
  } catch {
    await fs.rm(workspace.worktreePath, { recursive: true, force: true }).catch(() => {});
    await run(workspace.repoRoot, "git", ["worktree", "prune"]).catch(() => {});
  }
  await run(workspace.repoRoot, "git", ["branch", "-D", workspace.branchName]).catch(() => {
    // La rama puede no existir más si el worktree nunca se llegó a crear del todo — no es un error real.
  });
}

/**
 * Barrido de arranque: elimina worktrees de corridas previas del agente
 * que quedaron colgadas (crash del server, TTL vencido) sin que nadie
 * las haya limpiado. Se llama una vez al iniciar el server (o al empezar
 * el script de prueba), nunca en medio de una corrida activa.
 */
export async function sweepOrphanedWorkspaces(): Promise<{ swept: string[] }> {
  const repoRoot = await getRepoRoot();
  const swept: string[] = [];

  let entries: string[] = [];
  try {
    entries = await fs.readdir(WORKSPACE_ROOT);
  } catch {
    return { swept };
  }

  const { stdout } = await run(repoRoot, "git", ["worktree", "list", "--porcelain"]).catch(() => ({ stdout: "" }));
  const registeredWorktreePaths = new Set(
    stdout
      .split("\n\n")
      .map((block) => block.match(/^worktree (.+)$/m)?.[1])
      .filter((p): p is string => Boolean(p)),
  );

  for (const taskId of entries) {
    const worktreePath = path.join(WORKSPACE_ROOT, taskId);
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(worktreePath);
    } catch {
      continue;
    }
    const expired = Date.now() - stat.mtimeMs > WORKSPACE_TTL_MS;
    if (!expired) continue;

    if (registeredWorktreePaths.has(worktreePath)) {
      await destroyAgentWorkspace({ worktreePath, branchName: `agent/${taskId}`, repoRoot }).catch(() => {});
    } else {
      await fs.rm(worktreePath, { recursive: true, force: true }).catch(() => {});
    }
    swept.push(taskId);
  }

  return { swept };
}
