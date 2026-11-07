import { NextResponse } from "next/server";
import { readJsonBody } from "@/lib/api-json";
import { pingModels } from "@/lib/model-ping";
import { requireScope } from "@/lib/auth/authorize";
import { guardRequest } from "@/lib/auth/guard";

/** Dry run liviano: confirma que cada modelo seleccionado responde antes de
 * lanzar la corrida completa (que puede tardar minutos y gastar tokens
 * reales). No pasa por el pipeline de reintentos de la corrida real. */
export async function POST(request: Request) {
  const denied = guardRequest(request);
  if (denied) return denied;
  const parsed = await readJsonBody<{ modelIds?: string[] }>(request);

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
