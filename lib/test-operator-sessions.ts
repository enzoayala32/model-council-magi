/**
 * Sesiones de operador opacas (corrección de la revisión, punto 2).
 *
 * BUG que fija: la cookie `magi_access_token` guardaba el token maestro en
 * crudo. Ahora lleva un id aleatorio de 256 bits cuyo SHA-256 está en la DB,
 * así que ni un dump de la DB ni una cookie robada dan acceso permanente.
 *
 * Uso: npm run security:test-operator-sessions
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildOperatorSessionCookie,
  clearOperatorSessionCookie,
  countOperatorSessions,
  createOperatorSession,
  isValidOperatorSession,
  OPERATOR_COOKIE_NAME,
  pruneOperatorSessions,
  revokeAllOperatorSessions,
  revokeOperatorSession,
} from "./auth/operator-session";
import { isOperatorRequest } from "./auth/operator";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) { passed += 1; console.log("+ " + label); return; }
  failed += 1;
  const suffix = detail === undefined ? "" : " - " + JSON.stringify(detail);
  console.log("x " + label + suffix);
}

if (!process.env.MAGI_DATA_DIR) {
  process.env.MAGI_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "magi-opsec-test-"));
}

const OP_TOKEN = "token-maestro-de-prueba";

function reqWith(cookie: string | null): { headers: { get(name: string): string | null } } {
  return { headers: { get: (name: string) => (name === "cookie" ? cookie : null) } };
}

function main(): void {
  const saved = process.env.APP_ACCESS_TOKEN;
  process.env.APP_ACCESS_TOKEN = OP_TOKEN;

  console.log("== login crea una sesión opaca ==\n");
  const token = createOperatorSession();
  check("el id de sesión tiene 64 hex (256 bits)", /^[0-9a-f]{64}$/.test(token), token);
  check("queda una fila en la DB", countOperatorSessions() === 1, countOperatorSessions());
  check("el id NO es el token maestro", token !== OP_TOKEN);
  check("el id no contiene el token maestro", !token.includes(OP_TOKEN));
  check("la sesión es válida", isValidOperatorSession(reqWith(buildOperatorSessionCookie(token, { secure: false }))));
  check("el helper de operador acepta la sesión", isOperatorRequest(reqWith(buildOperatorSessionCookie(token, { secure: false }))));

  console.log("\n== la cookie nunca lleva el token ==\n");
  const cookieHeader = buildOperatorSessionCookie(token, { secure: false });
  check("el nombre de cookie es el esperado", cookieHeader.startsWith(OPERATOR_COOKIE_NAME + "="));
  check("el valor de la cookie no contiene el token", !cookieHeader.includes(OP_TOKEN), cookieHeader.slice(0, 60));
  check("la cookie es HttpOnly", cookieHeader.includes("HttpOnly"));
  check("la cookie es SameSite=Strict", cookieHeader.includes("SameSite=Strict"));
  check("sin https no agrega Secure", !cookieHeader.includes("Secure"));
  check("con https agrega Secure", buildOperatorSessionCookie(token, { secure: true }).includes("Secure"));

  console.log("\n== valores inválidos ==\n");
  check("cookie vacía no es sesión", !isValidOperatorSession(reqWith("")));
  check("cookie de otro nombre no es sesión", !isValidOperatorSession(reqWith("otra=abc")));
  check("id basura no es sesión", !isValidOperatorSession(reqWith(OPERATOR_COOKIE_NAME + "=basura")));
  check("id del largo correcto pero desconocido no es sesión", !isValidOperatorSession(reqWith(OPERATOR_COOKIE_NAME + "=" + "a".repeat(64))));
  check("sin cookie no es sesión", !isValidOperatorSession(reqWith(null)));

  console.log("\n== logout (revocación) ==\n");
  check("revocar devuelve true", revokeOperatorSession(token) === true);
  check("revocar dos veces devuelve false", revokeOperatorSession(token) === false);
  const revokedReq = reqWith(buildOperatorSessionCookie(token, { secure: false }));
  check("la cookie revocada ya no valida", !isValidOperatorSession(revokedReq));
  check("y el helper de operador la rechaza", !isOperatorRequest(revokedReq));

  console.log("\n== cookie robada tras logout ==\n");
  const stolen = createOperatorSession();
  const stolenCookie = buildOperatorSessionCookie(stolen, { secure: false });
  check("la cookie robada funciona antes del logout", isOperatorRequest(reqWith(stolenCookie)));
  revokeOperatorSession(stolen);
  check("tras el logout la cookie robada queda inútil", !isOperatorRequest(reqWith(stolenCookie)));

  console.log("\n== Bearer sigue disponible para scripts ==\n");
  check("Bearer con el token maestro sigue siendo operador", isOperatorRequest({ headers: { get: (n: string) => (n === "authorization" ? "Bearer " + OP_TOKEN : null) } }));
  check("Bearer con token equivocado no", !isOperatorRequest({ headers: { get: (n: string) => (n === "authorization" ? "Bearer otro" : null) } }));
  check("un id de sesión por Bearer no es operador", !isOperatorRequest({ headers: { get: (n: string) => (n === "authorization" ? "Bearer " + "a".repeat(64) : null) } }));

  console.log("\n== revocar todas (kill switch) ==\n");
  revokeAllOperatorSessions();
  const latest = countOperatorSessions();
  const a = createOperatorSession();
  const b = createOperatorSession();
  check("hay dos sesiones nuevas (más las revocadas)", countOperatorSessions() === latest + 2, { latest, ahora: countOperatorSessions() });
  const killed = revokeAllOperatorSessions();
  check("revocar todas dos sesiones", killed === 2, killed);
  check("la cookie de A quedó inútil", !isValidOperatorSession(reqWith(buildOperatorSessionCookie(a, { secure: false }))));
  check("la cookie de B quedó inútil", !isValidOperatorSession(reqWith(buildOperatorSessionCookie(b, { secure: false }))));

  console.log("\n== limpieza ==\n");
  const before = countOperatorSessions();
  const pruned = pruneOperatorSessions();
  check("podar no falla y devuelve un número", typeof pruned === "number");
  check("las sesiones revocadas siguen guardadas (auditoría)", countOperatorSessions() === before, { before, despues: countOperatorSessions() });
  check("clear de cookie produce una cookie vacía", clearOperatorSessionCookie().includes("Max-Age=0"));

  if (saved === undefined) delete process.env.APP_ACCESS_TOKEN;
  else process.env.APP_ACCESS_TOKEN = saved;

  console.log("");
  console.log(passed + "/" + (passed + failed) + " casos OK");
  if (failed > 0) process.exit(1);
}

main();
