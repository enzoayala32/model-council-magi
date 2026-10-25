/**
 * Fase 8B — clasificación de rutas sensibles/inseguras.
 *
 * Sin filesystem: prueba la función pura con separadores Windows/POSIX,
 * mayúsculas, plantillas `.env.*` y rutas absolutas/UNC/traversal.
 *
 * Uso: npm run agent:test-context-sensitive
 */
import { SENSITIVE_RULES_VERSION, filterSensitivePaths, isSensitivePath, normalizePathForRules, sensitiveRuleOf } from "./sensitive-paths";

const results: boolean[] = [];
function check(ok: boolean, message: string, detail?: () => unknown) {
  console.log(ok ? `✅ ${message}` : `❌ ${message}${detail ? `\n   ${JSON.stringify(detail())}` : ""}`);
  results.push(ok);
}
const canon = (value: unknown) => JSON.stringify(value);
function checkEq(actual: unknown, expected: unknown, message: string) {
  check(canon(actual) === canon(expected), message, () => ({ esperado: expected, actual }));
}
const rule = (path: string) => sensitiveRuleOf(path);

function main() {
  console.log("== Fase 8B — rutas sensibles/inseguras ==\n");

  console.log("--- Secretos de datos: se excluyen ---");
  for (const path of [
    ".env",
    ".env.local",
    ".env.production",
    "apps/web/.env",
    ".envrc",
    ".npmrc",
    ".pypirc",
    ".netrc",
    "_netrc",
    ".git-credentials",
    ".htpasswd",
    ".pgpass",
    ".my.cnf",
    ".dockercfg",
    "credentials.json",
    "config/secrets.json",
    "config/secrets.yaml",
    "config/secrets.yml",
    "config/secret.yaml",
    "kubeconfig",
    "server.pem",
    "server.key",
    "cert.p12",
    "cert.pfx",
    "app.jks",
    "app.keystore",
    "vault.kdbx",
    "id.ppk",
    "client.ovpn",
    "terraform.tfstate",
    "release.asc",
    "release.gpg",
    "foo.secret",
    "foo.secrets",
    "id_rsa",
    "id_ed25519",
    "id_ecdsa.pub",
    "service-account-prod.json",
    "firebase-adminsdk-abc.json",
  ]) {
    check(rule(path) !== null, `excluye ${path}`, () => rule(path));
  }
  checkEq(rule("config/secrets.json"), "file:secrets.json", "la regla de un basename sensible es estable");
  checkEq(rule("server.pem"), "extension:.pem", "la regla de extensión es estable");
  checkEq(rule("id_rsa"), "name:private-key", "la regla de clave privada es estable");
  checkEq(rule(".env.local"), "file:.env", "la regla de .env es estable");

  console.log("\n--- Directorios privados ---");
  for (const path of [".ssh/config", ".aws/credentials", ".gnupg/pubring.kbx", ".azure/az.json", ".kube/config", ".docker/config.json", ".terraform/terraform.tfstate", ".openai/auth.json", ".anthropic/config.json", ".huggingface/token"]) {
    check(rule(path)?.startsWith("directory:") === true, `excluye ${path} por directorio`, () => rule(path));
  }

  console.log("\n--- Plantillas .env: NO son secretos ---");
  for (const path of [".env.example", ".env.sample", ".env.template", ".env.dist", "apps/web/.env.example", ".env.local.example", ".env.production.template"]) {
    checkEq(rule(path), null, `permite ${path} (plantilla)`);
  }

  console.log("\n--- Código con nombres sensibles: NO se excluye ---");
  for (const path of ["src/auth.ts", "lib/credentials.ts", "lib/api-keys.ts", "app/api/secrets/route.ts", "docs/security.md", "keys.ts", "token-store.ts"]) {
    checkEq(rule(path), null, `permite ${path} (es código, no datos)`);
  }

  console.log("\n--- Windows / POSIX / mayúsculas ---");
  checkEq(rule("config\\secrets.json"), "file:secrets.json", "separador \\ se normaliza");
  checkEq(rule(".SSH\\config"), "directory:.ssh", "directorio case-insensitive (Windows)");
  checkEq(rule(".ENV.LOCAL"), "file:.env", ".env case-insensitive");
  checkEq(rule("ID_RSA"), "name:private-key", "clave privada case-insensitive");
  checkEq(rule("SERVER.PEM"), "extension:.pem", "extensión case-insensitive");
  checkEq(rule("./.env"), "file:.env", "./ se ignora");
  checkEq(rule("a//b//.env"), "file:.env", "barras duplicadas se ignoran");
  checkEq(rule("café/niño.ts"), null, "Unicode normal no se marca");
  checkEq(rule("cafe\u0301/niño.ts"), null, "Unicode NFD tampoco se normaliza a NFC");

  console.log("\n--- Rutas inseguras: se rechazan (fail-closed) ---");
  for (const path of ["/etc/passwd", "\\Windows\\win.ini", "C:\\Users\\Admin\\.env", "c:/x", "//server/share/x", "\\\\server\\share\\x", "https://example.com/a.ts", "file:///C:/x", "../secret", "a/../../b", "a/../b", "", ".", "a/\0b"]) {
    const result = rule(path);
    check(result !== null && result.startsWith("unsafe:"), `rechaza ${JSON.stringify(path)}`, () => result);
  }
  checkEq(normalizePathForRules("a\\b\\c.ts"), { ok: true, segments: ["a", "b", "c.ts"] }, "normalizePathForRules devuelve segmentos limpios");
  checkEq(normalizePathForRules("../x"), { ok: false, rule: "unsafe:traversal" }, "normalizePathForRules distingue traversal");

  console.log("\n--- filterSensitivePaths: preserva orden y reporta reglas ---");
  const entries = [{ path: "src/a.ts" }, { path: ".env" }, { path: "src/b.ts" }, { path: ".ssh/config" }, { path: "server.pem" }];
  const filtered = filterSensitivePaths(entries);
  checkEq(filtered.allowed.map((entry) => entry.path), ["src/a.ts", "src/b.ts"], "solo quedan las rutas permitidas, en orden");
  checkEq(filtered.excluded.map((entry) => entry.path), [".env", ".ssh/config", "server.pem"], "las exclusiones preservan orden");
  check(filtered.excluded.every((entry) => entry.rule.length > 0 && !entry.rule.includes("PRIVATE")), "cada exclusión trae una regla estable, sin contenido", () => filtered.excluded);
  checkEq(isSensitivePath(".env"), true, "isSensitivePath atajo booleano");
  checkEq(SENSITIVE_RULES_VERSION, 1, "versión de reglas explícita");

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} casos OK.`);
  if (passed !== results.length) process.exit(1);
}

main();
