/**
 * Correccion de seguridad #2 — enforcement real por ruta.
 *
 * El proxy deja pasar cualquier request con una cookie `magi_device_token`
 * (no puede consultar la DB). La decision la toma la ruta con
 * `guardRequest`. Este test recorre `app/api (todos los route.ts)` y por cada metodo
 * exportado llama el handler con distintas credenciales:
 *
 *   - peer remoto + SIN credencial       -> 401/403
 *   - peer remoto + cookie FALSA         -> 401/403
 *   - dispositivo observe + ruta mutante  -> 403
 *   - dispositivo operate + apply         -> 403
 *   - peer loopback sin credencial        -> pasa (uso local de siempre)
 *
 * Una ruta SIN guardia hace fallar el test: sin ella el handler correria y
 * devolveria 200/201 en vez de 401/403.
 *
 * Uso: npm run security:test-route-enforcement
 */
import fsSync from "node:fs";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDevice, DEVICE_COOKIE } from "./auth/devices";
import { ruleFor } from "./auth/scopes";

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

// Aislamiento tambien fuera del runner.
if (!process.env.MAGI_DATA_DIR) {
  process.env.MAGI_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "magi-enforce-test-"));
}

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const API_ROOT = path.join(REPO_ROOT, "app", "api");

type Handler = (request: Request, ctx?: { params: Promise<{ id: string }> }) => Promise<Response>;
type RouteModule = Record<string, UnknownHandler>;
type UnknownHandler = unknown;

const BS = String.fromCharCode(92);
const METHOD_RE = new RegExp("export" + BS + "s+(?:async" + BS + "s+)?function" + BS + "s+(GET|POST|PUT|PATCH|DELETE)", "g");

