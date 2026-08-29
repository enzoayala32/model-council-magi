import { NextResponse } from "next/server";
import { applyTask } from "@/lib/agent/apply";
import { InvalidTaskTransitionError } from "@/lib/agent/task-store";

/**
 * Fase 2G: dispara el flujo de APPLY de una `CodingTask` (ver diseño de
 * Fase 2, sección 10). Delgado a propósito — toda la lógica vive en
 * `lib/agent/apply.ts`, testeable sin pasar por HTTP (mismo patrón que
 * `runTask` en `runner.ts`, Fase 2D).
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: taskId } = await params;

  try {
    const result = await applyTask(taskId);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof InvalidTaskTransitionError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 409 });
    }
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Error inesperado al aplicar la task." },
      { status: 500 },
    );
  }
}
