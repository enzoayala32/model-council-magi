/**
 * Fase 8B — Clasificación de rutas sensibles/inseguras para el Context
 * Engine. Es una función PURA (sin filesystem): recibe una ruta relativa
 * tal como la entrega el inventario de Git y decide si puede llegar a ser
 * candidata de contexto.
 *
 * Principios:
 * - Fallar cerrado: ante la duda de que un archivo pueda contener
 *   credenciales, se excluye. La selección de contexto es una comodidad,
 *   no una fuente de verdad: omitir un archivo es recuperable (el modelo
 *   puede pedirlo con read_file), filtrar una key no lo es.
 * - No se excluyen por nombre genérico cosas como "auth.ts" o
 *   "credentials.ts": son código fuente normal y suelen ser justamente lo
 *   que hay que leer. Las reglas apuntan a archivos de DATOS sensibles y a
 *   directorios de configuración privada.
 * - Determinista y portable: separadores `\` y `/`, comparación
 *   case-insensitive solo para decidir sensibilidad (en Windows el
 *   filesystem no distingue mayúsculas), sin normalizar Unicode (dos
 *   nombres Unicode distintos son dos archivos distintos).
 */

/** Versión de las reglas — se reporta en las razones de exclusión para que
 * un cambio futuro sea trazable sin guardar contenido de archivos. */
export const SENSITIVE_RULES_VERSION = 1;

const SENSITIVE_DIRECTORIES: ReadonlySet<string> = new Set([
  ".ssh",
  ".aws",
  ".gnupg",
  ".azure",
  ".kube",
  ".docker",
  ".terraform",
  ".openai",
  ".anthropic",
  ".huggingface",
]);

/** Sufijos de `.env.*` que son plantillas, no secretos. Mismo criterio que
 * la evidencia de 8B: `.env.example`, `.env.sample`, `.env.template` y
 * `.env.dist` son seguros; cualquier otro `.env.*` se excluye. */
const ENV_SAFE_SUFFIXES: ReadonlySet<string> = new Set(["example", "sample", "template", "dist"]);

const SENSITIVE_BASENAMES: ReadonlySet<string> = new Set([
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
  "credential.json",
  "secrets.json",
  "secrets.yaml",
  "secrets.yml",
  "secret.yaml",
  "secret.yml",
  "kubeconfig",
]);

const SENSITIVE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".jks",
  ".keystore",
  ".kdbx",
  ".ppk",
  ".ovpn",
  ".tfstate",
  ".asc",
  ".gpg",
  ".secret",
  ".secrets",
]);

const PRIVATE_KEY_NAME = /^id_(rsa|dsa|ecdsa|ed25519)(\..*)?$/i;
const SERVICE_ACCOUNT_NAME = /^(service-account|firebase-adminsdk)[^/]*\.json$/i;

export type SensitivePathClassification =
  | { sensitive: false }
  | { sensitive: true; rule: string; unsafe?: boolean };

/** Normaliza solo para comparar: separadores, sin `.` inicial, sin barras
 * duplicadas. No resuelve `..` (eso es un error de seguridad, no una ruta a
 * normalizar) ni cambia mayúsculas/Unicode. */
export function normalizePathForRules(relPath: string): { ok: true; segments: string[] } | { ok: false; rule: string } {
  if (typeof relPath !== "string" || relPath.length === 0) return { ok: false, rule: "unsafe:empty" };
  if (relPath.includes("\0")) return { ok: false, rule: "unsafe:nul" };
  const slashed = relPath.replace(/\\/g, "/");
  if (/^[A-Za-z]:\//.test(slashed) || /^[A-Za-z]:$/.test(slashed)) return { ok: false, rule: "unsafe:absolute" };
  if (slashed.startsWith("//")) return { ok: false, rule: "unsafe:absolute" };
  if (slashed.startsWith("/")) return { ok: false, rule: "unsafe:absolute" };
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(slashed)) return { ok: false, rule: "unsafe:url" };
  const segments = slashed.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.length === 0) return { ok: false, rule: "unsafe:empty" };
  if (segments.some((segment) => segment === "..")) return { ok: false, rule: "unsafe:traversal" };
  return { ok: true, segments };
}

/**
 * Devuelve la regla que excluye la ruta, o `null` si es una ruta normal.
 * El string de la regla es estable y no incluye el contenido del archivo:
 * `directory:.ssh`, `file:.env`, `extension:.pem`, `name:id_rsa`,
 * `unsafe:absolute`, etc.
 */
export function sensitiveRuleOf(relPath: string): string | null {
  const normalized = normalizePathForRules(relPath);
  if (!normalized.ok) return normalized.rule;
  const segments = normalized.segments;
  for (const segment of segments.slice(0, -1)) {
    if (SENSITIVE_DIRECTORIES.has(segment.toLowerCase())) return `directory:${segment.toLowerCase()}`;
  }

  const basename = segments[segments.length - 1];
  const lower = basename.toLowerCase();

  if (lower === ".env" || lower.startsWith(".env.")) {
    const suffix = lower.slice(".env.".length);
    // `.env` no tiene sufijo; `.env.local.example` termina en una plantilla.
    if (lower !== ".env" && ENV_SAFE_SUFFIXES.has(suffix.split(".").pop() ?? "")) return null;
    return "file:.env";
  }
  if (SENSITIVE_BASENAMES.has(lower)) return `file:${lower}`;
  if (PRIVATE_KEY_NAME.test(lower)) return "name:private-key";
  if (SERVICE_ACCOUNT_NAME.test(lower)) return "name:service-account";
  const dot = lower.lastIndexOf(".");
  const extension = dot > 0 ? lower.slice(dot) : "";
  if (SENSITIVE_EXTENSIONS.has(extension)) return `extension:${extension}`;
  return null;
}

export function isSensitivePath(relPath: string): boolean {
  return sensitiveRuleOf(relPath) !== null;
}

export type SensitivePathExclusion = { path: string; rule: string };

/** Filtra una lista de entradas con `path`, preservando el orden original
 * y devolviendo las exclusiones (sin contenido) para poder reportar por
 * qué se omitió cada archivo. */
export function filterSensitivePaths<T extends { path: string }>(entries: readonly T[]): { allowed: T[]; excluded: SensitivePathExclusion[] } {
  const allowed: T[] = [];
  const excluded: SensitivePathExclusion[] = [];
  for (const entry of entries) {
    const rule = sensitiveRuleOf(entry.path);
    if (rule) excluded.push({ path: entry.path, rule });
    else allowed.push(entry);
  }
  return { allowed, excluded };
}
