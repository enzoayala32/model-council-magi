import { NextResponse } from "next/server";
import { deleteThread, getThread } from "@/lib/threads-db";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const thread = getThread(id);
  if (!thread) return NextResponse.json({ error: "Thread not found." }, { status: 404 });
  return NextResponse.json({ thread });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  deleteThread(id);
  return NextResponse.json({ ok: true });
}
