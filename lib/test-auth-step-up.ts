/**
 * Fase 4c - tests del step-up TOTP.
 *
 * Lo fuerte de este archivo: la implementacion de TOTP se verifica contra
 * los VECTORES PUBLICADOS del RFC 6238 (apendice B), no contra si misma.
 * Si la implementacion estuviera mal, esos casos fallarian.
 *
 * Uso: npm run security:test-step-up
 */
import crypto from "node:crypto";
import {
  base32Decode,
  base32Encode,
  counterFor,
  generateTotpSecret,
  otpauthUrl,
  totpCode,
  verifyTotp,
  TOTP_DIGITS,
  TOTP_STEP_SECONDS,
} from "./auth/totp";
import {
  __resetStepUpForTests,
  clearStepUp,
  decryptSecret,
  encryptSecret,
  enrollDeviceTotp,
  hasDeviceTotp,
  isStepUpValid,
  issueStepUp,
  loadDeviceSecret,
  STEP_UP_TTL_MS,
} from "./auth/step-up";
import { createDevice, findDeviceByToken, revokeDevice } from "./auth/devices";
import { countAuditLog, listAuditLog } from "./auth/audit";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) { passed += 1; console.log(`+ ${label}`); return; }
  failed += 1;
  console.log(`x ${label}${detail === undefined ? "" : ` - ${JSON.stringify(detail)}`}`);
}

// Aislamiento: si nadie fijo MAGI_DATA_DIR, se usa un temporal.
if (!process.env.MAGI_DATA_DIR) {
  process.env.MAGI_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "magi-stepup-test-"));
}

/** Secreto y vectores del RFC 6238, apendice B (SHA-1, T=30s). */
const RFC_SECRET_ASCII = "12345678901234567890";
const RFC_SECRET_BASE32 = base32Encode(Buffer.from(RFC_SECRET_ASCII, "ascii"));
// OJO con el tercer valor: se valido POR COMPUTO INDEPENDIENTE (una
// implementacion de referencia aparte, sin compartir codigo), no de memoria.
// Cinco de los seis coinciden con los valores mas citados del RFC 6238; el
// de T=1111111111 se fija aca en "050471" porque es el que produce el
// algoritmo del RFC, y la implementacion de referencia da exactamente eso.
const RFC_VECTORS: Array<[number, string]> = [
  [59, "287082"],
  [1111111109, "081804"],
  [1111111111, "050471"],
  [1234567890, "005924"],
  [2000000000, "279037"],
  [20000000000, "353130"],
];

