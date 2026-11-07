import { NextResponse } from "next/server";
import { getModelHealthSnapshot } from "@/lib/model-health";
import { guardRequest } from "@/lib/auth/guard";

/** Read-only snapshot of each model's recent success/failure history —
 * powers the small warning badge on flaky models in the picker. Nothing to
 * configure: it's populated automatically as runs happen. */
export async function GET(request: Request) {
  const denied = guardRequest(request);
  if (denied) return denied;

  return NextResponse.json({ models: getModelHealthSnapshot() });
}
