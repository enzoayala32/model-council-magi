import { NextResponse } from "next/server";
import { readJsonBody } from "@/lib/api-json";
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
  const parsed = await readJsonBody<{ threads: StoredThread[] }>(request);
  if (!parsed.ok) return parsed.response;
  const threads = Array.isArray(parsed.body?.threads) ? parsed.body.threads : [];
  const imported = importThreads(threads);
  return NextResponse.json({ imported, skipped: false });
}
