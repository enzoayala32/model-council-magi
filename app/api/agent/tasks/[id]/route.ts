import { NextResponse } from "next/server";
import { getTask, TaskNotTerminalError } from "@/lib/agent/task-store";
import { deleteTask } from "@/lib/agent/runner";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = getTask(id);
  if (!task) return NextResponse.json({ ok: false, error: `No existe la task ${id}.` }, { status: 404 });
  return NextResponse.json({ ok: true, task });
}

/** Borra una task terminada (botón "eliminar" en la UI, Fase posterior a
 * la 3). 409 si todavía está activa — nunca se borra algo que un proceso
 * real puede estar tocando, o que el usuario todavía puede necesitar
 * revisar. */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = getTask(id);
  if (!task) return NextResponse.json({ ok: false, error: `No existe la task ${id}.` }, { status: 404 });

  try {
    await deleteTask(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof TaskNotTerminalError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 409 });
    }
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "No se pudo eliminar la task." }, { status: 500 });
  }
}
