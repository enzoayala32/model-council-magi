import { NextResponse } from "next/server";
import { getTask } from "@/lib/agent/task-store";
import {
  QUEUE_STATE_LABELS,
  cancelQueuedPrompt,
  enqueuePrompt,
  listQueuedPrompts,
  MAX_QUEUED_PROMPTS,
} from "@/lib/agent/prompt-queue";
import { guardRequest } from "@/lib/auth/guard";

/**
 * Cola de prompts de una task — pedido de Enzo (2026-11-10).
 *
 * POST   → encola un prompt (queda esperando a que el ciclo actual dé su
 *          resumen).
 * GET    → la cola completa, en orden de atención.
 * DELETE → cancela un prompt que TODAVÍA no empezó (`?id=`). Lo que el agente
 *          está atendiendo no se cancela desde acá: para eso está
 *          `/api/agent/tasks/:id/cancel`.
 *
 * Scope `operate`: encolar y cancelar cambian el estado de la task (el runner
 * actúa en consecuencia), así que no es lectura pura.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = guardRequest(request);
  if (denied) return denied;

  const { id } = await params;
  const task = getTask(id);
  if (!task) return NextResponse.json({ ok: false, error: `No existe la task ${id}.` }, { status: 404 });

  const prompts = listQueuedPrompts(id);
  return NextResponse.json({
    ok: true,
    taskStatus: task.status,
    maxQueued: MAX_QUEUED_PROMPTS,
    prompts: prompts.map((p) => ({
      id: p.id,
      prompt: p.prompt,
      position: p.position,
      state: p.state,
      stateLabel: QUEUE_STATE_LABELS[p.state],
      createdAt: p.createdAt,
      startedAt: p.startedAt,
    })),
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = guardRequest(request);
  if (denied) return denied;

  const { id } = await params;
  const task = getTask(id);
  if (!task) return NextResponse.json({ ok: false, error: `No existe la task ${id}.` }, { status: 404 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Body inválido: se esperaba JSON." }, { status: 400 });
  }
  const prompt = (body as { prompt?: unknown })?.prompt;
  if (typeof prompt !== "string" || !prompt.trim()) {
    return NextResponse.json({ ok: false, error: 'Se requiere "prompt" (string no vacío).' }, { status: 400 });
  }

  try {
    const encolado = enqueuePrompt(id, prompt);
    return NextResponse.json(
      {
        ok: true,
        prompt: { id: encolado.id, position: encolado.position, state: encolado.state },
        // Se devuelve la cola entera para que la UI no tenga que volver a
        // pedirla: encolar es la acción que más seguido se hace en cadena.
        prompts: listQueuedPrompts(id).map((p) => ({ id: p.id, prompt: p.prompt, position: p.position, state: p.state })),
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof Error && error.name === "QueueLlenaError") {
      return NextResponse.json({ ok: false, error: error.message }, { status: 409 });
    }
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = guardRequest(request);
  if (denied) return denied;

  const { id } = await params;
  const task = getTask(id);
  if (!task) return NextResponse.json({ ok: false, error: `No existe la task ${id}.` }, { status: 404 });

  const promptId = new URL(request.url).searchParams.get("id");
  if (!promptId) {
    return NextResponse.json({ ok: false, error: 'Falta "id" del prompt en la query.' }, { status: 400 });
  }

  const cancelado = cancelQueuedPrompt(promptId);
  if (!cancelado) {
    // 409 y no 404: el prompt existe pero ya está corriendo o terminado, y esa
    // distinción le importa al usuario (no es "no existe", es "ya es tarde").
    return NextResponse.json(
      { ok: false, error: "Ese prompt ya empezó o ya terminó: no se puede cancelar desde la cola." },
      { status: 409 },
    );
  }
  return NextResponse.json({ ok: true, prompts: listQueuedPrompts(id).map((p) => ({ id: p.id, state: p.state })) });
}
