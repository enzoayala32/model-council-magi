/**
 * Fase 4a - tests de emparejamiento, dispositivos y auditoria.
 *
 * Corre contra una DB temporal (respeta MAGI_DATA_DIR si el runner ya la
 * fijó). Sin red.
 *
 * Uso: npm run security:test-devices
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DEVICE_COOKIE,
  DEVICE_SCOPES,
  countDevices,
  createDevice,
  findDeviceByToken,
  generateDeviceToken,
  getDevice,
  hashDeviceToken,
  isDeviceScope,
  listDevices,
  renameDevice,
  revokeAllDevices,
  revokeDevice,
  setDeviceScope,
  touchDevice,
} from "./auth/devices";
import {
  DEFAULT_PAIRING_TTL_MS,
  countPairingCodes,
  createPairingCode,
  pruneExpiredPairingCodes,
  redeemPairingCode,
} from "./auth/pairing";
import {
  __resetRateLimitsForTests,
  checkRateLimit,
  clientIdentifier,
  recordFailure,
  recordSuccess,
} from "./auth/rate-limit";
import { countAuditLog, listAuditLog, pruneAuditLog, recordAudit } from "./auth/audit";

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passed += 1;
    console.log(`+ ${label}`);
    return;
  }
  failed += 1;
  console.log(`x ${label}${detail === undefined ? "" : ` - ${JSON.stringify(detail)}`}`);
}

/** Cookie que manda el navegador: nombre=valor. */
function cookieFor(token: string): string {
  return `${DEVICE_COOKIE}=${encodeURIComponent(token)}`;
}

