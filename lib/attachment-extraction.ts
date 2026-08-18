import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";

/**
 * Text extraction for PDF and DOCX attachments. Runs server-side (Node
 * runtime, not edge) since both libraries need real Buffer/binary parsing
 * the browser can't do reliably. The client only reads these files as
 * base64 and tags their kind — see readUploads() in app/page.tsx — and this
 * module turns that base64 into plain text before it ever reaches a prompt.
 *
 * Both extractors are best-effort: a corrupt, encrypted, or unusually
 * structured file should never crash the run. On failure we return an
 * explanatory string instead of throwing, so the model — and the user — see
 * a clear reason the file's content wasn't available, rather than a
 * mysterious missing attachment or a broken run.
 */

const MAX_EXTRACTED_CHARS = 40_000; // keeps a single huge document from blowing out the prompt budget

export async function extractPdfText(buffer: Buffer): Promise<string> {
  try {
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    try {
      const result = await parser.getText();
      return capText(result.text?.trim() || "(No extractable text — this PDF may be scanned images without OCR text.)");
    } finally {
      await parser.destroy();
    }
  } catch (error) {
    return `(Could not extract text from this PDF: ${error instanceof Error ? error.message : "unknown error"}. It may be encrypted, corrupted, or scanned images without a text layer.)`;
  }
}

export async function extractDocxText(buffer: Buffer): Promise<string> {
  try {
    const result = await mammoth.extractRawText({ buffer });
    return capText(result.value?.trim() || "(No extractable text found in this document.)");
  } catch (error) {
    return `(Could not extract text from this DOCX file: ${error instanceof Error ? error.message : "unknown error"}. It may be corrupted or password-protected.)`;
  }
}

function capText(text: string): string {
  if (text.length <= MAX_EXTRACTED_CHARS) return text;
  return `${text.slice(0, MAX_EXTRACTED_CHARS)}\n\n… truncated (${text.length} characters total, showing first ${MAX_EXTRACTED_CHARS})`;
}

/** Pulls the base64 payload out of a `data:...;base64,XXXX` URL. */
export function bufferFromDataUrl(dataUrl: string): Buffer {
  const commaIndex = dataUrl.indexOf(",");
  const base64 = commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : dataUrl;
  return Buffer.from(base64, "base64");
}
