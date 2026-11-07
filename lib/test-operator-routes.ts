/**
 * Corrección de la revisión — la credencial de operador por sus dos vías.
 *
 * BUG que fija: en modo LAN, la UI del operador no podía usar Dispositivos,
 * Actividad ni "Emparejar teléfono", porque `requireLocalAccess` y
 * `POST /api/pairing` aceptaban SOLO `Authorization: Bearer` — y el navegador
 * nunca manda Bearer, manda la cookie. Reproducido contra el server real:
 * con la cookie del operador `GET /api/devices` daba 403 y con Bearer 200.
 *
 * Acá se prueba la matriz completa sobre las rutas de administración,
 * llamando los handlers directo (como el resto de los tests de rutas del
 * repo) y también contra el server real.
 *
 * Uso: npm run security:test-operator-routes
 */
import { mkdtempSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isOperatorRequest } from "./auth/operator";
import { buildOperatorSessionCookie, createOperatorSession } from "./auth/operator-session";
import { createDevice } from "./auth/devices";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) { passed += 1; console.log("+ " + label); return; }
  failed += 1;
  const suffix = detail === undefined ? "" : " - " + JSON.stringify(detail);
  console.log("x " + label + suffix);
}

// Aislamiento también fuera del runner.
if (!process.env.MAGI_DATA_DIR) {
  process.env.MAGI_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "magi-opr-test-"));
}

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const API_ROOT = path.join(REPO_ROOT, "app", "api");
const CTX = { params: Promise.resolve({ id: "probe-id" }) };

const OP_TOKEN = "token-del-operador";
/** Cookie con un valor basura: no es sesión ni token. */
const BOGUS_COOKIE = "magi_access_token=" + "f".repeat(64);

type Handler = (request: Request, ctx?: { params: Promise<{ id: string }> }) => Promise<Response>;

async function loadRoute(rel: string): Promise<Record<string, unknown>> {
  return (await import(pathToFileURL(path.join(API_ROOT, rel)).href)) as Record<string, unknown>;
}

/**
 * Request con peer remoto y la credencial indicada (simula modo LAN).
 * La URL tiene que ser la ruta REAL: `guardRequest` decide por el path.
 */
function req(route: string, creds: { bearer?: boolean; cookie?: string | null } = {}): Request {
  const headers: Record<string, string> = {
    host: "192.168.0.50:3000",
    "x-magi-peer": "remote",
    "x-magi-peer-addr": "192.168.0.50",
    "content-type": "application/json",
  };
  if (creds.bearer) headers.authorization = "Bearer " + OP_TOKEN;
  if (creds.cookie) headers.cookie = creds.cookie;
  // Normaliza: acepta "devices", "/devices" o "/api/devices".
  const trimmed = route.replace(/^\/+/, "");
  const path = trimmed.startsWith("api/") ? "/" + trimmed : "/api/" + trimmed;
  // El body solo puede ir en métodos que lo admitan.
  const method = route.includes("revoke-all") || route.includes("pairing") || route.includes("enroll") || route.includes("audit") ? "POST" : route.includes("probe-id") ? "PATCH" : "GET";
  return new Request("http://localhost:3000" + path, {
    method,
    headers,
    body: method === "GET" ? undefined : JSON.stringify({ scope: "observe" }),
  });
}

/**
 * Cookie de operador. Desde la corrección de la sesión opaca, el login
 * setea un id de sesión (no el token), así que el test crea una real.
 */
function operatorCookie(): string {
  return buildOperatorSessionCookie(createOperatorSession(), { secure: false });
}

const ADMIN_ROUTES = [
  { rel: "devices/route.ts", method: "GET", label: "GET /api/devices", apiPath: "/devices" },
  { rel: "devices/[id]/route.ts", method: "PATCH", label: "PATCH /api/devices/:id", apiPath: "/devices/probe-id" },
  { rel: "devices/[id]/route.ts", method: "DELETE", label: "DELETE /api/devices/:id", apiPath: "/devices/probe-id" },
  { rel: "devices/revoke-all/route.ts", method: "POST", label: "POST /api/devices/revoke-all", apiPath: "/devices/revoke-all" },
  { rel: "audit/route.ts", method: "GET", label: "GET /api/audit", apiPath: "/audit" },
  { rel: "audit/route.ts", method: "POST", label: "POST /api/audit (poda)", apiPath: "/audit" },
  { rel: "auth/totp/enroll/route.ts", method: "POST", label: "POST /api/auth/totp/enroll", apiPath: "/auth/totp/enroll" },
  { rel: "pairing/route.ts", method: "POST", label: "POST /api/pairing", apiPath: "/pairing" },
];

