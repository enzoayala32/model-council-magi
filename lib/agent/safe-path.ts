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
