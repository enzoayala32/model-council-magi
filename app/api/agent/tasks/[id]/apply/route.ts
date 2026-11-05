import { NextResponse } from "next/server";
import { requireScope } from "@/lib/auth/authorize";
import { applyTask } from "@/lib/agent/apply";
import { InvalidTaskTransitionError } from "@/lib/agent/task-store";

/**
 * Fase 2G: dispara el flujo de APPLY de una `CodingTask` (ver diseño de
 * Fase 2, sección 10). Delgado a propósito — toda la lógica vive en
 * `lib/agent/apply.ts`, testeable sin pasar por HTTP (mismo patrón que
 * `runTask` en `runner.ts`, Fase 2D).
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: taskId } = await params;
  // Fase 4b: autorizacion central por scope. Desde loopback sin credencial
  // configurada pasa igual que siempre (uso local); desde un dispositivo
  // remoto exige el scope de la ruta.
  const guard = requireScope({ method: "POST", pathname: new URL(request.url).pathname, request });
  if (!guard.ok) {
    return NextResponse.json({ ok: false, error: guard.error, reason: guard.reason }, { status: guard.status });
  }


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
