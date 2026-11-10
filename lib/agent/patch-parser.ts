/**
 * Etapa 2.4 / P1 de paridad con OpenCode — parser de `patch` multi-archivo.
 *
 * QUÉ FALTABA: el agente tenía que tocar los archivos de a uno (`edit_file`,
 * `write_file`, `delete_file`). Para un cambio que cruza varios archivos —un
 * rename, una firma que se usa en tres lados— eran tres llamadas y tres
 * round-trips, con el riesgo de que el modelo se olvide uno. OpenCode resuelve
 * esto con una tool `patch` que en un solo call puede agregar, actualizar,
 * mover y borrar varios archivos.
 *
 * FORMATO que se acepta (el de OpenCode, verificado contra su doc):
 *
 *     *** Add File: ruta/nueva.ts
 *     +línea
 *     +línea
 *     *** Update File: ruta/vieja.ts
 *     @@ (opcional, decorativo: la posición la da el contenido)
 *      contexto
 *     -lo que se va
 *     +lo que entra
 *     *** Delete File: ruta/fuera.ts
 *
 * DECISIONES de esta implementación, y por qué:
 *
 *  - Los hunks se buscan por CONTENIDO, no por número de línea. Es lo que hace
 *    que un segundo hunk del mismo archivo siga aplicando aunque el primero haya
 *    cambiado la cantidad de líneas. El `@@` se acepta pero no se usa para
 *    posicionar: confiar en él es frágil (cualquier edición intermedio lo
 *    desalinea).
 *  - Un hunk que no se encuentra, o que aparece más de una vez, es ERROR y NO se
 *    aplica a medias. Un patch que se aplica "más o menos" es peor que uno que
 *    falla: el modelo cree que cambió algo que no cambió.
 *  - Todo el archivo se normaliza a LF antes de comparar y se devuelve al estilo
 *    original al guardar — misma regla que `edit_file`, misma razón: en Windows
 *    el checkout real es CRLF y sin esto NINGÚN hunk que cruce un salto de línea
 *    matchearía.
 *  - Topes explícitos (tamaño del patch, cantidad de archivos, cantidad de hunks
 *    por archivo). Un patch de 10 MB no es un patch, es un problema.
 */

/** Tope del texto del patch completo. */
export const MAX_PATCH_CHARS = 512 * 1024;

/** Tope de archivos por patch. */
export const MAX_PATCH_FILES = 50;

/** Tope de hunks por archivo. */
export const MAX_HUNKS_PER_FILE = 200;

export type PatchKind = "add" | "update" | "delete";

export type PatchFileOp = {
  kind: PatchKind;
  /** Ruta tal como la escribió el modelo (relativa al workspace). */
  relPath: string;
  /** Para `add`: el contenido completo. Para `update`: los hunks ya parseados. */
  hunks?: PatchHunk[];
  content?: string;
};

export type PatchHunk = {
  /** Líneas que tienen que estar (contexto + las que se van), sin prefijo. */
  oldLines: string[];
  /** Líneas que quedan (contexto + las que entran), sin prefijo. */
  newLines: string[];
};

export type PatchParseResult =
  | { ok: true; ops: PatchFileOp[]; warnings: string[] }
  | { ok: false; error: string };

/** Parser. Devuelve error (nunca tira) con un mensaje que el modelo pueda usar
 *  para corregir el patch y reintentar. */
