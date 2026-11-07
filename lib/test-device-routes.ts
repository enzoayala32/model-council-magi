/**
 * Fase 4d - tests de las rutas de gestion y del kill switch.
 *
 * Se invocan los handlers directo (como hacen los otros tests de rutas del
 * repo), con Request construido a mano. Lo que se fija:
 *
 *  - toda ruta de gestion rechaza Hosts que no son loopback;
 *  - listar, renombrar, cambiar scope y revocar funcionan desde loopback;
 *  - cambiar el scope invalida el step-up en curso;
 *  - revocar corta el acceso en la request siguiente;
 *  - REMOTE_ACCESS=off rechaza cualquier Host no loopback (kill switch);
 *  - la auditoria registra los hechos relevantes.
 *
 * Uso: npm run security:test-device-routes
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { evaluateApiRequest } from "./api-security";
import { createDevice, findDeviceByToken, listDevices } from "./auth/devices";
import { enrollDeviceTotp, issueStepUp, isStepUpValid } from "./auth/step-up";
import { counterFor, totpCode } from "./auth/totp";
import { countAuditLog, listAuditLog } from "./auth/audit";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) { passed += 1; console.log(`+ ${label}`); return; }
  failed += 1;
  console.log(`x ${label}${detail === undefined ? "" : ` - ${JSON.stringify(detail)}`}`);
}

// Aislamiento tambien fuera del runner.
if (!process.env.MAGI_DATA_DIR) {
  process.env.MAGI_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "magi-devroutes-test-"));
}

/** Host loopback: la capa HTTP real siempre lo manda. */
function localRequest(url: string, init?: RequestInit): Request {
  const headers = new Headers(init?.headers);
  if (!headers.has("host")) headers.set("host", "localhost:3000");
  if (!headers.has("x-magi-peer")) headers.set("x-magi-peer", "loopback");
  if (!headers.has("x-magi-peer-addr")) headers.set("x-magi-peer-addr", "127.0.0.1");
  return new Request(url, { ...init, headers });
}

const LAN_HOST = "192.168.0.50:3000";

