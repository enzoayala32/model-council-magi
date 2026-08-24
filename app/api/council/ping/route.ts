import { NextResponse } from "next/server";
import { pingModels } from "@/lib/model-ping";

/** Dry run liviano: confirma que cada modelo seleccionado responde antes de
 * lanzar la corrida completa (que puede tardar minutos y gastar tokens
 * reales). No pasa por el pipeline de reintentos de la corrida real. */
export async function POST(request: Request) {
  const body = (await request.json()) as { modelIds?: string[] };
  const modelIds = Array.isArray(body?.modelIds) ? body.modelIds.filter((id) => typeof id === "string") : [];
  if (!modelIds.length) {
    return NextResponse.json({ error: "No modelIds provided." }, { status: 400 });
  }
  const results = await pingModels(modelIds);
  return NextResponse.json({ results });
}
