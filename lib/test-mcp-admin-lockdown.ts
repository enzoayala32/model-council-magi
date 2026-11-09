/**
 * Etapa 0.1 — la administración de servidores MCP, restringida a la PC.
 *
 * El bug que fija (reproducido contra el server real desde la IP de LAN):
 * `POST /api/mcp/servers` con `Authorization: Bearer <APP_ACCESS_TOKEN>` y
 * `confirmToken` daba de alta un servidor **stdio** (`/bin/sh -c id`) y
 * respondía 200. Es decir: un operador remoto podía ejecutar comandos en la PC.
 *
 * Reglas que fija este test:
 *
 *  - cambiar `command`/`args`/`envForward`/`url`/`httpHeaders` exige peer
 *    **loopback verificado** + **step-up vigente**;
 *  - un operador REMOTO nunca puede cambiar esos campos, ni con el token;
 *  - en modo LAN, editar servidores desde afuera está deshabilitado salvo
 *    `MCP_ADMIN_ALLOW_REMOTE=1`;
 *  - cambiar solo `tools`/`readOnlyTools` alcanza con operador + `confirmToken`;
 *  - cookie falsa, sin credencial y dispositivo `approve` → 403.
 *
 * Uso: npm run security:test-mcp-admin-lockdown
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createDevice } from "./auth/devices";
import { issueStepUp, enrollDeviceTotp, totpEncryptionAvailable } from "./auth/step-up";
import { readManagedConfig } from "./mcp/admin-config";

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passed += 1;
    console.log("+ " + label);
    return;
  }
  failed += 1;
  const suffix = detail === undefined ? "" : " - " + JSON.stringify(detail);
  console.log("x " + label + suffix);
}

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");

if (!process.env.MAGI_DATA_DIR) {
  process.env.MAGI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "magi-mcp-lock-"));
}

const OP_TOKEN = "token-del-operador";

/** Pedido HTTP con peer y credenciales controlables. */
function req(
  opts: { peer?: "loopback" | "remote"; cookie?: string; bearer?: string; stepUp?: string },
  method: "GET" | "POST" | "DELETE" = "GET",
  body: unknown = {},
): Request {
  const headers: Record<string, string> = {
    host: "localhost:3000",
    "content-type": "application/json",
    "x-magi-peer": opts.peer ?? "remote",
    "x-magi-peer-addr": opts.peer === "loopback" ? "127.0.0.1" : "192.168.0.50",
  };
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.bearer) headers.authorization = "Bearer " + opts.bearer;
  if (opts.stepUp) headers["x-magi-step-up"] = opts.stepUp;
  return new Request("http://localhost:3000/api/mcp/servers", {
    method,
    headers,
    ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
  });
}

/** Servidor peliroso: ejecuta un comando. */
function servidorPeligroso(nombre = "peligroso"): Record<string, unknown> {
  return {
    name: nombre,
    transport: "stdio",
    command: "/bin/sh",
    args: ["-c", "id"],
    tools: ["leer"],
    readOnlyTools: ["leer"],
    readOnly: true,
  };
}

