import { NextResponse } from "next/server";
import { requireScope } from "@/lib/auth/authorize";
import { cancelTask } from "@/lib/agent/runner";

/**
 * Fase 2H. Best-effort (ver `cancelTask` en `runner.ts`, Fase 2D): si no
 * hay una corrida activa en memoria para esta task en ESTE proceso (porque
 * ya terminó, o porque el server se reinició de por medio), no hay nada que
 * abortar — se responde `cancelled: false` en vez de un error, porque no
 * es una condición de error real, es un estado que ya no admite cancelación.
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

  const cancelled = cancelTask(taskId);
  return NextResponse.json({ ok: true, cancelled });
}
