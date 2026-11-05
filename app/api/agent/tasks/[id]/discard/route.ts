import { NextResponse } from "next/server";
import { requireScope } from "@/lib/auth/authorize";
import { discardTask } from "@/lib/agent/runner";
import { InvalidTaskTransitionError } from "@/lib/agent/task-store";

/** Fase 2H. Solo válido desde `READY_FOR_REVIEW` — `transitionTask` (vía
 * `discardTask`) rechaza cualquier otro estado con 409. */
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
    const task = await discardTask(taskId, "user");
    return NextResponse.json({ ok: true, task });
  } catch (error) {
    if (error instanceof InvalidTaskTransitionError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 409 });
    }
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "No se pudo descartar la task." }, { status: 500 });
  }
}
