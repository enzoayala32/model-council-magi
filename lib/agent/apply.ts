import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getTask, updateTaskFields } from "./task-store";
import { getProject } from "./project-store";
import { getProposalsForTask, markProposalApplied, markProposalConflict } from "./proposal-store";
import { destroyWorkspaceForTask, loadWorkspaceForTask, type TaskWorkspace } from "./workspace-manager";
import { resolveSafePath } from "./tools";
import { sha256 } from "./loop";
import { transitionAndLog } from "./runner";
import { appendEvent } from "./event-log";

const execFileAsync = promisify(execFile);

export type ApplyResult = {
  status: "APPLIED" | "READY_FOR_REVIEW";
  appliedPaths: string[];
  conflictedPaths: string[];
};

/** Fase 4D: intenta commitear `appliedPaths` en el worktree del agente
 * (`workspace.worktreePath`, NUNCA `project.localPath`) — best-effort, un
 * fallo acá nunca hace fallar el apply en sí (el archivo ya quedó escrito
 * en el proyecto real, eso es lo que importa; el commit es solo
 * trazabilidad). `git add -- <appliedPaths>` explícito, nunca `git add .`
 * (no se quiere arrastrar cambios sueltos ajenos que pudieran andar
 * dando vueltas en ese worktree). Autor/committer propios del agente vía
 * variables de entorno del proceso del commit — nunca se toca la config
 * git real del usuario (`git config user.name/email`). */
async function attemptGitCommit(
  taskId: string,
  workspace: TaskWorkspace,
  prompt: string,
  appliedPaths: string[],
): Promise<{ status: "success" | "failed"; sha?: string; error?: string }> {
  const promptExcerpt = prompt.slice(0, 72);
  const message = `agent: ${promptExcerpt}\n\nTask: ${taskId}\nFiles: ${appliedPaths.length}`;
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "Coding Agent (MAGI)",
    GIT_AUTHOR_EMAIL: "coding-agent@localhost",
    GIT_COMMITTER_NAME: "Coding Agent (MAGI)",
    GIT_COMMITTER_EMAIL: "coding-agent@localhost",
  };
  try {
    await execFileAsync("git", ["add", "--", ...appliedPaths], { cwd: workspace.worktreePath, env: gitEnv });
    await execFileAsync("git", ["commit", "-m", message], { cwd: workspace.worktreePath, env: gitEnv });
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: workspace.worktreePath, env: gitEnv });
    return { status: "success", sha: stdout.trim() };
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Flujo de APPLY de la Fase 2G (ver diseño de Fase 2, secciones 10 y 11):
 * aplicación granular por archivo contra `project.localPath` (el proyecto
 * real, NO el worktree del agente), re-chequeando `baseline_hash` archivo
 * por archivo en el momento exacto de aplicar. Nunca sobrescribe en
 * silencio: si el hash actual no matchea, esa proposal puntual queda
 * marcada en conflicto y no se toca ese archivo — las demás sí se aplican.
 *
 * Solo puede llamarse sobre una task en `READY_FOR_REVIEW` (lo exige
 * `transitionTask` al intentar pasar a `APPLYING`, vía `transitionAndLog`).
 * Reintentable: si una corrida previa dejó proposals en conflicto y
 * proposals ya aplicadas, esta función solo vuelve a intentar las que
 * todavía no se aplicaron (`applied === false`) — nunca reescribe una que
 * ya se aplicó, aunque la task vuelva a `READY_FOR_REVIEW → APPLYING`.
 */
