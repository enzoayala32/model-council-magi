/**
 * Tests de `lib/http-headers.ts`.
 *
 * El caso que motivó el módulo: `OPENROUTER_APP_NAME` con una raya larga
 * (U+2014) hacía que `fetch` lanzara
 * "Cannot convert argument to a ByteString ... 8212". El test cubre eso
 * y toda familia de caracteres que `fetch` rechazaría igual.
 *
 * Uso: npm run security:test-http-headers
 */
import {
  DEFAULT_APP_TITLE,
  DEFAULT_SITE_URL,
  isHeaderValueSafe,
  openRouterHeaders,
  sanitizeHeaderValue,
} from "./http-headers";

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passed += 1;
    console.log(`✅ ${label}`);
    return;
  }
  failed += 1;
  console.log(`❌ ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

function everyCharLatin1(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return false;
    if (code >= 0x80 && code <= 0x9f) return false;
    if (code > 0xff) return false;
  }
  return true;
}

function main(): void {
  console.log("== sanitizeHeaderValue ==\n");

  check("string vacío devuelve el fallback", sanitizeHeaderValue("", "X") === "X");
  check("undefined devuelve el fallback", sanitizeHeaderValue(undefined, "X") === "X");
  check("null devuelve el fallback", sanitizeHeaderValue(null, "X") === "X");
  check("solo espacios devuelve el fallback", sanitizeHeaderValue("   ", "X") === "X");

  // El bug original y sus parientes.
  check(
    "raya larga U+2014 se vuelve guion",
    sanitizeHeaderValue("Consenso IA — Coding Agent") === "Consenso IA - Coding Agent",
  );
  check("raya corta U+2013 se vuelve guion", sanitizeHeaderValue("a – b") === "a - b");
  check("menos tipográfico U+2212 se vuelve guion", sanitizeHeaderValue("a − b") === "a - b");
  check(
    "el default quedó ASCII puro e idéntico al helper",
    sanitizeHeaderValue("Consenso IA — Coding Agent") === DEFAULT_APP_TITLE,
  );

  // Acentos y Latin-1 extendida.
  check("acento agudo y e\u00f1e se transliteran", sanitizeHeaderValue("Cami\u00f3\u00f1") === "Camion");
  check("diéresis se translitera", sanitizeHeaderValue("Ünicode") === "Unicode");
  check("tilde se translitera", sanitizeHeaderValue("AÑO") === "ANO");
  check("cedilla se translitera", sanitizeHeaderValue("França") === "Franca");
  check("ß se vuelve ss", sanitizeHeaderValue("Straße") === "Strasse");
  check("ø se vuelve o", sanitizeHeaderValue("Sørensen") === "Sorensen");

  // Comillas tipográficas y puntuación.
  check(
    "comillas tipográficas se reemplazan",
    sanitizeHeaderValue('“Smart” ‘app’') === '"Smart" \'app\'',
  );
  check("elipsis se vuelve tres puntos", sanitizeHeaderValue("a…b") === "a...b");
  check("espacio duro se colapsa", sanitizeHeaderValue("a\u00A0b") === "a b");
  check("bullet se vuelve guion", sanitizeHeaderValue("• item") === "- item");

  // Lo que NO se puede representar se descarta.
  check("emoji se descarta", sanitizeHeaderValue("café ☕") === "cafe");
  check("CJK se descarta", sanitizeHeaderValue("模型 Council") === "Council");
  check("carácter sin representación deja el fallback", sanitizeHeaderValue("☕", "X") === "X");

  // Inyección de headers: los controles nunca sobreviven.
  // Los controles se DESCARTAN, no se colapsan: un CRLF dentro de un valor
  // de header es exactamente el vector de response splitting, así que no
  // puede sobrevivir ni convertirse en otra cosa.
  check("CRLF se descarta", sanitizeHeaderValue("a\r\nb") === "ab");
  check("tab se descarta", sanitizeHeaderValue("a\tb") === "ab");
  check("CRLF no deja rastro de cabecera nueva", !sanitizeHeaderValue("a\r\nX-Evil: 1").includes("\n"));
  check("carácter de control 0x01 se descarta", sanitizeHeaderValue("a\u0001b") === "ab");
  check("NUL se descarta", sanitizeHeaderValue("a\u0000b") === "ab");
  check("espacios repetidos se colapsan", sanitizeHeaderValue("a    b") === "a b");

  // Propiedad invariante: el resultado SIEMPRE es Latin-1 imprimible.
  const hostile = "Consenso IA — “ñ” ① café ☕ \u0007 a — b\u00A0c";
  const sanitized = sanitizeHeaderValue(hostile);
  check("el resultado de una entrada hostil es Latin-1 imprimible", everyCharLatin1(sanitized), sanitized);
  check("el resultado no está vacío", sanitized.length > 0, sanitized);
  check("es idempotente", sanitizeHeaderValue(sanitized) === sanitized);
  check(
    "isHeaderValueSafe acepta ASCII plano",
    isHeaderValueSafe("Consenso IA - Coding Agent"),
  );
  check("isHeaderValueSafe rechaza la raya larga", !isHeaderValueSafe("a — b"));
  check("isHeaderValueSafe rechaza el salto de línea", !isHeaderValueSafe("a\nb"));
  check("isHeaderValueSafe rechaza una cadena vacía", !isHeaderValueSafe(""));

  console.log("\n== openRouterHeaders ==\n");

  const plain = openRouterHeaders({ OPENROUTER_SITE_URL: "http://localhost:3000", OPENROUTER_APP_NAME: "Consenso IA" });
  check("solo arma HTTP-Referer y X-Title", Object.keys(plain).length === 2);
  check("HTTP-Referer usa el valor configurado", plain["HTTP-Referer"] === "http://localhost:3000");
  check("X-Title usa el valor configurado", plain["X-Title"] === "Consenso IA");

  const withMarks = openRouterHeaders({
    OPENROUTER_SITE_URL: "http://localhost:3000",
    OPENROUTER_APP_NAME: "Consenso IA — Coding Agent “ñ”",
  });
  check("X-Title con raya larga queda saneado", withMarks["X-Title"] === 'Consenso IA - Coding Agent "n"');
  check("HTTP-Referer no se contamina", withMarks["HTTP-Referer"] === "http://localhost:3000");
  check("ambos valores son header-safe", isHeaderValueSafe(withMarks["X-Title"]) && isHeaderValueSafe(withMarks["HTTP-Referer"]));

  const defaults = openRouterHeaders({});
  check("sin env, X-Title cae al default ASCII", defaults["X-Title"] === DEFAULT_APP_TITLE);
  check("sin env, HTTP-Referer cae al default", defaults["HTTP-Referer"] === DEFAULT_SITE_URL);
  check("el default ASCII es header-safe", isHeaderValueSafe(DEFAULT_APP_TITLE) && isHeaderValueSafe(DEFAULT_SITE_URL));

  const blank = openRouterHeaders({ OPENROUTER_APP_NAME: "   ", OPENROUTER_SITE_URL: "!!! \u2014" });
  check("valor compuesto solo de basura cae al default", blank["X-Title"] === DEFAULT_APP_TITLE, blank["X-Title"]);
  // "!!!" y la raya convertida en "-" SON Latin-1 imprimible: no hay nada que
  // sanear, el valor se acepta tal cual. El test fija eso para que nadie
  // "arregle" el sanitizador descartando puntuación válida.
  check("HTTP-Referer con basura Latin-1 se acepta tal cual", blank["HTTP-Referer"] === "!!! -", blank["HTTP-Referer"]);

  // El síntoma real: construir headers con un valor hostil no lanza.
  let threw = false;
  const headers = new Headers();
  try {
    headers.set("X-Title", withMarks["X-Title"]);
    // Headers.set lanzaría igual si el valor trajera caracteres fuera de Latin-1.
  } catch {
    threw = true;
  }
  check("Headers.set acepta el valor saneado (no hay ByteString)", !threw);

  console.log(`\n${passed}/${passed + failed} casos OK`);
  if (failed > 0) process.exit(1);
}

main();
