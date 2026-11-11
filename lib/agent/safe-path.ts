/**
 * Paso 0 de la Fase 7B — `resolveSafePath` y `UnsafePathError`, movidos
 * TAL CUAL desde `tools.ts` (la lógica no cambia) para que los módulos del
 * Repository Map (`repo-inventory.ts`, `repo-analysis.ts`) puedan usarlos
 * sin depender de `tools.ts`. En 7D `tools.ts` va a importar el Repository
 * Map; si éste siguiera importando `tools.ts` quedaría un ciclo
 * `tools.ts → repo-analysis.ts → tools.ts`.
 *
 * `tools.ts` los re-exporta con los mismos nombres y la MISMA clase (no una
 * copia), así que `instanceof UnsafePathError` sigue valiendo para quien lo
 * importe desde cualquiera de los dos módulos (`apply.ts`, tests, etc.).
 */
import fs from "node:fs/promises";
import path from "node:path";

export class UnsafePathError extends Error {}

/**
 * Resuelve `relativePath` dentro de `root` y valida que no se escape —
 * ni por `..`, ni por un symlink que apunte afuera. A diferencia de
 * `resolveSafePath` en `lib/fs-tools.ts` (que documenta esta validación
 * pero no la hace), acá el `fs.realpath` se ejecuta y se compara de
 * verdad contra la raíz real.
 */
export async function resolveSafePath(root: string, relativePath: string): Promise<string> {
  if (path.isAbsolute(relativePath)) throw new UnsafePathError(`Ruta absoluta no permitida: ${relativePath}`);
  const joined = path.resolve(root, relativePath);
  const realRoot = await fs.realpath(root);
  if (joined !== realRoot && !joined.startsWith(realRoot + path.sep)) {
    throw new UnsafePathError(`La ruta se sale del workspace: ${relativePath}`);
  }

  // Si el archivo/directorio ya existe, resolvemos symlinks de verdad y
  // confirmamos que el destino real sigue adentro de la raíz real.
  try {
    const real = await fs.realpath(joined);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
      throw new UnsafePathError(`Symlink apunta afuera del workspace: ${relativePath}`);
    }
    return real;
  } catch (error) {
    if (error instanceof UnsafePathError) throw error;
    // No existe todavía (caso típico de write_file con archivo nuevo) —
    // validamos el ancestro existente más cercano en su lugar.
    let dir = path.dirname(joined);
    while (true) {
      try {
        const realDir = await fs.realpath(dir);
        if (realDir !== realRoot && !realDir.startsWith(realRoot + path.sep)) {
          throw new UnsafePathError(`Symlink de directorio apunta afuera del workspace: ${relativePath}`);
        }
        break;
      } catch (dirError) {
        if (dirError instanceof UnsafePathError) throw dirError;
        const parent = path.dirname(dir);
        if (parent === dir) break; // llegamos a la raíz del filesystem sin encontrar nada — dejamos que falle más adelante
        dir = parent;
      }
    }
    return joined;
  }
}

