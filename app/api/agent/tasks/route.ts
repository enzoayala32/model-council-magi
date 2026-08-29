import { NextResponse } from "next/server";
import { createTask, listTasks, type TaskStatus } from "@/lib/agent/task-store";
import { getProject, touchProjectLastUsed } from "@/lib/agent/project-store";
import { isCodingAgentEnabled } from "@/lib/models";
import { runTask } from "@/lib/agent/runner";

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
 * Crea una `CodingTask` en `QUEUED` y dispara `runTask` SIN esperarlo (ver
 * diseño de Fase 2, sección 9, paso 2: "responde inmediato"). El estado
 * real de la corrida se sigue después vía `GET /api/agent/tasks/[id]` o el
 * SSE de `/api/agent/tasks/[id]/events` — nunca dependiendo de que esta
 * request HTTP en particular siga abierta.
 *
 * `runTask` corriendo sin `await` acá significa que una excepción suya no
 * viaja como rechazo de esta promesa hacia ningún `try/catch` — pero
 * `runTask` ya maneja sus propios errores internamente (los deja en
 * `task.error` + status `FAILED`, ver `runner.ts`), así que no hay un error
 * no capturado real; el `.catch` de abajo es solo una red de seguridad para
 * el caso (no debería pasar) de que algo reviente ANTES de ese manejo
 * interno, para que no quede como un unhandled rejection silencioso.
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

  runTask(task.id).catch((error) => {
    console.error(`[Coding Agent] runTask(${task.id}) tiró sin que runner.ts lo haya capturado internamente:`, error);
  });

  return NextResponse.json({ ok: true, task }, { status: 201 });
}
