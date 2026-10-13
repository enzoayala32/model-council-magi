/**
 * Prueba de aceptación de la Fase 7B (orquestador): `analyzeRepoInventory`
 * / `analyzeInventoryFile` sobre repos git temporales reales, consumiendo el
 * inventario de 7A — skipped, tracked:false, paths con espacios/unicode,
 * symlinks, archivos que cambian después del inventario, errores de
 * lectura, abort, roles de Next.js y determinismo.
 *
 * Sin modelo real ni red. Nada de 7C/7D (resolución, grafo, tool, cache).
 *
 * Uso: npm run agent:test-repo-analysis
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildRepoInventory } from "./repo-inventory";
import { analyzeInventoryFile, analyzeRepoInventory, RepoAnalysisError, type RepoAnalysis } from "./repo-analysis";
import * as toolsModule from "./tools";
import * as safePathModule from "./safe-path";
import type { FileAnalysis } from "./repo-symbols";

const execFileAsync = promisify(execFile);

type Files = Record<string, string | Buffer>;

async function writeFiles(dir: string, files: Files) {
  for (const [relPath, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, relPath)), { recursive: true });
    await fs.writeFile(path.join(dir, relPath), content);
  }
}

async function makeGitRepo(name: string, files: Files): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `consenso-ia-test7b-${name}-`));
  await writeFiles(dir, files);
  await execFileAsync("git", ["init"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
  await execFileAsync("git", ["add", "-A"], { cwd: dir });
  await execFileAsync("git", ["commit", "-m", "inicial"], { cwd: dir });
  return dir;
}

async function analyze(dir: string, options?: Parameters<typeof analyzeRepoInventory>[2]): Promise<{ analysis: RepoAnalysis; inventory: Awaited<ReturnType<typeof buildRepoInventory>> }> {
  const inventory = await buildRepoInventory(dir);
  return { analysis: await analyzeRepoInventory(dir, inventory, options), inventory };
}

const byPath = (analysis: RepoAnalysis, p: string): FileAnalysis | undefined => analysis.files.find((f) => f.path === p);

const results: boolean[] = [];
function check(ok: boolean, message: string, failDetail: () => string) {
  console.log(ok ? `✅ ${message}` : `❌ ${message}\n   Falló. ${failDetail()}`);
  results.push(ok);
}

async function main() {
  console.log("== Fase 7B — prueba de aceptación (orquestador: repo-analysis) ==\n");

  // --- Paso 0: safe-path ---
  {
    console.log("--- Paso 0: safe-path.ts ---");
    check(
      toolsModule.resolveSafePath === safePathModule.resolveSafePath && toolsModule.UnsafePathError === safePathModule.UnsafePathError,
      "tools.ts re-exporta la MISMA función y la MISMA clase que safe-path.ts (misma identidad: `instanceof` vale desde cualquiera de los dos).",
      () => "las referencias difieren",
    );
    let viaTools = false;
    let viaSafe = false;
    try {
      await toolsModule.resolveSafePath(os.tmpdir(), "../afuera.txt");
    } catch (error) {
      viaTools = error instanceof safePathModule.UnsafePathError && error instanceof toolsModule.UnsafePathError;
    }
    try {
      await safePathModule.resolveSafePath(os.tmpdir(), "/absoluta");
    } catch (error) {
      viaSafe = error instanceof toolsModule.UnsafePathError;
    }
    check(viaTools && viaSafe, "Un path que se escapa lanza UnsafePathError reconocible con instanceof por ambos módulos.", () => `viaTools=${viaTools}, viaSafe=${viaSafe}`);
  }

  // --- Caso 1: consume el inventario; skipped / no-código / tracked:false ---
  {
    console.log("\n--- Caso 1: consumo del inventario de 7A ---");
    const dir = await makeGitRepo("inventario", {
      "src/a.ts": "export const a = 1;\n",
      "src/b.tsx": "export default function B() { return <div />; }\n",
      "lib/c.js": "export const c = 1;\n",
      "lib/d.jsx": "export const d = () => <i />;\n",
      "README.md": "# no es código\n",
      "data.json": "{}\n",
      "enorme.ts": "x".repeat(5_000),
      "binario.ts": Buffer.from([0x65, 0x00, 0x66, 0x00, 0xff]),
      "foto.png": "texto con extensión binaria",
    });
    await writeFiles(dir, { "src/nuevo.ts": "export const nuevo = 1;\n" });
    const inventory = await buildRepoInventory(dir, { maxFileBytes: 1_000 });
    const analysis = await analyzeRepoInventory(dir, inventory, { maxFileBytes: 1_000 });
    const paths = analysis.files.map((f) => f.path);
    check(
      JSON.stringify(paths) === JSON.stringify(["lib/c.js", "lib/d.jsx", "src/a.ts", "src/b.tsx", "src/nuevo.ts"]),
      "Solo se analizan ts/tsx/js/jsx NO skipped (ni .md/.json, ni too_large, ni binarios); orden por path; el archivo nuevo sin trackear (tracked:false) SÍ.",
      () => JSON.stringify(paths),
    );
    check(
      inventory.files.find((f) => f.path === "src/nuevo.ts")?.tracked === false && analysis.stats.analyzed === 5 && analysis.stats.ok === 5 && analysis.stats.failed === 0 && analysis.stats.withDiagnostics === 0,
      "tracked:false se conserva en el inventario y stats coherentes (5 analizados, 5 ok).",
      () => JSON.stringify(analysis.stats),
    );
    check(byPath(analysis, "src/b.tsx")?.language === "tsx" && byPath(analysis, "lib/d.jsx")?.language === "jsx" && byPath(analysis, "lib/c.js")?.language === "javascript" && byPath(analysis, "src/b.tsx")?.exports[0]?.name === "default", "El language de 7A define el ScriptKind: el .tsx con JSX no da diagnostics y exporta default.", () => JSON.stringify(analysis.files));
  }

  // --- Caso 2: paths con espacios y unicode ---
  {
    console.log("\n--- Caso 2: paths con espacios y unicode ---");
    const dir = await makeGitRepo("unicode", { "carpeta con espacios/ñandú.ts": "export const ñandú = 1;\n", "日本語/ファイル.tsx": "export default function X() { return <b />; }\n" });
    const { analysis } = await analyze(dir);
    const a = byPath(analysis, "carpeta con espacios/ñandú.ts");
    const b = byPath(analysis, "日本語/ファイル.tsx");
    check(a?.parse.status === "ok" && a.symbols[0]?.name === "ñandú" && b?.parse.status === "ok" && b.exports[0]?.name === "default", "Paths con espacios y unicode se leen y analizan correctamente.", () => JSON.stringify(analysis.files));
  }

  // --- Caso 3: diagnostics y archivo vacío dentro del repo ---
  {
    console.log("\n--- Caso 3: errores de parseo y archivo vacío ---");
    const dir = await makeGitRepo("diag", { "roto.ts": 'import a from "./a";\nexport function ( {\n', "vacio.ts": "", "ok.ts": "export const ok = 1;\n" });
    const { analysis } = await analyze(dir);
    const roto = byPath(analysis, "roto.ts");
    const vacio = byPath(analysis, "vacio.ts");
    check(
      roto?.parse.status === "diagnostics" && roto.imports.length === 1 && vacio?.parse.status === "ok" && vacio.symbols.length === 0 && byPath(analysis, "ok.ts")?.parse.status === "ok" && analysis.stats.withDiagnostics === 1 && analysis.stats.ok === 2 && analysis.stats.failed === 0,
      "Un archivo con sintaxis inválida queda 'diagnostics' (con lo recuperable extraído) y NO rompe a los demás; el vacío es ok.",
      () => JSON.stringify(analysis),
    );
  }

  // --- Caso 4: symlinks reemplazados DESPUÉS del inventario ---
  {
    console.log("\n--- Caso 4: symlinks y archivos que cambian después del inventario ---");
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "consenso-ia-test7b-fuera-"));
    await fs.writeFile(path.join(outside, "secreto.ts"), "export const SECRETO = 1;\n");
    const dir = await makeGitRepo("cambios", {
      "ext.ts": "export const ext = 1;\n",
      "int.ts": "export const int = 1;\n",
      "real.ts": "export const real = 1;\n",
      "borrado.ts": "export const borrado = 1;\n",
      "crece.ts": "export const crece = 1;\n",
      "binarizado.ts": "export const binarizado = 1;\n",
      "carpeta.ts": "export const carpeta = 1;\n",
      "ok.ts": "export const ok = 1;\n",
    });
    const inventory = await buildRepoInventory(dir, { maxFileBytes: 1_000 });
    let symlinksOk = true;
    try {
      // Primero se crean los symlinks con nombre TEMPORAL: si el entorno no deja crearlos (EPERM en Windows sin
      // privilegios) no se toca ningún archivo del repo y el sub-caso se omite sin alterar el resto.
      await fs.symlink(path.join(outside, "secreto.ts"), path.join(dir, "ext.lnk")); // apuntará AFUERA
      await fs.symlink(path.join(dir, "real.ts"), path.join(dir, "int.lnk")); // apuntará ADENTRO
      await fs.rm(path.join(dir, "ext.ts"));
      await fs.rename(path.join(dir, "ext.lnk"), path.join(dir, "ext.ts"));
      await fs.rm(path.join(dir, "int.ts"));
      await fs.rename(path.join(dir, "int.lnk"), path.join(dir, "int.ts"));
    } catch (error) {
      symlinksOk = false;
      console.log(`⚠️  No se pudieron crear symlinks en este entorno (${(error as NodeJS.ErrnoException).code}) — se omite ese sub-caso.`);
    }
    await fs.rm(path.join(dir, "borrado.ts"));
    await fs.writeFile(path.join(dir, "crece.ts"), "x".repeat(5_000));
    await fs.writeFile(path.join(dir, "binarizado.ts"), Buffer.from([0x41, 0x00, 0x42, 0x00]));
    await fs.rm(path.join(dir, "carpeta.ts"));
    await fs.mkdir(path.join(dir, "carpeta.ts"));

    const readPaths: string[] = [];
    let analysis: RepoAnalysis | null = null;
    let threw: unknown = null;
    try {
      analysis = await analyzeRepoInventory(dir, inventory, {
        maxFileBytes: 1_000,
        readFile: async (abs) => {
          readPaths.push(abs);
          return fs.readFile(abs);
        },
      });
    } catch (error) {
      threw = error;
    }
    const failure = (p: string) => {
      const parse = analysis ? byPath(analysis, p)?.parse : undefined;
      return parse && parse.status === "failed" ? `${parse.code}${parse.detail ? `:${parse.detail}` : ""}` : parse?.status;
    };
    check(threw === null && analysis !== null && byPath(analysis, "ok.ts")?.parse.status === "ok" && byPath(analysis, "real.ts")?.parse.status === "ok", "Con cambios problemáticos en varios archivos, el análisis NO tira y los archivos sanos siguen ok.", () => `threw=${String(threw)}`);
    if (symlinksOk) {
      check(failure("ext.ts") === `unsafe_path:Symlink apunta afuera del workspace: ext.ts` && !readPaths.some((p) => p.includes("secreto.ts")) && byPath(analysis!, "ext.ts")?.exports.length === 0, "Archivo reemplazado por un symlink EXTERNO → failed:unsafe_path y su destino jamás se lee.", () => `${failure("ext.ts")}; leídos=${JSON.stringify(readPaths)}`);
      check(failure("int.ts") === "not_regular_file" && !readPaths.some((p) => p.endsWith(`${path.sep}int.ts`)), "Archivo reemplazado por un symlink INTERNO → failed:not_regular_file (no se sigue).", () => failure("int.ts") ?? "?");
    }
    check(failure("borrado.ts") === "changed_since_inventory:ENOENT", "Archivo borrado después del inventario → failed:changed_since_inventory.", () => failure("borrado.ts") ?? "?");
    check(failure("crece.ts")?.startsWith("changed_since_inventory:size 5000 > 1000") === true && !readPaths.some((p) => p.endsWith("crece.ts")), "Archivo que creció pasando el límite → failed:changed_since_inventory (ni se lee).", () => failure("crece.ts") ?? "?");
    check(failure("binarizado.ts") === "changed_since_inventory:binary", "Archivo que pasó a ser binario → failed:changed_since_inventory.", () => failure("binarizado.ts") ?? "?");
    check(failure("carpeta.ts") === "not_regular_file", "Archivo reemplazado por un directorio → failed:not_regular_file.", () => failure("carpeta.ts") ?? "?");
    check(analysis !== null && analysis.stats.failed === (symlinksOk ? 6 : 4) && analysis.stats.analyzed === 8, "stats.failed refleja los archivos fallidos y analyzed los incluye.", () => JSON.stringify(analysis?.stats));
  }

  // --- Caso 5: error de lectura aislado + abort ---
  {
    console.log("\n--- Caso 5: error de lectura y cancelación ---");
    const dir = await makeGitRepo("lectura", { "bueno1.ts": "export const a = 1;\n", "malo.ts": "export const b = 1;\n", "bueno2.ts": "export const c = 1;\n" });
    const inventory = await buildRepoInventory(dir);
    let threw: unknown = null;
    let analysis: RepoAnalysis | null = null;
    try {
      analysis = await analyzeRepoInventory(dir, inventory, {
        readFile: async (abs) => {
          if (path.basename(abs) === "malo.ts") throw Object.assign(new Error(`EIO leyendo ${abs}`), { code: "EIO" });
          return fs.readFile(abs);
        },
      });
    } catch (error) {
      threw = error;
    }
    const malo = analysis ? byPath(analysis, "malo.ts")?.parse : undefined;
    check(threw === null && malo?.status === "failed" && malo.code === "read_failed" && malo.detail === "EIO" && !JSON.stringify(analysis).includes(dir) && byPath(analysis!, "bueno1.ts")?.parse.status === "ok" && byPath(analysis!, "bueno2.ts")?.parse.status === "ok", "Un error de I/O en un archivo → failed:read_failed (solo el código, sin rutas absolutas); los demás siguen.", () => `threw=${String(threw)}, malo=${JSON.stringify(malo)}`);

    const preAborted = new AbortController();
    preAborted.abort();
    const err1 = await analyzeRepoInventory(dir, inventory, { signal: preAborted.signal }).then(() => null, (e) => e);
    const midAbort = new AbortController();
    const err2 = await analyzeRepoInventory(dir, inventory, {
      signal: midAbort.signal,
      readFile: async (abs) => {
        midAbort.abort();
        return fs.readFile(abs);
      },
    }).then(() => null, (e) => e);
    check(err1 instanceof RepoAnalysisError && err2 instanceof RepoAnalysisError, "signal abortado (antes o durante) → RepoAnalysisError explícito, no un resultado a medias.", () => `err1=${String(err1)}, err2=${String(err2)}`);
  }

  // --- Caso 6: Next.js ---
  {
    console.log("\n--- Caso 6: roles de Next.js ---");
    const pkg = JSON.stringify({ name: "app", dependencies: { next: "^16.0.0" } });
    const dir = await makeGitRepo("next", {
      "package.json": pkg,
      "app/api/a/route.ts": "export async function GET() {}\nexport async function POST() {}\nexport const maxDuration = 60;\n",
      "app/api/b/route.ts": "const h = async () => {};\nexport const GET = h;\nexport { h as DELETE };\nexport type PUT = string;\n",
      "app/api/c/route.ts": "export const { GET, PATCH } = handlers;\nexport { OPTIONS } from \"./h\";\n",
      "app/api/d/route.ts": "export async function HEAD() {}\nexport * from \"./handlers\";\n",
      "app/api/e/route.ts": "export default function nope() {}\nexport const dynamic = \"force-dynamic\";\n",
      "app/page.tsx": "export default function Page() { return <div />; }\n",
      "app/dash/[id]/layout.js": "export default function L({ children }) { return children; }\n",
      "app/(grupo)/ruta/page.jsx": "export default function G() { return <i />; }\n",
      "src/app/blog/page.tsx": "export default function Blog() { return <p />; }\n",
      "src/app/api/z/route.js": "export function GET() {}\n",
      "app/_privado/route.ts": "export async function GET() {}\n",
      "app/api/_interno/page.tsx": "export default function I() { return <i />; }\n",
      "app/components/boton.tsx": "export function Boton() { return <b />; }\n",
      "app/lib/util.ts": "export const util = 1;\n",
      "pages/api/hola.ts": "export default function handler() {}\n",
      "pages/index.tsx": "export default function Home() { return <h1 />; }\n",
    });
    const { analysis, inventory } = await analyze(dir);
    const next = (p: string) => byPath(analysis, p)?.next;
    check(inventory.frameworks[0]?.name === "next", "7A detecta Next.js en este repo (precondición).", () => JSON.stringify(inventory.frameworks));
    check(JSON.stringify(next("app/api/a/route.ts")) === JSON.stringify({ router: "app", role: "route", httpMethods: ["GET", "POST"] }), "route.ts con `export async function GET/POST` → métodos [GET, POST] (maxDuration no cuenta).", () => JSON.stringify(next("app/api/a/route.ts")));
    check(JSON.stringify(next("app/api/b/route.ts")?.httpMethods) === JSON.stringify(["GET", "DELETE"]), "`export const GET = h` y `export { h as DELETE }` → [GET, DELETE]; `export type PUT` NO cuenta.", () => JSON.stringify(next("app/api/b/route.ts")));
    check(JSON.stringify(next("app/api/c/route.ts")?.httpMethods) === JSON.stringify(["GET", "PATCH", "OPTIONS"]) && next("app/api/c/route.ts")?.httpMethodsPartial === undefined, "`export const { GET, PATCH } = handlers` y `export { OPTIONS } from` → [GET, PATCH, OPTIONS], sin partial.", () => JSON.stringify(next("app/api/c/route.ts")));
    check(JSON.stringify(next("app/api/d/route.ts")) === JSON.stringify({ router: "app", role: "route", httpMethods: ["HEAD"], httpMethodsPartial: true }), "`export * from` en un route → httpMethodsPartial:true (no se inventan métodos).", () => JSON.stringify(next("app/api/d/route.ts")));
    check(JSON.stringify(next("app/api/e/route.ts")?.httpMethods) === "[]", "route.ts sin métodos (solo default y config) → httpMethods:[].", () => JSON.stringify(next("app/api/e/route.ts")));
    check(JSON.stringify(next("app/page.tsx")) === JSON.stringify({ router: "app", role: "page" }) && JSON.stringify(next("app/dash/[id]/layout.js")) === JSON.stringify({ router: "app", role: "layout" }) && next("app/(grupo)/ruta/page.jsx")?.role === "page", "page.tsx, layout.js con [id] y page.jsx en (grupo) → roles page/layout/page (sin httpMethods).", () => JSON.stringify([next("app/page.tsx"), next("app/dash/[id]/layout.js"), next("app/(grupo)/ruta/page.jsx")]));
    check(next("src/app/blog/page.tsx")?.role === "page" && JSON.stringify(next("src/app/api/z/route.js")) === JSON.stringify({ router: "app", role: "route", httpMethods: ["GET"] }), "src/app/** también se reconoce (page.tsx y route.js).", () => JSON.stringify([next("src/app/blog/page.tsx"), next("src/app/api/z/route.js")]));
    check(next("app/_privado/route.ts") === undefined && next("app/api/_interno/page.tsx") === undefined, "Carpetas privadas (segmento que empieza con _) NO son rutas → sin rol.", () => JSON.stringify([next("app/_privado/route.ts"), next("app/api/_interno/page.tsx")]));
    check(next("app/components/boton.tsx") === undefined && next("app/lib/util.ts") === undefined, "Archivos de app/ que no se llaman route/page/layout → sin rol.", () => "tienen rol");
    check(next("pages/api/hola.ts") === undefined && next("pages/index.tsx") === undefined, "pages/ (Pages Router) NO se trata como App Router → sin rol.", () => "pages con rol");
  }

  // --- Caso 7: proyecto sin Next ---
  {
    console.log("\n--- Caso 7: proyecto sin Next.js ---");
    const dir = await makeGitRepo("sinnext", {
      "package.json": JSON.stringify({ name: "api", dependencies: { express: "^4" } }),
      "app/api/x/route.ts": "export async function GET() {}\n",
      "app/page.tsx": "export default function P() { return <div />; }\n",
    });
    const { analysis, inventory } = await analyze(dir);
    check(inventory.frameworks.length === 0 && analysis.files.every((f) => f.next === undefined) && byPath(analysis, "app/api/x/route.ts")?.exports[0]?.name === "GET", "Sin Next.js en 7A, un app/**/route.ts es un archivo común: sin rol (pero sí con sus exports).", () => JSON.stringify(analysis.files));
  }

  // --- Caso 8: analyzeInventoryFile (interfaz para 7D) y determinismo ---
  {
    console.log("\n--- Caso 8: archivo individual y determinismo ---");
    const dir = await makeGitRepo("det", {
      "package.json": JSON.stringify({ dependencies: { next: "^16" } }),
      "app/api/x/route.ts": "import { z } from \"zod\";\nexport async function GET() {}\n",
      "lib/a.ts": "import b from \"./b\";\nexport class A { m() {} }\nexport default A;\n",
      "lib/b.ts": "export default 1;\n",
    });
    const inventory = await buildRepoInventory(dir);
    const first = await analyzeRepoInventory(dir, inventory);
    const second = await analyzeRepoInventory(dir, inventory);
    check(JSON.stringify(first) === JSON.stringify(second), "Dos ejecuciones sobre el mismo contenido → JSON idéntico (incluso con lectura concurrente).", () => "difieren");
    const single = await analyzeInventoryFile(dir, { path: "app/api/x/route.ts", language: "typescript" }, { frameworks: inventory.frameworks });
    check(JSON.stringify(single) === JSON.stringify(byPath(first, "app/api/x/route.ts")), "analyzeInventoryFile (un solo archivo) da el MISMO resultado que dentro del análisis completo.", () => JSON.stringify(single));
    const noFrameworks = await analyzeInventoryFile(dir, { path: "app/api/x/route.ts", language: "typescript" });
    check(noFrameworks.next === undefined && noFrameworks.imports[0]?.source === "zod", "Sin `frameworks` no se calcula el rol de Next (el import sí se captura, crudo).", () => JSON.stringify(noFrameworks));
    const bad = await analyzeInventoryFile(dir, { path: "../fuera.ts", language: "typescript" });
    const nolang = await analyzeInventoryFile(dir, { path: "package.json", language: "json" });
    check(bad.parse.status === "failed" && bad.parse.code === "unsafe_path" && nolang.parse.status === "failed", "Un path con '..' → failed:unsafe_path; un language no analizable → failed (sin lanzar).", () => JSON.stringify([bad.parse, nolang.parse]));
  }

  console.log(`\n${results.filter(Boolean).length}/${results.length} casos OK.`);
  if (results.some((r) => !r)) process.exit(1);
}

main().catch((error) => {
  console.error("Error inesperado en la prueba:", error);
  process.exit(1);
});
