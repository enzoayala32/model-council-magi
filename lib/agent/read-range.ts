/**
 * Fase 8F — Lectura acotada por rangos y detección de binarios/UTF-8 inválido.
 *
 * Módulo PURO (salvo `hashBuffer`, que solo usa `node:crypto`): no lee
 * archivos, no resuelve rutas y no conoce el workspace. `tools.ts` hace la
 * validación de seguridad (`resolveSafePath`, `stat`, tamaño máximo) JUSTO
 * ANTES de leer, y acá solo se decide cómo decodificar y cortar.
 *
 * Decisiones:
 * - Un archivo con NUL en la muestra inicial, o con una proporción alta de
 *   bytes de control, se considera BINARIO y no se serializa como texto.
 *   Esto evita mandar basura al modelo y, sobre todo, evita que un archivo
 *   binario con apariencia de texto se cuele en el contexto.
 * - UTF-8 inválido se detecta con `TextDecoder(..., { fatal: true })`, no
 *   con `toString("utf-8")` (que reemplaza en silencio y oculta el
 *   problema). Un prefijo cortado a mitad de un carácter se recorta hasta
 *   el último carácter completo SOLO cuando el llamador avisa que el
 *   buffer es un prefijo truncado.
 * - Los rangos son 1-based e inclusivos, como un editor. `endLine` se
 *   acota a `maxLines` para que un pedido `1..999999` no explote.
 * - El tope de bytes se aplica por líneas completas; si UNA sola línea no
 *   entra, se devuelve esa línea recortada y se marca `lineTruncated`
 *   (nunca se miente diciendo que el rango está completo).
 */
import crypto from "node:crypto";

export const READ_RANGE_LIMITS = {
  /** Líneas por defecto si el modelo no pide un rango. */
  defaultLines: 200,
  /** Tope duro de líneas por llamada. */
  maxLines: 2_000,
  /** Tope de bytes de contenido devuelto. */
  maxBytes: 200_000,
  /** Tope de archivo que se acepta leer entero para localizar líneas. */
  maxFileBytes: 10_000_000,
  /** Bytes que se inspeccionan para decidir si es binario. */
  sniffBytes: 8_000,
} as const;

export type TextDecodeResult =
  | { ok: true; text: string; trimmedTail: boolean }
  | { ok: false; reason: "binary" | "invalid_utf8" };

/** `true` si la muestra parece binaria. No es un detector perfecto: es una
 * barrera conservadora para no serializar binarios como si fueran texto. */
export function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, READ_RANGE_LIMITS.sniffBytes);
  if (sample.length === 0) return false;
  if (sample.includes(0)) return true;
  let control = 0;
  for (const byte of sample) {
    // Permitimos tab, LF, VT, FF y CR; el resto de los controles C0 y DEL
    // son señal fuerte de contenido binario.
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20) || byte === 0x7f) control += 1;
  }
  return control / sample.length > 0.3;
}

/** Recorta un final incompleto de secuencia UTF-8 (solo para prefijos). */
export function trimIncompleteUtf8Tail(buffer: Buffer): Buffer {
  if (buffer.length === 0) return buffer;
  let index = buffer.length - 1;
  let continuations = 0;
  while (index >= 0 && (buffer[index] & 0xc0) === 0x80 && continuations < 3) {
    index -= 1;
    continuations += 1;
  }
  if (index < 0) return buffer;
  const lead = buffer[index];
  let expected = 0;
  if ((lead & 0x80) === 0) expected = 1;
  else if ((lead & 0xe0) === 0xc0) expected = 2;
  else if ((lead & 0xf0) === 0xe0) expected = 3;
  else if ((lead & 0xf8) === 0xf0) expected = 4;
  if (expected > 1 && index + expected > buffer.length) return buffer.subarray(0, index);
  return buffer;
}

export function decodeUtf8(buffer: Buffer, options: { truncatedPrefix?: boolean } = {}): TextDecodeResult {
  if (looksBinary(buffer)) return { ok: false, reason: "binary" };
  const candidate = options.truncatedPrefix ? trimIncompleteUtf8Tail(buffer) : buffer;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(candidate);
    return { ok: true, text, trimmedTail: candidate.length !== buffer.length };
  } catch {
    return { ok: false, reason: "invalid_utf8" };
  }
}

