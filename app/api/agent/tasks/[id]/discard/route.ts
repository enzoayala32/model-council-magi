import { NextResponse } from "next/server";
import { discardTask } from "@/lib/agent/runner";
import { InvalidTaskTransitionError } from "@/lib/agent/task-store";

/** Fase 2H. Solo válido desde `READY_FOR_REVIEW` — `transitionTask` (vía
 * `discardTask`) rechaza cualquier otro estado con 409. */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: taskId } = await params;
  try {
    const task = await discardTask(taskId, "user");
    return NextResponse.json({ ok: true, task });
  } catch (error) {
    if (error instanceof InvalidTaskTransitionError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 409 });
    }
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "No se pudo descartar la task." }, { status: 500 });
  }
}
