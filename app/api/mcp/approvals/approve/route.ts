import { NextResponse } from "next/server";
import { readJsonBody } from "@/lib/api-json";
import { guardRequest } from "@/lib/auth/guard";
import { requireScope } from "@/lib/auth/authorize";
import { recordAudit } from "@/lib/auth/audit";
import { approveApproval } from "@/lib/mcp/approvals";

/**
 * Fase 8.2 — aprobar una herramienta MCP de escritura.
 *
 * El acto humano de la Fase 8. Requiere scope `approve`, y un dispositivo
 * remoto además step-up vigente (`lib/auth/scopes.ts` lo declara con
 * `stepUp: true`, y `authorize.ts` loVerifica).
 *
 * Aprobar NO ejecuta la herramienta: la marca como aprobada y la ejecución
 * ocurre cuando el agente la consume, UNA sola vez, con los mismos argumentos.
 * Si el agente cambió los argumentos, `consumeApproval` la rechaza.
 *
 * El cliente MCP externo (`/api/mcp`) no puede aprobar: no expone ningún
 * método de aprobación, y esta ruta exige `approve` + step-up.
 */
export async function POST(request: Request) {
  const denied = guardRequest(request);
  if (denied) return denied;

  const authorized = requireScope({ method: "POST", pathname: "/api/mcp/approvals/approve", request });
  if (!authorized.ok) {
    return NextResponse.json({ ok: false, error: authorized.error }, { status: authorized.status });
  }
  const { context } = authorized;

  const parsed = await readJsonBody<{ code?: unknown }>(request);
  if (!parsed.ok) return parsed.response;

  const code = typeof parsed.body.code === "string" ? parsed.body.code.trim() : "";
  if (!code) {
    return NextResponse.json({ ok: false, error: "Falta el código de la aprobación." }, { status: 400 });
  }

  const decidedBy = context.operator ? "operador" : context.device?.id ?? "desconocido";
  const result = approveApproval(code, decidedBy);
  if (!result.ok) {
    // Genérico a propósito (igual que los códigos de emparejamiento).
    return NextResponse.json({ ok: false, error: result.error }, { status: 400 });
  }
  recordAudit({
    deviceId: context.device?.id ?? null,
    action: "mcp_approval_decided",
    result: "ok",
    targetId: result.approval.id,
    detail: result.approval.serverName + "/" + result.approval.toolName,
  });
  return NextResponse.json({ ok: true, approved: result.approval.id });
}
