import { NextResponse } from "next/server";
import { setThreadFavorite } from "@/lib/threads-db";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await request.json()) as { favorite: boolean };
  const thread = setThreadFavorite(id, Boolean(body.favorite));
  if (!thread) return NextResponse.json({ error: "Thread not found." }, { status: 404 });
  return NextResponse.json({ thread });
}