export async function applyTask(taskId: string): Promise<ApplyResult> {
  const task = getTask(taskId);
  if (!task) throw new Error(`No existe la task ${taskId}.`);

  const project = getProject(task.projectId);
  if (!project) throw new Error(`No existe el Project ${task.projectId}.`);

  const pending = getProposalsForTask(taskId).filter((p) => !p.applied);
  if (pending.length === 0) {
    throw new Error(`La task ${taskId} no tiene proposals pendientes de aplicar (¿ya se aplicó todo, o nunca tuvo propuestas?).`);
  }

  // Única transición de status de esta función — valida sola que la task
  // esté en READY_FOR_REVIEW (rechaza con InvalidTaskTransitionError si no).
  transitionAndLog(taskId, "APPLYING");

  // Fase 4D: se carga UNA vez acá temprano — se reusa más abajo tanto para
  // el intento de commit como para el destroy final, evita un doble lookup
  // contra `agent_workspaces`.
  const workspace = loadWorkspaceForTask(taskId);

  const appliedPaths: string[] = [];
  const conflictedPaths: string[] = [];

  for (const proposal of pending) {
    let absPath: string;
    try {
      absPath = await resolveSafePath(project.localPath, proposal.relPath);
    } catch {
      // relPath vino de git status en un worktree ajeno — no debería poder
      // escaparse del proyecto real, pero si pasa por algún motivo raro
      // (symlink, etc.), se trata como conflicto: mejor bloquear ESE
      // archivo puntual que arriesgarse a escribir fuera de lugar.
      conflictedPaths.push(proposal.relPath);
      markProposalConflict(proposal.id);
      continue;
    }

    let currentContent = "";
    try {
      currentContent = await fs.readFile(absPath, "utf-8");
    } catch (error) {
      const isMissing = typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
      if (!isMissing) {
        // Error real (permisos, etc.) — no lo confundimos con "no existe".
        conflictedPaths.push(proposal.relPath);
        markProposalConflict(proposal.id);
        continue;
      }
      // Fase 4C: para "delete", un archivo que YA no existe es
      // exactamente el objetivo cumplido — a diferencia de write/edit, acá
      // no hay ningún riesgo de pisar nada ajeno al no hacer nada (borrar
      // algo que ya no está es un no-op por definición). Se marca aplicado
      // sin comparar hash ni tocar el filesystem, y se sigue con la
      // siguiente proposal.
      if (proposal.kind === "delete") {
        markProposalApplied(proposal.id);
        appliedPaths.push(proposal.relPath);
        continue;
      }
      // write/edit: currentContent queda "" — coincide exactamente con lo
      // que vale `baselineHash` para una proposal "write" nueva
      // (sha256("")), así que un archivo que nunca existió en el proyecto
      // real no es un conflicto por sí solo.
    }

    const currentHash = sha256(currentContent);
    if (currentHash !== proposal.baselineHash) {
      // Alguien (usuario u otro proceso) cambió este archivo en el
      // proyecto real después de que se armó la proposal — incluye el
      // caso de un "delete" cuyo archivo SÍ sigue existiendo pero con
      // contenido distinto al que tenía cuando se armó la proposal (no se
      // borra un cambio ajeno sin que un humano lo revise). No se escribe
      // nada acá — es exactamente el caso que esta fase existe para
      // prevenir.
      conflictedPaths.push(proposal.relPath);
      markProposalConflict(proposal.id);
      continue;
    }

    if (proposal.kind === "delete") {
      await fs.unlink(absPath);
    } else {
      await fs.mkdir(path.dirname(absPath), { recursive: true });
      await fs.writeFile(absPath, proposal.nextContent, "utf-8");
    }
    markProposalApplied(proposal.id);
    appliedPaths.push(proposal.relPath);
  }

  // Fase 4D: trazabilidad git del commit en el worktree — independiente de
  // si la ronda terminó con conflictos o no (un apply parcial también deja
  // rastro de lo que sí se aplicó). `!project.isGitRepo` deja los 4 campos
  // en `null` para siempre (nunca se tocan). Sin `workspace` no hay dónde
  // commitear (no debería pasar en operación normal, pero es defensivo).
  let gitCommitStatus: "success" | "failed" | "not_attempted" | null = null;
  if (project.isGitRepo && workspace) {
    if (appliedPaths.length === 0) {
      gitCommitStatus = "not_attempted";
      updateTaskFields(taskId, { gitCommitStatus });
      appendEvent(taskId, { type: "git_commit_result", status: "not_attempted", branch: workspace.branchName ?? "", files: [] });
    } else {
      const commitResult = await attemptGitCommit(taskId, workspace, task.prompt, appliedPaths);
      gitCommitStatus = commitResult.status;
      if (commitResult.status === "success") {
        updateTaskFields(taskId, {
          gitCommitStatus: "success",
          appliedCommitSha: commitResult.sha ?? null,
          appliedBranchName: workspace.branchName,
        });
        appendEvent(taskId, {
          type: "git_commit_result",
          status: "success",
          branch: workspace.branchName ?? "",
          files: appliedPaths,
          sha: commitResult.sha,
        });
      } else {
        updateTaskFields(taskId, { gitCommitStatus: "failed", gitCommitError: commitResult.error ?? null });
        appendEvent(taskId, {
          type: "git_commit_result",
          status: "failed",
          branch: workspace.branchName ?? "",
          files: appliedPaths,
          error: commitResult.error,
        });
      }
    }
  }

  // La rama `agent/<taskId>` se conserva si el commit de ESTA ronda salió
  // bien — el commit real que quedó ahí no se puede recuperar si se borra
  // la rama, así que se prioriza no perderlo por sobre limpiar el temp dir.
  const keepBranch = gitCommitStatus === "success";

  if (conflictedPaths.length === 0) {
    transitionAndLog(taskId, "APPLIED");
    if (workspace) await destroyWorkspaceForTask(workspace, { keepBranch });
    return { status: "APPLIED", appliedPaths, conflictedPaths };
  }

  // Vuelve a READY_FOR_REVIEW (no es un error de la task, es una decisión
  // que ahora le toca a un humano) — las proposals sin conflicto ya quedaron
  // aplicadas y NO se revierten (ver diseño, sección 10, paso 4). El
  // workspace del agente sigue vivo a propósito: el usuario puede necesitar
  // volver a mirar el diff original de los archivos en conflicto.
  transitionAndLog(
    taskId,
    "READY_FOR_REVIEW",
    { conflictedPaths },
    `conflicto al aplicar en ${conflictedPaths.length} archivo(s): ${conflictedPaths.join(", ")}`,
  );
  return { status: "READY_FOR_REVIEW", appliedPaths, conflictedPaths };
}
