/**
 * Fase 8F — lectura por rangos, binarios y UTF-8 inválido.
 *
 * Módulo puro + integración con los tools reales en un workspace temporal.
 * Sin red ni DB.
 *
 * Uso: npm run agent:test-read-range
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { READ_RANGE_LIMITS, decodeUtf8, describeDecodeFailure, hashBuffer, looksBinary, sliceLines, trimIncompleteUtf8Tail, type LineSlice, type LineSliceError } from "./read-range";
import { createAgentTools } from "./tools";

const results: boolean[] = [];
function check(ok: boolean, message: string, detail?: () => unknown) {
  console.log(ok ? `✅ ${message}` : `❌ ${message}${detail ? `\n   ${JSON.stringify(detail())}` : ""}`);
  results.push(ok);
}
const canon = (value: unknown) => JSON.stringify(value);
/** `LineSlice` no lleva `ok:true`; el error sí lleva `ok:false`. Este guard
 * discrimina sin cambiar el contrato de producción. */
const isSlice = (value: LineSlice | LineSliceError): value is LineSlice => !("ok" in value);
function checkEq(actual: unknown, expected: unknown, message: string) {
  check(canon(actual) === canon(expected), message, () => ({ esperado: expected, actual }));
}

async function main() {
  console.log("== Fase 8F — lectura por rangos y binarios ==\n");

  console.log("--- Detección de binarios ---");
  checkEq(looksBinary(Buffer.alloc(0)), false, "buffer vacío no es binario");
  checkEq(looksBinary(Buffer.from("texto normal\ncon líneas\ty tab")), false, "texto con tab/CR/LF no es binario");
  checkEq(looksBinary(Buffer.from([0x41, 0x00, 0x42])), true, "NUL → binario");
  checkEq(looksBinary(Buffer.from([1, 2, 3, 4])), true, "mayoría de controles C0 → binario");
  checkEq(looksBinary(Buffer.from([0x7f, 0x7f, 0x41])), true, "DEL cuenta como control");
  checkEq(looksBinary(Buffer.from("áéíóú ñ 日本")), false, "UTF-8 multibyte normal no es binario");
  checkEq(describeDecodeFailure("binary").includes("binario"), true, "mensaje de binario es claro");
  checkEq(describeDecodeFailure("invalid_utf8").includes("UTF-8"), true, "mensaje de UTF-8 inválido es claro");

  console.log("\n--- UTF-8: decodificación estricta y cola incompleta ---");
  const emoji = Buffer.from("😀", "utf8");
  checkEq(trimIncompleteUtf8Tail(emoji).length, emoji.length, "secuencia completa no se recorta");
  for (const cut of [1, 2, 3]) {
    checkEq(trimIncompleteUtf8Tail(emoji.subarray(0, emoji.length - cut)).length, 0, `prefijo cortado por ${cut} byte(s) se recorta completo`);
  }
  const valid = decodeUtf8(Buffer.from("hola 😀", "utf8"));
  check(valid.ok === true && valid.text === "hola 😀" && valid.trimmedTail === false, "UTF-8 válido decodifica exacto", () => valid);
  const truncated = decodeUtf8(Buffer.concat([Buffer.from("hola "), emoji.subarray(0, 2)]), { truncatedPrefix: true });
  check(truncated.ok === true && truncated.text === "hola " && truncated.trimmedTail === true, "prefijo truncado a mitad de emoji se recorta sin reemplazo", () => truncated);
  const invalid = decodeUtf8(Buffer.from([0x41, 0xff, 0x42]));
  check(invalid.ok === false && invalid.reason === "invalid_utf8", "byte inválido → invalid_utf8 (no reemplaza en silencio)", () => invalid);
  const invalidTail = decodeUtf8(Buffer.from([0x41, 0xe2, 0x28, 0xa1]), { truncatedPrefix: true });
  check(invalidTail.ok === false && invalidTail.reason === "invalid_utf8", "secuencia inválida que no es cola truncada sigue siendo error", () => invalidTail);
  const binaryDecode = decodeUtf8(Buffer.from([0x00, 0x01]));
  check(binaryDecode.ok === false && binaryDecode.reason === "binary", "decodeUtf8 rechaza binario antes de decodificar", () => binaryDecode);

  console.log("\n--- Hash ---");
  checkEq(hashBuffer(Buffer.from("abc")), crypto.createHash("sha256").update("abc").digest("hex"), "SHA-256 de 'abc'");
  checkEq(hashBuffer(Buffer.from("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "hash conocido y estable");

  console.log("\n--- sliceLines: rangos 1-based inclusivos ---");
  const text = "a\nb\nc\nd\n";
  checkEq(sliceLines(text), { content: "a\nb\nc\nd", startLine: 1, endLine: 4, totalLines: 4, truncated: false, lineTruncated: false, nextStartLine: null }, "sin opciones: todas las líneas, sin fantasma final");
  checkEq(sliceLines(text, { startLine: 2, endLine: 3 }), { content: "b\nc", startLine: 2, endLine: 3, totalLines: 4, truncated: true, lineTruncated: false, nextStartLine: 4 }, "rango 2..3: quedan líneas, se ofrece nextStartLine");
  checkEq(sliceLines(text, { startLine: 1, maxLines: 2 }), { content: "a\nb", startLine: 1, endLine: 2, totalLines: 4, truncated: true, lineTruncated: false, nextStartLine: 3 }, "maxLines corta y ofrece nextStartLine");
  checkEq(sliceLines(text, { startLine: 3, endLine: 999 }), { content: "c\nd", startLine: 3, endLine: 4, totalLines: 4, truncated: false, lineTruncated: false, nextStartLine: null }, "endLine se acota al total");
  const crlf = sliceLines("a\r\nb\r\n");
  checkEq(isSlice(crlf) ? crlf.content : null, "a\nb", "CRLF se normaliza a LF");
  const trailing = sliceLines("a\n");
  checkEq(isSlice(trailing) ? trailing.totalLines : null, 1, "salto final no crea línea fantasma");
  checkEq(sliceLines(""), { ok: false, error: "el archivo está vacío (0 líneas)." }, "texto vacío → error");
  checkEq(sliceLines("a\nb", { startLine: 5 }), { ok: false, error: "startLine 5 supera el total de líneas (2)." }, "startLine fuera de rango → error");
  checkEq(sliceLines("a\nb", { startLine: 2, endLine: 1 }), { ok: false, error: "endLine 1 es menor que startLine 2." }, "endLine < startLine → error");
  {
    const line = "x".repeat(100);
    const cut = sliceLines(line, { maxBytes: 10 });
    check(isSlice(cut) && cut.content === "x".repeat(10) && cut.lineTruncated === true && cut.truncated === true && cut.nextStartLine === 2, "una línea más grande que maxBytes se recorta y se marca lineTruncated", () => cut);
  }
  {
    const cut = sliceLines("0123456789", { maxBytes: 5 });
    check(isSlice(cut) && cut.content === "01234" && cut.lineTruncated === true, "maxBytes corta la línea inicial sin mentir sobre el rango", () => cut);
  }
  {
    const many = Array.from({ length: 2_500 }, (_, index) => `línea ${index}`).join("\n");
    const capped = sliceLines(many, { maxLines: 99_999 });
    check(isSlice(capped) && capped.endLine === READ_RANGE_LIMITS.maxLines && capped.totalLines === 2_500 && capped.truncated, "maxLines se acota al tope duro", () => (isSlice(capped) ? { end: capped.endLine, total: capped.totalLines } : capped));
  }
  {
    const multiline = sliceLines("aaaa\nbbbb\ncccc", { maxBytes: 9 });
    check(isSlice(multiline) && multiline.content === "aaaa\nbbbb" && multiline.truncated && multiline.nextStartLine === 3, "maxBytes corta por líneas completas", () => multiline);
  }
  {
    const firstTooBig = sliceLines("0123456789\nsegunda", { maxBytes: 5 });
    check(isSlice(firstTooBig) && firstTooBig.content === "01234" && firstTooBig.lineTruncated === true && firstTooBig.nextStartLine === 2, "si la primera línea no entra, devuelve un fragmento marcado y la próxima línea", () => firstTooBig);
  }

  console.log("\n--- Integración con read_file / read_file_range ---");
  {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "magi-read-range-"));
    try {
      const content = "línea uno\nlínea dos\nlínea tres\n";
      await fs.writeFile(path.join(dir, "texto.txt"), content, "utf-8");
      await fs.writeFile(path.join(dir, "binario.bin"), Buffer.from([0x00, 0x01, 0x02, 0x03]));
      await fs.writeFile(path.join(dir, "invalido.txt"), Buffer.from([0x41, 0xff, 0x42]));
      const tools = createAgentTools(dir, () => {}, []) as unknown as Record<string, { execute: (input: Record<string, unknown>, options?: unknown) => Promise<any> }>;
      const readFile = await tools.read_file.execute({ path: "texto.txt" });
      check(readFile.ok === true && readFile.content === content && readFile.truncated === false && readFile.hash === hashBuffer(Buffer.from(content)), "read_file devuelve contenido + hash SHA-256", () => readFile);
      const range = await tools.read_file_range.execute({ path: "texto.txt", startLine: 2, endLine: 3 });
      check(range.ok === true && range.content === "línea dos\nlínea tres" && range.startLine === 2 && range.endLine === 3 && range.totalLines === 3, "read_file_range devuelve solo el rango pedido", () => range);
      check(range.hash === readFile.hash && range.hashAlgorithm === "sha256", "el hash del rango identifica el archivo completo", () => range);
      checkEq(range.nextStartLine, null, "rango que llega al final: no hay próxima línea");
      const page = await tools.read_file_range.execute({ path: "texto.txt", startLine: 1, maxLines: 2 });
      check(page.ok === true && page.content === "línea uno\nlínea dos" && page.truncated === true && page.nextStartLine === 3, "paginación con nextStartLine", () => page);
      const badRange = await tools.read_file_range.execute({ path: "texto.txt", startLine: 99 });
      check(badRange.ok === false && badRange.code === "invalid_range", "rango fuera del archivo → invalid_range", () => badRange);
      const binary = await tools.read_file.execute({ path: "binario.bin" });
      check(binary.ok === false && binary.code === "binary" && !binary.content, "read_file rechaza binarios (no los serializa)", () => binary);
      const binaryRange = await tools.read_file_range.execute({ path: "binario.bin" });
      check(binaryRange.ok === false && binaryRange.code === "binary", "read_file_range también rechaza binarios", () => binaryRange);
      const invalid = await tools.read_file.execute({ path: "invalido.txt" });
      check(invalid.ok === false && invalid.code === "invalid_utf8" && !invalid.content, "read_file rechaza UTF-8 inválido", () => invalid);
      const invalidRange = await tools.read_file_range.execute({ path: "invalido.txt" });
      check(invalidRange.ok === false && invalidRange.code === "invalid_utf8", "read_file_range rechaza UTF-8 inválido", () => invalidRange);
      const traversal = await tools.read_file_range.execute({ path: "../fuera.txt" });
      check(traversal.ok === false && !canon(traversal).includes(dir), "read_file_range bloquea traversal sin filtrar la ruta absoluta", () => traversal);
      const absolute = await tools.read_file_range.execute({ path: path.join(dir, "texto.txt") });
      check(absolute.ok === false, "read_file_range bloquea rutas absolutas", () => absolute);
      const missing = await tools.read_file_range.execute({ path: "no-existe.txt" });
      check(missing.ok === false && missing.error.includes("no existe"), "archivo inexistente → error legible", () => missing);
      const directory = await tools.read_file_range.execute({ path: "." });
      check(directory.ok === false && directory.error.includes("no es un archivo"), "directorio → error legible", () => directory);
      check(READ_RANGE_LIMITS.maxLines === 2_000 && READ_RANGE_LIMITS.maxBytes === 200_000, "límites duros documentados");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  console.log("\n--- Prefijo truncado de un archivo grande ---");
  {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "magi-read-prefix-"));
    try {
      const prefix = "a".repeat(READ_RANGE_LIMITS.maxBytes - 1);
      const buffer = Buffer.concat([Buffer.from(prefix, "utf8"), emoji]);
      await fs.writeFile(path.join(dir, "grande.txt"), buffer);
      const tools = createAgentTools(dir, () => {}, []) as unknown as Record<string, { execute: (input: Record<string, unknown>, options?: unknown) => Promise<any> }>;
      const result = await tools.read_file.execute({ path: "grande.txt" });
      check(result.ok === true && result.truncated === true && result.hash === null, "archivo > 200KB: truncated y hash null (no identifica una versión completa)", () => result);
      check(result.content.length === READ_RANGE_LIMITS.maxBytes - 1 && !result.content.includes("\uFFFD"), "el prefijo cortado a mitad de emoji se recorta sin carácter de reemplazo", () => ({ length: result.content.length, replacement: result.content.includes("\uFFFD") }));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} casos OK.`);
  if (passed !== results.length) process.exit(1);
}

main().catch((error) => {
  console.error("Error inesperado en la prueba:", error);
  process.exit(1);
});
