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

/** Raíz del repo git real que contiene `cwd` (donde vive `.git`), no
 * `AGENT_FS_ROOT`. Sigue existiendo como utilidad standalone (la usa
 * `test-run.ts` para probar el agente contra el propio repo de MAGI sin
 * pasar por la abstracción `Project`) pero `createAgentWorkspace` ya NO la
 * llama internamente — a partir de Fase 2A recibe `repoRoot` explícito,
 * resuelto por quien la invoque (típicamente `project.localPath` para
 * proyectos git, ver `lib/agent/project-store.ts`). Esto es lo que permite
 * que el Coding Agent trabaje sobre cualquier proyecto externo, no solo
 * sobre MAGI. */
export async function getRepoRoot(cwd: string = process.cwd()): Promise<string> {
  const { stdout } = await run(cwd, "git", ["rev-parse", "--show-toplevel"]);
  return stdout.trim();
}

/** SHA de `HEAD` en `repoRoot` — usado como `baseCommit` de la task (ver
 * diseño de Fase 2, sección 13: detección de conflictos al aplicar). Solo
 * tiene sentido en modo `"worktree"` — en modo `"copy"` no hay git de por
 * medio, el chequeo de conflictos usa un snapshot de hashes en su lugar. */
export async function getHeadCommit(repoRoot: string): Promise<string> {
  const { stdout } = await run(repoRoot, "git", ["rev-parse", "HEAD"]);
  return stdout.trim();
}

/**
 * Crea un worktree git nuevo y aislado, en una rama descartable
 * (`agent/<taskId>`), a partir de HEAD de `repoRoot`. El Coding Agent
 * trabaja exclusivamente dentro de `worktreePath` — nunca toca el checkout
 * principal del usuario mientras itera.
 *
 * `repoRoot` es la raíz real del proyecto objetivo (`AgentProject.localPath`
 * cuando `isGitRepo` es true) — nunca se asume `process.cwd()`. Para
 * proyectos que NO son un repo git, no se usa esta función: ver el modo
 * `"copy"` que se suma en Fase 2C.
 */
export async function createAgentWorkspace(taskId: string, repoRoot: string): Promise<AgentWorkspace> {
  const worktreePath = path.join(WORKSPACE_ROOT, taskId);
  const branchName = `agent/${taskId}`;

  await fs.mkdir(WORKSPACE_ROOT, { recursive: true });
  await run(repoRoot, "git", ["worktree", "add", "-b", branchName, worktreePath, "HEAD"]);

  // `git worktree` no copia node_modules (está en .gitignore) — sin esto,
  // `run_typecheck` correría contra un tsc "pelado" sin @types/* ni el
  // resto de las dependencias, y el veredicto no serviría de nada.
  // Symlink, no copia: son las mismas dependencias, no hace falta duplicar.
  // En Windows, un symlink de directorio ("dir") requiere modo Desarrollador
  // o una consola elevada — una "junction" (NTFS) no necesita ninguno de
  // los dos, así que la usamos ahí en vez de pelear con permisos.
  const nodeModulesPath = path.join(repoRoot, "node_modules");
  const hasNodeModules = await fs.stat(nodeModulesPath).then(() => true).catch(() => false);
  if (hasNodeModules) {
    const symlinkType = process.platform === "win32" ? "junction" : "dir";
    try {
      await fs.symlink(nodeModulesPath, path.join(worktreePath, "node_modules"), symlinkType);
    } catch (error) {
      // No lo tragamos en silencio: sin esto, run_typecheck va a fallar con
      // errores confusos y sin relación con el cambio real del agente.
      console.warn(
        `[coding-agent] No se pudo enlazar node_modules al workspace (${error instanceof Error ? error.message : error}). ` +
          `run_typecheck puede fallar con errores que no tienen que ver con el cambio real.`,
      );
    }
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
 * Copia un proyecto que NO es un repo git (o que tiene git pero sin ningún
 * commit todavía, ver `detectIsGitRepo`) a una carpeta temporal aislada.
 * Es el equivalente de `createAgentWorkspace` para el modo `"copy"` —
 * la garantía que importa ("el agente nunca toca el proyecto real mientras
 * trabaja") se cumple igual que con un worktree, solo que sin depender de
 * git para lograrlo (ver diseño de Fase 2, sección 14).
 *
 * No copia `.git` (por si el directorio tiene git sin commits — no tiene
 * sentido arrastrar un repo a medio inicializar) ni `node_modules` (se
 * enlaza con symlink/junction, igual que en el modo worktree, para no
 * duplicar dependencias pesadas).
 */
export async function createCopyWorkspace(taskId: string, basePath: string): Promise<AgentWorkspace> {
  const worktreePath = path.join(WORKSPACE_ROOT, taskId);
  await fs.mkdir(WORKSPACE_ROOT, { recursive: true });

  await fs.cp(basePath, worktreePath, {
    recursive: true,
    filter: (source) => {
      const base = path.basename(source);
      return base !== ".git" && base !== "node_modules";
    },
  });

  const nodeModulesPath = path.join(basePath, "node_modules");
  const hasNodeModules = await fs.stat(nodeModulesPath).then(() => true).catch(() => false);
  if (hasNodeModules) {
    const symlinkType = process.platform === "win32" ? "junction" : "dir";
    try {
      await fs.symlink(nodeModulesPath, path.join(worktreePath, "node_modules"), symlinkType);
    } catch (error) {
      console.warn(
        `[coding-agent] No se pudo enlazar node_modules al workspace (${error instanceof Error ? error.message : error}). ` +
          `run_typecheck puede fallar con errores que no tienen que ver con el cambio real.`,
      );
    }
  }

  // `branchName`/`repoRoot` no aplican en modo copy (no hay git de por
  // medio) — se dejan en `""`/`basePath` respectivamente; el wrapper de
  // `workspace-manager.ts` es quien persiste el registro completo con el
  // campo `mode`. Esta función de bajo nivel devuelve solo lo que necesita
  // para funcionar como copia física.
  return { taskId, worktreePath, branchName: "", repoRoot: basePath, createdAt: Date.now() };
}

/** Elimina la copia física de un workspace en modo `"copy"`. A diferencia
 * de `destroyAgentWorkspace` no hay ningún comando git que correr — es un
 * `rm -rf` directo sobre `worktreePath`, nunca sobre `basePath`. */
export async function destroyCopyWorkspace(workspace: Pick<AgentWorkspace, "worktreePath">): Promise<void> {
  await fs.rm(workspace.worktreePath, { recursive: true, force: true }).catch(() => {});
}

/**
 * Barrido de arranque: elimina worktrees de corridas previas del agente
 * que quedaron colgadas (crash del server, TTL vencido) sin que nadie
 * las haya limpiado. Se llama una vez al iniciar el server (o al empezar
 * el script de prueba), nunca en medio de una corrida activa.
 *
 * LIMITACIÓN CONOCIDA (Fase 2A): recibe un solo `repoRoot` porque hoy no
 * hay todavía una tabla `agent_workspaces` persistida que diga a qué
 * proyecto pertenece cada `taskId` huérfano bajo `WORKSPACE_ROOT` — eso
 * llega en Fase 2C. Hasta entonces, este barrido solo puede limpiar
 * worktrees huérfanos del `repoRoot` que se le pase (por ahora, el propio
 * repo de MAGI vía `test-run.ts`); worktrees huérfanos de otros proyectos
 * quedan sin barrer hasta 2C.
 */
export async function sweepOrphanedWorkspaces(repoRoot: string): Promise<{ swept: string[] }> {
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