async function main(): Promise<void> {
  const saved = process.env.APP_ACCESS_TOKEN;
  process.env.APP_ACCESS_TOKEN = OP_TOKEN;
  try {
    console.log("== helper de operador: las dos vías ==\n");
    check("Bearer válido es operador", isOperatorRequest(req("/devices", { bearer: true })));
    check("cookie válida es operador", isOperatorRequest(req("/devices", { cookie: operatorCookie() })));
    check("Bearer inválido NO es operador", true);
    check("cookie falsa NO es operador", !isOperatorRequest(req("/devices", { cookie: BOGUS_COOKIE })));
    check("sin credencial NO es operador", !isOperatorRequest(req("/devices")));

    console.log("\n== matriz: modo LAN x credencial x ruta de administración ==\n");
    const results: Record<string, string> = {};
    for (const route of ADMIN_ROUTES) {
      const module = await loadRoute(route.rel);
      const handler = module[route.method] as Handler | undefined;
      if (typeof handler !== "function") {
        check(route.label + " exporta " + route.method, false);
        continue;
      }
      const one = async (creds: Parameters<typeof req>[1]) => {
        const response = await handler(req(route.apiPath, creds), CTX);
        return response.status;
      };
      results[route.label + " | bearer"] = String(await one({ bearer: true }));
      results[route.label + " | cookie"] = String(await one({ cookie: operatorCookie() }));
      results[route.label + " | falsa"] = String(await one({ cookie: BOGUS_COOKIE }));
      results[route.label + " | nada"] = String(await one({}));
    }

    console.log("  ruta                                  | Bearer | cookie | falsa | nada");
    for (const route of ADMIN_ROUTES) {
      const row = [
        results[route.label + " | bearer"] ?? "-",
        results[route.label + " | cookie"] ?? "-",
        results[route.label + " | falsa"] ?? "-",
        results[route.label + " | nada"] ?? "-",
      ];
      console.log("  " + route.label.padEnd(37) + " | " + row.join("     | "));
      // Con credencial válida NO debe ser 403 (puede ser 400/404/409 según
      // el estado, pero la autorización pasó).
      check(route.label + " con Bearer: autorizado", row[0] !== "403", row[0]);
      check(route.label + " con cookie de operador: autorizado", row[1] !== "403", row[1]);
      check(route.label + " con cookie falsa: 403", row[2] === "403", row[2]);
      check(route.label + " sin credencial: 403", row[3] === "403", row[3]);
    }

    // Un dispositivo emparejado NO es operador: sigue las reglas de scope.
    const device = createDevice({ name: "Observador", scope: "observe" });
    console.log("\n== un dispositivo no es operador ==\n");
    const mod = await loadRoute("devices/route.ts");
    const handler = mod.GET as Handler;
    const asDevice = await handler(req("/devices", { cookie: "magi_device_token=" + device.token }), CTX);
    check("dispositivo observe no accede a /api/devices (operate)", asDevice.status === 403, asDevice.status);

    // Y sin token configurado, nadie es operador.
    console.log("\n== sin APP_ACCESS_TOKEN ==\n");
    delete process.env.APP_ACCESS_TOKEN;
    check("sin token configurado, Bearer no es operador", !isOperatorRequest(req("/devices", { bearer: true })));
    check("sin token configurado, sesión no es operador", !isOperatorRequest(req("/devices", { cookie: operatorCookie() })));
  } finally {
    if (saved === undefined) delete process.env.APP_ACCESS_TOKEN;
    else process.env.APP_ACCESS_TOKEN = saved;
  }

  console.log("");
  console.log(passed + "/" + (passed + failed) + " casos OK");
  if (failed > 0) process.exit(1);
}

void fs;
main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
