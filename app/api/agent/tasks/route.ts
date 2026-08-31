import { NextResponse } from "next/server";
import { createTask, listTasks, type TaskStatus } from "@/lib/agent/task-store";
import { getProject, touchProjectLastUsed } from "@/lib/agent/project-store";
import { isCodingAgentEnabled } from "@/lib/models";
import { maybeDispatchNext } from "@/lib/agent/dispatcher";

/** Fase 2H. `?projectId=` filtra por proyecto (lo que usa la UI para el
 * historial de un `Project`); sin filtro, devuelve todas las tasks. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const projectId = url.searchParams.get("projectId") ?? undefined;
  const status = (url.searchParams.get("status") as TaskStatus | null) ?? undefined;
  const tasks = listTasks({ projectId, status: status ?? undefined });
  return NextResponse.json({ ok: true, tasks });
}

/**
 * Crea una `CodingTask` en `QUEUED` y le avisa al dispatcher (Fase 3, ver
 * diseño sección 3) que ese proyecto tiene trabajo nuevo pendiente — sin
 * esperarlo (responde inmediato, ver diseño de Fase 2, sección 9, paso 2).
 * Si ya hay otra task `RUNNING` de este mismo proyecto, esta queda
 * simplemente esperando en `QUEUED` — `maybeDispatchNext` no hace nada en
 * ese caso, y el turno le llega solo apenas la que está corriendo termine.
 * El estado real se sigue después vía `GET /api/agent/tasks/[id]` o el SSE
 * de `/api/agent/tasks/[id]/events` — nunca dependiendo de que esta
 * request HTTP en particular siga abierta.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Body inválido: se esperaba JSON." }, { status: 400 });
  }

  const { projectId, modelId, prompt } = (body ?? {}) as { projectId?: unknown; modelId?: unknown; prompt?: unknown };
  if (typeof projectId !== "string" || !projectId || typeof modelId !== "string" || !modelId || typeof prompt !== "string" || !prompt.trim()) {
    return NextResponse.json({ ok: false, error: "Se requieren \"projectId\", \"modelId\" y \"prompt\" (string, no vacíos)." }, { status: 400 });
  }

  const project = getProject(projectId);
  if (!project) {
    return NextResponse.json({ ok: false, error: `No existe un Project con id "${projectId}".` }, { status: 404 });
  }

  // Ver diseño de Fase 2, sección 15: protege contra un cliente
  // desactualizado (o una llamada directa a la API) que mande un modelId
  // que existe en el Council pero nunca se validó para el Coding Agent.
  if (!isCodingAgentEnabled(modelId)) {
    return NextResponse.json({ ok: false, error: `El modelo "${modelId}" no está habilitado para el Coding Agent.` }, { status: 400 });
  }

  const task = createTask({ projectId, modelId, prompt });
  touchProjectLastUsed(projectId);

  maybeDispatchNext(projectId);

  return NextResponse.json({ ok: true, task }, { status: 201 });
}