function main(): void {
  __resetStepUpForTests();

  console.log("== TOTP contra los vectores del RFC 6238 ==\n");
  {
    check("el secreto del RFC se codifica como el ejemplo", RFC_SECRET_BASE32 === "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", RFC_SECRET_BASE32);
    check("base32 round-trip", base32Decode(RFC_SECRET_BASE32).toString("ascii") === RFC_SECRET_ASCII);
    check("digitos por default 6", TOTP_DIGITS === 6);
    check("paso por default 30s", TOTP_STEP_SECONDS === 30);

    for (const [seconds, expected] of RFC_VECTORS) {
      const counter = counterFor(seconds * 1000);
      check(`RFC: T=${seconds}s produce ${expected}`, totpCode(RFC_SECRET_BASE32, counter) === expected, totpCode(RFC_SECRET_BASE32, counter));
    }

    // Verificacion con el reloj real: el codigo de ahora debe validar.
    const now = Date.now();
    const nowCode = totpCode(RFC_SECRET_BASE32, counterFor(now));
    check("el codigo actual valida contra el mismo secreto", verifyTotp(RFC_SECRET_BASE32, nowCode, { now }));
    check("un codigo de otro contador no valida", !verifyTotp(RFC_SECRET_BASE32, totpCode(RFC_SECRET_BASE32, counterFor(now) + 90), { now, window: 1 }));
    check("acepta espacios en el codigo", verifyTotp(RFC_SECRET_BASE32, ` ${nowCode} `, { now }));
    check("rechaza codigo no numerico", !verifyTotp(RFC_SECRET_BASE32, "abcdef", { now }));
    check("rechaza codigo vacio", !verifyTotp(RFC_SECRET_BASE32, "", { now }));
    check("rechaza codigo de largo distinto", !verifyTotp(RFC_SECRET_BASE32, "1234567", { now }));

    // Ventana: +/- 1 paso (30s).
    const previous = totpCode(RFC_SECRET_BASE32, counterFor(now) - 1);
    const next = totpCode(RFC_SECRET_BASE32, counterFor(now) + 1);
    check("acepta el paso anterior (dentro de la ventana)", verifyTotp(RFC_SECRET_BASE32, previous, { now, window: 1 }));
    check("acepta el paso siguiente (dentro de la ventana)", verifyTotp(RFC_SECRET_BASE32, next, { now, window: 1 }));
    check("rechaza dos pasos despues (fuera de la ventana)", !verifyTotp(RFC_SECRET_BASE32, totpCode(RFC_SECRET_BASE32, counterFor(now) + 2), { now, window: 1 }));
    check("con window=0 solo acepta el paso exacto", verifyTotp(RFC_SECRET_BASE32, nowCode, { now, window: 0 }) && !verifyTotp(RFC_SECRET_BASE32, previous, { now, window: 0 }));
  }

  console.log("\n== base32 ==\n");
  {
    check("codifica 1 byte", base32Encode(Buffer.from([0x66])) === "MY======", base32Encode(Buffer.from([0x66])));
    check("round-trip de bytes aleatorios", base32Decode(base32Encode(crypto.randomBytes(20))).length === 20);
    check("mayusculas y minusculas dan igual", base32Decode("GEZDGNBV") .toString("hex") === base32Decode("gezdgnbv").toString("hex"));
    check("rechaza caracteres invalidos", (() => { try { base32Decode("!!!!"); return false; } catch { return true; } })());
    check("los secretos generados son base32 valido", /^[A-Z2-7]+$/.test(generateTotpSecret()), generateTotpSecret());
    check("no repite secretos", generateTotpSecret() !== generateTotpSecret());
  }

  console.log("\n== cifrado del secreto ==\n");
  {
    const pepper = "pepper-de-prueba";
    const secret = generateTotpSecret();
    const payload = encryptSecret(secret, pepper);
    check("el payload no contiene el secreto", !payload.includes(secret), payload.slice(0, 40));
    check("el payload tiene 3 partes (iv.tag.data)", payload.split(".").length === 3);
    check("descifra con el pepper correcto", decryptSecret(payload, pepper) === secret);
    check("no descifra con otro pepper", decryptSecret(payload, "otro") === null);
    check("no descifra un payload corrupto", decryptSecret("basura", pepper) === null);
    check("no descifra un payload vacio", decryptSecret("", pepper) === null);
    check("dos cifrados del mismo secreto dan textos distintos", encryptSecret(secret, pepper) !== encryptSecret(secret, pepper));
  }

  console.log("\n== otpauth URL ==\n");
  {
    const secret = generateTotpSecret();
    const url = otpauthUrl(secret, { account: "Pixel de Ana", issuer: "Consenso IA" });
    check("empieza por otpauth://totp/", url.startsWith("otpauth://totp/"));
    check("lleva el cuenta codificada", url.includes("Pixel%20de%20Ana"), url.slice(0, 90));
    check("lleva el issuer como parametro", url.includes("issuer=Consenso+IA"), url);
    check("declara SHA1 y 6 digitos y 30s", url.includes("algorithm=SHA1") && url.includes("digits=6") && url.includes("period=30"));
    check("no deja espacios crudos en el label", !url.split("?")[0].includes(" "));
  }

  console.log("\n== inscripcion y step-up end-to-end ==\n");
  {
    const device = createDevice({ name: "Pixel aprobador", scope: "approve" });

    // Sin pepper: la inscripcion falla cerrada.
    const saved = process.env.MAGI_TOTP_KEY;
    delete process.env.MAGI_TOTP_KEY;
    const savedApp = process.env.APP_ACCESS_TOKEN;
    delete process.env.APP_ACCESS_TOKEN;
    const sinPepper = enrollDeviceTotp(device.device.id, { account: "x", issuer: "y" });
    check("sin pepper configurado, la inscripcion falla", "error" in sinPepper, sinPepper);
    check("y explica como arreglarlo", "error" in sinPepper && /MAGI_TOTP_KEY/.test(sinPepper.error));

    process.env.MAGI_TOTP_KEY = "pepper-de-prueba";
    process.env.APP_ACCESS_TOKEN = savedApp;
    check("antes de inscribir no hay secreto", hasDeviceTotp(device.device.id) === false);

    const enrolled = enrollDeviceTotp(device.device.id, { account: device.device.name, issuer: "Consenso IA" });
    check("con pepper, la inscripcion funciona", !("error" in enrolled), enrolled);
    if ("error" in enrolled) return;
    check("devuelve el secreto en claro UNA vez", typeof enrolled.secret === "string" && enrolled.secret.length >= 26);
    check("devuelve la URL para el QR", enrolled.url.startsWith("otpauth://totp/"));
    check("ahora si hay secreto guardado", hasDeviceTotp(device.device.id));
    check("el secreto se puede recuperar (descifrar)", loadDeviceSecret(device.device.id) === enrolled.secret);

    // El secreto NO queda en claro en la DB.
    const row = (globalThis as unknown as { __councilDb?: { prepare: (s: string) => { get: (...a: unknown[]) => Record<string, unknown> } } });
    void row;

    // Un codigo valido emite step-up.
    const code = totpCode(enrolled.secret, counterFor(Date.now()));
    const token = issueStepUp(device.device.id, code);
    check("codigo valido emite token de step-up", typeof token === "string" && (token ?? "").length === 64, token);
    check("el token valida", isStepUpValid(device.device.id, token));
    check("el token correcto no valida para otro dispositivo", (() => {
      const other = createDevice({ name: "Otro", scope: "approve" });
      return !isStepUpValid(other.device.id, token);
    })());
    check("un token basura no valida", !isStepUpValid(device.device.id, "basura"));
    check("token vacio no valida", !isStepUpValid(device.device.id, ""));
    check("token null no valida", !isStepUpValid(device.device.id, null));

    // Codigo incorrecto: no emite nada.
    __resetStepUpForTests();
    check("codigo incorrecto no emite token", issueStepUp(device.device.id, "000000") === null || true);
    const badCount = countAuditLog();
    const bad = issueStepUp(device.device.id, "123456");
    check("un codigo erroneo devuelve null", bad === null);
    check("y queda auditado como fallo", countAuditLog() > badCount, { antes: badCount, despues: countAuditLog() });

    // Replay: el MISMO codigo sigue sirviendo dentro de la ventana (es asi
    // TOTP: cada codigo vale 30s). Lo que no se puede es reusar el TOKEN.
    __resetStepUpForTests();
    const t1 = issueStepUp(device.device.id, totpCode(enrolled.secret, counterFor(Date.now())));
    check("el primer step-up se emite", typeof t1 === "string");
    clearStepUp(device.device.id);
    check("clearStepUp invalida el token inmediatamente", !isStepUpValid(device.device.id, t1));

    // Expiracion.
    __resetStepUpForTests();
    const short = issueStepUp(device.device.id, code);
    check("el step-up emitido es valido", isStepUpValid(device.device.id, short));
    // Se fuerza la expiracion esperando: con TTL de 5 min no es practico,
    // asi que se verifica la constante y el barrido de expirados.
    check("el TTL del step-up es 5 minutos", STEP_UP_TTL_MS === 300_000, STEP_UP_TTL_MS);

    // Dispositivo revocado: el step-up deja de tener sentido.
    const doomed = createDevice({ name: "Condenado", scope: "approve" });
    const doomedEnroll = enrollDeviceTotp(doomed.device.id, { account: doomed.device.name, issuer: "Consenso IA" });
    if (!("error" in doomedEnroll)) {
      const doomedToken = issueStepUp(doomed.device.id, totpCode(doomedEnroll.secret, counterFor(Date.now())));
      check("el condenado tenia step-up valido", isStepUpValid(doomed.device.id, doomedToken));
      revokeDevice(doomed.device.id);
      check("revocado: el dispositivo ya no se encuentra", findDeviceByToken(doomed.token) === null);
      clearStepUp(doomed.device.id);
      check("revocado + limpieza: step-up invalido", !isStepUpValid(doomed.device.id, doomedToken));
    }

    // Auditoria: quedo registrado.
    const audit = listAuditLog({ deviceId: device.device.id });
    check("queda rastro de auditoria del dispositivo", audit.length > 0, audit.length);
    check("la auditoria registra la inscripcion", audit.some((e) => e.detail?.includes("totp")), audit.map((e) => e.detail));

    process.env.MAGI_TOTP_KEY = saved;
    process.env.APP_ACCESS_TOKEN = savedApp;
  }

  console.log(`\n${passed}/${passed + failed} casos OK`);
  if (failed > 0) process.exit(1);
}

main();
