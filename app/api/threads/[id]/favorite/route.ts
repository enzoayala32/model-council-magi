import { NextResponse } from "next/server";
import { readJsonBody } from "@/lib/api-json";
import { setThreadFavorite } from "@/lib/threads-db";
import { guardRequest } from "@/lib/auth/guard";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = guardRequest(request);
  if (denied) return denied;

  const { id } = await params;
  const parsed = await readJsonBody<{ favorite: boolean }>(request);
  if (!parsed.ok) return parsed.response;
  const thread = setThreadFavorite(id, Boolean(parsed.body.favorite));
  if (!thread) return NextResponse.json({ error: "Thread not found." }, { status: 404 });
  return NextResponse.json({ thread });
}
