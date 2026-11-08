/**
 * Fase 8 — administración de servidores MCP: reglas de acceso.
 *
 * Reglas que fija este test:
 *
 *  1. **Solo la PC del operador**: `requireLocalAccess()`. Un dispositivo
 *     emparejado con scope `approve` NO puede, ni para listar ni para editar.
 *  2. **Doble confirmación**: crear/cambiar/eliminar exige el token de operador
 *     OTRA VEZ (`confirmToken`). Crear un servidor stdio es ejecutar un comando.
 *  3. **La config sigue fuera del repo** y la escritura es atómica con respaldo.
 *  4. **Nunca se muestran valores de variables de entorno**, solo referencias.
 *  5. Una config inválida no se escribe.
 *
 * Uso: npm run security:test-mcp-admin
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createDevice } from "./auth/devices";
import { describeServerForUi, readManagedConfig, writeManagedConfig } from "./mcp/admin-config";
import { loadMcpConfig } from "./mcp/config";

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
  process.env.MAGI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "magi-mcp-admin-"));
}

const OP_TOKEN = "token-del-operador";

async function main(): Promise<void> {
  const savedToken = process.env.APP_ACCESS_TOKEN;
  process.env.APP_ACCESS_TOKEN = OP_TOKEN;

  // Config en un temporal: NUNCA la del usuario.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "magi-mcp-cfg-admin-"));
  const configPath = path.join(tempDir, "mcp.json");
  process.env.MAGI_MCP_CONFIG = configPath;

  console.log("== lectura/escritura de la config administrada ==\n");
  const inicial = readManagedConfig();
  check("sin archivo, la lectura es válida y vacía", inicial.ok === true && inicial.config.servers.length === 0, inicial);
  check("e informa que no existe", inicial.ok === true && inicial.exists === false);

  const escrito = writeManagedConfig([
    {
      name: "stdio-local",
      transport: "stdio",
      command: "node",
      args: ["server.js"],
      tools: ["leer", "borrar"],
      readOnlyTools: ["leer"],
      readOnly: false,
      timeoutMs: 5000,
    },
    {
      name: "http-remoto",
      transport: "http",
      url: "https://mcp.ejemplo.com/mcp",
      httpHeaders: { authorization: "${MI_TOKEN_MCP}" },
      tools: ["listar"],
      readOnlyTools: [],
      readOnly: true,
      timeoutMs: 5000,
    },
  ]);
  check("la escritura funciona", escrito.ok === true, escrito);
  check("la primera escritura no tiene respaldo (no habia nada antes)", escrito.ok === true && escrito.backup === undefined);

  const releido = readManagedConfig();
  check("se puede volver a leer", releido.ok === true && releido.config.servers.length === 2);
  const segunda = writeManagedConfig([
    {
      name: "solo-uno",
      transport: "stdio",
      command: "node",
      args: ["x.js"],
      tools: ["leer"],
      readOnlyTools: ["leer"],
      readOnly: true,
      timeoutMs: 5000,
    },
  ]);
  check("la segunda escritura deja respaldo", segunda.ok === true && typeof segunda.backup === "string");
  check("el respaldo existe en disco", fs.existsSync(configPath + ".bak"));
  const restaurada = readManagedConfig();
  check("y queda la versión nueva", restaurada.ok === true && restaurada.config.servers.length === 1);
  check("no quedó el temporal suelto", !fs.readdirSync(tempDir).some((f) => f.includes(".tmp-")), fs.readdirSync(tempDir));

  console.log("\n== lo que se muestra en la UI ==\n");
  if (releido.ok) {
    const http = describeServerForUi(releido.config.servers[1]);
    check("el target http es la url", http.target === "https://mcp.ejemplo.com/mcp", http);
    check("los headers se muestran como REFERENCIA, no como valor", http.headers.authorization === "${MI_TOKEN_MCP}", http.headers);
    check("no hay valores de variables de entorno en la vista", !JSON.stringify(http).includes("secreto"), JSON.stringify(http));
    check("marca que hay credencial por referencia", http.hasCredentials === true);
    const stdio = describeServerForUi(releido.config.servers[0]);
    check("el target stdio es comando + args", stdio.target === "node server.js", stdio.target);
    check("readOnlyTools se ve separado de tools", stdio.readOnlyTools.length === 1 && stdio.tools.length === 2);
  }

  console.log("\n== config inválida: no se escribe ==\n");
  const invalida = writeManagedConfig([
    {
      name: "roto",
      transport: "stdio",
      command: "node",
      tools: [],
      readOnlyTools: ["no-esta-en-tools"],
      readOnly: true,
      timeoutMs: 5000,
    },
  ]);
  check("readOnlyTools fuera de tools se rechaza", invalida.ok === false && invalida.error.includes("readOnlyTools"), invalida);
  const trasError = readManagedConfig();
  check("la config anterior sigue intacta", trasError.ok === true && trasError.config.servers.length === 1);

  console.log("\n== rutas: solo la PC del operador ==\n");
  const serversModule = (await import(pathToFileURL(path.join(REPO_ROOT, "app", "api", "mcp", "servers", "route.ts")).href)) as unknown as {
    GET(request: Request): Promise<Response>;
    POST(request: Request): Promise<Response>;
    DELETE(request: Request): Promise<Response>;
  };

  const aprobador = createDevice({ name: "Aprobador MCP", scope: "approve" });
  const observador = createDevice({ name: "Observador MCP", scope: "observe" });

  const req = (
    opts: { peer?: string; cookie?: string; bearer?: string },
    method: "GET" | "POST" | "DELETE" = "GET",
    body: unknown = {},
  ) =>
    new Request("http://localhost:3000/api/mcp/servers", {
      method,
      headers: {
        host: "localhost:3000",
        "content-type": "application/json",
        "x-magi-peer": opts.peer ?? "remote",
        "x-magi-peer-addr": opts.peer === "loopback" ? "127.0.0.1" : "192.168.0.50",
        ...(opts.cookie ? { cookie: opts.cookie } : {}),
        ...(opts.bearer ? { authorization: "Bearer " + opts.bearer } : {}),
      },
      ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
    });

  // 1) Sin credencial: 401/403.
  const anon = await serversModule.GET(req({}));
  check("sin credencial: 401/403", anon.status === 401 || anon.status === 403, anon.status);

  // 2) Dispositivo approve (remoto): NO puede, ni para listar.
  const dispositivo = await serversModule.GET(req({ cookie: "magi_device_token=" + aprobador.token }));
  check("dispositivo approve NO puede listar (403)", dispositivo.status === 403, dispositivo.status);

  // 3) Dispositivo observe: tampoco.
  const observe = await serversModule.GET(req({ cookie: "magi_device_token=" + observador.token }));
  check("dispositivo observe NO puede listar", observe.status === 403, observe.status);

  // 4) Cookie falsa: 401/403.
  const falsa = await serversModule.GET(req({ cookie: "magi_device_token=falsa" }));
  check("cookie falsa: 401/403", falsa.status === 401 || falsa.status === 403, falsa.status);

  // 5) Operador por Bearer desde loopback: puede listar.
  const operador = await serversModule.GET(req({ peer: "loopback", bearer: OP_TOKEN }));
  check("operador desde loopback puede listar", operador.status === 200, operador.status);
  if (operador.status === 200) {
    const data = (await operador.json()) as { servers?: Array<{ name: string }> };
    check("la lista trae el servidor guardado", (data.servers ?? []).length === 1, data.servers?.map((s) => s.name));
  }

  // 6) Operador desde peer REMOTO: la regla es "operador O loopback", así que
  //    con el token maestro SÍ puede: no es un dispositivo emparejado.
  const remoto = await serversModule.GET(req({ bearer: OP_TOKEN }));
  check("operador con token desde remoto puede listar", remoto.status === 200, remoto.status);

  console.log("\n== rutas: doble confirmacion para escribir ==\n");
  const nuevoServidor = {
    name: "nuevo",
    transport: "stdio",
    command: "node",
    args: ["otro.js"],
    tools: ["leer"],
    readOnlyTools: ["leer"],
    readOnly: true,
    timeoutMs: 5000,
  };

  // Sin confirmación, desde loopback con token: rechazado.
  const sinConfirmar = await serversModule.POST(
    req({ peer: "loopback", bearer: OP_TOKEN }, "POST", { server: nuevoServidor }),
  );
  check("crear sin confirmToken: 403", sinConfirmar.status === 403, sinConfirmar.status);

  // Con token equivocado: rechazado.
  const tokenMalo = await serversModule.POST(
    req({ peer: "loopback", bearer: OP_TOKEN }, "POST", { server: nuevoServidor, confirmToken: "no-es" }),
  );
  check("confirmToken equivocado: 403", tokenMalo.status === 403, tokenMalo.status);

  // Con el token correcto: funciona.
  const creado = await serversModule.POST(
    req({ peer: "loopback", bearer: OP_TOKEN }, "POST", { server: nuevoServidor, confirmToken: OP_TOKEN }),
  );
  check("con confirmToken correcto crea", creado.status === 200, await creado.clone().json());
  const trasCrear = readManagedConfig();
  check("la config tiene 2 servidores", trasCrear.ok === true && trasCrear.config.servers.length === 2);

  // La config queda válida y la puede leer el loop.
  const recargada = loadMcpConfig();
  check("el loop ve el servidor nuevo sin reiniciar", recargada.ok === true && recargada.config.servers.some((s) => s.name === "nuevo"));

  // Body inválido: 400 y no escribe.
  const roto = await serversModule.POST(
    req({ peer: "loopback", bearer: OP_TOKEN }, "POST", { server: { name: "x", transport: "stdio" }, confirmToken: OP_TOKEN }),
  );
  check("un servidor sin command da 400", roto.status === 400, roto.status);
  check("y no se escribió", (readManagedConfig() as { config: { servers: unknown[] } }).config.servers.length === 2);

  // Eliminar: misma doble confirmación.
  const borrarSinConfirmar = await serversModule.DELETE(
    req({ peer: "loopback", bearer: OP_TOKEN }, "DELETE", { name: "nuevo" }),
  );
  check("eliminar sin confirmToken: 403", borrarSinConfirmar.status === 403, borrarSinConfirmar.status);

  const borrado = await serversModule.DELETE(
    req({ peer: "loopback", bearer: OP_TOKEN }, "DELETE", { name: "nuevo", confirmToken: OP_TOKEN }),
  );
  check("eliminar con confirmToken funciona", borrado.status === 200, borrado.status);
  check("queda 1 servidor", (readManagedConfig() as { config: { servers: unknown[] } }).config.servers.length === 1);

  // Dispositivo approve intentando escribir: 403 antes de tocar nada.
  const dispositivoEscribe = await serversModule.POST(
    req({ cookie: "magi_device_token=" + aprobador.token }, "POST", { server: nuevoServidor, confirmToken: OP_TOKEN }),
  );
  check("dispositivo approve NO puede crear (403)", dispositivoEscribe.status === 403, dispositivoEscribe.status);
  check("y la config no cambió", (readManagedConfig() as { config: { servers: unknown[] } }).config.servers.length === 1);

  fs.rmSync(tempDir, { recursive: true, force: true });
  if (savedToken === undefined) delete process.env.APP_ACCESS_TOKEN;
  else process.env.APP_ACCESS_TOKEN = savedToken;
  delete process.env.MAGI_MCP_CONFIG;

  console.log("");
  console.log(passed + "/" + (passed + failed) + " casos OK");
  if (failed > 0) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
