import { NextResponse } from "next/server";
import { readJsonBody } from "@/lib/api-json";
import { guardRequest, requireLocalAccess } from "@/lib/auth/guard";
import { isOperatorRequest } from "@/lib/auth/operator";
import { constantTimeEqual } from "@/lib/api-security";
import { requireScope } from "@/lib/auth/authorize";
import { recordAudit } from "@/lib/auth/audit";
import { describeServerForUi, readManagedConfig, writeManagedConfig } from "@/lib/mcp/admin-config";
import { loadMcpConfig, type McpServerConfig } from "@/lib/mcp/config";

/**
 * Fase 8 — administración de servidores MCP.
 *
 * QUIÉN puede: **solo la PC del operador**. `requireLocalAccess()` + scope
 * `approve`. Un dispositivo emparejado con scope `approve` NO puede: no es la
 * PC, y agregar un servidor stdio equivale a ejecutar un comando acá.
 *
 * GET lista los servidores con su estado. Nunca muestra valores de variables de
 * entorno: solo las referencias (`${VAR}`), que es lo que hay en el archivo.
 */
export async function GET(request: Request) {
  const denied = guardRequest(request);
  if (denied) return denied;

  const local = requireLocalAccess(request);
  if (local) return local;

  const authorized = requireScope({ method: "GET", pathname: "/api/mcp/servers", request });
  if (!authorized.ok) {
    return NextResponse.json({ ok: false, error: authorized.error }, { status: authorized.status });
  }

  const managed = readManagedConfig();
  if (!managed.ok) {
    return NextResponse.json({ ok: false, error: managed.error, source: managed.source }, { status: 500 });
  }

  const config = loadMcpConfig();
  const conError = !config.ok ? config.error : null;

  return NextResponse.json({
    ok: true,
    source: managed.config.source,
    exists: managed.exists,
    configError: conError,
    servers: managed.config.servers.map(describeServerForUi),
    /** Herramientas permitidas por servidor, para la UI (no descubre: eso se
     *  hace con "probar conexión"). */
    allowlistPorServidor: Object.fromEntries(managed.config.servers.map((server) => [server.name, [...server.tools]])),
  });
}

/**
 * Crea o actualiza un servidor. Reglas:
 *
 * - Solo loopback + operador (ver `requireLocalAccess`).
 * - **Confirmar con el token de operador otra vez**: `{ server, confirmToken }`.
 *   Crear un servidor stdio es ejecutar un comando; no se hace con la sesión
 *   sola.
 * - El cuerpo se valida con el mismo validador de la lectura, y la escritura es
 *   atómica con respaldo.
 */
export async function POST(request: Request) {
  const denied = guardRequest(request);
  if (denied) return denied;

  const local = requireLocalAccess(request);
  if (local) return local;

  const authorized = requireScope({ method: "POST", pathname: "/api/mcp/servers", request });
  if (!authorized.ok) {
    return NextResponse.json({ ok: false, error: authorized.error }, { status: authorized.status });
  }

  const parsed = await readJsonBody<{ server?: unknown; confirmToken?: unknown }>(request);
  if (!parsed.ok) return parsed.response;

  // Doble confirmación: el token de operador, OTRA VEZ, y comparado en tiempo
  // constante contra el real. Sin la comparación, cualquier string servía.
  const confirm = typeof parsed.body.confirmToken === "string" ? parsed.body.confirmToken.trim() : "";
  const expected = process.env.APP_ACCESS_TOKEN?.trim() ?? "";
  if (!expected || !confirm || !constantTimeEqual(confirm, expected) || !isOperatorRequest(request)) {
    recordAudit({ action: "access_denied", result: "denied", detail: "alta de servidor MCP sin confirmar" });
    return NextResponse.json(
      { ok: false, error: "Para agregar o cambiar un servidor hay que confirmar con el token de acceso." },
      { status: 403 },
    );
  }

  const incoming = parsed.body.server;
  if (typeof incoming !== "object" || incoming === null || Array.isArray(incoming)) {
    return NextResponse.json({ ok: false, error: "Falta el servidor." }, { status: 400 });
  }
  const candidate = incoming as Record<string, unknown>;
  const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
  if (!name) return NextResponse.json({ ok: false, error: "Falta el nombre del servidor." }, { status: 400 });

  const managed = readManagedConfig();
  if (!managed.ok) {
    return NextResponse.json({ ok: false, error: managed.error }, { status: 500 });
  }

  const servers = [...managed.config.servers.filter((server) => server.name !== name), normalizeIncoming(candidate, name)];
  const written = writeManagedConfig(servers);
  if (!written.ok) {
    return NextResponse.json({ ok: false, error: written.error }, { status: 400 });
  }

  recordAudit({ action: "mcp_tool_called", result: "ok", targetId: name, detail: "servidor MCP guardado" });
  return NextResponse.json({
    ok: true,
    servers: written.config.servers.map(describeServerForUi),
    backup: written.backup,
    /** El proceso que corre no recarga solo: hay que reiniciar el server. */
    needsRestart: true,
  });
}

