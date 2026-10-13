/**
 * Prueba de aceptación de la Fase 7A (Repository Map — Inventario):
 * `buildRepoInventory` — archivos desde Git (`git ls-files`), lenguaje por
 * extensión, tamaño, skipped (too_large / binary / symlink / unsafe_path),
 * lectura de `package.json`, detección de Next.js y robustez ante errores
 * por archivo.
 *
 * Sin modelo real ni red — repos git temporales reales, mismo patrón que
 * el resto de las fases. Nada de 7B/7C/7D (símbolos, imports, grafo, tool).
 *
 * Uso: npm run agent:test-repo-inventory
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildRepoInventory, detectLanguage, isSyntacticallySafe, RepoInventoryError, type InventoryFile, type RepoInventory } from "./repo-inventory";

const execFileAsync = promisify(execFile);

type Files = Record<string, string | Buffer>;

async function makeGitRepo(name: string, files: Files): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `consenso-ia-test7a-${name}-`));
  await writeFiles(dir, files);
  await execFileAsync("git", ["init"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
  await execFileAsync("git", ["add", "-A"], { cwd: dir });
  await execFileAsync("git", ["commit", "-m", "inicial"], { cwd: dir });
  return dir;
}

async function writeFiles(dir: string, files: Files) {
  for (const [relPath, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, relPath)), { recursive: true });
    await fs.writeFile(path.join(dir, relPath), content);
  }
}

function find(inventory: RepoInventory, filePath: string): InventoryFile | undefined {
  return inventory.files.find((file) => file.path === filePath);
}

const results: boolean[] = [];
function check(ok: boolean, passMessage: string, failDetail: () => string) {
  console.log(ok ? `✅ ${passMessage}` : `❌ Falló. ${failDetail()}`);
  results.push(ok);
}

async function main() {
  console.log("== Fase 7A — prueba de aceptación (Repository Map: inventario) ==\n");

  // --- Caso 1: el inventario sale de git ls-files (tracked + nuevos no ignorados, sin ignorados) ---
  {
    console.log("--- Caso 1: inventario desde git ls-files ---");
    const dir = await makeGitRepo("caso1", {
      ".gitignore": "node_modules/\nignorado.ts\n",
      "src/b.ts": "export const b = 1;\n",
      "src/a.ts": "export const a = 1;\n",
      "carpeta con espacios/ñandú.ts": "export const n = 1;\n",
      "vacio.ts": "",
    });
    // Después del commit: uno nuevo (untracked, no ignorado), uno ignorado por nombre, uno en node_modules (ignorado).
    await writeFiles(dir, { "src/nuevo.ts": "export const nuevo = 1;\n", "ignorado.ts": "x\n", "node_modules/pkg/index.js": "x\n" });
    const inv = await buildRepoInventory(dir);
    const paths = inv.files.map((f) => f.path);
    const expected = [".gitignore", "carpeta con espacios/ñandú.ts", "src/a.ts", "src/b.ts", "src/nuevo.ts", "vacio.ts"];
    const sorted = JSON.stringify(paths) === JSON.stringify(expected);
    const tracking = find(inv, "src/a.ts")?.tracked === true && find(inv, "src/nuevo.ts")?.tracked === false;
    const sizes = find(inv, "src/a.ts")?.size === Buffer.byteLength("export const a = 1;\n") && find(inv, "vacio.ts")?.size === 0 && !find(inv, "vacio.ts")?.skipped;
    check(sorted && tracking && sizes && inv.stats.files === 6 && inv.stats.analyzable === 6 && !inv.truncated, "Inventario = tracked + nuevos no ignorados (ordenado, con espacios/unicode, sin node_modules ni ignorados); tracked/size correctos.", () => `paths=${JSON.stringify(paths)}, stats=${JSON.stringify(inv.stats)}`);
  }

  // --- Casos 2-3: lenguaje por extensión ---
  {
    console.log("\n--- Casos 2-3: lenguaje por extensión ---");
    const dir = await makeGitRepo("lang", {
      "a.ts": "export {};\n",
      "b.tsx": "export {};\n",
      "c.js": "module.exports = {};\n",
      "d.jsx": "export {};\n",
      "e.mjs": "export {};\n",
      "F.TS": "export {};\n",
      "data.json": "{}\n",
      "README.md": "# hola\n",
      "Makefile": "all:\n",
      "notas.xyz": "texto\n",
    });
    const inv = await buildRepoInventory(dir);
    const lang = (p: string) => find(inv, p)?.language;
    check(lang("a.ts") === "typescript" && find(inv, "a.ts")?.extension === ".ts" && lang("b.tsx") === "tsx" && find(inv, "b.tsx")?.extension === ".tsx" && lang("F.TS") === "typescript" && find(inv, "F.TS")?.extension === ".ts", "Caso 2: .ts → typescript y .tsx → tsx (la extensión se normaliza a minúscula).", () => JSON.stringify(inv.files.map((f) => [f.path, f.language, f.extension])));
    check(lang("c.js") === "javascript" && lang("d.jsx") === "jsx" && lang("e.mjs") === "javascript" && lang("data.json") === "json" && lang("README.md") === "markdown" && lang("Makefile") === "other" && find(inv, "Makefile")?.extension === "" && lang("notas.xyz") === "other", "Caso 3: .js → javascript, .jsx → jsx, .mjs/.json/.md bien clasificados; sin extensión o desconocida → other.", () => JSON.stringify(inv.files.map((f) => [f.path, f.language, f.extension])));
    check(detectLanguage("lib/x/y.tsx").language === "tsx" && detectLanguage("noext").extension === "", "detectLanguage es una función pura determinista.", () => "detectLanguage falló");
  }

  // --- Caso 4: archivos demasiado grandes ---
  {
    console.log("\n--- Caso 4: archivos demasiado grandes ---");
    const dir = await makeGitRepo("grande", { "chico.ts": "export {};\n", "enorme.ts": "x".repeat(5_000), "justo.ts": "y".repeat(100) });
    const inv = await buildRepoInventory(dir, { maxFileBytes: 100 });
    const big = find(inv, "enorme.ts");
    const ok = big?.skipped?.reason === "too_large" && big.size === 5_000 && !find(inv, "chico.ts")?.skipped && !find(inv, "justo.ts")?.skipped && inv.stats.skipped === 1 && inv.stats.analyzable === 2;
    check(ok, "Un archivo sobre el límite queda como skipped:too_large (con su tamaño) y NO se descarta del inventario; el borde exacto (100 bytes) sí es analizable.", () => JSON.stringify(inv.files));
    const def = await buildRepoInventory(dir);
    check(!find(def, "enorme.ts")?.skipped, "Con el límite default (1 MB) el mismo archivo es analizable.", () => JSON.stringify(def.files));
  }

  // --- Caso 5: binarios ---
  {
    console.log("\n--- Caso 5: archivos binarios ---");
    const dir = await makeGitRepo("binario", {
      "foto.png": "esto dice ser texto pero la extensión manda",
      "raro.dat": Buffer.from([0x41, 0x00, 0x42, 0x00, 0xff]),
      "texto.dat": "solo texto, sin NUL\n",
      "app.ts": "export {};\n",
    });
    const readPaths: string[] = [];
    const inv = await buildRepoInventory(dir, {
      readFilePrefix: async (abs, bytes) => {
        readPaths.push(path.basename(abs));
        const handle = await fs.open(abs, "r");
        try {
          const buf = Buffer.alloc(bytes);
          const { bytesRead } = await handle.read(buf, 0, bytes, 0);
          return buf.subarray(0, bytesRead);
        } finally {
          await handle.close();
        }
      },
    });
    const ok =
      find(inv, "foto.png")?.skipped?.reason === "binary" &&
      find(inv, "raro.dat")?.skipped?.reason === "binary" &&
      !find(inv, "texto.dat")?.skipped &&
      !find(inv, "app.ts")?.skipped &&
      !readPaths.includes("foto.png"); // extensión binaria conocida: ni siquiera se lee
    check(ok, "Binario por extensión (.png, sin leerlo) y por contenido (NUL en los primeros bytes) → skipped:binary; texto normal no.", () => `readPaths=${JSON.stringify(readPaths)}, files=${JSON.stringify(inv.files)}`);
  }

  // --- Casos 7-8: package.json + Next.js ---
  {
    console.log("\n--- Casos 7-8: package.json y detección de Next.js ---");
    const pkg = JSON.stringify({ name: "mi-app", scripts: { build: "next build", test: "tsx t.ts", raro: 5 }, dependencies: { next: "^16.2.4", react: "19.0.0", mala: { x: 1 } }, devDependencies: { typescript: "^5.9.3" } });
    const dir = await makeGitRepo("pkg", { "package.json": pkg, "next.config.ts": "export default {};\n", "app/page.tsx": "export default function P() { return null; }\n" });
    const inv = await buildRepoInventory(dir);
    const p = inv.package;
    check(
      p?.name === "mi-app" && p.scripts.build === "next build" && p.scripts.test === "tsx t.ts" && !("raro" in p.scripts) && p.dependencies.next === "^16.2.4" && p.dependencies.react === "19.0.0" && !("mala" in p.dependencies) && p.devDependencies.typescript === "^5.9.3" && inv.packageError === undefined,
      "package.json: name/scripts/dependencies/devDependencies leídos; valores que no son string se descartan.",
      () => JSON.stringify(inv.package),
    );
    check(inv.frameworks.length === 1 && inv.frameworks[0].name === "next" && inv.frameworks[0].version === "^16.2.4" && inv.frameworks[0].evidence.join(",") === "dependency:next,config:next.config.ts", "Next.js detectado, con versión y evidencia (dependencia + next.config.ts).", () => JSON.stringify(inv.frameworks));

    const noNext = await makeGitRepo("nonext", { "package.json": JSON.stringify({ name: "x", dependencies: { express: "^4" } }), "index.js": "x\n" });
    const invNoNext = await buildRepoInventory(noNext);
    check(invNoNext.frameworks.length === 0, "Sin next en dependencias ni config → no se detecta ningún framework.", () => JSON.stringify(invNoNext.frameworks));

    const onlyConfig = await makeGitRepo("cfgonly", { "package.json": JSON.stringify({ name: "y" }), "next.config.mjs": "export default {};\n" });
    const invCfg = await buildRepoInventory(onlyConfig);
    check(invCfg.frameworks[0]?.name === "next" && invCfg.frameworks[0].version === null && invCfg.frameworks[0].evidence.join(",") === "config:next.config.mjs", "Solo next.config.mjs (sin dependencia) también detecta Next.js, con version:null.", () => JSON.stringify(invCfg.frameworks));

    const sinPkg = await makeGitRepo("sinpkg", { "a.ts": "export {};\n" });
    const invSin = await buildRepoInventory(sinPkg);
    check(invSin.package === null && invSin.packageError === undefined && invSin.frameworks.length === 0, "Sin package.json raíz: package:null, sin error, sin frameworks.", () => JSON.stringify(invSin));

    const roto = await makeGitRepo("pkgroto", { "package.json": "{ esto no es json", "a.ts": "export {};\n" });
    const invRoto = await buildRepoInventory(roto);
    check(invRoto.package === null && typeof invRoto.packageError === "string" && invRoto.files.length === 2 && !!find(invRoto, "a.ts"), "package.json inválido: package:null + packageError, y el resto del inventario sigue completo.", () => JSON.stringify(invRoto));
  }

  // --- Caso 9: paths inseguros ---
  {
    console.log("\n--- Caso 9: paths inseguros ---");
    check(
      !isSyntacticallySafe("../fuera.ts") && !isSyntacticallySafe("a/../../b.ts") && !isSyntacticallySafe("/etc/passwd") && !isSyntacticallySafe("C:\\Windows\\x.ts") && !isSyntacticallySafe("") && !isSyntacticallySafe("a\0b") && isSyntacticallySafe("src/a..b.ts") && isSyntacticallySafe("src/ok.ts"),
      "Validación sintáctica: rechaza '..', rutas absolutas (POSIX y Windows), vacío y NUL; acepta nombres normales (incluso 'a..b').",
      () => "isSyntacticallySafe devolvió algo inesperado",
    );

    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "consenso-ia-test7a-fuera-"));
    await fs.writeFile(path.join(outside, "secreto.txt"), "SECRETO\n");
    const dir = await makeGitRepo("symlinks", { "ok.ts": "export {};\n", "real.ts": "export const real = 1;\n" });
    let symlinksOk = true;
    try {
      await fs.symlink(path.join(outside, "secreto.txt"), path.join(dir, "fuga.txt")); // apunta AFUERA
      await fs.symlink(path.join(dir, "real.ts"), path.join(dir, "alias.ts")); // apunta ADENTRO
      await execFileAsync("git", ["add", "-A"], { cwd: dir });
      await execFileAsync("git", ["commit", "-m", "symlinks"], { cwd: dir });
    } catch (error) {
      symlinksOk = false;
      console.log(`⚠️  No se pudieron crear symlinks en este entorno (${(error as NodeJS.ErrnoException).code}) — se omite este sub-caso.`);
    }
    if (symlinksOk) {
      const touched: string[] = [];
      const inv = await buildRepoInventory(dir, {
        readFilePrefix: async (abs) => {
          touched.push(abs);
          return fs.readFile(abs);
        },
      });
      const fuga = find(inv, "fuga.txt");
      const alias = find(inv, "alias.ts");
      const ok =
        fuga?.skipped?.reason === "unsafe_path" &&
        alias?.skipped?.reason === "symlink" &&
        !find(inv, "real.ts")?.skipped &&
        touched.every((abs) => !abs.includes("secreto.txt")) &&
        !touched.some((abs) => abs.endsWith("alias.ts"));
      check(ok, "Symlink que apunta afuera → skipped:unsafe_path (su destino jamás se lee); symlink interno → skipped:symlink (no se sigue); el resto intacto.", () => `fuga=${JSON.stringify(fuga)}, alias=${JSON.stringify(alias)}, touched=${JSON.stringify(touched)}`);
    }
  }

  // --- Caso 10: un error por archivo no rompe el inventario ---
  {
    console.log("\n--- Caso 10: error controlado en un archivo ---");
    const dir = await makeGitRepo("errorarchivo", { "bueno1.ts": "export {};\n", "malo.dat": "contenido\n", "bueno2.ts": "export {};\n" });
    let threw: unknown = null;
    let inv: RepoInventory | null = null;
    try {
      inv = await buildRepoInventory(dir, {
        readFilePrefix: async (abs) => {
          if (path.basename(abs) === "malo.dat") throw Object.assign(new Error(`EIO leyendo ${abs}`), { code: "EIO" });
          return Buffer.from("ok");
        },
      });
    } catch (error) {
      threw = error;
    }
    const malo = inv ? find(inv, "malo.dat") : undefined;
    const ok = threw === null && !!inv && malo?.skipped?.reason === "unreadable" && malo.skipped.detail === "EIO" && !find(inv, "bueno1.ts")?.skipped && !find(inv, "bueno2.ts")?.skipped && inv.files.length === 3;
    check(ok, "Un error de I/O en un archivo → skipped:unreadable (solo el código, sin rutas absolutas); los demás siguen y el inventario no tira.", () => `threw=${String(threw)}, malo=${JSON.stringify(malo)}`);
  }

  // --- Extras: borrados, truncado, git ausente ---
  {
    console.log("\n--- Extras: borrado sin stagear, truncado y git ausente ---");
    const dir = await makeGitRepo("extras", { "a.ts": "export {};\n", "b.ts": "export {};\n", "c.ts": "export {};\n" });
    await fs.rm(path.join(dir, "b.ts"));
    const inv = await buildRepoInventory(dir);
    check(!find(inv, "b.ts") && inv.stats.deletedInWorktree === 1 && inv.files.length === 2, "Un archivo versionado pero borrado en el worktree se omite y se cuenta en stats.deletedInWorktree.", () => JSON.stringify(inv.stats));

    const trunc = await buildRepoInventory(dir, { maxFiles: 1 });
    check(trunc.truncated === true && trunc.files.length === 1 && trunc.files[0].path === "a.ts", "maxFiles recorta de forma determinista (después de ordenar) y marca truncated:true.", () => JSON.stringify(trunc));

    const nogit = await fs.mkdtemp(path.join(os.tmpdir(), "consenso-ia-test7a-nogit-"));
    let err: unknown = null;
    await buildRepoInventory(nogit).catch((e) => (err = e));
    check(err instanceof RepoInventoryError, "Fuera de un repo git → RepoInventoryError explícito (nunca un inventario vacío silencioso).", () => `err=${String(err)}`);

    const controller = new AbortController();
    controller.abort();
    let abortErr: unknown = null;
    await buildRepoInventory(dir, { signal: controller.signal }).catch((e) => (abortErr = e));
    check(abortErr instanceof RepoInventoryError, "Con el signal ya abortado, el inventario se corta con RepoInventoryError.", () => `err=${String(abortErr)}`);
  }

  console.log(`\n${results.filter(Boolean).length}/${results.length} casos OK.`);
  if (results.some((r) => !r)) process.exit(1);
}

main().catch((error) => {
  console.error("Error inesperado en la prueba:", error);
  process.exit(1);
});
