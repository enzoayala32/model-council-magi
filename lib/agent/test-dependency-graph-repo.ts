/**
 * Prueba de aceptación de la Fase 7C (de punta a punta): el pipeline real
 * `buildRepoInventory (7A) → analyzeRepoInventory (7B) → loadResolutionConfig
 * → buildDependencyGraph (7C)` sobre repos git temporales y sobre una COPIA
 * del proyecto real (sus propios imports, su tsconfig y su alias `@/`).
 *
 * Verifica también la semántica de snapshot: lo que cambia en el disco
 * DESPUÉS del inventario no altera la resolución en memoria; solo 7B marca
 * los archivos que cambiaron y 7C bloquea los destinos inseguros.
 *
 * Sin modelo ni red. Nada de 7D (tool, cache, invalidación).
 *
 * Uso: npm run agent:test-dependency-graph-repo
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildRepoInventory, type RepoInventory } from "./repo-inventory";
import { analyzeRepoInventory } from "./repo-analysis";
import { loadResolutionConfig } from "./resolution-config";
import { buildDependencyGraph, type DependencyEdge, type DependencyGraph } from "./dependency-graph";

const execFileAsync = promisify(execFile);

async function writeFiles(dir: string, files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), content);
  }
}

async function gitInit(dir: string) {
  await execFileAsync("git", ["init"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
}
async function gitCommitAll(dir: string, message = "commit") {
  await execFileAsync("git", ["add", "-A"], { cwd: dir });
  await execFileAsync("git", ["commit", "-m", message], { cwd: dir });
}

/** Crea `<tmp>/<name>/repo` (git, con un commit) — el padre sirve para colocar archivos "afuera". */
async function makeRepo(name: string, files: Record<string, string>): Promise<{ parent: string; dir: string }> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), `consenso-ia-test7c-repo-${name}-`));
  const dir = path.join(parent, "repo");
  await fs.mkdir(dir);
  await writeFiles(dir, files);
  await gitInit(dir);
  await gitCommitAll(dir, "inicial");
  return { parent, dir };
}

type Pipeline = { inventory: RepoInventory; analysis: Awaited<ReturnType<typeof analyzeRepoInventory>>; graph: DependencyGraph };

async function analyzeAndBuild(dir: string, inventory: RepoInventory, options: { maxFileBytes?: number; readFile?: (abs: string) => Promise<Buffer> } = {}): Promise<Pipeline> {
  const analysis = await analyzeRepoInventory(dir, inventory, options);
  const config = await loadResolutionConfig(dir, inventory);
  return { inventory, analysis, graph: await buildDependencyGraph(inventory, analysis, config) };
}
async function pipeline(dir: string, options: { maxFileBytes?: number } = {}): Promise<Pipeline> {
  const inventory = await buildRepoInventory(dir, options);
  return analyzeAndBuild(dir, inventory, options);
}

function sum(edge: DependencyEdge | undefined): string {
  if (!edge) return "(sin edge)";
  if (edge.resolution === "internal") return `→${edge.to}`;
  if (edge.resolution === "external") return `ext:${edge.package}${edge.builtin ? "/builtin" : ""}`;
  return `✗${edge.reason}`;
}
const edgeOf = (g: DependencyGraph, from: string, source: string) => g.edges.find((e) => e.from === from && e.source === source);
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const results: boolean[] = [];
function check(ok: boolean, message: string, failDetail: () => string) {
  console.log(ok ? `✅ ${message}` : `❌ ${message}\n   Falló. ${failDetail()}`);
  results.push(ok);
}
const ALIAS_TSCONFIG = '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["./*"]}}}';

