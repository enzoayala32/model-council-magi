/**
 * Prueba de aceptación de la Fase 7C (configuración de resolución):
 * `loadResolutionConfig` / `parseResolutionConfig` — tsconfig/jsconfig de la
 * raíz, JSONC, `extends` relativo (cadenas, ciclos, profundidad, paquetes,
 * escapes), symlinks / directorios / archivos enormes, `paths` fuera de la
 * raíz y opciones forzadas.
 *
 * Repos git temporales reales (el inventario de 7A decide qué config
 * existe). Sin modelo ni red.
 *
 * Uso: npm run agent:test-resolution-config
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ts from "typescript";
import { buildRepoInventory } from "./repo-inventory";
import { loadResolutionConfig, MAX_CONFIG_BYTES, parseResolutionConfig, ResolutionConfigError, type ResolutionConfig } from "./resolution-config";

const execFileAsync = promisify(execFile);

const REAL_TSCONFIG = `{
  // tsconfig real del proyecto
  "compilerOptions": {
    "target": "ES2017", "lib": ["dom", "dom.iterable", "esnext"], "allowJs": true, "skipLibCheck": true,
    "strict": true, "noEmit": true, "esModuleInterop": true, "module": "esnext", "moduleResolution": "bundler",
    "baseUrl": ".",
    "paths": { "@/*": ["./*"] },
    "resolveJsonModule": true, "isolatedModules": true, "jsx": "react-jsx", "incremental": true,
    "plugins": [{ "name": "next" }]
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}`;

async function writeFiles(dir: string, files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), content);
  }
}

/** Crea `<tmp>/<name>/repo` (git) — el padre sirve para colocar archivos "afuera" del workspace. */
async function makeRepo(name: string, files: Record<string, string>): Promise<{ parent: string; dir: string }> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), `consenso-ia-test7c-cfg-${name}-`));
  const dir = path.join(parent, "repo");
  await fs.mkdir(dir);
  await writeFiles(dir, { "index.ts": "export {};\n", ...files });
  await execFileAsync("git", ["init"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
  await execFileAsync("git", ["add", "-A"], { cwd: dir });
  await execFileAsync("git", ["commit", "-m", "inicial"], { cwd: dir });
  return { parent, dir };
}

async function load(dir: string, options?: Parameters<typeof loadResolutionConfig>[2]): Promise<ResolutionConfig> {
  const inventory = await buildRepoInventory(dir);
  return loadResolutionConfig(dir, inventory, options);
}

const summary = (c: ResolutionConfig) => ({ file: c.file, baseUrl: c.baseUrl, aliases: c.aliases, warnings: c.warnings });
const patterns = (c: ResolutionConfig) => c.aliases.map((a) => a.pattern);
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const results: boolean[] = [];
function check(ok: boolean, message: string, failDetail: () => string) {
  console.log(ok ? `✅ ${message}` : `❌ ${message}\n   Falló. ${failDetail()}`);
  results.push(ok);
}
const dump = (c: ResolutionConfig) => JSON.stringify(summary(c));
const tsconfig = (compilerOptions: object, extra: object = {}) => JSON.stringify({ compilerOptions, ...extra });

async function main() {
  console.log("== Fase 7C — prueba de aceptación (configuración de resolución) ==\n");

  // --- Selección del archivo ---
  console.log("--- tsconfig / jsconfig / ninguno ---");
  {
    const { dir } = await makeRepo("real", { "tsconfig.json": REAL_TSCONFIG });
    const c = await load(dir);
    check(eq(summary(c), { file: "tsconfig.json", baseUrl: ".", aliases: [{ pattern: "@/*", targets: ["./*"] }], warnings: [] }), "tsconfig REAL del proyecto: archivo, baseUrl '.', alias @/* → ./* y sin warnings (los include/exclude no molestan)", () => dump(c));
    const o = c.compilerOptions as ts.CompilerOptions & { pathsBasePath?: string };
    check(o.moduleResolution === ts.ModuleResolutionKind.Bundler && o.module === ts.ModuleKind.ESNext && o.allowJs === true && o.resolveJsonModule === true && o.allowArbitraryExtensions === true && o.baseUrl === "/ws" && !JSON.stringify(o).includes(dir), "las opciones usan la raíz VIRTUAL (/ws): ninguna ruta real del sistema", () => JSON.stringify(o));
  }
  {
    const { dir } = await makeRepo("jsconfig", { "jsconfig.json": tsconfig({ paths: { "~/*": ["./src/*"] } }) });
    const c = await load(dir);
    check(c.file === "jsconfig.json" && eq(patterns(c), ["~/*"]) && c.warnings.length === 0, "jsconfig.json como respaldo cuando no hay tsconfig.json", () => dump(c));
  }
  {
    const { dir } = await makeRepo("ambos", { "tsconfig.json": tsconfig({ paths: { "@t/*": ["./*"] } }), "jsconfig.json": tsconfig({ paths: { "@j/*": ["./*"] } }) });
    const c = await load(dir);
    check(c.file === "tsconfig.json" && eq(patterns(c), ["@t/*"]), "si existen los dos, gana tsconfig.json", () => dump(c));
  }
  {
    const { dir } = await makeRepo("ninguno", {});
    const c = await load(dir);
    const o = c.compilerOptions;
    check(c.file === null && c.aliases.length === 0 && c.baseUrl === undefined && c.warnings.length === 0 && o.moduleResolution === ts.ModuleResolutionKind.Bundler && o.allowArbitraryExtensions === true, "sin ninguna config: file:null, opciones por defecto, sin warnings", () => dump(c));
  }
  {
    const { dir } = await makeRepo("gitignored", { ".gitignore": "tsconfig.json\n", "tsconfig.json": REAL_TSCONFIG });
    const c = await load(dir);
    check(c.file === null && c.warnings.length === 0, "un tsconfig.json que existe en disco pero 7A NO lista (ignorado por git) no existe para el grafo", () => dump(c));
  }

  // --- Formato ---
  console.log("\n--- JSONC y JSON inválido ---");
  {
    const { dir } = await makeRepo("jsonc", { "tsconfig.json": '{\n // comentario\n "compilerOptions": { /* x */ "baseUrl": "src", "paths": { "@/*": ["./*"], }, },\n}\n' });
    const c = await load(dir);
    check(c.file === "tsconfig.json" && c.baseUrl === "src" && eq(patterns(c), ["@/*"]) && c.warnings.length === 0, "JSONC (comentarios y comas finales) se acepta; baseUrl queda relativo a la raíz ('src')", () => dump(c));
  }
  {
    const { dir } = await makeRepo("invalido", { "tsconfig.json": "{ esto no es json" });
    const c = await load(dir);
    check(c.file === null && c.warnings.length === 1 && c.warnings[0].startsWith("tsconfig.json: no es JSON válido"), "tsconfig inválido (sin jsconfig) → file:null con un warning claro", () => dump(c));
    const { dir: dir2 } = await makeRepo("invalido-js", { "tsconfig.json": "[1, 2]", "jsconfig.json": tsconfig({ paths: { "@j/*": ["./*"] } }) });
    const c2 = await load(dir2);
    check(c2.file === "jsconfig.json" && eq(patterns(c2), ["@j/*"]) && c2.warnings.some((w) => w.startsWith("tsconfig.json: no es JSON válido")), "tsconfig inválido + jsconfig válido → se usa jsconfig y queda el warning del tsconfig", () => dump(c2));
  }
  {
    const pure = parseResolutionConfig("tsconfig.json", new Map());
    const arr = parseResolutionConfig("tsconfig.json", new Map([["tsconfig.json", "42"]]));
    check(pure.config === null && pure.warnings.length === 1 && arr.config === null && arr.warnings[0].includes("no es JSON válido"), "parseResolutionConfig (pura): sin texto o con JSON que no es un objeto → null + warning", () => JSON.stringify([pure, arr]));
  }
  {
    const { dir } = await makeRepo("opcion-mala", { "tsconfig.json": tsconfig({ moduleResolution: "bogus", paths: { "@/*": ["./*"] } }) });
    const c = await load(dir);
    check(c.file === "tsconfig.json" && eq(patterns(c), ["@/*"]) && c.warnings.length >= 1 && c.warnings.every((w) => !w.includes("/ws/")), "una opción inválida produce un warning (mensaje de TS sin la raíz virtual) pero la config se usa igual", () => dump(c));
  }

  // --- extends ---
  console.log("\n--- extends ---");
  {
    const { dir } = await makeRepo("ext1", {
      "tsconfig.json": JSON.stringify({ extends: "./base.json", compilerOptions: { strict: true } }),
      "base.json": tsconfig({ baseUrl: ".", paths: { "@/*": ["./src/*"] } }),
    });
    const c = await load(dir);
    check(c.file === "tsconfig.json" && c.baseUrl === "." && eq(c.aliases, [{ pattern: "@/*", targets: ["./src/*"] }]) && c.warnings.length === 0, "extends relativo: hereda baseUrl y paths del archivo base", () => dump(c));
  }
  {
    const { dir } = await makeRepo("ext-cadena", {
      "tsconfig.json": JSON.stringify({ extends: "./cfg/a.json" }),
      "cfg/a.json": JSON.stringify({ extends: "./b.json" }),
      "cfg/b.json": tsconfig({ paths: { "~/*": ["./x/*"] } }),
    });
    const c = await load(dir);
    check(eq(patterns(c), ["~/*"]) && c.warnings.length === 0, "extends encadenado (tsconfig → cfg/a → cfg/b, rutas relativas a cada archivo)", () => dump(c));
  }
  {
    const { dir } = await makeRepo("ext-sin-json", { "tsconfig.json": JSON.stringify({ extends: "./base" }), "base.json": tsconfig({ paths: { "@b/*": ["./*"] } }) });
    const c = await load(dir);
    check(eq(patterns(c), ["@b/*"]) && c.warnings.length === 0, "extends sin la extensión (./base → base.json), como hace TS", () => dump(c));
    const { dir: dir2 } = await makeRepo("ext-array", { "tsconfig.json": JSON.stringify({ extends: ["./one.json", "./two.json"] }), "one.json": tsconfig({ strict: true }), "two.json": tsconfig({ paths: { "@two/*": ["./*"] } }) });
    const c2 = await load(dir2);
    check(eq(patterns(c2), ["@two/*"]) && c2.warnings.length === 0, "extends como arreglo (TS 5)", () => dump(c2));
  }
  {
    const { dir } = await makeRepo("ext-ciclo", {
      "tsconfig.json": JSON.stringify({ extends: "./a.json", compilerOptions: { paths: { "@root/*": ["./*"] } } }),
      "a.json": JSON.stringify({ extends: "./b.json" }),
      "b.json": JSON.stringify({ extends: "./a.json" }),
    });
    const started = Date.now();
    const c = await load(dir);
    const cycleWarnings = c.warnings.filter((w) => w.includes("ciclo de extends"));
    check(Date.now() - started < 5000 && c.file === "tsconfig.json" && eq(patterns(c), ["@root/*"]) && cycleWarnings.length === 1 && c.warnings.every((w) => !w.includes("Circularity")), "ciclo de extends (a → b → a): sin loop, UN warning propio, y la config raíz se usa igual", () => dump(c));
  }
  {
    const files: Record<string, string> = { "tsconfig.json": JSON.stringify({ extends: "./c1.json" }) };
    for (let i = 1; i <= 7; i++) files[`c${i}.json`] = i === 7 ? tsconfig({ paths: { "@d7/*": ["./*"] } }) : JSON.stringify({ extends: `./c${i + 1}.json`, ...(i === 5 ? { compilerOptions: { paths: { "@d5/*": ["./*"] } } } : {}) });
    const { dir } = await makeRepo("ext-prof", files);
    const c = await load(dir);
    check(eq(patterns(c), ["@d5/*"]) && c.warnings.filter((w) => w.includes("profundidad máxima (5)")).length === 1, "profundidad máxima: se cargan 5 niveles de extends (c1..c5) y el 6.º se ignora con un warning (c7 nunca se aplica)", () => dump(c));
  }
  {
    const { dir } = await makeRepo("ext-paquete", { "tsconfig.json": JSON.stringify({ extends: "@tsconfig/next/tsconfig.json", compilerOptions: { paths: { "@/*": ["./*"] } } }) });
    const c = await load(dir);
    check(c.file === "tsconfig.json" && eq(patterns(c), ["@/*"]) && c.warnings.length === 1 && c.warnings[0].includes("paquete"), "extends a un PAQUETE: un warning y se sigue con la config propia", () => dump(c));
  }
  {
    const { parent, dir } = await makeRepo("ext-afuera", { "tsconfig.json": JSON.stringify({ extends: "../outside.json", compilerOptions: { paths: { "@own/*": ["./*"] } } }) });
    await fs.writeFile(path.join(parent, "outside.json"), tsconfig({ paths: { "@out/*": ["./*"] } }));
    const c = await load(dir);
    check(eq(patterns(c), ["@own/*"]) && c.warnings.some((w) => w.includes("sale del workspace")), "extends que sale del workspace (../outside.json): warning y el archivo de afuera NO se lee (su alias no aparece)", () => dump(c));
  }
  {
    const { dir } = await makeRepo("ext-falta", { "tsconfig.json": JSON.stringify({ extends: "./nope.json", compilerOptions: { paths: { "@own/*": ["./*"] } } }) });
    const c = await load(dir);
    check(eq(patterns(c), ["@own/*"]) && c.warnings.length === 1 && c.warnings[0].includes("no existe"), "extends a un archivo inexistente: un solo warning ('no existe') y se sigue", () => dump(c));
  }

  {
    const { dir } = await makeRepo("ext-roto", { "tsconfig.json": JSON.stringify({ extends: "./roto.json", compilerOptions: { paths: { "@own/*": ["./*"] } } }), "roto.json": "{ esto no es json" });
    const c = await load(dir);
    check(c.file === "tsconfig.json" && eq(patterns(c), ["@own/*"]) && c.warnings.length >= 1 && c.warnings.every((w) => !w.includes("/ws/")), "extends con JSON inválido: warning (de TS, sin la raíz virtual) y la config propia se usa igual", () => dump(c));
  }

  // --- Seguridad de la lectura ---
  console.log("\n--- Seguridad de la lectura (symlink / directorio / tamaño) ---");
  {
    const { parent, dir } = await makeRepo("symlink", { "tsconfig.json": REAL_TSCONFIG });
    await fs.writeFile(path.join(parent, "afuera.json"), tsconfig({ paths: { "@secreto/*": ["./*"] } }));
    const inventory = await buildRepoInventory(dir);
    let created = true;
    try {
      await fs.symlink(path.join(parent, "afuera.json"), path.join(dir, "tsconfig.lnk")); // se crea primero con nombre temporal: sin privilegios no se toca nada
      await fs.rm(path.join(dir, "tsconfig.json"));
      await fs.rename(path.join(dir, "tsconfig.lnk"), path.join(dir, "tsconfig.json")); // symlink EXTERNO, después del inventario
    } catch (error) {
      created = false;
      console.log(`⚠️  No se pudieron crear symlinks en este entorno (${(error as NodeJS.ErrnoException).code}) — se omite este sub-caso.`);
    }
    if (created) {
      const c = await loadResolutionConfig(dir, inventory);
      check(c.file === null && c.aliases.length === 0 && c.warnings.length === 1 && c.warnings[0].startsWith("tsconfig.json: ruta no permitida") && !JSON.stringify(c).includes("secreto"), "tsconfig reemplazado por un symlink EXTERNO después del inventario → no se lee su destino (warning, sin alias)", () => dump(c));
    }
    const { dir: dir2 } = await makeRepo("symlink-int", { "real.json": tsconfig({ paths: { "@real/*": ["./*"] } }) });
    let created2 = true;
    try {
      await fs.symlink(path.join(dir2, "real.json"), path.join(dir2, "tsconfig.json"));
      await execFileAsync("git", ["add", "-A"], { cwd: dir2 });
      await execFileAsync("git", ["commit", "-m", "symlink"], { cwd: dir2 });
    } catch {
      created2 = false;
    }
    if (created2) {
      const c = await load(dir2);
      check(c.file === null && c.warnings.length === 1 && c.warnings[0].includes("tsconfig.json: no analizable (symlink)") && c.aliases.length === 0, "tsconfig.json versionado como symlink (7A lo marca skipped) → se ignora con un warning, aunque apunte adentro", () => dump(c));
    }
  }
  {
    const { dir } = await makeRepo("directorio", { "tsconfig.json": REAL_TSCONFIG, "jsconfig.json": tsconfig({ paths: { "@j/*": ["./*"] } }) });
    const inventory = await buildRepoInventory(dir);
    await fs.rm(path.join(dir, "tsconfig.json"));
    await fs.mkdir(path.join(dir, "tsconfig.json"));
    const c = await loadResolutionConfig(dir, inventory);
    check(c.file === "jsconfig.json" && eq(patterns(c), ["@j/*"]) && c.warnings.some((w) => w.includes("tsconfig.json: no es un archivo regular")), "tsconfig reemplazado por un DIRECTORIO → warning y se cae a jsconfig.json", () => dump(c));
  }
  {
    const { dir } = await makeRepo("enorme", { "tsconfig.json": `{ /* ${"x".repeat(MAX_CONFIG_BYTES + 1000)} */ "compilerOptions": { "paths": { "@/*": ["./*"] } } }` });
    const c = await load(dir);
    check(c.file === null && c.aliases.length === 0 && c.warnings.length === 1 && c.warnings[0].includes("demasiado grande"), `config de más de ${MAX_CONFIG_BYTES} bytes → se ignora con un warning (nunca se parsea)`, () => dump(c));
  }
  {
    const { dir } = await makeRepo("borrado", { "tsconfig.json": REAL_TSCONFIG });
    const inventory = await buildRepoInventory(dir);
    await fs.rm(path.join(dir, "tsconfig.json"));
    const c = await loadResolutionConfig(dir, inventory);
    check(c.file === null && c.warnings.length === 1 && c.warnings[0].includes("ya no existe en el disco"), "tsconfig borrado después del inventario → warning y opciones por defecto", () => dump(c));
  }

  // --- paths fuera de la raíz, opciones forzadas, warnings, abort, determinismo ---
  console.log("\n--- paths fuera de la raíz, opciones forzadas, abort ---");
  {
    const { dir } = await makeRepo("fuera", { "tsconfig.json": tsconfig({ baseUrl: ".", paths: { "@out/*": ["../afuera/*"], "@ok/*": ["./ok/*"] } }) });
    const c = await load(dir);
    check(eq(patterns(c), ["@out/*", "@ok/*"]) && c.warnings.length === 1 && c.warnings[0].includes('"@out/*"') && c.warnings[0].includes("fuera del workspace"), "paths que apuntan fuera de la raíz: el alias figura pero con un warning (no se sigue); el que está adentro no avisa", () => dump(c));
  }
  {
    const { dir } = await makeRepo("forzadas", {
      "tsconfig.json": tsconfig({ module: "commonjs", moduleResolution: "node16", target: "ES5", jsx: "react-jsx", strict: true, moduleSuffixes: [".ios", ""], customConditions: ["x"], typeRoots: ["./types"], allowJs: false, resolveJsonModule: false, baseUrl: ".", paths: { "@/*": ["./*"] }, rootDirs: ["src", "gen"] }),
    });
    const c = await load(dir);
    const o = c.compilerOptions as ts.CompilerOptions & { pathsBasePath?: string };
    const allowed = new Set(["moduleResolution", "module", "allowJs", "resolveJsonModule", "allowArbitraryExtensions", "baseUrl", "paths", "pathsBasePath", "rootDirs"]);
    const extra = Object.keys(o).filter((key) => !allowed.has(key));
    check(o.moduleResolution === ts.ModuleResolutionKind.Bundler && o.module === ts.ModuleKind.ESNext && o.allowJs === true && o.resolveJsonModule === true && o.allowArbitraryExtensions === true && extra.length === 0 && Array.isArray(o.rootDirs) && o.rootDirs.length === 2, `opciones forzadas aunque el tsconfig diga otra cosa; solo se conservan baseUrl/paths/rootDirs${extra.length ? ` (sobran: ${extra.join(",")})` : ""}`, () => JSON.stringify(o));
  }
  {
    const { dir } = await makeRepo("warnings", {
      "tsconfig.json": JSON.stringify({ extends: ["../fuera.json", "@pkg/base", "./nope.json", "./a.json"], compilerOptions: { paths: { "@out/*": ["../x/*"] } } }),
      "a.json": JSON.stringify({ extends: "./a.json" }),
    });
    const c = await load(dir);
    const all = c.warnings.join("\n");
    check(c.warnings.length >= 4 && !all.includes(dir) && !all.includes(os.tmpdir()) && !all.includes("/ws/") && c.warnings.every((w) => w.length <= 400), "los warnings jamás incluyen rutas absolutas (ni reales ni la raíz virtual)", () => all);
  }
  {
    const { dir } = await makeRepo("abort", { "tsconfig.json": REAL_TSCONFIG });
    const controller = new AbortController();
    controller.abort();
    const err = await load(dir, { signal: controller.signal }).then(() => null, (e) => e);
    check(err instanceof ResolutionConfigError, "signal abortado → ResolutionConfigError", () => String(err));
  }
  {
    const { dir } = await makeRepo("determinismo", { "tsconfig.json": JSON.stringify({ extends: "./base.json", compilerOptions: { paths: { "@/*": ["./*"], "~/*": ["./src/*"] } } }), "base.json": tsconfig({ baseUrl: "." }) });
    const a = await load(dir);
    const b = await load(dir);
    check(JSON.stringify(summary(a)) === JSON.stringify(summary(b)) && eq(patterns(a), ["@/*", "~/*"]), "determinismo: dos cargas → mismo resumen (el orden de los aliases es el del archivo)", () => `${dump(a)}\n   ${dump(b)}`);
  }
  {
    // El tsconfig.json REAL de este proyecto (si el test corre desde la raíz del proyecto).
    let real: string | null = null;
    try {
      real = await fs.readFile(path.join(process.cwd(), "tsconfig.json"), "utf-8");
    } catch {
      console.log("⚠️  No se encontró tsconfig.json en el directorio actual — se omite el caso del tsconfig real del proyecto.");
    }
    if (real !== null) {
      const { dir } = await makeRepo("proyecto", { "tsconfig.json": real });
      const c = await load(dir);
      check(c.file === "tsconfig.json" && c.aliases.some((a) => a.pattern === "@/*") && c.warnings.length === 0, "el tsconfig.json REAL de este proyecto carga sin warnings y expone el alias @/*", () => dump(c));
    }
  }

  console.log(`\n${results.filter(Boolean).length}/${results.length} casos OK.`);
  if (results.some((r) => !r)) process.exit(1);
}

main().catch((error) => {
  console.error("Error inesperado en la prueba:", error);
  process.exit(1);
});
