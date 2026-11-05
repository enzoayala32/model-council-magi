/**
 * Fase 4b - cobertura de scopes.
 *
 * REGLA que hace cumplir: ninguna ruta bajo app/api puede quedar sin scope
 * declarado. El test recorre el arbol real de route.ts, deriva la ruta y los
 * metodos que exporta, y exige que cada combinacion tenga una entrada en
 * `lib/auth/scopes.ts`. Si alguien agrega un endpoint y se olvida de
 * clasificarlo, esta prueba falla con la lista de lo que falta.
 *
 * Uso: npm run security:test-route-scopes
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authorize, resolveAuthContext } from "./auth/authorize";
import { isLoopbackHost, patternRegex, ROUTE_RULES, ruleFor, scopeSatisfies, type HttpMethod } from "./auth/scopes";
import { createDevice, findDeviceByToken } from "./auth/devices";
import { DEVICE_SCOPES } from "./auth/devices";

// Aislamiento tambien FUERA del runner: si nadie fijo MAGI_DATA_DIR, se crea
// un temporal. `lib/db.ts` resuelve el directorio dentro de `getDb()` (no como
// constante de modulo), asi que ponerlo acalcanza con ponerlo antes de la
// primera consulta — incluso aunque los imports estaticos ya hayan cargado el
// modulo. Sin esto, correr este test a mano escribia en data/council.db real.
if (!process.env.MAGI_DATA_DIR) {
  process.env.MAGI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "magi-auth-test-"));
}


let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) { passed += 1; console.log(`+ ${label}`); return; }
  failed += 1;
  console.log(`x ${label}${detail === undefined ? "" : ` - ${JSON.stringify(detail)}`}`);
}

// `fileURLToPath` (no `URL.pathname`): en Windows devuelve la letra de
// unidad correcta; con `pathname` queda "C:\C:\...".
const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const API_ROOT = path.join(REPO_ROOT, "app", "api");

type FoundRoute = { route: string; file: string; methods: HttpMethod[] };

function discoverRoutes(): FoundRoute[] {
  const out: FoundRoute[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (entry.name !== "route.ts") continue;
      // `full` es absoluta (C:/.../app/api/...), asi que hay que recortar
      // TODO lo anterior a "app/", no solo un "app/" inicial.
      const rel = full
        .split(path.sep)
        .join("/")
        .replace(/^.*?\/app\//, "")
        .replace(/\/route\.ts$/, "");
      const route = "/" + rel.replace(/\[(\w+)\]/g, ":$1");
      const src = fs.readFileSync(full, "utf8");
      const BS = String.fromCharCode(92);
      const re = new RegExp("export" + BS + "s+(?:async" + BS + "s+)?function" + BS + "s+(GET|POST|PUT|PATCH|DELETE)", "g");
      const methods: HttpMethod[] = [];
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        const method = m[1] as HttpMethod;
        if (!methods.includes(method)) methods.push(method);
      }
      out.push({ route, file: full.split(path.sep).join("/"), methods });
    }
  };
  walk(API_ROOT);
  return out.sort((a, b) => a.route.localeCompare(b.route));
}

async function main(): Promise<void> {
  const discovered = discoverRoutes();
  console.log("== cobertura: toda ruta clasificada ==\n");

  check("se descubrieron rutas en app/api", discovered.length >= 25, discovered.length);
  console.log(`  (${discovered.length} archivos route.ts encontrados)\n`);

  const missing: string[] = [];
  const unclassified: string[] = [];
  for (const found of discovered) {
    for (const method of found.methods) {
      const rule = ruleFor(method, found.route);
      if (!rule) unclassified.push(`${method} ${found.route}`);
    }
    // El path con parametros debe matchear el patron declarado.
    if (found.methods.length === 0) missing.push(`${found.route} (sin metodos exportados?)`);
  }
  check("ninguna ruta sin scope declarado", unclassified.length === 0, unclassified);
  check("todas las rutas exportan metodos", missing.length === 0, missing);

  // Al reves: cada entrada de la tabla debe corresponder a una ruta real.
  // Inverso: cada regla debe apuntar a algo REAL. Se matchea contra el
  // patron propio (no contra `ruleFor`, que aplica precedencia y puede
  // dejar una regla mas generica sin matches directos).
  const declaredButMissing: string[] = [];
  for (const rule of ROUTE_RULES) {
    const regex = patternRegex(rule.pattern);
    const matches = discovered.filter((f) => f.methods.includes(rule.method) && regex.test(f.route));
    if (matches.length === 0) declaredButMissing.push(`${rule.method} ${rule.pattern}`);
  }
  check("ninguna regla apunta a una ruta inexistente", declaredButMissing.length === 0, declaredButMissing);

  // Cada metodo de cada ruta debe estar cubierto por ALGUNA regla.
  const methodGaps: string[] = [];
  for (const found of discovered) {
    for (const method of found.methods) {
      // ruleFor ya se verifico arriba; acá solo se confirma que no queden
      // metodos huerfanos dentro de una ruta que si tiene reglas.
      if (!ruleFor(method, found.route)) methodGaps.push(`${method} ${found.route}`);
    }
  }
  check("no hay metodos huerfanos", methodGaps.length === 0, methodGaps);

  console.log("\n== las reglas mas sensibles ==\n");
  {
    const apply = ruleFor("POST", "/api/agent/tasks/abc/apply");
    check("apply exige approve", apply?.scope === "approve", apply);
    check("apply exige step-up", apply?.stepUp === true, apply);
    const discard = ruleFor("POST", "/api/agent/tasks/abc/discard");
    check("discard exige approve", discard?.scope === "approve", discard);
    const councilApply = ruleFor("POST", "/api/council/apply-file-change");
    check("apply-file-change exige approve + step-up", councilApply?.scope === "approve" && councilApply.stepUp === true, councilApply);
    const stream = ruleFor("POST", "/api/council/stream");
    check("stream exige operate (gasta cuota)", stream?.scope === "operate", stream);
    const cancel = ruleFor("POST", "/api/agent/tasks/abc/cancel");
    check("cancel exige operate", cancel?.scope === "operate", cancel);
    const create = ruleFor("POST", "/api/agent/tasks");
    check("crear task exige operate", create?.scope === "operate", create);
    const events = ruleFor("GET", "/api/agent/tasks/abc/events");
    check("eventos (SSE) exige observe", events?.scope === "observe", events);
    const subscribe = ruleFor("POST", "/api/pairing/redeem");
    check("el canje es publico", subscribe?.scope === "public", subscribe);
    const login = ruleFor("POST", "/api/auth/token");
    check("el login es publico", login?.scope === "public", login);
  }

  console.log("\n== matcher de patrones ==\n");
  {
    check("matchea con parametro", ruleFor("GET", "/api/agent/tasks/abc")?.method === "GET");
    check("no matchea otro metodo", ruleFor("DELETE", "/api/agent/tasks/abc/apply") === null);
    check("no matchea ruta desconocida", ruleFor("GET", "/api/no/existe") === null);
    check("los parametros no cruzan segmentos", ruleFor("GET", "/api/agent/tasks/a/b") === null);
    check("una ruta mas larga no matchea", ruleFor("GET", "/api/agent/tasks/abc/extra") === null);
    // Precedencia como Next: el segmento estatico le gana al dinamico.
    check("compare le gana a :id", ruleFor("GET", "/api/council/runs/compare")?.pattern === "/api/council/runs/compare", ruleFor("GET", "/api/council/runs/compare"));
    check("un id cualquiera sigue yendo a :id", ruleFor("GET", "/api/council/runs/otro-id")?.pattern === "/api/council/runs/:id");
    check("export es mas especifico que :id", ruleFor("GET", "/api/council/runs/abc/export")?.pattern === "/api/council/runs/:id/export");
  }

  console.log("\n== los scopes son jerarquicos ==\n");
  {
    check("observe alcanza observe", scopeSatisfies("observe", "observe"));
    check("operate alcanza observe", scopeSatisfies("operate", "observe"));
    check("approve alcanza operate", scopeSatisfies("approve", "operate"));
    check("observe NO alcanza operate", !scopeSatisfies("observe", "operate"));
    check("operate NO alcanza approve", !scopeSatisfies("operate", "approve"));
    check("approve alcanza todo", scopeSatisfies("approve", "observe") && scopeSatisfies("approve", "approve"));
    check("los tres scopes existen", DEVICE_SCOPES.join(",") === "observe,operate,approve", DEVICE_SCOPES);
  }

  console.log("\n== autorizacion: quien puede que ==\n");
  {
    const saved = { ...process.env };
    try {
      // --- sin credencial configurada, loopback implicito ---
      delete process.env.APP_ACCESS_TOKEN;
      const localRead = authorize({
        method: "GET", pathname: "/api/agent/tasks",
        request: { headers: { get: (n: string) => (n === "host" ? "localhost:3000" : null) } },
      });
      check("loopback sin credencial: lectura permitida (uso local)", localRead.ok, localRead);
      const localWrite = authorize({
        method: "POST", pathname: "/api/agent/tasks",
        request: { headers: { get: (n: string) => (n === "host" ? "127.0.0.1:3000" : null) } },
      });
      check("loopback sin credencial: escritura permitida (uso local)", localWrite.ok, localWrite);
      const localApply = authorize({
        method: "POST", pathname: "/api/agent/tasks/x/apply",
        request: { headers: { get: (n: string) => (n === "host" ? "localhost:3000" : null) } },
      });
      check("loopback sin credencial: apply permitido (es la PC)", localApply.ok, localApply);

      const remoteRead = authorize({
        method: "GET", pathname: "/api/agent/tasks",
        request: { headers: { get: (n: string) => (n === "host" ? "192.168.0.50:3000" : null) } },
      });
      check("remoto sin credencial: DENEGADO", !remoteRead.ok, remoteRead);

      // --- con token del operador ---
      process.env.APP_ACCESS_TOKEN = "secreto-operador";
      const withToken = authorize({
        method: "POST", pathname: "/api/agent/tasks/x/apply",
        request: { headers: { get: (n: string) => (n === "authorization" ? "Bearer secreto-operador" : n === "host" ? "localhost:3000" : null) } },
      });
      check("token del operador: apply permitido (es el operador)", withToken.ok, withToken);
      check("y se marca como operator", withToken.ok && withToken.context.operator === true, withToken);

      const badToken = authorize({
        method: "GET", pathname: "/api/agent/tasks",
        request: { headers: { get: (n: string) => (n === "authorization" ? "Bearer otro" : n === "host" ? "localhost:3000" : null) } },
      });
      check("token incorrecto en loopback: DENEGADO", !badToken.ok, badToken);

      // --- dispositivos por scope ---
      const observer = createDevice({ name: "Observador", scope: "observe" });
      const operator = createDevice({ name: "Operador", scope: "operate" });
      const withDevice = (device: { token: string }, method: string, pathname: string, stepUpValid?: boolean) =>
        authorize({
          method, pathname, stepUpValid,
          request: { headers: { get: (n: string) => (n === "cookie" ? `magi_device_token=${device.token}` : n === "host" ? "192.168.0.50:3000" : null) } },
        });

      check("observe puede leer tareas", withDevice(observer, "GET", "/api/agent/tasks").ok);
      check("observe puede ver eventos (SSE)", withDevice(observer, "GET", "/api/agent/tasks/x/events").ok);
      check("observe NO puede crear tareas", !withDevice(observer, "POST", "/api/agent/tasks").ok, withDevice(observer, "POST", "/api/agent/tasks"));
      check("observe NO puede cancelar", !withDevice(observer, "POST", "/api/agent/tasks/x/cancel").ok);
      check("observe NO puede aplicar", !withDevice(observer, "POST", "/api/agent/tasks/x/apply").ok);

      check("operate puede crear tareas", withDevice(operator, "POST", "/api/agent/tasks").ok);
      check("operate puede cancelar", withDevice(operator, "POST", "/api/agent/tasks/x/cancel").ok);
      check("operate NO puede aplicar", !withDevice(operator, "POST", "/api/agent/tasks/x/apply").ok);
      check("operate NO puede descartar", !withDevice(operator, "POST", "/api/agent/tasks/x/discard").ok);
      check("operate puede leer (hereda observe)", withDevice(operator, "GET", "/api/agent/tasks").ok);

      const approver = createDevice({ name: "Aprobador", scope: "approve" });
      const applyNoStepUp = withDevice(approver, "POST", "/api/agent/tasks/x/apply");
      check("approve SIN step-up: apply DENEGADO", !applyNoStepUp.ok, applyNoStepUp);
      check("el motivo es step-up", !applyNoStepUp.ok && applyNoStepUp.reason === "step_up_requerido", applyNoStepUp);
      const applyWithStepUp = withDevice(approver, "POST", "/api/agent/tasks/x/apply", true);
      check("approve CON step-up: apply permitido", applyWithStepUp.ok, applyWithStepUp);
      check("approve puede descartar con step-up", withDevice(approver, "POST", "/api/agent/tasks/x/discard", true).ok);
      check("approve puede leer sin step-up", withDevice(approver, "GET", "/api/agent/tasks").ok);

      // Revocado: se corta en la siguiente request.
      const doomed = createDevice({ name: "Condenado", scope: "approve" });
      check("antes de revocar puede aplicar", withDevice(doomed, "POST", "/api/agent/tasks/x/apply", true).ok);
      const { revokeDevice } = await import("./auth/devices");
      check("revocar devuelve true", revokeDevice(doomed.device.id) === true);
      check("revocado: DENEGADO de inmediato", !withDevice(doomed, "GET", "/api/agent/tasks").ok);

      // Ruta sin clasificar: fail closed.
      const unknown = authorize({
        method: "GET", pathname: "/api/ruta/inventada",
        request: { headers: { get: (n: string) => (n === "authorization" ? "Bearer secreto-operador" : n === "host" ? "localhost:3000" : null) } },
      });
      check("ruta sin clasificar: DENEGADA incluso con token", !unknown.ok, unknown);
      check("y el motivo es unclassified_route", !unknown.ok && unknown.reason === "unclassified_route", unknown);

      // Ruta publica: pasa sin identidad.
      const loginRoute = authorize({
        method: "POST", pathname: "/api/auth/token",
        request: { headers: { get: (n: string) => (n === "host" ? "192.168.0.50:3000" : null) } },
      });
      check("el login pasa sin identidad (ruta publica)", loginRoute.ok, loginRoute);
    } finally {
      process.env = saved;
    }
  }

  console.log("\n== contexto de autenticacion ==\n");
  {
    check("localhost es loopback", isLoopbackHost("localhost:3000"));
    check("127.0.0.1 es loopback", isLoopbackHost("127.0.0.1"));
    check("una IP de LAN no es loopback", !isLoopbackHost("192.168.0.50:3000"));
    check("un dominio no es loopback", !isLoopbackHost("mi-tunnel.tailnet.ts.net"));

    const ctx = resolveAuthContext({ headers: { get: (n: string) => (n === "host" ? "localhost:3000" : null) } });
    check("loopback sin credencial: localImplicit", ctx.localImplicit === true, ctx);
    check("y no es dispositivo ni operador", ctx.device === null && ctx.operator === false, ctx);

    const ctx2 = resolveAuthContext({ headers: { get: (n: string) => (n === "host" ? "192.168.0.50:3000" : null) } });
    check("remoto sin credencial: no es localImplicito", ctx2.localImplicit === false, ctx2);

    process.env.APP_ACCESS_TOKEN = "secreto";
    const ctx3 = resolveAuthContext({ headers: { get: (n: string) => (n === "authorization" ? "Bearer secreto" : n === "host" ? "localhost:3000" : null) } });
    check("con token valido: operator", ctx3.operator === true && ctx3.localImplicit === false, ctx3);
    delete process.env.APP_ACCESS_TOKEN;
  }

  console.log("\n== persistencia: el dispositivo sigue ahi ==\n");
  {
    // La DB aislada del runner sigue viva: se comprueba que lo creado en la
    // seccion anterior sigue siendo encontrable por token (el hash funciona).
    const created = createDevice({ name: "Persistente", scope: "approve" });
    check("se encuentra por token despues de creado", findDeviceByToken(created.token)?.id === created.device.id);
    check("con el scope pedido", findDeviceByToken(created.token)?.scope === "approve");
  }

  console.log(`\n${passed}/${passed + failed} casos OK`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
