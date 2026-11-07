import { NextResponse } from "next/server";
import { deleteThread, getThread } from "@/lib/threads-db";
import { guardRequest } from "@/lib/auth/guard";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = guardRequest(request);
  if (denied) return denied;

  const { id } = await params;
  const thread = getThread(id);
  if (!thread) return NextResponse.json({ error: "Thread not found." }, { status: 404 });
  return NextResponse.json({ thread });
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = guardRequest(request);
  if (denied) return denied;

  const { id } = await params;
  deleteThread(id);
  return NextResponse.json({ ok: true });
}
