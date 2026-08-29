import { NextResponse } from "next/server";
import { getTask } from "@/lib/agent/task-store";
import { getProposalsForTask } from "@/lib/agent/proposal-store";
import { toFileProposal } from "@/lib/agent/proposal-adapter";

/** Fase 2H. Usa el adaptador puro de la Fase 2F (`toFileProposal`) — la UI
 * recibe el mismo shape de `FileProposal` para renderizar diffs, sin que
 * este endpoint tenga que reinventar ningún mapeo de campos. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: taskId } = await params;
  const task = getTask(taskId);
  if (!task) return NextResponse.json({ ok: false, error: `No existe la task ${taskId}.` }, { status: 404 });

  const proposals = getProposalsForTask(taskId).map((p) => ({
    ...toFileProposal(p, taskId),
    // Campos propios de `agent_proposals` que `FileProposal` (heredado del
    // agente viejo) no tiene lugar para guardar, pero la UI de 2H sí
    // necesita mostrar (si esta proposal puntual quedó aplicada o en
    // conflicto tras un intento de apply anterior).
    applied: p.applied,
    conflict: p.conflict,
  }));

  return NextResponse.json({ ok: true, proposals });
}