async function main(): Promise<void> {
  console.log("== kill switch REMOTE_ACCESS=off ==\n");
  {
    const saved = process.env.REMOTE_ACCESS;
    const allowed = { ALLOWED_HOSTS: "localhost:3000,192.168.0.50:3000" };

    delete process.env.REMOTE_ACCESS;
    check("sin REMOTE_ACCESS, loopback pasa", evaluateApiRequest({ method: "GET", host: "localhost:3000", hasBody: false }, allowed).ok);

    process.env.REMOTE_ACCESS = "off";
    const lanOff = evaluateApiRequest({ method: "GET", host: LAN_HOST, hasBody: false }, { ...allowed, REMOTE_ACCESS: "off" });
    check("REMOTE_ACCESS=off corta el Host de LAN", !lanOff.ok && lanOff.reason === "remote-access-disabled", lanOff);
    const lanOffEvenWithToken = evaluateApiRequest(
      { method: "GET", host: LAN_HOST, authorization: "Bearer x", hasBody: false },
      { ...allowed, APP_ACCESS_TOKEN: "x", REMOTE_ACCESS: "off" },
    );
    check("y lo corta incluso con credencial valida", !lanOffEvenWithToken.ok, lanOffEvenWithToken);
    const localOff = evaluateApiRequest(
      { method: "GET", host: "localhost:3000", hasBody: false },
      { ...allowed, REMOTE_ACCESS: "off" },
    );
    check("REMOTE_ACCESS=off NO afecta a loopback", localOff.ok, localOff);
    const mutated = evaluateApiRequest(
      { method: "POST", host: LAN_HOST, origin: "http://192.168.0.50:3000", contentType: "application/json", hasBody: true },
      { ...allowed, REMOTE_ACCESS: "off" },
    );
    check("tambien corta los metodos que mutan", !mutated.ok, mutated);
    check("acepta mayusculas/minussculas", !evaluateApiRequest({ method: "GET", host: LAN_HOST, hasBody: false }, { ...allowed, REMOTE_ACCESS: "OFF" }).ok);

    process.env.REMOTE_ACCESS = saved;
    check("sin la variable, la LAN vuelve a permitirse (con credencial)",
      evaluateApiRequest({ method: "GET", host: LAN_HOST, authorization: "Bearer y", hasBody: false }, { ...allowed, APP_ACCESS_TOKEN: "y" }).ok);
  }

  console.log("\n== rutas de gestion: solo loopback ==\n");
  {
    // Los modulos de ruta se importan dinamicamente con URL absoluta: el
    // specifier lleva corchetes y ni TypeScript ni el resolver estatico lo
    // reconocen.
    const { fileURLToPath } = await import("node:url");
    const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");
    const load = async (rel: string) => {
      const spec = pathToFileURL(path.join(REPO_ROOT, "app", "api", rel + ".ts")).href;
      return (await import(spec)) as Record<string, (req: Request, ctx?: { params: Promise<{ id: string }> }) => Promise<Response>>;
    };

    type Ctx = { params: Promise<{ id: string }> };
    type RouteModule = {
      GET?(request: Request, ctx?: Ctx): Promise<Response>;
      PATCH?(request: Request, ctx?: Ctx): Promise<Response>;
      DELETE?(request: Request, ctx?: Ctx): Promise<Response>;
      POST?(request: Request, ctx?: Ctx): Promise<Response>;
    };
    /** Llama un metodo y falla ruidosamente si la ruta no lo exporta. */
    const call = async (module: RouteModule, method: "GET" | "PATCH" | "DELETE" | "POST", url: string, init?: RequestInit, ctx?: Ctx) => {
      const handler = module[method];
      if (!handler) throw new Error(`la ruta no exporta ${method}`);
      return handler(localRequest(url, init), ctx);
    };
    const pathToFileURL = (await import("node:url")).pathToFileURL;

    const devicesList = (await load("devices/route")) as unknown as RouteModule;
    const deviceById = (await load("devices/[id]/route")) as unknown as RouteModule;
    const revokeAll = (await load("devices/revoke-all/route")) as unknown as RouteModule;
    const audit = (await load("audit/route")) as unknown as RouteModule;

    const device = createDevice({ name: "Del test", scope: "observe" });

    const idCtx = { params: Promise.resolve({ id: device.device.id }) };

    // Fuera de loopback: todas rechazan.
    check("GET /api/devices desde LAN: 403", (await call(devicesList, "GET", "http://localhost/api/devices", { method: "GET", headers: { host: LAN_HOST, "x-magi-peer": "remote", "x-magi-peer-addr": "192.168.0.50" } })).status === 403);
    check("PATCH /api/devices/:id desde LAN: 403", (await call(deviceById, "PATCH", "http://localhost/api/devices/x", { method: "PATCH", headers: { host: LAN_HOST, "x-magi-peer": "remote", "x-magi-peer-addr": "192.168.0.50" } }, idCtx)).status === 403);
    check("DELETE /api/devices/:id desde LAN: 403", (await call(deviceById, "DELETE", "http://localhost/api/devices/x", { method: "DELETE", headers: { host: LAN_HOST, "x-magi-peer": "remote", "x-magi-peer-addr": "192.168.0.50" } }, idCtx)).status === 403);
    check("POST /api/devices/revoke-all desde LAN: 403", (await call(revokeAll, "POST", "http://localhost/api/devices/revoke-all", { method: "POST", headers: { host: LAN_HOST, "x-magi-peer": "remote", "x-magi-peer-addr": "192.168.0.50" } })).status === 403);
    check("GET /api/audit desde LAN: 403", (await call(audit, "GET", "http://localhost/api/audit", { method: "GET", headers: { host: LAN_HOST, "x-magi-peer": "remote", "x-magi-peer-addr": "192.168.0.50" } })).status === 403);
    check(
      "el rechazo dice que es solo desde esta PC",
      /esta pc|token de acceso/i.test(await (await call(audit, "GET", "http://localhost/api/audit", { method: "GET", headers: { host: LAN_HOST, "x-magi-peer": "remote", "x-magi-peer-addr": "192.168.0.50" } })).text()),
    );

    // Desde loopback: funcionan.
    const listed = await call(devicesList, "GET", "http://localhost/api/devices");
    check("GET /api/devices desde loopback: 200", listed.status === 200);
    const listedBody = (await listed.json()) as { ok: boolean; devices: Array<{ id: string; name: string }> };
    check("la lista incluye el dispositivo creado", listedBody.devices.some((d) => d.id === device.device.id));
    check("la respuesta trae ok:true", listedBody.ok === true);

    const renamed = await call(deviceById, "PATCH", "http://localhost/api/devices/x", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Nombre nuevo" }) }, idCtx);
    check("PATCH renombra: 200", renamed.status === 200);
    check("el renombre se ve en la lista", listDevices().some((d) => d.name === "Nombre nuevo"));

    const badScope = await call(deviceById, "PATCH", "http://localhost/api/devices/x", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scope: "admin" }) }, idCtx);
    check("PATCH con scope invalido: 400", badScope.status === 400);

    const scopeChanged = await call(deviceById, "PATCH", "http://localhost/api/devices/x", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scope: "approve" }) }, idCtx);
    check("PATCH cambia el scope: 200", scopeChanged.status === 200);
    check("el scope quedo en approve", listDevices().some((d) => d.id === device.device.id && d.scope === "approve"));

    const missing = await call(deviceById, "PATCH", "http://localhost/api/devices/x", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "x" }) }, { params: Promise.resolve({ id: "no-existe" }) });
    check("PATCH de dispositivo inexistente: 404", missing.status === 404);
  }

  console.log("\n== step-up, revocacion y auditoria ==\n");
  {
    const { fileURLToPath, pathToFileURL } = await import("node:url");
    const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");
    const load = async (rel: string) => {
      const spec = pathToFileURL(path.join(REPO_ROOT, "app", "api", rel + ".ts")).href;
      return (await import(spec)) as unknown as Record<string, (req: Request, ctx?: { params: Promise<{ id: string }> }) => Promise<Response>>;
    };
    // Mismo shape que en el bloque de arriba.
    type Ctx = { params: Promise<{ id: string }> };
    type RouteModule = {
      GET?(request: Request, ctx?: Ctx): Promise<Response>;
      PATCH?(request: Request, ctx?: Ctx): Promise<Response>;
      DELETE?(request: Request, ctx?: Ctx): Promise<Response>;
      POST?(request: Request, ctx?: Ctx): Promise<Response>;
    };
    const call = async (module: RouteModule, method: "GET" | "PATCH" | "DELETE" | "POST", url: string, init?: RequestInit, ctx?: Ctx) => {
      const handler = module[method];
      if (!handler) throw new Error(`la ruta no exporta ${method}`);
      return handler(localRequest(url, init), ctx);
    };
    const deviceById = (await load("devices/[id]/route")) as unknown as RouteModule;
    const revokeAll = (await load("devices/revoke-all/route")) as unknown as RouteModule;

    // Cambiar el scope invalida el step-up en curso.
    process.env.MAGI_TOTP_KEY = "pepper-de-rutas";
    const device = createDevice({ name: "Con step-up", scope: "approve" });
    const enroll = enrollDeviceTotp(device.device.id, { account: device.device.name, issuer: "Consenso IA" });
    if ("error" in enroll) {
      check("la inscripcion funciono (precondicion)", false, enroll);
    } else {
      const token = issueStepUp(device.device.id, totpCode(enroll.secret, counterFor(Date.now())));
      check("emite step-up", typeof token === "string");
      check("el step-up es valido", isStepUpValid(device.device.id, token));
      const changed = await call(deviceById, "PATCH", "http://localhost/api/devices/x", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scope: "operate" }) }, { params: Promise.resolve({ id: device.device.id }) });
      check("bajar el scope: 200", changed.status === 200);
      check("el step-up quedo invalidado por el cambio de scope", !isStepUpValid(device.device.id, token));
    }
    delete process.env.MAGI_TOTP_KEY;

    // Revocar corta el acceso en la siguiente request.
    const doomed = createDevice({ name: "A revocar", scope: "approve" });
    check("antes de revocar se encuentra", findDeviceByToken(doomed.token)?.id === doomed.device.id);
    const revoked = await call(deviceById, "DELETE", "http://localhost/api/devices/x", { method: "DELETE" }, { params: Promise.resolve({ id: doomed.device.id }) });
    check("DELETE revoca: 200", revoked.status === 200);
    check("revocado: ya no se encuentra por token", findDeviceByToken(doomed.token) === null);
    check("revocado: sigue en la lista (borrado logico)", listDevices().some((d) => d.id === doomed.device.id));

    const again = await call(deviceById, "DELETE", "http://localhost/api/devices/x", { method: "DELETE" }, { params: Promise.resolve({ id: doomed.device.id }) });
    check("revocar dos veces: 404", again.status === 404);

    // Revocar todos, dejando uno afuera.
    const keep = createDevice({ name: "El que se salva", scope: "observe" });
    createDevice({ name: "Victima 1", scope: "operate" });
    createDevice({ name: "Victima 2", scope: "approve" });
    // Se mide el delta sobre los activos que habria ANTES: bloques previos
    // del test dejaron algunos, y el número exacto depende del orden.
    const activeBefore = listDevices().filter((d) => d.revokedAt === null).length;
    const all = await call(revokeAll, "POST", "http://localhost/api/devices/revoke-all", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ exceptId: keep.device.id }) });
    check("revoke-all: 200", all.status === 200);
    const allBody = (await all.json()) as { ok: boolean; revoked: number };
    check("revoco a todos menos al excluido", allBody.revoked === activeBefore - 1, { revoked: allBody.revoked, activeBefore });
    check("el excluido sigue activo", findDeviceByToken(keep.token)?.id === keep.device.id);

    const allNoExcept = await call(revokeAll, "POST", "http://localhost/api/devices/revoke-all", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
    check("revoke-all sin exclusionado: 200", allNoExcept.status === 200);
    check("el resto quedo inactivo", listDevices().filter((d) => d.revokedAt === null).length === 0, listDevices().length);

    // Auditoria: quedo rastro de todo esto.
    const entries = listAuditLog({ limit: 500 });
    check("la auditoria registro los cambios", entries.length > 0, entries.length);
    check("registro la revocacion", entries.some((e) => e.action === "device_revoked"));
    check("registro el cambio de scope", entries.some((e) => e.action === "device_scope_changed"));
    check("registro el revoke-all", entries.some((e) => e.action === "device_revoke_all"));
    const before = countAuditLog();
    const pruned = (await load("audit/route")) as unknown as RouteModule;
    const pruneRes = await call(pruned, "POST", "http://localhost/api/audit", { method: "POST" });
    check("POST /api/audit poda: 200", pruneRes.status === 200);
    const pruneBody = (await pruneRes.json()) as { ok: boolean; deleted: number; retentionDays: number };
    check("la poda informa la retencion", pruneBody.retentionDays === 90, pruneBody);
    check("la poda no borro entradas recientes", countAuditLog() >= before - pruneBody.deleted);
    void entries;
  }

  console.log(`\n${passed}/${passed + failed} casos OK`);
  if (failed > 0) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