/**
 * Etapa 2.6 (punto 1a del trabajo de seguridad) — rechazo de rutas `.git`.
 *
 * EL ATAQUE que cierra: el agente trabaja en un git worktree, donde `.git` es
 * un ARCHIVO-puntero ("gitdir: ..."). Si el agente puede escribir ese archivo,
 * puede apuntarlo a un directorio que él mismo crea y poner en su `config` una
 * directiva de ejecución (`[core] fsmonitor = <comando>`): la próxima vez que
 * LA APP corre `git` en ese workspace, git ejecuta el comando con los
 * privilegios del usuario de la app. Escalada de "el modelo cambia un archivo"
 * a "el modelo ejecuta código", sin necesidad de ninguna tool de shell.
 * También alcanza con `.git/hooks/*` cuando `.git` es un directorio (workspace
 * de copia, fixtures de test) y con `core.fsmonitor`, `.gitattributes`
 * (filtros) y `.gitmodules`.
 *
 *REGLA: se rechaza toda ruta con un segmento `.git` en CUALQUIER posición,
 * sin distinguir mayúsculas/minúsculas, aguantando los alias de Windows:
 *  - puntos o espacios finales: `.git.`, `.git ` (Windows los descarta al
 *    resolver, así que `.git.` y `.git` son el MISMO archivo ahí);
 *  - nombre corto 8.3: `GIT~1` (y en general `GIT~N`);
 *  - variantes Unicode/normalización: se compara la forma NFC y también una
 *    versión sin marcas de combinación, así que un `.gít` con tilde rara o un
 *    punto final no cuela.
 * Y también cuando el destino REAL (ya con symlinks resueltos) cae dentro de un
 * `.git`: alcanza con crear un symlink dentro del workspace que apunte a
 * `../.git/` y escribir a través de él.
 *
 * Se usa desde TODAS las herramientas que escriben (write_file, edit_file,
 * patch, delete_file y cualquiera que se agregue), y hay un test que enumera las
 * herramientas de escritura y falla si alguna no lo aplica.
 */
/** Nombre canónico del directorio interno de git. */
const GIT_DIR_NAME = ".git";

/** Patrón del nombre corto 8.3 de Windows para `.git` (`GIT~1`, `GIT~2`, ...). */
const NOMBRE_CORTO_8_3 = /^git~\d+$/i;

/**
 * Normaliza UN segmento de ruta para compararlo: minúsculas, NFC, sin marcas
 * de combinación (NFD + strip), y sin puntos ni espacios finales (que Windows
 * descarta). No toca el resto: es para comparar nombres, no para construir
 * rutas.
 */
export function normalizarSegmento(segmento: string): string {
  return segmento
    .normalize("NFC")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[.\s]+$/, "");
}

/** ¿El segmento (ya normalizado) es el directorio interno de git? */
export function esSegmentoGit(segmentoNormalizado: string): boolean {
  return segmentoNormalizado === GIT_DIR_NAME || NOMBRE_CORTO_8_3.test(segmentoNormalizado);
}

/** Los segmentos de una ruta relativa, ya normalizados. */
function segmentosDe(relPath: string): string[] {
  return relPath.split(/[\/]+/).filter((s) => s.length > 0).map(normalizarSegmento);
}

/**
 * ¿La ruta toca el directorio interno de git, por nombre o por destino real?
 *
 * @param relPath ruta relativa tal como la escribió el modelo (para el mensaje
 *   de error, que tiene que mostrar lo que el usuario pidió, no la versión
 *   normalizada).
 * @param absDestino ruta absoluta ya resuelta (con symlinks) del destino. Se
 *   verifica TAMBIÉN cuando existe o cuando se puede resolver el ancestro: es
 *   el caso del symlink dentro del workspace que apunta a `../.git/`.
 */
export async function esRutaGitInternals(relPath: string, absDestino?: string): Promise<string | null> {
  const segmentos = segmentosDe(relPath);
  if (segmentos.some(esSegmentoGit)) {
    return `La ruta toca el directorio interno de git (.git): ${relPath}`;
  }
  if (absDestino) {
    const real = absDestino.split(/[\/]+/).filter((s) => s.length > 0);
    if (real.some((s) => esSegmentoGit(normalizarSegmento(s)))) {
      return `El destino real cae dentro del directorio interno de git (.git): ${relPath}`;
    }
  }
  return null;
}

/**
 * Igual que `rulaGitInternals`, pero tirando `UnsafePathError` (para que el
 * mensaje salga por el mismo camino que los otros rechazos de ruta).
 */
export async function assertNotGitInternals(relPath: string, absDestino?: string): Promise<void> {
  const motivo = await esRutaGitInternals(relPath, absDestino);
  if (motivo) throw new UnsafePathError(motivo);
}
