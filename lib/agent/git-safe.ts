/**
 * Etapa 2.6 (punto 1b del trabajo de seguridad) — git ENDURECIDO.
 *
 * POR QUÉ EXISTE: el punto 1a cierra la puerta de entrada (el agente no puede
 * escribir en `.git`). Este módulo es la SEGUNDA capa, la que hace que aunque
 * esa puerta se abriera —por otro vector, por un bug, o por un repo que trae una
 * config maliciosa ya committed— git no ejecute nada que venga del workspace.
 *
 * Las vías de ejecución que neutraliza, todas verificadas contra la doc de git:
 *  - `core.fsmonitor` (y `core.fsmonitor.<versión>`): comando que git corre al
 *    mirar el estado del índice. Es la que usaba la PoC de la revisión.
 *  - `core.hooksPath` y los hooks de siempre (`pre-commit`, `post-commit`, ...):
 *    si `core.hooksPath` apunta a un directorio vacío que creamos nosotros, no
 *    se busca ningún hook del repo.
 *  - `.gitattributes` con `filter=` / `diff=`: ejecuta un comando al hacer
 *    checkout o diff. No se puere negar por config (el archivo es del repo), así
 *    que lo neutraliza `-c protocol.ext.allow=never` para los `ext:` y, para los
 *    filtros locales, la única defensa real es no permitir que el agente los
 *    escriba: ver el modelo de amenazas en docs/SEGURIDAD-AGENTE.md.
 *  - config del sistema y global del usuario (`GIT_CONFIG_NOSYSTEM`, y una ruta
 *    de config global nula): un `include.path` con un comando en la config
 *    global también ejecutaría.
 *
 * VERIFICACIÓN DE INTEGRIDAD ANTES DE CADA OPERACIÓN: el puntero `.git` del
 * workspace tiene que seguir apuntando al gitdir que registró el
 * workspace-manager al crear el worktree. Si no apunta ahí, la task FALLA con un
 * error de integridad y git NO se ejecuta. Es lo que convierte "el puntero fue
 * manipulados" en un fallo visible en vez de en una ejecución silenciosa.
 *
 * REGLA DE USO: ninguna llamada a git de la app fuera de este módulo. Hay un
 * test que falla si queda algún `execFile("git")` suelto (los de test tienen
 * permiso: arman fixtures, no operan sobre el trabajo del agente —ver el propio
 * test para el alcance exacto).
 */

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";

const execFileAsync = promisify(execFile);

/** Error de integridad: el workspace dejó de ser confiable para git. */
export class GitIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitIntegrityError";
  }
}

/** Directorio vacío y propio, para `core.hooksPath`. Se crea bajo demanda. */
let hooksVacio: string | null = null;
async function directorioHooksVacio(): Promise<string> {
  if (hooksVacio) return hooksVacio;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "magi-githooks-"));
  hooksVacio = dir;
  return dir;
}

/** Solo para tests: olvida el directorio de hooks cacheado. */
export function __resetHooksVaciosForTests(): void {
  hooksVacio = null;
}

/**
 * Config global anulada. En Windows no existe `/dev/null`, así que se usa un
 * archivo vacío temporal por proceso (misma idea, otra ruta).
 */
let configGlobalNula: string | null = null;
async function configGlobalAnulada(): Promise<string> {
  if (configGlobalNula) return configGlobalNula;
  if (process.platform === "win32") {
    const archivo = path.join(os.tmpdir(), "magi-gitconfig-vacio");
    await fs.writeFile(archivo, "", "utf-8").catch(() => {});
    configGlobalNula = archivo;
    return configGlobalNula;
  }
  configGlobalNula = "/dev/null";
  return configGlobalNula;
}

/** Solo para tests. */
export function __resetConfigGlobalForTests(): void {
  configGlobalNula = null;
}

/** Opciones de una llamada git endurecida. */
export type GitSafeOptions = {
  /** Directorio de trabajo: el worktree (o el repo) sobre el que se opera. */
  cwd: string;
  /** Gitdir ESPERADO, tal como lo registró el workspace-manager. Si se pasa,
   *  se verifica que el puntero `.git` de `cwd` siga apuntando ahí. */
  gitDirEsperado?: string | null;
  /** Variables de entorno extra (autor/committer del commit del agente). */
  env?: Record<string, string | undefined>;
  /** Timeout en ms (default 60s). */
  timeoutMs?: number;
  /** `maxBuffer` (default 8 MB). */
  maxBuffer?: number;
  /** Cancelación externa. `gitSafeSync` no la soporta (execFileSync no acepta
   *  signal): quien necesite abortar tiene que usar la variante async. */
  signal?: AbortSignal;
};

