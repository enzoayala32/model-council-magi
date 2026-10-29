import { NextResponse } from "next/server";
import { compareStoredCouncilRuns } from "@/lib/council-run-store";

/** Fase 7C: compara dos corridas del mismo prompt. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const a = url.searchParams.get("a")?.trim();
  const b = url.searchParams.get("b")?.trim();
  if (!a || !b) {
    return NextResponse.json({ error: "Faltan los parámetros a y b." }, { status: 400 });
  }
  if (a === b) {
    return NextResponse.json({ error: "Elegí dos corridas distintas." }, { status: 400 });
  }

  try {
    const result = compareStoredCouncilRuns(a, b);
    if (!result) return NextResponse.json({ error: "Alguna de las corridas no existe." }, { status: 404 });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "No se pudieron comparar las corridas." },
      { status: 500 },
    );
  }
}
