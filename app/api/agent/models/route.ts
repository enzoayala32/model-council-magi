import { NextResponse } from "next/server";
import { getCodingAgentModels } from "@/lib/models";
import { guardRequest } from "@/lib/auth/guard";

/** Fase 2H. La UI de selección de modelo del Coding Agent SIEMPRE debe
 * llamar a este endpoint (que a su vez llama `getCodingAgentModels()`,
 * Fase 2/sección 15) — nunca debe traer su propia copia de `COUNCIL_MODELS`,
 * o un modelo deshabilitado para agentes (ej. sin tool-calling multi-step
 * probado) terminaría apareciendo como opción igual. */
export async function GET(request: Request) {
  const denied = guardRequest(request);
  if (denied) return denied;

  const models = getCodingAgentModels().map((m) => ({ id: m.id, label: m.label, shortName: m.shortName, maker: m.maker }));
  return NextResponse.json({ ok: true, models });
}