export function parsePatch(patchText: string): PatchParseResult {
  if (typeof patchText !== "string" || !patchText.trim()) {
    return { ok: false, error: "El patch está vacío." };
  }
  if (patchText.length > MAX_PATCH_CHARS) {
    return {
      ok: false,
      error: `El patch mide ${patchText.length} caracteres y el tope es ${MAX_PATCH_CHARS}. Partilo en varios patches más chicos.`,
    };
  }

  const lineas = patchText.replace(/\r\n/g, "\n").split("\n");
  const ops: PatchFileOp[] = [];
  const warnings: string[] = [];
  let actual: PatchFileOp | null = null;
  let hunksDeEsteArchivo = 0;
  // El hunk que se está armando. null = recién arrancó la sección, o vino un @@
  // (que separa hunks).
  let hunkActual: PatchHunk | null = null;

  for (let i = 0; i < lineas.length; i += 1) {
    const linea = lineas[i];

    if (linea.startsWith("***")) {
      const header = /^\*\*\*\s*(Add File|Update File|Delete File|Move File|End of File)\s*:?\s*(.*)$/.exec(linea.trim());
      if (!header) {
        return { ok: false, error: `Línea ${i + 1}: encabezado de sección no reconocido: ${linea.slice(0, 80)}` };
      }
      const accion = header[1];
      const ruta = header[2].trim();
      if (accion === "End of File") {
        actual = null;
        continue;
      }
      if (accion === "Move File") {
        return {
          ok: false,
          error:
            "Move File no está soportado todavía: borrá el archivo con Delete File y crealo con Add File. " +
            "(Soportarlo exige decidir qué pasa con el historial de git; no se inventa.)",
        };
      }
      if (!ruta) return { ok: false, error: `Línea ${i + 1}: la sección ${accion} no dice qué archivo.` };
      if (ops.length >= MAX_PATCH_FILES) {
        return { ok: false, error: `El patch toca demasiados archivos (tope ${MAX_PATCH_FILES}).` };
      }
      const kind: PatchKind = accion === "Add File" ? "add" : accion === "Delete File" ? "delete" : "update";
      actual = {
        kind,
        relPath: ruta,
        ...(kind === "update" ? { hunks: [] } : {}),
        ...(kind === "add" ? { content: "" } : {}),
      };
      ops.push(actual);
      hunksDeEsteArchivo = 0;
      hunkActual = null;
      continue;
    }

    // Línea fuera de toda sección: solo se acepta si está vacía (espaciado
    // entre secciones). Cualquier otra cosa es un patch mal formado y se dice,
    // en vez de ignorarla en silencio.
    if (!actual) {
      if (linea.trim() === "") continue;
      return { ok: false, error: `Línea ${i + 1}: contenido fuera de una sección *** Add/Update/Delete File.` };
    }

    if (actual.kind === "add") {
      // En un Add File, TODO lo que sigue es contenido: las líneas llevan +
      // en el formato canónico, pero se aceptan también sin prefijo (hay
      // modelos que lo omiten) y en ese caso el contenido es tal cual.
      const contenido = linea.startsWith("+") ? linea.slice(1) : linea;
      actual.content = (actual.content ?? "") + (actual.content ? "\n" : "") + contenido;
      continue;
    }

    if (actual.kind === "delete") {
      // Delete File no lleva cuerpo.
      if (linea.trim() !== "") warnings.push(`${actual.relPath}: líneas ignoradas en una sección Delete File.`);
      continue;
    }

    // update: armar hunks.
    //
    // El @@ es el SEPARADOR de hunks: cada uno empieza un hunk nuevo. Los
    // números de línea que trae NO se usan para posicionar (confiar en ellos es
    // frágil: cualquier edición previa los desalinea), pero delimitar con él es
    // la semántica real del formato. Tratarlo como decorativo hacía que dos
    // cambios lejanos del mismo archivo quedaran en UN solo hunk, que después
    // no se encontraba como bloque contiguo: el test lo destapó.
    if (linea.startsWith("@@")) {
      hunkActual = null;
      continue;
    }
    if (hunksDeEsteArchivo >= MAX_HUNKS_PER_FILE) {
      return { ok: false, error: `${actual.relPath}: demasiados hunks (tope ${MAX_HUNKS_PER_FILE}).` };
    }

    if (!hunkActual) {
      hunkActual = { oldLines: [], newLines: [] };
      actual.hunks?.push(hunkActual);
      hunksDeEsteArchivo += 1;
    }

    const primerCaracter = linea.charAt(0);
    if (primerCaracter === "+") {
      hunkActual.newLines.push(linea.slice(1));
    } else if (primerCaracter === "-") {
      hunkActual.oldLines.push(linea.slice(1));
    } else {
      // Contexto: con prefijo de espacio, o línea totalmente vacía (el espacio
      // final suele desaparecer al copiar/pegar). Se trata como contexto vacío.
      const contenido = primerCaracter === " " ? linea.slice(1) : linea;
      hunkActual.oldLines.push(contenido);
      hunkActual.newLines.push(contenido);
    }
  }

  if (ops.length === 0) return { ok: false, error: "El patch no tiene ninguna sección *** Add/Update/Delete File." };
  for (const op of ops) {
    if (op.kind === "update" && (!op.hunks || op.hunks.length === 0)) {
      return { ok: false, error: `${op.relPath}: sección Update File sin ningún hunk.` };
    }
    if (op.kind === "add" && (!op.content || op.content.length === 0)) {
      return { ok: false, error: `${op.relPath}: sección Add File sin contenido.` };
    }
  }
  return { ok: true, ops, warnings };
}

