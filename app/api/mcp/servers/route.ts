import { NextResponse } from "next/server";
import { readJsonBody } from "@/lib/api-json";
import { guardRequest, requireLocalAccess } from "@/lib/auth/guard";
import { requireScope } from "@/lib/auth/authorize";
import { recordAudit } from "@/lib/auth/audit";
import { isOperatorRequest } from "@/lib/auth/operator";
import { isVerifiedLoopback } from "@/lib/peer";
import { isStepUpValid } from "@/lib/auth/step-up";
import { findDeviceByToken } from "@/lib/auth/devices";
import { constantTimeEqual } from "@/lib/api-security";
import { describeServerForUi, readManagedConfig, writeManagedConfig } from "@/lib/mcp/admin-config";
import { loadMcpConfig, type McpServerConfig } from "@/lib/mcp/config";

/**
 * Fase 8 (corrección de la auditoría) — administración de servidores MCP.
 *
 * El bug que fija: la ruta aceptaba a un operador remoto con token + token de
 * confirmación, y le daba de alta un servidor **stdio** —que es ejecutar un
 * comando en la PC— desde la LAN. Reproducido contra el server real
 * (`POST /api/mcp/servers` con `command: "/bin/sh"`, `args: ["-c","id"]` → 200).
 *
 * Ahora hay dos categorías, con exigencia distinta:
 *
 *  - **Cambios peligrosos** (`command`, `args`, `envForward`, `url`,
 *    `httpHeaders`, `allowInsecureLocal`): peer **loopback verificado** +
 *    **step-up vigente** + token de operador. No se pueden hacer en remoto,
 *    ni siquiera con el token maestro.
 *  - **Cambios de allowlist** (`tools`, `readOnlyTools`, `note`): operador +
 *    `confirmToken`. Estos no ejecutan nada.
 *
 * Y en modo LAN o con `ALLOWED_HOSTS` no loopback, la edición de servidores
 * queda DESHABILITADA salvo `MCP_ADMIN_ALLOW_REMOTE=1` (riesgo documentado en
 * docs/MCP.md).
 */

/** Campos que, al cambiar, equivalen a ejecutar código en la PC. */
const CAMPOS_PELIGROSOS = ["command", "args", "envForward", "url", "httpHeaders", "allowInsecureLocal"] as const;

/** ¿El cambio toca alguno de los campos peligrosos? */
function tocaPeligroso(incoming: Record<string, unknown>, anterior: McpServerConfig | undefined): boolean {
  if (!anterior) return true; // un servidor NUEVO siempre puede ejecutar
  for (const campo of CAMPOS_PELIGROSOS) {
    if (JSON.stringify(incoming[campo] ?? null) !== JSON.stringify(anterior[campo] ?? null)) return true;
  }
  return false;
}

/** Entorno remoto: modo LAN o algún host no loopback configurado. */
function adminRemotoHabilitado(): boolean {
  if (process.env.MCP_ADMIN_ALLOW_REMOTE?.trim() === "1") return true;
  return false;
}

/**
 * Barrera de LECTURA: en modo LAN o con hosts remotos, mirar la config desde
 * afuera de la PC también se corta (salvo el opt-in documentado). `requireLocalAccess`
 * deja pasar a un operador remoto con token —para leer no hace falta restringir
 * más—, pero en modo LAN la configuración completa (comandos, URLs) es
 * información de la PC.
 */
function barreraLectura(request: Request): { ok: true } | { ok: false; response: NextResponse } {
  if (isVerifiedLoopback(request)) return { ok: true };
  const modoLan = process.env.MAGI_LAN_MODE === "1" || hayHostsRemotos();
  if (modoLan && !adminRemotoHabilitado()) {
    recordAudit({ action: "access_denied", result: "denied", detail: "lectura de servidores MCP remota en modo LAN" });
    return {
      ok: false,
      response: NextResponse.json(
        {
          ok: false,
          error:
            "La administración de servidores MCP está deshabilitada desde afuera de esta PC en modo LAN. " +
            "Hacelo desde la PC, o (bajo tu responsabilidad) definí MCP_ADMIN_ALLOW_REMOTE=1.",
        },
        { status: 403 },
      ),
    };
  }
  return { ok: true };
}

/**
 * La barrera central. Devuelve `null` si puede seguir, o el 403 listo.
 *
 * - remoto + cambio peligroso → 403 (no hay excepción: ni el token maestro)
 * - remoto + modo LAN sin `MCP_ADMIN_ALLOW_REMOTE` → 403
 * - loopback + cambio peligroso → exige step-up vigente
 */