async function main() {
  console.log("== Fase 7C — prueba de aceptación (grafo de dependencias, de punta a punta) ==\n");

  // --- Caso 1: clasificación internal / external / unresolved ---
  console.log("--- Pipeline completo en un repo git ---");
  {
    const { dir } = await makeRepo("basico", {
      "tsconfig.json": ALIAS_TSCONFIG,
      "a.ts": 'import "./b";\nimport c from "@/lib/c";\nimport "react";\nimport "node:fs";\nimport "./missing";\nimport "./style.css";\n',
      "b.ts": "export const b = 1;\n",
      "lib/c.ts": "export default 1;\n",
      "style.css": "body {}\n",
    });
    const { graph } = await pipeline(dir);
    check(
      eq(graph.edges.map((e) => `${e.from} ${e.source} ${sum(e)}`), ["a.ts ./b →b.ts", "a.ts @/lib/c →lib/c.ts", "a.ts react ext:react", "a.ts node:fs ext:node:fs/builtin", "a.ts ./missing ✗not_found", "a.ts ./style.css →style.css"]) && eq(graph.stats, { edges: 6, internal: 3, external: 2, unresolved: 1, dynamicNonLiteral: 0 }) && graph.config.file === "tsconfig.json",
      "7A→7B→config→7C: relativo, alias @/, paquete, builtin, inexistente y asset; stats coherentes",
      () => JSON.stringify(graph),
    );
  }

  // --- Caso 2: archivos nuevos sin trackear ---
  {
    const { dir } = await makeRepo("untracked", { "tsconfig.json": ALIAS_TSCONFIG, "base.ts": "export {};\n" });
    await writeFiles(dir, { "src/fresh.ts": "export const fresh = 1;\n", "src/user.ts": 'import "./fresh";\nimport "@/base";\n' });
    const { inventory, graph } = await pipeline(dir);
    check(inventory.files.find((f) => f.path === "src/user.ts")?.tracked === false && sum(edgeOf(graph, "src/user.ts", "./fresh")) === "→src/fresh.ts" && sum(edgeOf(graph, "src/user.ts", "@/base")) === "→base.ts" && eq(graph.importedBy.map((i) => i.path), ["base.ts", "src/fresh.ts"]), "archivos nuevos SIN trackear (tracked:false) participan del grafo como cualquier otro", () => JSON.stringify(graph.edges));
  }

  // --- Caso 3-4: snapshot (desaparece / aparece un archivo) ---
  console.log("\n--- Snapshot: lo que cambia después del inventario ---");
  {
    const { dir } = await makeRepo("snapshot", { "a.ts": 'import "./b";\nimport "./later";\n', "b.ts": 'import "./c";\nimport "react";\n', "c.ts": "export {};\n" });
    const inventory = await buildRepoInventory(dir);
    await fs.rm(path.join(dir, "b.ts")); // desaparece DESPUÉS del inventario
    await fs.writeFile(path.join(dir, "later.ts"), "export {};\n"); // aparece DESPUÉS del inventario
    const { analysis, graph } = await analyzeAndBuild(dir, inventory);
    const b = analysis.files.find((f) => f.path === "b.ts");
    check(
      b?.parse.status === "failed" && b.parse.code === "changed_since_inventory" && sum(edgeOf(graph, "a.ts", "./b")) === "→b.ts" && graph.edges.every((e) => e.from !== "b.ts") && !graph.importedBy.some((i) => i.path === "c.ts"),
      "archivo borrado tras el inventario: 7B lo marca changed_since_inventory, 7C conserva el snapshot (a → b sigue) y no inventa edges salientes de b (c ya no tiene importadores)",
      () => JSON.stringify({ b: b?.parse, edges: graph.edges, importedBy: graph.importedBy }),
    );
    check(sum(edgeOf(graph, "a.ts", "./later")) === "✗not_found" && !graph.importedBy.some((i) => i.path === "later.ts"), "archivo que aparece tras el inventario NO aparece mágicamente en el grafo (./later → not_found)", () => JSON.stringify(graph.edges));
  }

  // --- Caso 5-7: symlinks y directorios sustituidos ---
  console.log("\n--- Symlinks y sustituciones ---");
  {
    const { parent, dir } = await makeRepo("swap", {
      "main.ts": 'import "./ext";\nimport "./int";\nimport "./dir";\nimport "./ok";\n',
      "ext.ts": "export const ext = 1;\n",
      "int.ts": "export const int = 1;\n",
      "dir.ts": "export const dir = 1;\n",
      "ok.ts": "export const ok = 1;\n",
      "real.ts": "export const real = 1;\n",
    });
    await fs.writeFile(path.join(parent, "secreto.ts"), 'import "./nunca";\nexport const SECRETO = 1;\n');
    const inventory = await buildRepoInventory(dir);
    let symlinks = true;
    try {
      // Symlinks con nombre temporal primero: sin privilegios (EPERM) no se toca ningún archivo del repo.
      await fs.symlink(path.join(parent, "secreto.ts"), path.join(dir, "ext.lnk")); // symlink EXTERNO
      await fs.symlink(path.join(dir, "real.ts"), path.join(dir, "int.lnk")); // symlink INTERNO
      await fs.rm(path.join(dir, "ext.ts"));
      await fs.rename(path.join(dir, "ext.lnk"), path.join(dir, "ext.ts"));
      await fs.rm(path.join(dir, "int.ts"));
      await fs.rename(path.join(dir, "int.lnk"), path.join(dir, "int.ts"));
    } catch (error) {
      symlinks = false;
      console.log(`⚠️  No se pudieron crear symlinks en este entorno (${(error as NodeJS.ErrnoException).code}) — se omiten esos sub-casos.`);
    }
    await fs.rm(path.join(dir, "dir.ts"));
    await fs.mkdir(path.join(dir, "dir.ts")); // reemplazado por un DIRECTORIO
    const read: string[] = [];
    const { graph } = await analyzeAndBuild(dir, inventory, { readFile: async (abs) => (read.push(abs), fs.readFile(abs)) });
    if (symlinks) {
      check(sum(edgeOf(graph, "main.ts", "./ext")) === "✗unsafe_target" && sum(edgeOf(graph, "main.ts", "./int")) === "✗unsafe_target" && !read.some((p) => p.includes("secreto")) && graph.edges.every((e) => e.source !== "./nunca"), "archivo sustituido por un symlink (externo o interno) tras el inventario → unsafe_target; el destino externo jamás se lee ni aporta edges", () => `${JSON.stringify(graph.edges)} leídos=${JSON.stringify(read)}`);
    }
    check(sum(edgeOf(graph, "main.ts", "./dir")) === "✗unsafe_target" && sum(edgeOf(graph, "main.ts", "./ok")) === "→ok.ts", "archivo sustituido por un directorio → unsafe_target; los archivos sanos siguen internos", () => JSON.stringify(graph.edges));
  }
  {
    const { dir } = await makeRepo("tracked-symlink", { "main.ts": 'import "./link";\n', "real.ts": "export const real = 1;\n" });
    let created = true;
    try {
      await fs.symlink(path.join(dir, "real.ts"), path.join(dir, "link.ts"));
      await gitCommitAll(dir, "symlink");
    } catch {
      created = false;
      console.log("⚠️  No se pudo crear/versionar un symlink en este entorno — se omite ese sub-caso.");
    }
    if (created) {
      const { inventory, graph } = await pipeline(dir);
      check(inventory.files.find((f) => f.path === "link.ts")?.skipped?.reason === "symlink" && sum(edgeOf(graph, "main.ts", "./link")) === "✗unsafe_target", "symlink versionado en el repo (7A lo marca skipped) → un import que resuelve ahí es unsafe_target", () => JSON.stringify(graph.edges));
    }
  }

  // --- Caso 8: tsconfig modificado ---
  console.log("\n--- tsconfig y destinos sin análisis ---");
  {
    const { dir } = await makeRepo("tsconfig-cambia", { "tsconfig.json": '{"compilerOptions":{"strict":true}}', "main.ts": 'import "@/lib/c";\n', "lib/c.ts": "export {};\n" });
    const inventory = await buildRepoInventory(dir);
    const analysis = await analyzeRepoInventory(dir, inventory);
    const before = await buildDependencyGraph(inventory, analysis, await loadResolutionConfig(dir, inventory));
    await fs.writeFile(path.join(dir, "tsconfig.json"), ALIAS_TSCONFIG);
    const after = await buildDependencyGraph(inventory, analysis, await loadResolutionConfig(dir, inventory));
    check(sum(before.edges[0]) === "✗unmapped_alias" && before.config.aliases.length === 0 && sum(after.edges[0]) === "→lib/c.ts" && after.config.aliases.length === 1, "modificar tsconfig.json cambia la resolución al recargar la config (mismo inventario y análisis): @/ pasa de unmapped_alias a internal", () => `${JSON.stringify(before.edges)} ${JSON.stringify(after.edges)}`);
  }
  {
    const { dir } = await makeRepo("too-large", { "main.ts": 'import "./big";\n', "big.ts": `export const big = "${"x".repeat(400)}";\n` });
    const { inventory, graph } = await pipeline(dir, { maxFileBytes: 100 });
    check(inventory.files.find((f) => f.path === "big.ts")?.skipped?.reason === "too_large" && sum(edgeOf(graph, "main.ts", "./big")) === "→big.ts" && eq(graph.importedBy, [{ path: "big.ts", by: ["main.ts"] }]), "un archivo too_large (sin análisis) es un destino válido y aparece en importedBy", () => JSON.stringify(graph));
  }

  // --- Determinismo: no depende del orden de creación en disco ---
  {
    const files: Record<string, string> = { "tsconfig.json": ALIAS_TSCONFIG, "z.ts": 'import "./a";\nimport "react";\n', "a.ts": 'import "@/m/b";\n', "m/b.ts": 'import "../z";\n', "s.css": "" };
    const forward = await makeRepo("det-a", files);
    const backward = await makeRepo("det-b", Object.fromEntries(Object.entries(files).reverse()));
    const g1 = (await pipeline(forward.dir)).graph;
    const g2 = (await pipeline(backward.dir)).graph;
    const g3 = (await pipeline(forward.dir)).graph;
    check(JSON.stringify(g1) === JSON.stringify(g2) && JSON.stringify(g1) === JSON.stringify(g3) && g1.edges.length === 4, "determinismo: mismo grafo (JSON idéntico) creando los archivos en otro orden y en una segunda corrida", () => `${JSON.stringify(g1.edges.map((e) => e.from))} vs ${JSON.stringify(g2.edges.map((e) => e.from))}`);
  }

  // --- La copia del proyecto real ---
  console.log("\n--- Copia del proyecto real (sus propios imports y alias) ---");
  {
    const root = process.cwd();
    const hasProject = await Promise.all(["tsconfig.json", "app", "lib"].map((p) => fs.stat(path.join(root, p)).then(() => true, () => false)));
    if (!hasProject.every(Boolean)) {
      console.log("⚠️  El directorio actual no parece la raíz del proyecto (falta tsconfig.json, app/ o lib/) — se omite el caso del proyecto real.");
    } else {
      const parent = await fs.mkdtemp(path.join(os.tmpdir(), "consenso-ia-test7c-proyecto-"));
      const dir = path.join(parent, "repo");
      await fs.mkdir(dir);
      const skip = (src: string) => !/(^|[\\/])(node_modules|\.next)([\\/]|$)/.test(src);
      for (const entry of ["app", "lib"]) await fs.cp(path.join(root, entry), path.join(dir, entry), { recursive: true, filter: skip });
      for (const file of ["tsconfig.json", "package.json", "next.config.ts", "instrumentation.ts", "next-env.d.ts"]) await fs.copyFile(path.join(root, file), path.join(dir, file)).catch(() => undefined);
      await fs.writeFile(path.join(dir, ".gitignore"), "node_modules/\n.next/\n");
      await gitInit(dir);
      await gitCommitAll(dir, "copia");

      const first = await pipeline(dir);
      const second = await pipeline(dir);
      const g = first.graph;
      const generated = (e: DependencyEdge) => e.from === "next-env.d.ts" && e.source.includes(".next/");
      const internalLooking = g.edges.filter((e) => /^(\.{1,2}\/|@\/)/.test(e.source));
      const broken = internalLooking.filter((e) => e.resolution !== "internal" && !generated(e));
      check(internalLooking.length > 100 && broken.length === 0, `todos los imports relativos y con alias @/ del proyecto (${internalLooking.length}) resuelven a un archivo interno (salvo los tipos generados de .next)`, () => JSON.stringify(broken.slice(0, 5)));
      check(g.edges.filter((e) => e.resolution === "unresolved").every(generated), "lo único sin resolver es lo generado e ignorado por git (next-env.d.ts → .next/types/…)", () => JSON.stringify(g.edges.filter((e) => e.resolution === "unresolved" && !generated(e))));
      check(g.config.file === "tsconfig.json" && g.config.baseUrl === "." && g.config.aliases.some((a) => a.pattern === "@/*") && g.config.warnings.length === 0 && !g.truncated, "config real del proyecto: tsconfig.json, baseUrl '.', alias @/*, sin warnings, sin recorte", () => JSON.stringify(g.config));

      const layout = edgeOf(g, "app/layout.tsx", "./globals.css");
      check(layout?.resolution === "internal" && layout.to === "app/globals.css" && layout.kind === "side-effect", "app/layout.tsx → app/globals.css (asset CSS como arista side-effect)", () => JSON.stringify(layout));
      // tools.ts importa ./safe-path de DOS formas (import estático para usarlo y `export … from` para re-exportarlo): son 2 edges por el dedupe por kind.
      const toSafePath = g.edges.filter((e) => e.from === "lib/agent/tools.ts" && e.source === "./safe-path");
      check(eq(toSafePath.map((e) => `${e.kind}${sum(e)}`), ["static→lib/agent/safe-path.ts", "reexport→lib/agent/safe-path.ts"]), "lib/agent/tools.ts → lib/agent/safe-path.ts como static Y como reexport (el Paso 0 de 7B): dos edges porque el kind difiere", () => JSON.stringify(toSafePath));
      const roleToSymbols = edgeOf(g, "lib/agent/next-roles.ts", "./repo-symbols");
      const symbolsToRole = edgeOf(g, "lib/agent/repo-symbols.ts", "./next-roles");
      check(roleToSymbols?.resolution === "internal" && symbolsToRole?.resolution === "internal" && roleToSymbols.isTypeOnly && symbolsToRole.isTypeOnly, "ciclo REAL next-roles ↔ repo-symbols: las dos edges existen y son type-only", () => JSON.stringify([roleToSymbols, symbolsToRole]));
      const packages = new Set(g.edges.filter((e): e is Extract<DependencyEdge, { resolution: "external" }> => e.resolution === "external").map((e) => e.package));
      check(packages.has("next") && packages.has("typescript") && [...packages].some((p) => p.startsWith("node:")) && g.edges.some((e) => e.resolution === "external" && e.builtin === true), "externos reales: next, typescript y builtins node:* (con builtin:true)", () => JSON.stringify([...packages].slice(0, 12)));
      check(g.edges.some((e) => e.kind === "dynamic" && e.resolution === "internal"), "hay imports dinámicos con literal que resuelven a archivos internos (instrumentation.ts → runner, etc.)", () => "ningún dynamic internal");
      const importers = g.importedBy.find((i) => i.path === "lib/agent/safe-path.ts")?.by ?? [];
      check(importers.includes("lib/agent/tools.ts") && importers.includes("lib/agent/repo-inventory.ts") && importers.includes("lib/agent/repo-analysis.ts"), "importedBy de safe-path.ts incluye tools.ts, repo-inventory.ts y repo-analysis.ts", () => JSON.stringify(importers));
      check(g.stats.edges === g.edges.length && g.stats.edges === g.stats.internal + g.stats.external + g.stats.unresolved && g.stats.internal > 300, `stats coherentes (${JSON.stringify(g.stats)})`, () => JSON.stringify(g.stats));
      check(JSON.stringify(first.graph) === JSON.stringify(second.graph), "determinismo sobre el proyecto real: dos corridas completas → grafo idéntico", () => "difieren");
    }
  }

  console.log(`\n${results.filter(Boolean).length}/${results.length} casos OK.`);
  if (results.some((r) => !r)) process.exit(1);
}

main().catch((error) => {
  console.error("Error inesperado en la prueba:", error);
  process.exit(1);
});
