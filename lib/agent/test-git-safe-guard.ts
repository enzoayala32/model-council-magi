/**
 * Etapa 2.6 (punto 1b del trabajo de seguridad) — guardián de git endurecido.
 *
 * LA REGLA: ninguna llamada a git de la app fuera de `lib/agent/git-safe.ts`.
 * Este test la verifica leyendo el código, no confiando en la memoria de nadie:
 * si alguien agrega un `execFile("git")` suelto, esto falla.
 *
 * ALCANCE, y por qué tiene exclusiones: los ficheros de TEST (`test-*`) quedan
 * afuera a propósito. Arman fixtures —un repo de mentira en un temporal, un
 * worktree para la PoC— y no operan sobre el trabajo del agente; incluirlos
 * obligaría a mockear el helper en cada test nuevo sin ganar nada de seguridad.
 * Lo que importa es el código de producción. Los scripts de humo (`smoke-*`)
 * también arrancan servers y fixtures, y quedan afuera por la misma razón.
 *
 * Uso: npm run agent:test-git-safe-guard
 */
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { gitSafe } from "./git-safe";

const execFileAsync = promisify(execFile);
import path from "node:path";

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passed += 1;
    console.log("+ " + label);
    return;
  }
  failed += 1;
  console.log("x " + label + (detail === undefined ? "" : " - " + JSON.stringify(detail).slice(0, 500)));
}

/** Archivos excluidos del barrido (fixtures, no operación del agente). */
function esExcluido(relPath: string): boolean {
  return (
    relPath.includes("test-") ||
    relPath.includes("git-safe.ts") ||
    relPath.startsWith("scripts" + path.sep + "smoke-") ||
    relPath.startsWith("scripts" + path.sep + "probe-")
  );
}

/** Todos los .ts de producción, sin node_modules ni .next. */
function archivosDeProduccion(raiz: string): string[] {
  const salida: string[] = [];
  const walk = (dir: string) => {
    for (const entrada of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entrada.name === "node_modules" || entrada.name === ".next" || entrada.name === ".git") continue;
      const abs = path.join(dir, entrada.name);
      if (entrada.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entrada.name.endsWith(".ts") && !entrada.name.endsWith(".tsx")) continue;
      salida.push(abs);
    }
  };
  walk(raiz);
  return salida;
}

/** Llamadas a git "sueltas": execFile/execFileSync/spawn con "git". */
const LLAMADA_GIT = /(execFile(?:Async|Sync)?\s*\(\s*["']git["']|spawn(?:Sync)?\s*\(\s*["']git["'])/;

async function main(): Promise<void> {
  const raiz = path.resolve(import.meta.dirname, "..", "..");
  const archivos = archivosDeProduccion(raiz).filter((abs) => {
    const rel = path.relative(raiz, abs);
    return rel.startsWith("lib") || rel.startsWith("app");
  });

  const sueltos: Array<{ archivo: string; linea: number; texto: string }> = [];
  const queUsanElHelper: string[] = [];

  for (const abs of archivos) {
    const rel = path.relative(raiz, abs).split(path.sep).join("/");
    if (esExcluido(rel)) continue;
    const lineas = fs.readFileSync(abs, "utf-8").split("\n");
    lineas.forEach((texto, indice) => {
      // Los comentarios que mencionan la regla no cuentan como violación.
      if (/^\s*(\/\/|\*)/.test(texto)) return;
      if (LLAMADA_GIT.test(texto)) {
        sueltos.push({ archivo: rel, linea: indice + 1, texto: texto.trim().slice(0, 90) });
      }
      if (texto.includes("gitSafe(") || texto.includes("gitSafeSync(")) {
        if (!queUsanElHelper.includes(rel)) queUsanElHelper.push(rel);
      }
    });
  }

  check("se barrió el código de producción", archivos.length > 20, archivos.length);
  check("NO queda ninguna llamada git suelta fuera de git-safe", sueltos.length === 0, sueltos);
  check("y varios módulos de producción SÍ usan el helper", queUsanElHelper.length >= 3, queUsanElHelper);

  // Y el helper existe con lo que tiene que tener adentro.
  const fuente = fs.readFileSync(path.join(raiz, "lib", "agent", "git-safe.ts"), "utf-8");
  for (const marca of [
    "GIT_CONFIG_NOSYSTEM",
    "core.fsmonitor=false",
    "core.hooksPath=",
    "protocol.ext.allow=never",
    "GitIntegrityError",
    "verificarIntegridadGit",
  ]) {
    check(`git-safe.ts endurece: ${marca}`, fuente.includes(marca), marca);
  }

  // Y el entorno que arma tiene que PARTIR del del proceso (PATH incluido), no
  // de las variables de git solamente: sin PATH, `execFile("git")` no encuentra
  // el binario. Ese bug rompió el CI desde el commit 5e953d2 —en Linux falla
  // con ENOENT y en Windows no, así que la suite local pasaba sin problemas—.
  // Este check es el que lo impide volver.
  const entornos = fuente.match(/const entorno: Record<string, string \| undefined> = \{[\s\S]*?\};/g) ?? [];
  check("hay dos variantes de entorno (async y sync)", entornos.length === 2, entornos.length);
  for (const [indice, entorno] of entornos.entries()) {
    const empiezaPorProceso = /\{\s*\.\.\.process\.env/.test(entorno);
    check(`entorno #${indice + 1} parte de process.env (PATH heredado)`, empiezaPorProceso, (entorno.split(String.fromCharCode(10))[1] ?? "").trim());
  }


  // Y la prueba FUNCIONAL, que es la que hubiera cazado el bug: con un `env`
  // minimo (sin PATH), gitSafe tiene que encontrar el binario igual. En Windows
  // `execFile` lo busca en el PATH del sistema aunque no se lo pases, así que
  // este test pasa en los dos sistemas — pero en Linux es la diferencia entre
  // "funciona" y "ENOENT en toda la suite".
  {
    const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "magi-gitsafe-fn-"));
    await execFileAsync("git", ["init"], { cwd: dir });
    const { stdout } = await gitSafe(["rev-parse", "--is-inside-work-tree"], {
      cwd: dir,
      // A propósito SIN process.env: solo lo mínimo de un commit.
      env: { GIT_AUTHOR_NAME: "test" },
    });
    check("gitSafe encuentra el binario aunque el env no traiga PATH", stdout.trim() === "true", stdout.trim());
    await fsPromises.rm(dir, { recursive: true, force: true });
  }

  console.log("");
  console.log(passed + "/" + (passed + failed) + " casos OK");
  if (failed > 0) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