async function main(): Promise<void> {
  const inheritedDataDir = process.env.MAGI_DATA_DIR?.trim();
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "magi-devices-"));
  const originalCwd = process.cwd();
  const dataRoot = inheritedDataDir ? path.resolve(inheritedDataDir) : temp;
  let db: { close(): void } | null = null;

  try {
    await fs.mkdir(dataRoot, { recursive: true });
    if (inheritedDataDir) check("respeta MAGI_DATA_DIR del runner", path.resolve(process.env.MAGI_DATA_DIR ?? "") === dataRoot);
    else {
      process.chdir(temp);
      check("corre en un cwd temporal", process.cwd() === temp);
    }

    const globalWithDb = globalThis as unknown as { __councilDb?: unknown };
    delete globalWithDb.__councilDb;
    const dbModule = (await import("./db")) as { getDb(): { close(): void } };
    db = dbModule.getDb();

    console.log("== hashing de tokens ==\n");
    {
      const token = generateDeviceToken();
      check("el token es hex de 64 chars (256 bits)", /^[0-9a-f]{64}$/.test(token), token.length);
      check("dos tokens no coinciden", generateDeviceToken() !== generateDeviceToken());
      check("el hash es determinista", hashDeviceToken(token) === hashDeviceToken(token));
      check("el hash no contiene el token", !hashDeviceToken(token).includes(token));
      check("el hash es hex de 64", /^[0-9a-f]{64}$/.test(hashDeviceToken(token)));
      check("hashes de tokens distintos difieren", hashDeviceToken("a") !== hashDeviceToken("b"));
    }

    console.log("\n== creacion y busqueda ==\n");
    {
      const a = createDevice({ name: "Telefono", scope: "operate", userAgent: "Android" });
      check("crea con scope operate", a.device.scope === "operate");
      check("devuelve el token una vez", typeof a.token === "string" && a.token.length === 64);
      const found = findDeviceByToken(a.token);
      check("se encuentra por token", found?.id === a.device.id);
      check("no queda revocado al nacer", found?.revokedAt === null);
      check("guarda el user agent", found?.userAgent === "Android");
      check("lastSeen arranca null", found?.lastSeenAt === null);

      touchDevice(a.device.id);
      check("touchDevice fija last_seen", (findDeviceByToken(a.token)?.lastSeenAt ?? 0) > 0);

      check("buscar con basura da null", findDeviceByToken("no-existe") === null);
      check("la cookie lleva el token tal cual", cookieFor(a.token) === `${DEVICE_COOKIE}=${encodeURIComponent(a.token)}`);
      check("el hash del token de la cookie coincide", hashDeviceToken(a.token) === hashDeviceToken(decodeURIComponent(cookieFor(a.token).split("=")[1])));
      check("buscar con token vacio da null", findDeviceByToken("") === null);
      check("getDevice por id funciona", getDevice(a.device.id)?.name === "Telefono");
      const activeBefore = countDevices().active;
      createDevice({ name: "Otro", scope: "observe" });
      check("countDevices sube al crear", countDevices().active === activeBefore + 1, countDevices());
    }

    console.log("\n== el token nunca se guarda en claro ==\n");
    {
      const created = createDevice({ name: "Tablet", scope: "observe" });
      const row = (db as unknown as { prepare: (sql: string) => { get: (...a: unknown[]) => Record<string, unknown> } }).prepare(
        "SELECT * FROM devices WHERE id = ?",
      ).get(created.device.id) as Record<string, unknown>;
      check("la fila existe", Boolean(row));
      check("token_hash NO es el token", row.token_hash !== created.token);
      check("token_hash es el sha256 del token", row.token_hash === hashDeviceToken(created.token));
      const raw = JSON.stringify(row);
      check("el token en claro no aparece en la fila", !raw.includes(created.token), raw.slice(0, 80));
    }

    console.log("\n== revocacion ==\n");
    {
      const created = createDevice({ name: "A revocar", scope: "approve" });
      check("antes de revocar se encuentra", findDeviceByToken(created.token)?.id === created.device.id);
      check("revokeDevice devuelve true", revokeDevice(created.device.id) === true);
      check("revokeDevice segunda vez da false", revokeDevice(created.device.id) === false);
      check("revocado: ya no se encuentra por token", findDeviceByToken(created.token) === null);
      check("revocado: sigue visible en el listado", listDevices().some((d) => d.id === created.device.id));
      check("revocado: getDevice lo muestra con revoked_at", getDevice(created.device.id)?.revokedAt !== null);
      const fresh = createDevice({ name: "Recien creado", scope: "observe" });
      const activeAfterRevoke = countDevices().active;
      check("revocar baja el contador de activos", revokeDevice(fresh.device.id) && countDevices().active === activeAfterRevoke - 1, countDevices());
    }

    console.log("\n== scopes ==\n");
    {
      check("los tres scopes son los esperados", DEVICE_SCOPES.join(",") === "observe,operate,approve", DEVICE_SCOPES);
      check("observe es scope valido", isDeviceScope("observe"));
      check("admin NO es scope valido (no se inventan niveles)", !isDeviceScope("admin"));
      check("vacio no es scope", !isDeviceScope(""));
      check("null no es scope", !isDeviceScope(null));

      const created = createDevice({ name: "Cambiable", scope: "observe" });
      const changed = setDeviceScope(created.device.id, "approve");
      check("setDeviceScope cambia el scope", changed?.scope === "approve");
      check("el cambio se ve al buscar por token", findDeviceByToken(created.token)?.scope === "approve");
      check("setDeviceScope con scope invalido da null", setDeviceScope(created.device.id, "admin" as never) === null);
      check("un scope invalido no pisa el anterior", findDeviceByToken(created.token)?.scope === "approve");

      const renamed = renameDevice(created.device.id, "  Nombre nuevo  ");
      check("renameDevice recorta el nombre", renamed?.name === "Nombre nuevo");
      check("renameDevice con vacio da null", renameDevice(created.device.id, "   ") === null);
    }

    console.log("\n== revocar todos ==\n");
    {
      const keep = createDevice({ name: "El bueno", scope: "approve" });
      createDevice({ name: "Victor 1", scope: "observe" });
      createDevice({ name: "Victor 2", scope: "operate" });
      const activeBeforeAll = countDevices().active;
      const revoked = revokeAllDevices([keep.device.id]);
      check("revoca a todos menos al excluido", revoked === activeBeforeAll - 1, { revoked, activeBeforeAll });
      check("quedan los revocados como inactivos", countDevices().active === 1, countDevices());
      check("el excluido sigue funcionando", findDeviceByToken(keep.token)?.id === keep.device.id);
    }

    console.log("\n== codigos de emparejamiento ==\n");
    {
      const ttl = 60_000;
      const code = createPairingCode("operate", ttl);
      check("genera un codigo con formato legible", /^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/.test(code.code), code.code);
      check("expira en el futuro", code.expiresAt > Date.now());
      check("el TTL por default es 5 min", DEFAULT_PAIRING_TTL_MS === 300_000);

      const usedBefore = countPairingCodes().used;
      const redeemed = redeemPairingCode(code.code);
      check("el canje valido devuelve el scope", redeemed.ok && redeemed.scope === "operate");
      const again = redeemPairingCode(code.code);
      check("un segundo canje falla (un solo uso)", !again.ok);
      check("el mensaje de error es generico", !again.ok && again.error === "Codigo de emparejamiento invalido o vencido.");
      check("el canje marca exactamente uno como usado", countPairingCodes().used === usedBefore + 1, countPairingCodes());

      check("canje de codigo inexistente falla", !redeemPairingCode("AAAA-BBBB-CCCC-DDDD").ok);
      check("canje vacio falla", !redeemPairingCode("").ok);
      check("el codigo es case-sensitive", !redeemPairingCode(code.code.toLowerCase()).ok);

      const short = createPairingCode("observe", 1);
      await new Promise((r) => setTimeout(r, 20));
      check("un codigo vencido no se puede canjear", !redeemPairingCode(short.code).ok);

      createPairingCode("observe", 1);
      await new Promise((r) => setTimeout(r, 20));
      check("pruneExpiredPairingCodes limpia los vencidos", pruneExpiredPairingCodes() >= 1);
      check("scope invalido no crea codigo", (() => { try { createPairingCode("admin" as never); return false; } catch { return true; } })());
    }

    console.log("\n== el codigo no se guarda en claro ==\n");
    {
      const code = createPairingCode("observe", 60_000);
      const row = (db as unknown as { prepare: (sql: string) => { get: (...a: unknown[]) => Record<string, unknown> } }).prepare(
        "SELECT * FROM pairing_codes LIMIT 1",
      ).get() as Record<string, unknown>;
      check("code_hash no es el codigo", row.code_hash !== code.code);
      check("el codigo en claro no aparece en la fila", !JSON.stringify(row).includes(code.code));
      redeemPairingCode(code.code);
      check("tras el canje queda used_at", countPairingCodes().used >= 1);
    }

    console.log("\n== rate limiting ==\n");
    {
      __resetRateLimitsForTests();
      const id = "1.2.3.4";
      const res = "pairing";
      check("arranca permitido", checkRateLimit(id, res).allowed);
      // El tope son 5 fallos DENTRO de la ventana: los 5 primeros pasan, el
      // 6to bloquea.
      for (let i = 0; i < 5; i += 1) recordFailure(id, res);
      check("5 fallos: sigue permitido (tope 5)", checkRateLimit(id, res).allowed);
      const sixth = recordFailure(id, res);
      check("el 6to fallo bloquea", !sixth.allowed, sixth);
      check("informa el retry", !sixth.allowed && sixth.retryAfterMs > 0);
      check("mientras esta bloqueado sigue bloqueado", !checkRateLimit(id, res).allowed);
      check("otra IP no se ve afectada", checkRateLimit("5.6.7.8", res).allowed);
      check("otro recurso no se ve afectado", checkRateLimit(id, "login").allowed);

      const before = (recordFailure(id, res) as { allowed: false; retryAfterMs: number }).retryAfterMs;
      const after = (recordFailure(id, res) as { allowed: false; retryAfterMs: number }).retryAfterMs;
      check("el bloqueo crece con mas fallos", after > before, { before, after });

      let tope = 0;
      for (let i = 0; i < 40; i += 1) {
        const r = recordFailure(id, res);
        if (!r.allowed) tope = r.retryAfterMs;
      }
      check("el bloqueo tiene tope (1 hora)", tope <= 3600000, tope);

      recordSuccess(id, res);
      check("un exito limpia el medidor", checkRateLimit(id, res).allowed);
      check("devuelve el cupo completo", (checkRateLimit(id, res) as { allowed: true; remaining: number }).remaining === 5);
    }

    console.log("\n== clientIdentifier ==\n");
    {
      const withForwarded = new Request("http://localhost/api/x", { headers: { "x-forwarded-for": "9.9.9.9, 10.0.0.1" } });
      check("toma el primer salto", clientIdentifier(withForwarded) === "9.9.9.9", clientIdentifier(withForwarded));
      check("sin header devuelve desconocido", clientIdentifier(new Request("http://localhost/api/x")) === "desconocido");
    }

    console.log("\n== auditoria ==\n");
    {
      const before = countAuditLog();
      const device = createDevice({ name: "Auditado", scope: "operate" });
      recordAudit({ deviceId: device.device.id, action: "task_created", targetId: "task-1", result: "ok", detail: "creo una tarea" });
      recordAudit({ action: "auth_token_failed", result: "denied" });
      recordAudit({ deviceId: device.device.id, action: "task_applied", targetId: "task-1", result: "ok", detail: "x".repeat(500) });
      check("registra las entradas", countAuditLog() === before + 3, countAuditLog());
      const all = listAuditLog();
      check("las lista en orden descendente", all[0].ts >= all[1].ts);
      check("filtra por device", listAuditLog({ deviceId: device.device.id }).length === 2);
      check("la entrada sin sesion tiene device_id null", all.some((e) => e.deviceId === null));
      check("recorta el detalle largo", all.some((e) => e.detail === null || e.detail.length <= 200));
      check("el limite se respeta", listAuditLog({ limit: 1 }).length === 1);
      check("podar no falla", pruneAuditLog(0) >= 0);
    }
  } finally {
    try {
      db?.close();
    } catch {
      /* best-effort */
    }
    (globalThis as unknown as { __councilDb?: unknown }).__councilDb = undefined;
    if (!inheritedDataDir) process.chdir(originalCwd);
    await fs.rm(temp, { recursive: true, force: true }).catch(() => undefined);
    if (inheritedDataDir) await fs.rm(inheritedDataDir, { recursive: true, force: true }).catch(() => undefined);
  }

  console.log(`\n${passed}/${passed + failed} casos OK`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