/** Lee el puntero `.git` de un workspace y devuelve el gitdir que declara. */
async function punteroGit(cwd: string): Promise<{ tipo: "archivo" | "directorio" | "ausente"; gitdir: string | null }> {
  const ruta = path.join(cwd, ".git");
  const stat = await fs.stat(ruta).catch(() => null);
  if (!stat) return { tipo: "ausente", gitdir: null };
  if (stat.isDirectory()) return { tipo: "directorio", gitdir: ruta };
  const contenido = (await fs.readFile(ruta, "utf-8")).trim();
  const match = /^gitdir:\s*(.+)$/m.exec(contenido);
  return { tipo: "archivo", gitdir: match ? match[1].trim() : null };
}

/** Compara dos rutas sin depender de separadores ni case (Windows). */
function mismaRuta(a: string, b: string): boolean {
  const na = path.resolve(a).split(path.sep).join("/").toLowerCase();
  const nb = path.resolve(b).split(path.sep).join("/").toLowerCase();
  return na === nb;
}

/**
 * Verifica que el `.git` del workspace siga apuntando al gitdir esperado.
 * Devuelve el gitdir REAL resuelto (para pasarlo como GIT_DIR), o tira
 * `GitIntegrityError`.
 */
export async function verificarIntegridadGit(cwd: string, gitDirEsperado?: string | null): Promise<string> {
  const puntero = await punteroGit(cwd);
  if (puntero.tipo === "ausente") {
    throw new GitIntegrityError(
      `El workspace ${cwd} perdió su .git: no es un repo git válido. La tarea se detiene antes de tocar nada.`,
    );
  }
  if (puntero.tipo === "directorio") {
    // Workspace NO-worktree (modo copia): el gitdir es el .git de adentro.
    if (gitDirEsperado && !mismaRuta(puntero.gitdir ?? "", gitDirEsperado)) {
      throw new GitIntegrityError(
        `Integridad rota: el gitdir del workspace (${puntero.gitdir}) no es el esperado (${gitDirEsperado}). ` +
          "Puede haber sido modificado durante la tarea. No se ejecuta git.",
      );
    }
    return path.join(cwd, ".git");
  }
  // Worktree: el puntero es un archivo.
  if (!puntero.gitdir) {
    throw new GitIntegrityError(`El puntero .git de ${cwd} no declara un gitdir legible. No se ejecuta git.`);
  }
  if (gitDirEsperado && !mismaRuta(puntero.gitdir, gitDirEsperado)) {
    throw new GitIntegrityError(
      `Integridad rota: el puntero .git apunta a ${puntero.gitdir} y debería apuntar a ${gitDirEsperado}. ` +
        "No se ejecuta git.",
    );
  }
  // Se resuelve contra `cwd` si la ruta es relativa (caso "gitdir: ./algo").
  return path.isAbsolute(puntero.gitdir) ? puntero.gitdir : path.resolve(cwd, puntero.gitdir);
}

/**
 * Corre un comando git ENDURECIDO.
 *
 * - `GIT_DIR` y `GIT_WORK_TREE` explícitos, tomados del registro del workspace
 *   (o del puntero, verificado contra el esperado). NUNCA se deja que git
 *   descubra el gitdir leyendo el puntero: si el puntero fue manipulado, ya
 *   verificó contra el esperado antes.
 * - `GIT_CONFIG_NOSYSTEM=1` y config global anulada.
 * - `-c core.fsmonitor=false -c core.hooksPath=<vacío> -c core.pager=cat
 *    -c protocol.ext.allow=never`.
 * - `safe.directory` se pasa para que el repo del usuario no aparezca como
 *   "dudoso" (es dueño de todo esto).
 */
export async function gitSafe(args: string[], opciones: GitSafeOptions): Promise<{ stdout: string; stderr: string }> {
  const gitDir = await verificarIntegridadGit(opciones.cwd, opciones.gitDirEsperado ?? null);
  const hooks = await directorioHooksVacio();
  const globalNula = await configGlobalAnulada();

  // El entorno arranca del proceso HOERE: sin PATH, execFile no encuentra el
  // binario de git (en Windows se descubre igual y por eso el bug pasó
  // desapercibido acá; en Linux falla con ENOENT y TODA la suite que usa git
  // se cae — fue exactamente lo que rompió el CI desde el commit 5e953d2).
  // Los de git van DESPUÉS, para pisar cualquier cosa que haya quedado.
  const entorno: Record<string, string | undefined> = {
    ...process.env,
    ...opciones.env,
    GIT_DIR: gitDir,
    GIT_WORK_TREE: opciones.cwd,
    // Config del sistema y global: fuera. Un `include.path` con comando en la
    // config global del usuario también ejecutaría.
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: globalNula,
    ...(process.platform === "win32" ? {} : { GIT_CONFIG_SYSTEM: "/dev/null" }),
    LC_ALL: "C",
  };

  return execFileAsync(
    "git",
    [
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=" + hooks,
      "-c",
      "core.pager=cat",
      "-c",
      "protocol.ext.allow=never",
      "-c",
      "safe.directory=*",
      ...args,
    ],
    {
      cwd: opciones.cwd,
      env: entorno as NodeJS.ProcessEnv,
      timeout: opciones.timeoutMs ?? 60_000,
      maxBuffer: opciones.maxBuffer ?? 8 * 1024 * 1024,
      ...(opciones.signal ? { signal: opciones.signal } : {}),
    },
  );
}