export type HunkApplication =
  | { ok: true; lines: string[] }
  | { ok: false; error: string };

/**
 * Aplica UN hunk a las líneas del archivo. Busca el bloque `oldLines` como
 * subsecuencia contigua; si no está o está más de una vez, error (no se aplica a
 * medias).
 */
export function applyHunk(lineas: string[], hunk: PatchHunk): HunkApplication {
  if (hunk.oldLines.length === 0) {
    // Un hunk sin nada que sacar es una inserción pura: no se puede saber DÓNDE
    // sin un número de línea, y no se inventa.
    return { ok: false, error: "El hunk no tiene líneas de contexto ni de borrado: no se sabe dónde insertarlo." };
  }
  const coincidencias: number[] = [];
  for (let i = 0; i + hunk.oldLines.length <= lineas.length; i += 1) {
    let igual = true;
    for (let j = 0; j < hunk.oldLines.length; j += 1) {
      if (lineas[i + j] !== hunk.oldLines[j]) {
        igual = false;
        break;
      }
    }
    if (igual) coincidencias.push(i);
  }
  if (coincidencias.length === 0) {
    return { ok: false, error: `No se encontró el bloque que el hunk quiere reemplazar (primera línea: ${JSON.stringify(hunk.oldLines[0]).slice(0, 80)}).` };
  }
  if (coincidencias.length > 1) {
    return { ok: false, error: `El bloque aparece ${coincidencias.length} veces: agregá más contexto para que sea único.` };
  }
  const inicio = coincidencias[0];
  return {
    ok: true,
    lines: [...lineas.slice(0, inicio), ...hunk.newLines, ...lineas.slice(inicio + hunk.oldLines.length)],
  };
}

/** Aplica todos los hunks de un archivo, en orden. Si uno falla, no sigue. */
export function applyHunks(contenido: string, hunks: PatchHunk[]): HunkApplication {
  let lineas = contenido.split("\n");
  for (const hunk of hunks) {
    const aplicado = applyHunk(lineas, hunk);
    if (!aplicado.ok) return aplicado;
    lineas = aplicado.lines;
  }
  return { ok: true, lines: lineas };
}

/** Normaliza a LF para comparar. El estilo original lo restaura quien escribe. */
export function normalizarSaltos(texto: string): { normalizado: string; eraCRLF: boolean } {
  const eraCRLF = texto.includes("\r\n");
  return { normalizado: eraCRLF ? texto.replace(/\r\n/g, "\n") : texto, eraCRLF };
}

/** Vuelve al estilo original si el archivo era CRLF. */
export function restaurarSaltos(texto: string, eraCRLF: boolean): string {
  return eraCRLF ? texto.replace(/\n/g, "\r\n") : texto;
}
