/**
 * Fase 8B — Señales de tarea: extracción PURA y determinista de menciones
 * de rutas, nombres de archivo y términos desde el pedido del usuario.
 *
 * No toca disco, no consulta el mapa, no usa el modelo. La misma tarea
 * produce siempre el mismo resultado, byte a byte.
 *
 * Decisiones de seguridad/robustez (ver evidencia de 8B en `salidas/08-*`):
 * - Se aceptan rutas relativas con `/` o `\`, `./`, barras dobles, `:línea`,
 *   `#L10`, `?query`, comillas, backticks, paréntesis, corchetes, `<>` y
 *   enlaces Markdown `[texto](ruta)`.
 * - Se RECHAZAN rutas absolutas POSIX/Windows, UNC, URLs y cualquier ruta
 *   con `..` — el selector nunca debe poder mirar fuera del workspace.
 * - No se normaliza Unicode: `café/niño.ts` (NFC) y su variante NFD son
 *   menciones distintas, igual que en Git. La comparación case-insensitive
 *   se resuelve en `select.ts` y solo si hay una única coincidencia.
 * - Los términos son palabras de 4+ caracteres (así `lib` no ensucia, pero
 *   `agent`, `zone`, `util` e `index` sí participan) y se excluyen palabras
 *   vacías de pedidos típicos.
 */

export const TASK_SCAN_MAX_CHARS = 100_000;
export const MAX_PATH_TOKENS = 50;
export const MAX_TERMS = 100;
export const MIN_TERM_CHARS = 4;

const TOKEN_RE = /[\p{L}\p{N}_@.\-[\]()+~\\\/]+/gu;
const WORD_RE = /[\p{L}\p{N}_$]+/gu;
const EXTENSION_RE = /\.[A-Za-z0-9]{1,10}$/u;

const STOP_TERMS: ReadonlySet<string> = new Set([
  // Español
  "para", "porque", "como", "cuando", "donde", "desde", "hasta", "entre", "sobre", "todo", "todos",
  "esta", "este", "estos", "estas", "otro", "otra", "otros", "otras", "algo", "solo", "también",
  "revisá", "revisa", "revisar", "mirá", "mira", "mirar", "agregá", "agrega", "agregar", "cambiá",
  "cambia", "cambiar", "corregí", "corrige", "corregir", "arreglá", "arregla", "arreglar",
  "buscá", "busca", "buscar", "leé", "lee", "leer", "escribí", "escribe", "escribir",
  "archivo", "archivos", "código", "codigo", "función", "funcion", "línea", "linea", "test",
  "tests", "prueba", "pruebas", "proyecto", "tarea", "cambio", "cambios", "error", "errores",
  "después", "despues", "antes", "ahora", "necesito", "quiero", "debería", "deberia", "puedas",
  "hacer", "hacé", "hace", "solo", "mismo", "misma", "usando", "usar", "uso",
  // Inglés
  "the", "and", "for", "with", "from", "this", "that", "these", "those", "into", "your",
  "please", "should", "would", "could", "make", "change", "update", "fix", "file", "files",
  "code", "line", "function", "project", "task", "test", "tests", "error", "errors", "after",
  "before", "need", "want", "using", "use", "add", "remove", "review", "read", "write",
]);

const EXTENSION_WORDS: ReadonlySet<string> = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "md", "mdx", "css", "scss", "html", "yml",
  "yaml", "toml", "xml", "sh", "bash", "ps1", "py", "rb", "go", "rs", "java", "kt", "sql",
]);

export type PathMention = {
  /** Texto original (con separadores normalizados a `/`, sin limpiar). */
  raw: string;
  /** Ruta relativa limpia; `null` si es insegura. */
  path: string | null;
  /** `true` si la mención vino con `/` o `\` (aunque al limpiarla quede un
   * nombre suelto, como `./b.ts` → `b.ts`). */
  hadSlash: boolean;
};

export type TaskScan = {
  /** Texto efectivamente escaneado (recortado a `TASK_SCAN_MAX_CHARS`). */
  text: string;
  /** Variantes de rutas (crudas y limpias) para diagnóstico; incluye
   * formas con puntuación final, igual que la evidencia de 8B. */
  fullPaths: string[];
  /** Nombres de archivo sueltos (`b.ts`, `index.ts`). */
  baseNames: string[];
  /** Menciones tipadas que consume el selector (deduplicadas). */
  mentions: PathMention[];
  /** Términos en minúsculas, ordenados por primera aparición. */
  terms: string[];
  truncated: boolean;
};

/** Pares de delimitadores que pueden envolver una mención. */
const ENCLOSING_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["`", "`"],
  ['"', '"'],
  ["'", "'"],
  ["(", ")"],
  ["[", "]"],
  ["<", ">"],
];

function stripEnclosing(value: string): string {
  let current = value.trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [open, close] of ENCLOSING_PAIRS) {
      if (current.length >= 2 && current.startsWith(open) && current.endsWith(close)) {
        current = current.slice(open.length, current.length - close.length).trim();
        changed = true;
      }
    }
  }
  return current;
}