export function hashBuffer(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

export type LineSliceOptions = {
  startLine?: number;
  endLine?: number;
  maxLines?: number;
  maxBytes?: number;
};

export type LineSlice = {
  content: string;
  /** Primera línea devuelta (1-based). */
  startLine: number;
  /** Última línea devuelta (1-based, inclusiva). */
  endLine: number;
  totalLines: number;
  /** `true` si quedaron líneas afuera por `endLine`, `maxLines` o bytes. */
  truncated: boolean;
  /** `true` si la última línea devuelta se cortó a mitad por `maxBytes`. */
  lineTruncated: boolean;
  /** Próxima línea a pedir, o `null` si no quedan. */
  nextStartLine: number | null;
};

export type LineSliceError = { ok: false; error: string };

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  // Un salto final no crea una línea vacía "fantasma": "a\nb\n" son 2 líneas.
  if (lines.length > 0 && lines[lines.length - 1] === "" && text.endsWith("\n")) lines.pop();
  return lines;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

export function sliceLines(text: string, options: LineSliceOptions = {}): LineSlice | LineSliceError {
  const lines = splitLines(text);
  const totalLines = lines.length;
  const startLine = clampInt(options.startLine, 1, 1, Number.MAX_SAFE_INTEGER);
  const maxLines = clampInt(options.maxLines, READ_RANGE_LIMITS.defaultLines, 1, READ_RANGE_LIMITS.maxLines);
  const maxBytes = clampInt(options.maxBytes, READ_RANGE_LIMITS.maxBytes, 1, READ_RANGE_LIMITS.maxBytes);

  if (totalLines === 0) return { ok: false, error: "el archivo está vacío (0 líneas)." };
  if (startLine > totalLines) return { ok: false, error: `startLine ${startLine} supera el total de líneas (${totalLines}).` };

  const requestedEnd = typeof options.endLine === "number" && Number.isFinite(options.endLine) ? Math.floor(options.endLine) : startLine + maxLines - 1;
  if (requestedEnd < startLine) return { ok: false, error: `endLine ${requestedEnd} es menor que startLine ${startLine}.` };
  const endLine = Math.min(requestedEnd, startLine + maxLines - 1, totalLines);

  const selected: string[] = [];
  let bytes = 0;
  let lineTruncated = false;
  for (let lineNumber = startLine; lineNumber <= endLine; lineNumber++) {
    const line = lines[lineNumber - 1] ?? "";
    const separator = selected.length === 0 ? 0 : 1;
    const lineBytes = Buffer.byteLength(line, "utf-8");
    if (bytes + separator + lineBytes <= maxBytes) {
      selected.push(line);
      bytes += separator + lineBytes;
      continue;
    }
    if (selected.length === 0) {
      // Ni una línea entra: devolvemos lo que sí entra, marcado como cortado.
      let low = 0;
      let high = line.length;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (Buffer.byteLength(line.slice(0, mid), "utf-8") <= maxBytes) low = mid;
        else high = mid - 1;
      }
      selected.push(line.slice(0, low));
      lineTruncated = true;
    }
    break;
  }

  const returnedEnd = startLine + selected.length - 1;
  const truncated = returnedEnd < totalLines || lineTruncated;
  const nextStartLine = truncated ? (lineTruncated ? startLine + 1 : returnedEnd + 1) : null;

  return {
    content: selected.join("\n"),
    startLine,
    endLine: returnedEnd,
    totalLines,
    truncated,
    lineTruncated,
    nextStartLine,
  };
}

/** Texto de error estable para el tool; nunca incluye rutas absolutas. */
export function describeDecodeFailure(reason: "binary" | "invalid_utf8"): string {
  return reason === "binary"
    ? "El archivo parece binario (contiene bytes NUL o demasiados caracteres de control); no se serializa como texto. Usá otra herramienta o un archivo de texto."
    : "El archivo no es UTF-8 válido; no se serializa para evitar enviar contenido corrupto al modelo.";
}