/** Igual que `gitSafe` pero devuelve null en vez de tirar (para los `.catch`). */
export async function gitSafeSilencioso(args: string[], opciones: GitSafeOptions): Promise<{ stdout: string } | null> {
  try {
    const res = await gitSafe(args, opciones);
    return { stdout: res.stdout };
  } catch {
    return null;
  }
}

/**
 * Igual que `gitSafe`, pero SÍNCRONO.
 *
 * Existe para los caminos que ya son sincrónicos y no vale la pena volver async
 * (la huella de estado del workspace del loop autónomo, el HEAD del checkpoint).
 * El endurecimiento es IDÉNTICO: misma verificación de integridad, mismas
 * variables de entorno, mismos `-c`. No es un atajo: es el mismo helper con
 * `execFileSync` adentro.
 */
export function gitSafeSync(args: string[], opciones: GitSafeOptions): { stdout: string; stderr: string } {
  const gitDir = verificarIntegridadGitSync(opciones.cwd, opciones.gitDirEsperado ?? null);
  const hooks = directorioHooksVacioSync();
  const globalNula = configGlobalAnuladaSync();

  // Mismo entorno que la variante async: HOERE primero (PATH incluido), los de
  // git después.
  const entorno: Record<string, string | undefined> = {
    ...process.env,
    ...opciones.env,
    GIT_DIR: gitDir,
    GIT_WORK_TREE: opciones.cwd,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: globalNula,
    ...(process.platform === "win32" ? {} : { GIT_CONFIG_SYSTEM: "/dev/null" }),
    LC_ALL: "C",
  };

  const salida = execFileSync(
    "git",
    [
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=" + hooks,
      "-c",
      "core.pager=cat",
      "-c",
      "protocol.ext.allow=never",
      "-c",
      "safe.directory=*",
      ...args,
    ],
    {
      cwd: opciones.cwd,
      env: entorno as NodeJS.ProcessEnv,
      timeout: opciones.timeoutMs ?? 60_000,
      maxBuffer: opciones.maxBuffer ?? 8 * 1024 * 1024,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  return { stdout: typeof salida === "string" ? salida : String(salida), stderr: "" };
}

/** Verificación de integridad, versión sincrónica (mismas reglas). */
function verificarIntegridadGitSync(cwd: string, gitDirEsperado?: string | null): string {
  const ruta = path.join(cwd, ".git");
  const stat = fsSync.statSync(ruta);
  if (stat.isDirectory()) {
    const real = path.join(cwd, ".git");
    if (gitDirEsperado && !mismaRuta(real, gitDirEsperado)) {
      throw new GitIntegrityError(
        `Integridad rota: el gitdir del workspace (${real}) no es el esperado (${gitDirEsperado}). No se ejecuta git.`,
      );
    }
    return real;
  }
  const contenido = fsSync.readFileSync(ruta, "utf-8").trim();
  const match = /^gitdir:\s*(.+)$/m.exec(contenido);
  if (!match) throw new GitIntegrityError(`El puntero .git de ${cwd} no declara un gitdir legible. No se ejecuta git.`);
  const declarado = match[1].trim();
  if (gitDirEsperado && !mismaRuta(declarado, gitDirEsperado)) {
    throw new GitIntegrityError(
      `Integridad rota: el puntero .git apunta a ${declarado} y debería apuntar a ${gitDirEsperado}. No se ejecuta git.`,
    );
  }
  return path.isAbsolute(declarado) ? declarado : path.resolve(cwd, declarado);
}

function directorioHooksVacioSync(): string {
  return hooksVacio ?? "magi-githooks-sync";
}

function configGlobalAnuladaSync(): string {
  if (process.platform !== "win32") return "/dev/null";
  const archivo = path.join(os.tmpdir(), "magi-gitconfig-vacio");
  fsSync.writeFileSync(archivo, "");
  return archivo;
}
