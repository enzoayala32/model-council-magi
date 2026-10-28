/**
 * Fase 4 — tests de extracción de adjuntos PDF/DOCX.
 *
 * Cubre `lib/attachment-extraction.ts`: parsing de data URLs, extracción
 * best-effort de PDF y DOCX, y el tope de 40.000 caracteres. Genera los
 * binarios en memoria (PDF armado a mano, DOCX con JSZip) — sin fixtures
 * opacos ni red.
 *
 * Uso: npm run council:test-attachment-extraction
 */
import JSZip from "jszip";
import { bufferFromDataUrl, extractDocxText, extractPdfText } from "./attachment-extraction";

const results: boolean[] = [];
function check(ok: boolean, label: string, detail?: unknown): void {
  results.push(ok);
  console.log(`${ok ? "✅" : "❌"} ${label}${ok ? "" : ` — ${JSON.stringify(detail)}`}`);
}
function checkEq(actual: unknown, expected: unknown, label: string): void {
  check(JSON.stringify(actual) === JSON.stringify(expected), label, { esperado: expected, actual });
}

function escapePdf(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/** PDF 1.4 mínimo de una página con texto Helvetica y xref correcto. */
function makePdf(lines: string[]): Buffer {
  const content = [
    "BT",
    "/F1 12 Tf",
    "72 720 Td",
    ...lines.flatMap((line, index) => [index === 0 ? "" : "0 -14 Td", `(${escapePdf(line)}) Tj`]).filter(Boolean),
    "ET",
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
  ];

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** DOCX mínimo (ZIP con [Content_Types].xml, _rels/.rels y word/document.xml). */
async function makeDocx(paragraphs: string[]): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  );
  zip.folder("_rels")!.file(
    ".rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  const body = paragraphs.map((paragraph) => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(paragraph)}</w:t></w:r></w:p>`).join("");
  zip.folder("word")!.file(
    "document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr/></w:body></w:document>`,
  );
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

async function main(): Promise<void> {
  console.log("== Fase 4 — extracción de adjuntos ==\n");

  console.log("--- bufferFromDataUrl ---");
  {
    checkEq(bufferFromDataUrl("data:text/plain;base64,SGVsbG8=").toString("utf8"), "Hello", "extrae el payload de un data URL");
    checkEq(bufferFromDataUrl("SGVsbG8=").toString("utf8"), "Hello", "acepta base64 pelado sin coma");
    checkEq(bufferFromDataUrl("data:text/plain;base64,").length, 0, "payload vacío devuelve buffer vacío");
    checkEq(bufferFromDataUrl("data:application/pdf;charset=utf-8;base64,AAAA").length, 3, "ignora parámetros del data URL antes de base64");

    const binary = Buffer.from([0x00, 0x01, 0x02, 0xff]);
    checkEq([...bufferFromDataUrl(`data:application/octet-stream;base64,${binary.toString("base64")}`)], [...binary], "conserva bytes binarios, incluido 0xff");

    const pdf = makePdf(["Hola desde data URL"]);
    const fromDataUrl = await extractPdfText(bufferFromDataUrl(`data:application/pdf;base64,${pdf.toString("base64")}`));
    check(fromDataUrl.includes("Hola desde data URL"), "un PDF embebido como data URL se extrae igual", fromDataUrl);
  }

  console.log("\n--- extractPdfText ---");
  {
    const invalid = await extractPdfText(Buffer.from("esto no es un pdf"));
    check(invalid.startsWith("(Could not extract text from this PDF:"), "buffer inválido devuelve mensaje explicativo, no excepción", invalid);
    check(invalid.includes("encrypted, corrupted, or scanned images"), "el mensaje menciona las causas probables", invalid);

    const empty = await extractPdfText(Buffer.alloc(0));
    check(empty.startsWith("(Could not extract text from this PDF:"), "buffer vacío también se maneja sin tirar", empty);

    const valid = makePdf(["Hola PDF", "Segunda linea", "Tercera linea"]);
    const text = await extractPdfText(valid);
    check(text.includes("Hola PDF") && text.includes("Segunda linea") && text.includes("Tercera linea"), "extrae todas las líneas de un PDF válido", text);
    check(text.includes("-- 1 of 1 --"), "pdf-parse agrega el marcador de página (comportamiento actual)", text);

    // Texto ASCII a propósito: Helvetica/WinAnsi no round-tripéa acentos en este PDF mínimo.
    const special = makePdf(["Parentesis (y) \\ barra"]);
    const specialText = await extractPdfText(special);
    check(specialText.includes("Parentesis (y) \\ barra"), "respeta paréntesis y barras escapadas en el PDF", specialText);

    const noText = makePdf([]);
    const noTextResult = await extractPdfText(noText);
    check(typeof noTextResult === "string" && !noTextResult.startsWith("(Could not extract"), "un PDF sin capa de texto no se reporta como error de extracción", noTextResult);

    const truncated = await extractPdfText(valid.subarray(0, Math.floor(valid.length / 2)));
    check(truncated.startsWith("(Could not extract text from this PDF:"), "un PDF truncado se maneja como error best-effort", truncated);
  }

  console.log("\n--- extractDocxText ---");
  {
    const invalid = await extractDocxText(Buffer.from("esto no es un docx"));
    check(invalid.startsWith("(Could not extract text from this DOCX file:"), "buffer inválido devuelve mensaje explicativo, no excepción", invalid);
    check(invalid.includes("corrupted or password-protected"), "el mensaje menciona corrupción o contraseña", invalid);

    const empty = await extractDocxText(Buffer.alloc(0));
    check(empty.startsWith("(Could not extract text from this DOCX file:"), "buffer vacío también se maneja sin tirar", empty);

    const valid = await makeDocx(["Hola DOCX", "Segunda linea"]);
    const text = await extractDocxText(valid);
    check(text.includes("Hola DOCX") && text.includes("Segunda linea"), "extrae todos los párrafos de un DOCX válido", text);

    const unicode = await makeDocx(["Informe técnico — ñandú", "Año 2026: acción y decisión"]);
    const unicodeText = await extractDocxText(unicode);
    check(unicodeText.includes("Informe técnico — ñandú") && unicodeText.includes("Año 2026: acción y decisión"), "conserva acentos, eñes y guiones largos", unicodeText);

    const special = await makeDocx(['A & B < C > D "E"']);
    const specialText = await extractDocxText(special);
    check(specialText.includes('A & B < C > D "E"'), "escapa y recupera caracteres XML especiales", specialText);

    const emptyDoc = await makeDocx([]);
    checkEq(await extractDocxText(emptyDoc), "(No extractable text found in this document.)", "documento sin párrafos devuelve el mensaje de vacío");

    const whitespaceDoc = await makeDocx(["   ", "\n\t"]);
    checkEq(await extractDocxText(whitespaceDoc), "(No extractable text found in this document.)", "documento con solo espacios devuelve el mensaje de vacío");

    const corruptZip = valid.subarray(0, Math.floor(valid.length / 3));
    const corruptResult = await extractDocxText(corruptZip);
    check(corruptResult.startsWith("(Could not extract text from this DOCX file:"), "un ZIP truncado se maneja como error best-effort", corruptResult);

    const exactLimit = await makeDocx(["x".repeat(40_000)]);
    checkEq(await extractDocxText(exactLimit), "x".repeat(40_000), "40.000 caracteres exactos no se truncan");

    const overLimit = await makeDocx(["x".repeat(40_001)]);
    const overText = await extractDocxText(overLimit);
    check(overText.startsWith("x".repeat(40_000)), "41.000 caracteres se cortan a los primeros 40.000");
    check(overText.includes("… truncated (40001 characters total, showing first 40000)"), "el truncado explica el total y lo mostrado", overText.slice(-120));
    checkEq(overText.length, 40_000 + "\n\n… truncated (40001 characters total, showing first 40000)".length, "el marcador de truncado se agrega al final");
  }

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} casos OK.`);
  if (passed !== results.length) process.exit(1);
}

main().catch((error) => {
  console.error("Error inesperado en la prueba:", error);
  process.exit(1);
});
