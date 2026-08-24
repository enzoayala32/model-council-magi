import { NextResponse } from "next/server";
import { listThreads, upsertThread } from "@/lib/threads-db";
import type { StoredThread } from "@/lib/threads";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get("q") ?? undefined;
  const favoriteOnly = searchParams.get("favorite") === "1";
  const threads = listThreads({ query, favoriteOnly });
  return NextResponse.json({ threads });
}

export async function POST(request: Request) {
  const body = (await request.json()) as StoredThread;
  if (!body?.id || !body.title || !Array.isArray(body.turns)) {
    return NextResponse.json({ error: "Invalid thread payload." }, { status: 400 });
  }
  const saved = upsertThread(body);
  return NextResponse.json({ thread: saved });
}