/** Limpia puntuación final y referencias de línea/columna/query/fragmento. */
function stripTrailingDecorations(value: string): string {
  let current = value;
  let changed = true;
  while (changed) {
    changed = false;
    const next = current
      .replace(/[.,;!?]+$/u, "")
      .replace(/:\d+(?::\d+)?$/u, "")
      .replace(/#L\d+(?:-L?\d+)?$/iu, "")
      .replace(/\?[^/]*$/u, "")
      .replace(/\/+$/u, "");
    if (next !== current) {
      current = next;
      changed = true;
    }
  }
  return current;
}

/**
 * Convierte una mención cruda en una ruta relativa limpia, o `null` si es
 * absoluta/UNC/URL/tiene `..`/está vacía. No consulta el inventario: solo
 * valida la FORMA. La resolución contra archivos reales vive en `select.ts`.
 */
export function normalizeMentionedPath(token: string): string | null {
  if (typeof token !== "string" || token.length === 0 || token.includes("\0")) return null;
  let value = token.trim();
  if (value.length === 0) return null;

  // Enlace Markdown: quedarse con lo que está después del último `](` y
  // consumir el `)` de cierre del enlace (no cualquier `)` final: un nombre
  // de archivo legítimo puede terminar en `)`).
  const markdown = value.lastIndexOf("](");
  if (markdown !== -1) {
    value = value.slice(markdown + 2);
    if (value.endsWith(")")) value = value.slice(0, -1);
  }

  value = stripEnclosing(value);
  value = stripTrailingDecorations(value);
  value = stripEnclosing(value);
  value = stripTrailingDecorations(value);

  const slashed = value.replace(/\\/g, "/").replace(/\/+/g, "/");
  if (slashed.length === 0) return null;
  if (slashed.startsWith("/") || slashed.startsWith("//")) return null;
  if (/^[A-Za-z]:/.test(slashed)) return null;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(slashed)) return null;
  const segments = slashed.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.length === 0) return null;
  if (segments.some((segment) => segment === "..")) return null;
  return segments.join("/");
}

/** Variantes de una mención cruda: la forma cruda con `/` y la limpia (si
 * difiere). Así `lib/agent/loop.ts.` produce ambas, igual que la evidencia. */
export function pathVariants(raw: string): string[] {
  const normalizedRaw = raw.replace(/\\/g, "/");
  const cleaned = normalizeMentionedPath(raw);
  const variants: string[] = [];
  if (normalizedRaw.length > 0) variants.push(normalizedRaw);
  if (cleaned && cleaned !== normalizedRaw) variants.push(cleaned);
  return variants;
}

function isWordTerm(word: string): boolean {
  if (word.length < MIN_TERM_CHARS) return false;
  const lower = word.toLowerCase();
  if (STOP_TERMS.has(lower) || EXTENSION_WORDS.has(lower)) return false;
  if (/^\d+$/u.test(lower)) return false;
  return true;
}

/**
 * Escanea la tarea. El texto se recorta a `TASK_SCAN_MAX_CHARS` (límite
 * duro de trabajo, no de salida): una tarea gigantesca no puede hacer que
 * el selector consuma tiempo/memoria sin cota.
 */
export function scanTask(task: string, options: { maxChars?: number } = {}): TaskScan {
  const maxChars = Math.max(0, options.maxChars ?? TASK_SCAN_MAX_CHARS);
  const text = typeof task === "string" ? task.slice(0, maxChars) : "";
  const truncated = typeof task === "string" ? task.length > text.length : false;

  const fullPaths: string[] = [];
  const baseNames: string[] = [];
  const mentions: PathMention[] = [];
  const seenVariants = new Set<string>();
  const seenMentions = new Set<string>();

  for (const match of text.matchAll(TOKEN_RE)) {
    const raw = match[0];
    if (!raw) continue;
    const hasSlash = /[\\/]/.test(raw);
    const cleaned = normalizeMentionedPath(raw);

    if (hasSlash) {
      for (const variant of pathVariants(raw)) {
        if (seenVariants.has(variant)) continue;
        seenVariants.add(variant);
        fullPaths.push(variant);
      }
      if (mentions.filter((mention) => mention.hadSlash).length >= MAX_PATH_TOKENS) continue;
      for (const variant of pathVariants(raw)) {
        const mentionPath = normalizeMentionedPath(variant);
        const key = `path:${variant}:${mentionPath ?? ""}`;
        if (seenMentions.has(key)) continue;
        seenMentions.add(key);
        mentions.push({ raw: variant, path: mentionPath, hadSlash: true });
      }
      continue;
    }

    if (cleaned && EXTENSION_RE.test(cleaned)) {
      if (!baseNames.includes(cleaned)) baseNames.push(cleaned);
      if (mentions.filter((mention) => !mention.hadSlash).length >= MAX_PATH_TOKENS) continue;
      const key = `base:${cleaned}`;
      if (!seenMentions.has(key)) {
        seenMentions.add(key);
        mentions.push({ raw, path: cleaned, hadSlash: false });
      }
    }
  }

  const terms: string[] = [];
  const seenTerms = new Set<string>();
  for (const match of text.matchAll(WORD_RE)) {
    const word = match[0];
    if (!isWordTerm(word)) continue;
    const lower = word.toLowerCase();
    if (seenTerms.has(lower)) continue;
    seenTerms.add(lower);
    terms.push(lower);
    if (terms.length >= MAX_TERMS) break;
  }

  return { text, fullPaths, baseNames, mentions, terms, truncated };
}
