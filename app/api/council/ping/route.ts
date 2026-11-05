import { NextResponse } from "next/server";
import { readJsonBody } from "@/lib/api-json";
import { pingModels } from "@/lib/model-ping";
import { requireScope } from "@/lib/auth/authorize";

/** Dry run liviano: confirma que cada modelo seleccionado responde antes de
 * lanzar la corrida completa (que puede tardar minutos y gastar tokens
 * reales). No pasa por el pipeline de reintentos de la corrida real. */
export async function POST(request: Request) {
  const parsed = await readJsonBody<{ modelIds?: string[] }>(request);
  // Fase 4b: autorizacion central por scope.
  const guard = requireScope({ method: "POST", pathname: new URL(request.url).pathname, request });
  if (!guard.ok) {
    return NextResponse.json({ ok: false, error: guard.error, reason: guard.reason }, { status: guard.status });
  }

  if (!parsed.ok) return parsed.response;
  const modelIds = Array.isArray(parsed.body?.modelIds)
    ? parsed.body.modelIds.filter((id) => typeof id === "string")
    : [];
  if (!modelIds.length) {
    return NextResponse.json({ error: "No modelIds provided." }, { status: 400 });
  }
  const results = await pingModels(modelIds);
  return NextResponse.json({ results });
}
