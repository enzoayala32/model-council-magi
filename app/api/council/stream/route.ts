import { NextResponse } from "next/server";
import { readJsonBody } from "@/lib/api-json";
import { requireScope } from "@/lib/auth/authorize";
import { runCouncilStream } from "@/lib/council-orchestrator";
import { createCouncilRunRecorder } from "@/lib/council-run-store";
import { logStep } from "@/lib/council-run";
import type { StreamEvent, StreamRequest } from "@/lib/council-types";
import { redactSecrets } from "@/lib/provider-resilience/redact";

/**
 * Plomería HTTP del consejo: parsea el body, abre el SSE y delega el pipeline
 * completo a `runCouncilStream` (lib/council-orchestrator.ts). La orquestación
 * vive ahí para poder testearla con un proveedor falso; acá no hay lógica de
 * negocio.
 */

export const maxDuration = 300;

export async function POST(request: Request) {
  // Fase 1: parsear antes de abrir el SSE. Un body inválido debe ser un
  // 400 JSON normal, no un stream 200 que recién falla adentro.
  const parsed = await readJsonBody<StreamRequest>(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  // Fase 4b: autorizacion ANTES de abrir el stream. Un 403 despues de
  // haber empezado a streamear seria un 200 con error adentro.
  const guard = requireScope({ method: "POST", pathname: new URL(request.url).pathname, request });
  if (!guard.ok) {
    return NextResponse.json({ ok: false, error: guard.error, reason: guard.reason }, { status: guard.status });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      // Fase 7: la traza se persiste best-effort. Si la DB falla, el recorder
      // se desactiva solo y el SSE sigue sin enterarse.
      const recorder = createCouncilRunRecorder({
        id: body.runId,
        threadId: body.threadId ?? null,
        turnId: body.turnId ?? null,
        question: body.prompt ?? "",
        selectedModels: body.selectedModels ?? [],
      });
      recorder.start();

      const send = (event: StreamEvent) => {
        recorder.recordEvent(event);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      const signal = request.signal;
      const isAborted = () => signal.aborted;

      try {
        await runCouncilStream({ body, signal, send });
        recorder.finish(isAborted() ? "stopped" : "complete");
      } catch (error) {
        if (isAborted() || (error instanceof Error && error.name === "AbortError")) {
          logStep("⏹ RUN ABORTED (client cancelled)");
          recorder.finish("stopped");
          // client cancelled; quietly close
        } else {
          const message = redactSecrets(error instanceof Error ? error.message : "Council stream failed.");
          logStep("✗✗ RUN FAILED", { error: message, stack: error instanceof Error ? redactSecrets(error.stack ?? "") : undefined });
          send({ type: "error", error: message });
          recorder.finish("error");
        }
      } finally {
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
