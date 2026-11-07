import { NextResponse } from "next/server";
import { readJsonBody } from "@/lib/api-json";
import { guardRequest } from "@/lib/auth/guard";
import { requireScope } from "@/lib/auth/authorize";
import { recordAudit } from "@/lib/auth/audit";
import { listApprovals, rejectApproval } from "@/lib/mcp/approvals";

/**
 * Fase 8.1 — listar las aprobaciones de herramientas MCP de escritura.
 *
 * QUIÉN puede: approve (`operate` no alcanza — ver la tabla de scopes). Un
 * cliente MCP externo conectado a `/api/mcp` con scope `observe` o `operate`
 * recibe 403: aprobar es un acto humano, no algo que un cliente de protocolo
 * pueda pedir. Las herramientas de `/api/mcp` son todas de solo lectura, así
 * que no hay forma de llegar acá desde ahí.
 *
 * Se devuelve el resumen de argumentos (recortado) para que el operador pueda
 * decidir, nunca los argumentos completos ni el código de las ya decididas.
 */
export async function GET(request: Request) {
  const denied = guardRequest(request);
  if (denied) return denied;

  const authorized = requireScope({ method: "GET", pathname: "/api/mcp/approvals", request });
  if (!authorized.ok) {
    return NextResponse.json({ ok: false, error: authorized.error }, { status: authorized.status });
  }

  const approvals = listApprovals(50);
  return NextResponse.json({
    ok: true,
    approvals: approvals.map((approval) => ({
      id: approval.id,
      serverName: approval.serverName,
      toolName: approval.toolName,
      argsSummary: approval.argsSummary,
      status: approval.status,
      createdAt: approval.createdAt,
      expiresAt: approval.expiresAt,
      decidedAt: approval.decidedAt,
      decidedBy: approval.decidedBy,
    })),
  });
}

/**
 * Rechazar una aprobación. Mismo nivel que aprobar: `approve` + (para
 * dispositivos remotos) step-up vigente.
 *
 * El código se manda en el body. Los errores son genéricos: no se filtra si la
 * solicitud existía, si ya estaba decidida o si venció.
 */
export async function POST(request: Request) {
  const denied = guardRequest(request);
  if (denied) return denied;

  const authorized = requireScope({ method: "POST", pathname: "/api/mcp/approvals", request });
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
  const result = rejectApproval(code, decidedBy);
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 400 });
  }
  recordAudit({
    deviceId: context.device?.id ?? null,
    action: "mcp_approval_decided",
    result: "denied",
    targetId: result.approval.id,
    detail: result.approval.serverName + "/" + result.approval.toolName,
  });
  return NextResponse.json({ ok: true, rejected: result.approval.id });
}
