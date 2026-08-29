import { NextResponse } from "next/server";
import { getTask } from "@/lib/agent/task-store";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = getTask(id);
  if (!task) return NextResponse.json({ ok: false, error: `No existe la task ${id}.` }, { status: 404 });
  return NextResponse.json({ ok: true, task });
}
