import { NextResponse } from "next/server";
import { getProject, archiveProject } from "@/lib/agent/project-store";
import { listTasks } from "@/lib/agent/task-store";

/** Archiva un proyecto (botón "🗑" en el sidebar de `/agent`) — nunca lo
 * borra de verdad: `archiveProject` solo pone `archived=1`, y
 * `listProjects()` ya lo excluye del listado por default (Fase 2A). Esto
 * es intencional: los `agent_tasks`/`agent_events`/`agent_proposals` de
 * ese proyecto siguen existiendo en la base (a diferencia del `DELETE` de
 * una task individual, que sí borra todo su rastro) — archivar un
 * proyecto es reversible sin perder ningún historial; no hay endpoint
 * para desarchivar todavía porque la UI no lo necesitó hasta ahora.
 *
 * 409 si tiene alguna task QUEUED o RUNNING — igual que el `DELETE` de
 * tasks, nunca se esconde un proyecto que un proceso real puede estar
 * tocando ahora mismo. */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = getProject(id);
  if (!project) return NextResponse.json({ ok: false, error: `No existe el proyecto ${id}.` }, { status: 404 });

  const activeTasks = listTasks({ projectId: id }).filter((t) => t.status === "QUEUED" || t.status === "RUNNING");
  if (activeTasks.length > 0) {
    return NextResponse.json({ ok: false, error: `Este proyecto tiene ${activeTasks.length} task(s) todavía en curso (QUEUED/RUNNING) — esperá a que terminen antes de archivarlo.` }, { status: 409 });
  }

  archiveProject(id);
  return NextResponse.json({ ok: true });
}
