import { NextResponse } from "next/server";
import { listAuditLog, pruneAuditLog, AUDIT_RETENTION_DAYS } from "@/lib/auth/audit";
import { isLoopbackHost } from "@/lib/auth/scopes";

/**
 * Fase 4d - registro de actividad.
 *
 * GET lista (nunca incluye tokens ni codigos: no se guardan). POST poda con
 * la retencion configurada (90 dias por default).
 */
export async function GET(request: Request) {
  if (!isLoopbackHost(request.headers.get("host"))) {
    return NextResponse.json({ ok: false, error: "Solo se ve desde esta PC." }, { status: 403 });
  }
  const url = new URL(request.url);
  const rawLimit = Number(url.searchParams.get("limit") ?? 200);
  const limit = Number.isFinite(rawLimit) ? rawLimit : 200;
  const deviceId = url.searchParams.get("deviceId")?.trim() || undefined;
  return NextResponse.json({ ok: true, entries: listAuditLog({ deviceId, limit }), retentionDays: AUDIT_RETENTION_DAYS });
}

export async function POST(request: Request) {
  if (!isLoopbackHost(request.headers.get("host"))) {
    return NextResponse.json({ ok: false, error: "Solo se poda desde esta PC." }, { status: 403 });
  }
  const deleted = pruneAuditLog(AUDIT_RETENTION_DAYS);
  return NextResponse.json({ ok: true, deleted, retentionDays: AUDIT_RETENTION_DAYS });
}