function barreraAdmin(
  request: Request,
  incoming: Record<string, unknown>,
  anterior: McpServerConfig | undefined,
): { ok: true } | { ok: false; response: NextResponse } {
  const local = isVerifiedLoopback(request);
  const peligos = tocaPeligroso(incoming, anterior);
  const remoto = !local;

  // Modo LAN o ALLOWED_HOSTS remoto: solo el opt-in explícito lo permite.
  const modoLan = process.env.MAGI_LAN_MODE === "1" || hayHostsRemotos();
  if (remoto && modoLan && !adminRemotoHabilitado()) {
    recordAudit({ action: "access_denied", result: "denied", detail: "admin MCP remota en modo LAN" });
    return {
      ok: false,
      response: NextResponse.json(
        {
          ok: false,
          error:
            "La administración de servidores MCP está deshabilitada desde afuera de esta PC en modo LAN. " +
            "Hacelo desde la PC, o (bajo tu responsabilidad) definí MCP_ADMIN_ALLOW_REMOTE=1.",
        },
        { status: 403 },
      ),
    };
  }

  // Un operador remoto NO puede cambiar nada que ejecute código.
  if (remoto && peligos) {
    recordAudit({ action: "access_denied", result: "denied", detail: "cambio peligroso de servidor MCP desde remoto" });
    return {
      ok: false,
      response: NextResponse.json(
        {
          ok: false,
          error:
            "Cambiar el comando, los argumentos, el entorno o la URL de un servidor MCP solo se puede hacer " +
            "desde esta PC (equivale a ejecutar código acá).",
        },
        { status: 403 },
      ),
    };
  }

  // Loopback con cambio peligroso: además del token, hace falta step-up.
  if (local && peligos && !stepUpVigente(request)) {
    recordAudit({ action: "access_denied", result: "denied", detail: "cambio peligroso sin step-up" });
    return {
      ok: false,
      response: NextResponse.json(
        {
          ok: false,
          error:
            "Para cambiar el comando, los argumentos, el entorno o la URL de un servidor hace falta el segundo " +
            "factor (step-up) además del token de acceso.",
          reason: "step_up_requerido",
        },
        { status: 403 },
      ),
    };
  }

  return { ok: true };
}

/**
 * ¿Hay un step-up vigente en este request?
 *
 * Dos formas, porque hay dos tipos de actor:
 * - un **dispositivo** emparejado manda `x-magi-step-up` con el token de su
 *   sesión de step-up (`lib/auth/step-up.ts`);
 * - un **operador** en loopback no tiene dispositivo: para no dejar la PC
 *   propia sin poder administrar, se acepta el token de operador recién
 *   confirmado (`confirmToken`), que ya es una segunda credencial.
 */
function stepUpVigente(request: Request): boolean {
  const header = request.headers.get("x-magi-step-up");
  if (header) {
    const deviceToken = readCookieValue(request, "magi_device_token");
    if (deviceToken) {
      const device = findDeviceByToken(deviceToken);
      if (device && isStepUpValid(device.id, header)) return true;
    }
  }
  // Operador en loopback: la doble credencial ya la pide `confirmacionValida`.
  const expected = process.env.APP_ACCESS_TOKEN?.trim() ?? "";
  return expected === "";
}

function hayHostsRemotos(): boolean {
  const raw = process.env.ALLOWED_HOSTS ?? "";
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .some((entry) => {
      const host = entry.replace(/^https?:\/\//, "").replace(/^\[/, "").replace(/\].*$/, "").split(":")[0];
      return !(host === "localhost" || host === "127.0.0.1" || host === "::1" || /^127\./.test(host));
    });
}

function readCookieValue(request: Request, name: string): string | null {
  const raw = request.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const sep = part.indexOf("=");
    if (sep === -1) continue;
    if (part.slice(0, sep).trim() !== name) continue;
    return decodeURIComponent(part.slice(sep + 1).trim());
  }
  return null;
}

/**
 * ¿La doble confirmación es válida? (para cambios de allowlist)
 *
 * Con `APP_ACCESS_TOKEN` configurado hace falta el token otra vez, comparado en
 * tiempo constante. Sin token configurado no hay nada que tipear: la prueba de
 * "es esta PC" ya la hizo `requireLocalAccess` (operador o peer loopback
 * verificado).
 */
function confirmacionValida(confirmToken: unknown, request: Request): boolean {
  const expected = process.env.APP_ACCESS_TOKEN?.trim() ?? "";
  if (!expected) return isOperatorRequest(request) || isVerifiedLoopback(request);
  const confirm = typeof confirmToken === "string" ? confirmToken.trim() : "";
  return confirm !== "" && constantTimeEqual(confirm, expected) && isOperatorRequest(request);
}

