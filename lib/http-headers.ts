/**
 * Sanitización de valores de header HTTP.
 *
 * Por qué existe: los valores de un header son `ByteString` — Latin-1
 * imprimible. Cualquier carácter fuera de ese rango (la raya larga
 * U+2014 del default anterior de `X-Title`, un emoji, un acento mal
 * normalizado) hace que `fetch` lance
 * `Cannot convert argument to a ByteString ... 8212` y rompa la llamada
 * al proveedor entera, que es justo lo que pasaba con
 * `OPENROUTER_APP_NAME`.
 *
 * Regla: se translitera a Latin-1 imprimible y lo que no se puede
 * representar se descarta (o se sustituye por el equivalente ASCII más
 * cercano). Nunca se deja un carácter que `fetch` rechace.
 */

/** Sustituciones directas por equivalente ASCII. */
const PUNCTUATION_MAP: Record<string, string> = {
  "\u2014": "-", // — Em dash (el que rompía el default)
  "\u2013": "-", // – En dash
  "\u2012": "-", // ‒ Figure dash
  "\u2015": "-", // ― Horizontal bar
  "\u2212": "-", // − Minus sign
  "\u2018": "'", // ‘ Left single quote
  "\u2019": "'", // ’ Right single quote
  "\u201A": ",",
  "\u201C": '"', // “ Left double quote
  "\u201D": '"', // ” Right double quote
  "\u2026": "...", // … Ellipsis
  "\u00A0": " ", // Non-breaking space
  "\u200B": "", // Zero-width space
  "\u2022": "-", // • Bullet
  "\u00AB": '"',
  "\u00BB": '"',
  "\u2039": "<",
  "\u203A": ">",
  "\u2192": "->",
  "\u2190": "<-",
};

/** Letras Latin-1 extendidas sin equivalente NFD. */
const LETTER_MAP: Record<string, string> = {
  "\u00DF": "ss", // ß
  "\u00E6": "ae", // æ
  "\u0153": "oe", // œ
  "\u00F8": "o", // ø
  "\u0111": "d", // đ
  "\u0142": "l", // ł
  "\u00FE": "th", // þ
  "\u00DE": "Th", // Þ
  "\u0131": "i", // ı
  "\u0152": "Oe",
};

/** Caracteres de control y C1: nunca pueden estar en un header. */
function isPrintableLatin1(codePoint: number): boolean {
  if (codePoint <= 0x1f || codePoint === 0x7f) return false;
  if (codePoint >= 0x80 && codePoint <= 0x9f) return false;
  return codePoint <= 0xff;
}

/**
 * Devuelve `value` saneado, o `fallback` si no queda nada utilizable.
 * Idempotente: sanitizar dos veces da el mismo resultado.
 */
export function sanitizeHeaderValue(value: string | undefined | null, fallback = ""): string {
  if (typeof value !== "string" || value.length === 0) return fallback;

  let out = "";
  for (const char of value.normalize("NFC")) {
    const punctuation = PUNCTUATION_MAP[char];
    if (punctuation !== undefined) {
      out += punctuation;
      continue;
    }
    const letter = LETTER_MAP[char];
    if (letter !== undefined) {
      out += letter;
      continue;
    }
    // Acentos: la forma NFD separa la marca, que se descarta. Cubre
    // á→a, ñ→n, ü→u, ç→c y cualquier otro diacrítico Latin-1.
    const decomposed = char.normalize("NFD");
    if (decomposed.length > 1) {
      const stripped = decomposed.replace(/[\u0300-\u036f]/g, "");
      if (stripped.length > 0 && stripped !== char) {
        out += stripped;
        continue;
      }
    }
    const codePoint = char.codePointAt(0) ?? 0;
    if (!isPrintableLatin1(codePoint)) continue;
    out += char;
  }

  const collapsed = out.replace(/[\t\n\r ]+/g, " ").trim();
  return collapsed.length > 0 ? collapsed : fallback;
}

/** True si el valor ya es aceptable como header sin tocarlo. */
export function isHeaderValueSafe(value: string): boolean {
  if (value.length === 0) return false;
  for (const char of value) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (!isPrintableLatin1(codePoint)) return false;
  }
  return true;
}

export const DEFAULT_APP_TITLE = "Consenso IA - Coding Agent";
export const DEFAULT_SITE_URL = "http://localhost:3000";

/** Subconjunto de variables que el helper necesita, todas opcionales:
 * el helper usa defaults para las que falten. Los tests pasan objetos
 * chicos (`{}`, una sola clave) sin pelearse con el tipo. */
export type OpenRouterHeaderEnv = {
  OPENROUTER_SITE_URL?: string | undefined;
  OPENROUTER_APP_NAME?: string | undefined;
};

/**
 * Headers de identificación de OpenRouter (`HTTP-Referer` y `X-Title`),
 * siempre saneados. Es el ÚNICO lugar del repo que los arma: si mañana
 * se agrega otra llamada a OpenRouter, se usa esta función y no se
 * reedita el string.
 */
export function openRouterHeaders(env?: OpenRouterHeaderEnv): Record<string, string> {
  // Sin argumento se lee `process.env`; con argumento se usa tal cual
  // (los tests pasan uno chico). La lectura explícita evita que
  // TypeScript compare el index signature de `ProcessEnv` contra el tipo
  // laxo de arriba, que es un error de asignación, no un bug real.
  const source: OpenRouterHeaderEnv = env ?? {
    OPENROUTER_SITE_URL: process.env.OPENROUTER_SITE_URL,
    OPENROUTER_APP_NAME: process.env.OPENROUTER_APP_NAME,
  };
  return {
    "HTTP-Referer": sanitizeHeaderValue(source.OPENROUTER_SITE_URL, DEFAULT_SITE_URL),
    "X-Title": sanitizeHeaderValue(source.OPENROUTER_APP_NAME, DEFAULT_APP_TITLE),
  };
}
