import { NextResponse } from "next/server";
import { countThreads, importThreads } from "@/lib/threads-db";
import type { StoredThread } from "@/lib/threads";

/**
 * Migración de arranque, disparada una sola vez por el cliente cuando
 * la base local está vacía pero había hilos guardados en localStorage.
 * Si el server ya tiene datos, no pisa nada — evita duplicar en cada
 * pestaña que abras mientras el flag de "ya migré" no llegó a guardarse.
 */
export async function POST(request: Request) {
  const existing = countThreads();
  if (existing > 0) {
    return NextResponse.json({ imported: 0, skipped: true, reason: "Server already has threads." });
  }
  const body = (await request.json()) as { threads: StoredThread[] };
  const threads = Array.isArray(body?.threads) ? body.threads : [];
  const imported = importThreads(threads);
  return NextResponse.json({ imported, skipped: false });
}
