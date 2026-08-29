import type { FileProposal } from "../fs-tools";
import type { PersistedProposal } from "./proposal-store";

/**
 * Adaptador puro de la Fase 2F (ver diseño de Fase 2, sección 6): convierte
 * una `PersistedProposal` (`agent_proposals`, propia del Coding Agent) al
 * mismo `FileProposal` que ya consume `FileProposalsPanel`/`DiffView`/
 * `TypeCheckBadge` del agente de archivos viejo (`lib/fs-tools.ts`) — la UI
 * no aprende un tipo nuevo. Sin estado, sin I/O, mapeo campo a campo.
 *
 * `taskId` se usa como `groupId`: el panel viejo ya sabe agrupar proposals
 * por `groupId` para ofrecer "aplicar todo"/"descartar todo", y acá cada
 * grupo es exactamente una `CodingTask` — coincide sin inventar nada nuevo.
 * Es también la pista que necesita el frontend para saber que el endpoint
 * de apply de ESTA proposal no es `/api/council/apply-file-change` (el del
 * agente de archivos viejo, fijo a `AGENT_FS_ROOT`=MAGI) sino el propio del
 * Coding Agent (Fase 2G).
 *
 * `absPath` es un placeholder deliberado (igual a `relPath`): el repoRoot
 * real vive en `agent_workspaces`, no en la proposal, y este adaptador se
 * mantiene puro a propósito (sin ir a buscarlo a la base) — el endpoint de
 * apply de 2G va a resolver la ruta real contra el workspace/proyecto por
 * su cuenta, no confiando en este campo. `createdAt` tampoco existe en
 * `agent_proposals` (no hizo falta persistirlo) — se usa `Date.now()` como
 * el momento en que se pide la conversión, no el de creación real.
 */
export function toFileProposal(proposal: PersistedProposal, taskId: string): FileProposal {
  return {
    id: proposal.id,
    groupId: taskId,
    kind: proposal.kind,
    relPath: proposal.relPath,
    absPath: proposal.relPath,
    diff: proposal.diff,
    nextContent: proposal.nextContent,
    createdAt: Date.now(),
    typeCheck: { status: proposal.typecheckStatus },
  };
}