/** Elimina un servidor por nombre. Misma doble confirmación. */
export async function DELETE(request: Request) {
  const denied = guardRequest(request);
  if (denied) return denied;

  const local = requireLocalAccess(request);
  if (local) return local;

  const authorized = requireScope({ method: "DELETE", pathname: "/api/mcp/servers", request });
  if (!authorized.ok) {
    return NextResponse.json({ ok: false, error: authorized.error }, { status: authorized.status });
  }

  const parsed = await readJsonBody<{ name?: unknown; confirmToken?: unknown }>(request);
  if (!parsed.ok) return parsed.response;

  const confirm = typeof parsed.body.confirmToken === "string" ? parsed.body.confirmToken.trim() : "";
  const expected = process.env.APP_ACCESS_TOKEN?.trim() ?? "";
  const name = typeof parsed.body.name === "string" ? parsed.body.name.trim() : "";
  if (!name) return NextResponse.json({ ok: false, error: "Falta el nombre." }, { status: 400 });
  if (!expected || !confirm || !constantTimeEqual(confirm, expected) || !isOperatorRequest(request)) {
    recordAudit({ action: "access_denied", result: "denied", detail: "baja de servidor MCP sin confirmar" });
    return NextResponse.json(
      { ok: false, error: "Para eliminar un servidor hay que confirmar con el token de acceso." },
      { status: 403 },
    );
  }

  const managed = readManagedConfig();
  if (!managed.ok) return NextResponse.json({ ok: false, error: managed.error }, { status: 500 });

  const servers = managed.config.servers.filter((server) => server.name !== name);
  const written = writeManagedConfig(servers);
  if (!written.ok) return NextResponse.json({ ok: false, error: written.error }, { status: 400 });

  recordAudit({ action: "mcp_tool_called", result: "ok", targetId: name, detail: "servidor MCP eliminado" });
  return NextResponse.json({ ok: true, servers: written.config.servers.map(describeServerForUi), needsRestart: true });
}

/** Convierte el body en la forma que espera el validador (mismos campos). */
function normalizeIncoming(raw: Record<string, unknown>, name: string): McpServerConfig {
  const asStringArray = (value: unknown): string[] | undefined =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : undefined;

  const headers =
    typeof raw.httpHeaders === "object" && raw.httpHeaders !== null && !Array.isArray(raw.httpHeaders)
      ? Object.fromEntries(
          Object.entries(raw.httpHeaders as Record<string, unknown>)
            .filter(([, value]) => typeof value === "string")
            .map(([key, value]) => [key, value as string]),
        )
      : undefined;

  return {
    name,
    transport: raw.transport === "http" ? "http" : "stdio",
    command: typeof raw.command === "string" ? raw.command : undefined,
    args: asStringArray(raw.args),
    cwd: typeof raw.cwd === "string" ? raw.cwd : undefined,
    envForward: asStringArray(raw.envForward),
    url: typeof raw.url === "string" ? raw.url : undefined,
    httpHeaders: headers,
    allowInsecureLocal: raw.allowInsecureLocal === true,
    tools: asStringArray(raw.tools) ?? [],
    readOnlyTools: asStringArray(raw.readOnlyTools) ?? [],
    readOnly: raw.readOnly !== false,
    timeoutMs: typeof raw.timeoutMs === "number" ? raw.timeoutMs : 60_000,
    note: typeof raw.note === "string" ? raw.note.slice(0, 300) : undefined,
  };
}
