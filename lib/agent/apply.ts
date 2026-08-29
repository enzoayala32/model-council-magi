import fs from "node:fs/promises";
import path from "node:path";
import { getTask } from "./task-store";
import { getProject } from "./project-store";
import { getProposalsForTask, markProposalApplied, markProposalConflict } from "./proposal-store";
import { destroyWorkspaceForTask, loadWorkspaceForTask } from "./workspace-manager";
import { resolveSafePath } from "./tools";
import { sha256 } from "./loop";
import { transitionAndLog } from "./runner";

export type ApplyResult = {
  status: "APPLIED" | "READY_FOR_REVIEW";
  appliedPaths: string[];
  conflictedPaths: string[];
};

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
      // ENOENT: currentContent queda "" — coincide exactamente con lo que
      // vale `baselineHash` para una proposal "write" nueva (sha256("")),
      // así que un archivo que nunca existió en el proyecto real no es un
      // conflicto por sí solo.
    }

    const currentHash = sha256(currentContent);
    if (currentHash !== proposal.baselineHash) {
      // Alguien (usuario u otro proceso) cambió este archivo en el
      // proyecto real después de que se armó la proposal. No se escribe
      // nada acá — es exactamente el caso que esta fase existe para
      // prevenir.
      conflictedPaths.push(proposal.relPath);
      markProposalConflict(proposal.id);
      continue;
    }

    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, proposal.nextContent, "utf-8");
    markProposalApplied(proposal.id);
    appliedPaths.push(proposal.relPath);
  }

  if (conflictedPaths.length === 0) {
    transitionAndLog(taskId, "APPLIED");
    const workspace = loadWorkspaceForTask(taskId);
    if (workspace) await destroyWorkspaceForTask(workspace);
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
