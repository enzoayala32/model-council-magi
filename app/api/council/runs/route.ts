import { NextResponse } from "next/server";
import { listCouncilRuns } from "@/lib/council-run-store";
import { guardRequest } from "@/lib/auth/guard";

/** Fase 7: lista de corridas persistidas, opcionalmente por hilo. */
export async function GET(request: Request) {
  const denied = guardRequest(request);
  if (denied) return denied;

  try {
    const url = new URL(request.url);
    const threadId = url.searchParams.get("threadId")?.trim() || null;
    const rawLimit = Number(url.searchParams.get("limit") ?? 50);
    const limit = Number.isFinite(rawLimit) ? rawLimit : 50;
    return NextResponse.json({ runs: listCouncilRuns({ threadId, limit }) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "No se pudieron listar las corridas." },
      { status: 500 },
    );
  }
}