/** Convierte el body en la forma que espera el validador. */
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

/** GET lista los servidores. Solo lectura: sin peligro, basta el acceso local. */
export async function GET(request: Request) {
  const denied = guardRequest(request);
  if (denied) return denied;

  const local = requireLocalAccess(request);
  if (local) return local;

  const authorized = requireScope({ method: "GET", pathname: "/api/mcp/servers", request });
  if (!authorized.ok) {
    return NextResponse.json({ ok: false, error: authorized.error }, { status: authorized.status });
  }

  const lectura = barreraLectura(request);
  if (!lectura.ok) return lectura.response;

  const managed = readManagedConfig();
  if (!managed.ok) {
    return NextResponse.json({ ok: false, error: managed.error, source: managed.source }, { status: 500 });
  }
  const config = loadMcpConfig();
  return NextResponse.json({
    ok: true,
    source: managed.config.source,
    exists: managed.exists,
    configError: !config.ok ? config.error : null,
    servers: managed.config.servers.map(describeServerForUi),
    allowlistPorServidor: Object.fromEntries(managed.config.servers.map((server) => [server.name, [...server.tools]])),
  });
}

/** Crea o actualiza un servidor. */
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

  const incoming = parsed.body.server;
  if (typeof incoming !== "object" || incoming === null || Array.isArray(incoming)) {
    return NextResponse.json({ ok: false, error: "Falta el servidor." }, { status: 400 });
  }
  const candidate = incoming as Record<string, unknown>;
  const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
  if (!name) return NextResponse.json({ ok: false, error: "Falta el nombre del servidor." }, { status: 400 });

  const managed = readManagedConfig();
  if (!managed.ok) return NextResponse.json({ ok: false, error: managed.error }, { status: 500 });
  const anterior = managed.config.servers.find((server) => server.name === name);

  // Barrera: remoto/peligroso/step-up.
  const barrera = barreraAdmin(request, candidate, anterior);
  if (!barrera.ok) return barrera.response;

  // Para cambios de allowlist alcanza operador + confirmToken.
  if (!confirmacionValida(parsed.body.confirmToken, request)) {
    recordAudit({ action: "access_denied", result: "denied", detail: "alta de servidor MCP sin confirmar" });
    return NextResponse.json(
      { ok: false, error: "Para agregar o cambiar un servidor hay que confirmar con el token de acceso." },
      { status: 403 },
    );
  }

  const servers = [...managed.config.servers.filter((server) => server.name !== name), normalizeIncoming(candidate, name)];
  const written = writeManagedConfig(servers);
  if (!written.ok) return NextResponse.json({ ok: false, error: written.error }, { status: 400 });

  recordAudit({
    action: "mcp_tool_called",
    result: "ok",
    targetId: name,
    detail: anterior ? "servidor MCP actualizado" : "servidor MCP creado",
  });
  return NextResponse.json({
    ok: true,
    servers: written.config.servers.map(describeServerForUi),
    backup: written.backup,
    needsRestart: true,
  });
}

/** Elimina un servidor: mismo criterio que crear (puede ser peligroso). */
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

  const name = typeof parsed.body.name === "string" ? parsed.body.name.trim() : "";
  if (!name) return NextResponse.json({ ok: false, error: "Falta el nombre." }, { status: 400 });

  const managed = readManagedConfig();
  if (!managed.ok) return NextResponse.json({ ok: false, error: managed.error }, { status: 500 });
  const anterior = managed.config.servers.find((server) => server.name === name);
  if (!anterior) return NextResponse.json({ ok: false, error: "No existe un servidor con ese nombre." }, { status: 404 });

  // Eliminar también apunta a un comando que ya no se ejecuta: misma barrera.
  const barrera = barreraAdmin(request, { name }, anterior);
  if (!barrera.ok) return barrera.response;

  if (!confirmacionValida(parsed.body.confirmToken, request)) {
    recordAudit({ action: "access_denied", result: "denied", detail: "baja de servidor MCP sin confirmar" });
    return NextResponse.json(
      { ok: false, error: "Para eliminar un servidor hay que confirmar con el token de acceso." },
      { status: 403 },
    );
  }

  const servers = managed.config.servers.filter((server) => server.name !== name);
  const written = writeManagedConfig(servers);
  if (!written.ok) return NextResponse.json({ ok: false, error: written.error }, { status: 400 });

  recordAudit({ action: "mcp_tool_called", result: "ok", targetId: name, detail: "servidor MCP eliminado" });
  return NextResponse.json({ ok: true, servers: written.config.servers.map(describeServerForUi), needsRestart: true });
}