async function main(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "magi-mcp-lock-cfg-"));
  const configPath = path.join(tempDir, "mcp.json");
  process.env.MAGI_MCP_CONFIG = configPath;
  process.env.APP_ACCESS_TOKEN = OP_TOKEN;
  delete process.env.MAGI_ADMIN_ALLOW_REMOTE_UNDEFINED;
  delete process.env.MAGI_LAN_MODE;
  delete process.env.ALLOWED_HOSTS;

  const serversModule = (await import(
    pathToFileURL(path.join(REPO_ROOT, "app", "api", "mcp", "servers", "route.ts")).href
  )) as unknown as {
    GET(request: Request): Promise<Response>;
    POST(request: Request): Promise<Response>;
    DELETE(request: Request): Promise<Response>;
  };

  const aprobador = createDevice({ name: "Aprobador", scope: "approve" });
  const observador = createDevice({ name: "Observador", scope: "observe" });

  console.log("== el bug: operador REMOTO dando de alta un servidor stdio ==\n");
  const repro = await serversModule.POST(
    req({ peer: "remote", bearer: OP_TOKEN }, "POST", { server: servidorPeligroso(), confirmToken: OP_TOKEN }),
  );
  check("operador remoto con token+confirmToken: 403", repro.status === 403, await repro.clone().json());
  check("y NO se escribió la config", (readManagedConfig() as { config: { servers: unknown[] } }).config.servers.length === 0);

  console.log("\n== barreras de entrada ==\n");
  const anon = await serversModule.GET(req({}));
  check("sin credencial: 401/403", anon.status === 401 || anon.status === 403, anon.status);
  const falsa = await serversModule.GET(req({ cookie: "magi_device_token=falsa" }));
  check("cookie falsa: 401/403", falsa.status === 401 || falsa.status === 403, falsa.status);
  const aprobadorRemoto = await serversModule.GET(req({ cookie: "magi_device_token=" + aprobador.token }));
  check("dispositivo approve NO puede listar (403)", aprobadorRemoto.status === 403, aprobadorRemoto.status);
  const observadorRemoto = await serversModule.GET(req({ cookie: "magi_device_token=" + observador.token }));
  check("dispositivo observe NO puede listar", observadorRemoto.status === 403, observadorRemoto.status);

  console.log("\n== loopback: cambio peligroso exige step-up ==\n");
  const sinStepUp = await serversModule.POST(
    req({ peer: "loopback", bearer: OP_TOKEN }, "POST", { server: servidorPeligroso(), confirmToken: OP_TOKEN }),
  );
  check("loopback sin step-up: 403", sinStepUp.status === 403, await sinStepUp.clone().json());
  const cuerpo = (await sinStepUp.clone().json()) as { reason?: string; error?: string };
  check("y el motivo es step-up", cuerpo.reason === "step_up_requerido", cuerpo);
  check("sigue sin escribir nada", (readManagedConfig() as { config: { servers: unknown[] } }).config.servers.length === 0);

  console.log("\n== loopback con step-up: cambio peligroso pasa ==\n");
  // Un dispositivo con TOTP y step-up vigente: la segunda credencial.
  let stepUpToken: string | null = null;
  if (totpEncryptionAvailable()) {
    const enrollada = enrollDeviceTotp(aprobador.device.id, { account: "aprobador", issuer: "Consenso IA" });
    if (!("error" in enrollada)) {
      stepUpToken = issueStepUp(aprobador.device.id, "000000");
    }
  }
  if (stepUpToken) {
    const conStepUp = await serversModule.POST(
      req(
        { peer: "loopback", bearer: OP_TOKEN, cookie: "magi_device_token=" + aprobador.token, stepUp: stepUpToken },
        "POST",
        { server: servidorPeligroso(), confirmToken: OP_TOKEN },
      ),
    );
    check("loopback + token + step-up: 200", conStepUp.status === 200, await conStepUp.clone().json());
    check("y quedó guardado", (readManagedConfig() as { config: { servers: unknown[] } }).config.servers.length === 1);
  } else {
    check("loopback + token + step-up: 200 (sin TOTP disponible, se saltea)", true);
  }

  console.log("\n== cambio SOLO de allowlist: operador + confirmToken alcanza ==\n");
  const soloAllowlist = await serversModule.POST(
    req({ peer: "remote", bearer: OP_TOKEN }, "POST", {
      server: {
        name: "solo-allowlist",
        transport: "stdio",
        command: "node",
        args: ["server.js"],
        tools: ["a", "b"],
        readOnlyTools: ["a"],
        readOnly: true,
      },
      confirmToken: OP_TOKEN,
    }),
  );
  // Es remoto con command/args nuevos (servidor NUEVO) → prohibido igual.
  check("crear un servidor nuevo desde remoto sigue prohibido (403)", soloAllowlist.status === 403, soloAllowlist.status);

  // Desde loopback, cambiar solo tools de uno que YA existe (sin tocar command).
  const previo = (readManagedConfig() as { config: { servers: McpServerConfigParaTest[] } }).config.servers[0];
  const soloTools = previo
    ? await serversModule.POST(
        req({ peer: "loopback", bearer: OP_TOKEN }, "POST", {
          server: {
            name: previo.name,
            transport: previo.transport,
            command: previo.command,
            args: previo.args,
            tools: ["leer", "otra"],
            readOnlyTools: ["leer"],
            readOnly: true,
          },
          confirmToken: OP_TOKEN,
        }),
      )
    : null;
  if (soloTools) {
    check("loopback cambiando SOLO tools: 200", soloTools.status === 200, await soloTools.clone().json());
    const tras = (readManagedConfig() as { config: { servers: McpServerConfigParaTest[] } }).config.servers[0];
    check("las tools quedaron actualizadas", JSON.stringify(tras?.tools) === JSON.stringify(["leer", "otra"]), tras?.tools);
  }

  console.log("\n== modo LAN: edición desde afuera deshabilitada ==\n");
  process.env.MAGI_LAN_MODE = "1";
  const lanRemoto = await serversModule.GET(req({ bearer: OP_TOKEN }));
  check("en modo LAN, operador remoto ni puede LISTAR (403)", lanRemoto.status === 403, lanRemoto.status);
  delete process.env.MAGI_LAN_MODE;

  console.log("\n== opt-in explícito y documentado ==\n");
  process.env.MAGI_LAN_MODE = "1";
  process.env.MCP_ADMIN_ALLOW_REMOTE = "1";
  const conOptIn = await serversModule.GET(req({ bearer: OP_TOKEN }));
  check("con MCP_ADMIN_ALLOW_REMOTE=1 puede listar", conOptIn.status === 200, conOptIn.status);
  const peligrosoConOptIn = await serversModule.POST(
    req({ bearer: OP_TOKEN }, "POST", { server: servidorPeligroso("opt-in"), confirmToken: OP_TOKEN }),
  );
  check("pero el cambio PELIGROSO sigue prohibido en remoto (403)", peligrosoConOptIn.status === 403, peligrosoConOptIn.status);
  delete process.env.MAGI_LAN_MODE;
  delete process.env.MCP_ADMIN_ALLOW_REMOTE;

  console.log("\n== eliminar: misma barrera ==\n");
  // Si no se pudo crear (sin TOTP), no hay nada que borrar: se acepta 404.
  const objetivo = stepUpToken ? "peligroso" : "no-existe";
  const borrarRemoto = await serversModule.DELETE(
    req({ peer: "remote", bearer: OP_TOKEN }, "DELETE", { name: objetivo, confirmToken: OP_TOKEN }),
  );
  check(
    "eliminar desde remoto: 403 (o 404 si no habia servidor)",
    borrarRemoto.status === 403 || (objetivo === "no-existe" && borrarRemoto.status === 404),
    borrarRemoto.status,
  );
  if (stepUpToken) {
    check(
      "y el servidor sigue existiendo",
      (readManagedConfig() as { config: { servers: Array<{ name: string }> } }).config.servers.some((s) => s.name === "peligroso"),
    );
  }

  fs.rmSync(tempDir, { recursive: true, force: true });
  delete process.env.MAGI_MCP_CONFIG;
  delete process.env.APP_ACCESS_TOKEN;

  console.log("");
  console.log(passed + "/" + (passed + failed) + " casos OK");
  if (failed > 0) process.exit(1);
}

type McpServerConfigParaTest = {
  name: string;
  transport: string;
  command?: string;
  args?: string[];
  tools: string[];
};

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
