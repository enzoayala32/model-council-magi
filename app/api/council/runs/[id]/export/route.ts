import { NextResponse } from "next/server";
import { getCouncilRunDetail } from "@/lib/council-run-store";
import { renderRunMarkdown } from "@/lib/council-run-trace";
import { guardRequest } from "@/lib/auth/guard";

/** Fase 7B: exporta una corrida como Markdown (default) o JSON. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = guardRequest(request);
  if (denied) return denied;

  const { id } = await params;
  const format = (new URL(request.url).searchParams.get("format") ?? "markdown").toLowerCase();
  if (format !== "markdown" && format !== "json") {
    return NextResponse.json({ error: "Formato inválido: usá markdown o json." }, { status: 400 });
  }

  try {
    const detail = getCouncilRunDetail(id);
    if (!detail) return NextResponse.json({ error: "Corrida no encontrada." }, { status: 404 });

    if (format === "json") {
      return new Response(JSON.stringify(detail, null, 2), {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Disposition": `attachment; filename="council-run-${id}.json"`,
          "Cache-Control": "no-store",
        },
      });
    }

    return new Response(renderRunMarkdown(detail), {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="council-run-${id}.md"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "No se pudo exportar la corrida." },
      { status: 500 },
    );
  }
}