function discoverRoutes(): Array<{ route: string; file: string; methods: string[] }> {
  const out: Array<{ route: string; file: string; methods: string[] }> = [];
  const walk = (dir: string): void => {
    for (const entry of fsSync.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (entry.name !== "route.ts") continue;
      const rel = full.split(path.sep).join("/").replace(/^.*?\/app\//, "").replace(/\/route\.ts$/, "");
      const route = "/" + rel.replace(/\[(\w+)\]/g, ":$1");
      const src = fsSync.readFileSync(full, "utf8");
      const methods: string[] = [];
      let m: RegExpExecArray | null;
      while ((m = METHOD_RE.exec(src))) if (!methods.includes(m[1])) methods.push(m[1]);
      out.push({ route, file: full.split(path.sep).join("/"), methods });
    }
  };
  walk(API_ROOT);
  return out.sort((a, b) => a.route.localeCompare(b.route));
}

/** Carga un modulo de ruta por su archivo (URL absoluta: los corchetes). */
async function loadRoute(file: string): Promise<RouteModule> {
  const { pathToFileURL } = await import("node:url");
  return (await import(pathToFileURL(file).href)) as RouteModule;
}

/** Request con el peer y las credenciales indicadas. */
function requestFor(route: string, method: string, creds: {
  peer?: "loopback" | "remote";
  deviceToken?: string;
  operatorToken?: string;
  body?: unknown;
} = {}): Request {
  const headers: Record<string, string> = { host: `localhost:3000` };
  headers["x-magi-peer"] = creds.peer ?? "remote";
  headers["x-magi-peer-addr"] = creds.peer === "loopback" ? "127.0.0.1" : "192.168.0.50";
  if (creds.deviceToken) headers.cookie = `${DEVICE_COOKIE}=${creds.deviceToken}`;
  if (creds.operatorToken) headers.authorization = `Bearer ${creds.operatorToken}`;
  if (creds.body !== undefined) headers["content-type"] = "application/json";
  const url = `http://localhost:3000${route.replace(/:[^/]+/g, "probe-id")}`;
  return new Request(url, {
    method,
    headers,
    body: creds.body !== undefined ? JSON.stringify(creds.body) : undefined,
  });
}

const CTX = { params: Promise.resolve({ id: "probe-id" }) };

async function main(): Promise<void> {
  const routes = discoverRoutes();
  console.log(`(${routes.length} archivos route.ts encontrados)\n`);

  // Dispositivos de prueba, con su token real.
  const observer = createDevice({ name: "Observador", scope: "observe" });
  const operator = createDevice({ name: "Operador", scope: "operate" });
  const approver = createDevice({ name: "Aprobador", scope: "approve" });

  const noCreds: string[] = [];
  const fakeCookie: string[] = [];
  let withGuard = 0;

  for (const found of routes) {
    const routeModule = await loadRoute(found.file);
    for (const method of found.methods) {
      const handler = routeModule[method] as Handler | undefined;
      if (typeof handler !== "function") continue;

      const label = method + " " + found.route;
      const rule = ruleFor(method, found.route);
      // Las rutas `public` se autentican solas (login, canje de código): no
      // tienen que denegar sin credencial, tienen su propio control. Lo que
      // se les exige es no ser un agujero: se verifican aparte.
      if (rule && rule.scope === "public") continue;
      let guarded = false;

      // --- peer remoto, sin credencial ---
      try {
        const response = await handler(requestFor(found.route, method), CTX);
        const status = response.status;
        if (status === 401 || status === 403) guarded = true;
        else noCreds.push(`${label} -> ${status}`);
      } catch (error) {
        noCreds.push(`${label} lanzó ${error instanceof Error ? error.message : String(error)}`);
      }

      // --- cookie de dispositivo FALSA ---
      try {
        const response = await handler(requestFor(found.route, method, { deviceToken: "cookie-falsa" }), CTX);
        if (response.status === 401 || response.status === 403) guarded = true;
        else fakeCookie.push(`${label} -> ${response.status}`);
      } catch {
        /* un handlerque lanza igual está denegando; no es el hueco */
      }

      if (guarded) withGuard += 1;
    }
  }

  console.log("== default-deny: toda ruta deniega sin credencial ==\n");
  check("ninguna ruta corrió con peer remoto y sin credencial", noCreds.length === 0, noCreds);
  check("ninguna ruta aceptó una cookie de dispositivo falsa", fakeCookie.length === 0, fakeCookie);
  console.log(`  (${withGuard} pares ruta+metodo con guardia verificada)\n`);

  // ---------- matriz de scopes sobre rutas concretas ----------
  console.log("== matriz de scopes ==\n");
  {
    const files = {
      browse: path.join(API_ROOT, "agent", "browse", "route.ts"),
      tasksPost: path.join(API_ROOT, "agent", "tasks", "route.ts"),
      cancel: path.join(API_ROOT, "agent", "tasks", "[id]", "cancel", "route.ts"),
      apply: path.join(API_ROOT, "agent", "tasks", "[id]", "apply", "route.ts"),
      devices: path.join(API_ROOT, "devices", "route.ts"),
      threadsPost: path.join(API_ROOT, "threads", "route.ts"),
    };

    const statusOf = async (file: string, method: string, creds: Parameters<typeof requestFor>[2]): Promise<number> => {
      const routeModule = await loadRoute(file);
      const handler = routeModule[method] as Handler | undefined;
      if (typeof handler !== "function") return -1;
      const route = "/" + file.split(path.sep).join("/").replace(/^.*?\/app\//, "").replace(/\/route\.ts$/, "").replace(/\[(\w+)\]/g, ":$1");
      const response = await handler(requestFor(route, method, creds), CTX);
      return response.status;
    };

    check("observe NO puede crear tasks (requiere operate)", (await statusOf(files.tasksPost, "POST", { deviceToken: observer.token, body: { projectId: "x", modelId: "y", prompt: "z" } })) === 403);
    check("observe NO puede cancelar (requiere operate)", (await statusOf(files.cancel, "POST", { deviceToken: observer.token })) === 403);
    check("observe NO puede listar devices (requiere operate)", (await statusOf(files.devices, "GET", { deviceToken: observer.token })) === 403);
    check("observe SÍ puede leer browse (observe)", (await statusOf(files.browse, "GET", { deviceToken: observer.token })) !== 403);
    check("operate NO puede aplicar (requiere approve)", (await statusOf(files.apply, "POST", { deviceToken: operator.token })) === 403);
    check("operate SÍ puede escribir threads (operate)", (await statusOf(files.threadsPost, "POST", { deviceToken: operator.token, body: {} })) !== 403);
    check("approve SIN step-up no puede aplicar", (await statusOf(files.apply, "POST", { deviceToken: approver.token })) === 403);
    // El operador se autentica con APP_ACCESS_TOKEN: hay que definirla en el
    // proceso para que el test pueda ejercitar ese camino.
    process.env.APP_ACCESS_TOKEN = "clave-del-operador";
    check("operador (token de app) puede crear tasks", (await statusOf(files.tasksPost, "POST", { operatorToken: "clave-del-operador", body: { projectId: "x", modelId: "y", prompt: "z" } })) !== 403);
    check("operador con token equivocado: 403", (await statusOf(files.tasksPost, "POST", { operatorToken: "otra-clave", body: { projectId: "x", modelId: "y", prompt: "z" } })) === 403);
    delete process.env.APP_ACCESS_TOKEN;
    check("cookie falsa no puede crear tasks", (await statusOf(files.tasksPost, "POST", { deviceToken: "falsa", body: { projectId: "x", modelId: "y", prompt: "z" } })) === 403);
    check("peer loopback sin credencial puede crear tasks (uso local)", (await statusOf(files.tasksPost, "POST", { peer: "loopback", body: { projectId: "x", modelId: "y", prompt: "z" } })) !== 403);
  }

  console.log(`\n${passed}/${passed + failed} casos OK`);
  if (failed > 0) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
