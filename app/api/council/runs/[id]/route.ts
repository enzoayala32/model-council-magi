import { NextResponse } from "next/server";
import { deleteCouncilRun, getCouncilRunDetail } from "@/lib/council-run-store";
import { guardRequest } from "@/lib/auth/guard";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = guardRequest(request);
  if (denied) return denied;

  const { id } = await params;
  try {
    const detail = getCouncilRunDetail(id);
    if (!detail) return NextResponse.json({ error: "Corrida no encontrada." }, { status: 404 });
    return NextResponse.json(detail);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "No se pudo cargar la corrida." },
      { status: 500 },
    );
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = guardRequest(request);
  if (denied) return denied;

  const { id } = await params;
  try {
    const deleted = deleteCouncilRun(id);
    if (!deleted) return NextResponse.json({ error: "Corrida no encontrada." }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "No se pudo borrar la corrida." },
      { status: 500 },
    );
  }
}
