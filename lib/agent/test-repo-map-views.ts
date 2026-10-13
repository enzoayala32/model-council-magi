/**
 * Prueba de aceptación de la Fase 7D (vistas puras): `projectRepoMap` —
 * overview / files / symbols, `subPath`, paginación por cursor, presupuesto de
 * salida, escalera de recorte, errores y determinismo. Todo en memoria: sin
 * disco, sin Git, sin modelo.
 *
 * Uso: npm run agent:test-repo-map-views
 */
import { detectLanguage, type InventoryFile, type RepoInventory, type SkipReason } from "./repo-inventory";
import { analyzeSourceText, failedAnalysis, isParseableLanguage, type FileAnalysis } from "./repo-symbols";
import { detectNextRole } from "./next-roles";
import { parseResolutionConfig, defaultResolutionConfig } from "./resolution-config";
import { buildDependencyGraph } from "./dependency-graph";
import { registerSecret } from "../provider-resilience/redact";
import {
  normalizeRelativeInput,
  projectRepoMap,
  REPO_MAP_LIMITS,
  repoMapInputSchema,
  type RepoMapFiles,
  type RepoMapInput,
  type RepoMapOverview,
  type RepoMapResult,
  type RepoMapSnapshotData,
  type RepoMapSymbols,
} from "./repo-map-views";

type WorldFile = string | { text?: string; skipped?: SkipReason; failed?: "unsafe_path" | "not_regular_file" | "changed_since_inventory"; tracked?: boolean };
type WorldOptions = { tsconfig?: string; withNext?: boolean; pkg?: RepoInventory["package"] };

async function world(files: Record<string, WorldFile>, options: WorldOptions = {}): Promise<RepoMapSnapshotData> {
  const inventoryFiles: InventoryFile[] = [];
  const analyses: FileAnalysis[] = [];
  const frameworks: RepoInventory["frameworks"] = options.withNext ? [{ name: "next", version: "^16", evidence: ["dependency:next"] }] : [];
  for (const [filePath, spec] of Object.entries(files)) {
    const text = typeof spec === "string" ? spec : (spec.text ?? "");
    const skipped = typeof spec === "string" ? undefined : spec.skipped;
    const failed = typeof spec === "string" ? undefined : spec.failed;
    const tracked = typeof spec === "string" ? true : (spec.tracked ?? true);
    const { extension, language } = detectLanguage(filePath);
    inventoryFiles.push({ path: filePath, extension, language, size: text.length, tracked, ...(skipped ? { skipped: { reason: skipped } } : {}) });
    if (!skipped && isParseableLanguage(language)) {
      const analysis = failed ? failedAnalysis(filePath, language, failed) : analyzeSourceText(filePath, language, text);
      if (analysis.parse.status !== "failed") {
        const role = detectNextRole(filePath, analysis.exports, frameworks);
        if (role) analysis.next = role;
      }
      analyses.push(analysis);
    }
  }
  const byPath = <T extends { path: string }>(a: T, b: T) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  inventoryFiles.sort(byPath);
  analyses.sort(byPath);
  const inventory: RepoInventory = { files: inventoryFiles, package: options.pkg ?? null, frameworks, truncated: false, stats: { files: inventoryFiles.length, analyzable: inventoryFiles.length, skipped: 0, deletedInWorktree: 0 } };
  const parsed = options.tsconfig ? parseResolutionConfig("tsconfig.json", new Map([["tsconfig.json", options.tsconfig]])).config : null;
  const graph = await buildDependencyGraph(inventory, { files: analyses }, parsed ?? defaultResolutionConfig());
  return { inventory, analysis: { files: analyses }, graph };
}

const results: boolean[] = [];
function check(ok: boolean, message: string, failDetail: () => string) {
  console.log(ok ? `✅ ${message}` : `❌ ${message}\n   Falló. ${failDetail()}`);
  results.push(ok);
}
const canon = (value: unknown) => JSON.stringify(value);
const eq = (a: unknown, b: unknown) => canon(a) === canon(b);
const len = (value: unknown) => JSON.stringify(value).length;
function checkEq(actual: unknown, expected: unknown, message: string) {
  check(eq(actual, expected), message, () => `esperado=${canon(expected)}\n   actual  =${canon(actual)}`);
}

const ALIAS_TSCONFIG = '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["./*"]}}}';
const PKG: NonNullable<RepoInventory["package"]> = { name: "demo", scripts: { dev: "next dev", build: "next build" }, dependencies: { react: "19", next: "^16" }, devDependencies: { typescript: "^5" } };

/** Proyecto Next de juguete usado por casi todos los casos. */
const NEXT_FILES: Record<string, WorldFile> = {
  "package.json": "{}",
  "tsconfig.json": ALIAS_TSCONFIG,
  "app/layout.tsx": 'import "./globals.css";\nexport default function Layout() { return null; }\n',
  "app/globals.css": "",
  "app/page.tsx": 'import { x } from "@/lib/util";\nexport default function Page() { return null; }\n',
  "app/api/a/route.ts": 'import { NextResponse } from "next/server";\nexport async function GET() {}\nexport async function POST() {}\n',
  "app/api/b/route.ts": 'export * from "./h";\nexport async function DELETE() {}\n',
  "app/api/b/h.ts": "export async function GET() {}\n",
  "lib/util.ts": 'import fs from "node:fs";\nimport "./missing";\nexport const x = 1;\nexport class Box { m() {} static s() {} }\n',
  "data.bin": { skipped: "binary" },
  "huge.ts": { skipped: "too_large" },
};

function ov(result: RepoMapResult): RepoMapOverview {
  if (!result.ok || result.detail !== "overview") throw new Error(`se esperaba un overview ok: ${canon(result).slice(0, 200)}`);
  return result;
}
function files(result: RepoMapResult): RepoMapFiles {
  if (!result.ok || result.detail !== "files") throw new Error(`se esperaba files ok: ${canon(result).slice(0, 200)}`);
  return result;
}
function symbols(result: RepoMapResult): RepoMapSymbols {
  if (!result.ok || result.detail !== "symbols") throw new Error(`se esperaba symbols ok: ${canon(result).slice(0, 200)}`);
  return result;
}

/** Recorre TODAS las páginas siguiendo budget.nextAfter. */
function allPages(data: RepoMapSnapshotData, input: RepoMapInput, maxChars: number): { pages: RepoMapResult[]; paths: string[] } {
  const pages: RepoMapResult[] = [];
  const paths: string[] = [];
  let after: string | undefined = input.after;
  for (let guard = 0; guard < 10_000; guard++) {
    const page = projectRepoMap(data, { ...input, after }, { maxChars });
    pages.push(page);
    if (!page.ok || page.detail === "overview") break;
    for (const entry of page.files) paths.push(entry.path);
    if (!page.budget.truncated) break;
    after = page.budget.nextAfter;
  }
  return { pages, paths };
}

function manyFiles(n: number, prefix = "src"): Record<string, WorldFile> {
  const out: Record<string, WorldFile> = {};
  for (let i = 0; i < n; i++) {
    const id = String(i).padStart(5, "0");
    out[`${prefix}/f${id}.ts`] = `import "./f${String((i + 1) % n).padStart(5, "0")}";\nexport const v${i} = ${i};\nexport function fn${i}(a: number) { return a; }\n`;
  }
  return out;
}

/**
 * Guarda del arnés: si la promesa principal queda colgada (sin timers ni handles) Node sale en SILENCIO con
 * código 0. Una suite que no llegó a su resumen final NUNCA debe contar como exitosa.
 */
let completed = false;
process.on("exit", () => {
  if (completed) return;
  console.error("❌ La suite terminó sin completarse (una promesa quedó colgada o el proceso salió antes de tiempo).");
  process.exitCode = 1;
});

async function main() {
  console.log("== Fase 7D — prueba de aceptación (vistas puras de repo_map) ==\n");
  const next = await world(NEXT_FILES, { tsconfig: ALIAS_TSCONFIG, withNext: true, pkg: PKG });

  // ---------------- Entrada ----------------
  console.log("--- Entrada: schema y normalización ---");
  check(repoMapInputSchema.safeParse({}).success && repoMapInputSchema.safeParse({ detail: "files", subPath: "src", after: "src/a.ts" }).success && !repoMapInputSchema.safeParse({ detail: "todo" }).success && !repoMapInputSchema.safeParse({ subPath: 5 }).success, "schema: todo opcional ({} vale), detail restringido, tipos validados", () => "schema");
  {
    const n = (raw: string | undefined, strict = true) => normalizeRelativeInput(raw, "subPath", strict);
    const value = (raw: string | undefined) => {
      const r = n(raw);
      return r.ok ? r.value : `ERR:${r.code}`;
    };
    checkEq([value(undefined), value(""), value("."), value("./"), value("./a/b/"), value("a\\b\\c"), value("a//b"), value("./a/./b")], [null, null, null, null, "a/b", "a/b/c", "a/b", "a/b"], "normalización de subPath: vacío / '.' → todo; './', '\\', '//' y '/' final se limpian");
    checkEq([value("../x"), value("a/../b"), value("/etc"), value("C:\\x"), value("C:/x")], ["ERR:unsafe_path", "ERR:unsafe_path", "ERR:unsafe_path", "ERR:unsafe_path", "ERR:unsafe_path"], "subPath inseguro ('..', absoluto POSIX / Windows) → unsafe_path");
    checkEq([value("a\u0000b"), value("x".repeat(1025))], ["ERR:invalid_input", "ERR:invalid_input"], "subPath con NUL o de más de 1024 caracteres → invalid_input");
    const cursor = normalizeRelativeInput("./a\\b/", "after", false);
    check(cursor.ok && cursor.value === "a/b" && normalizeRelativeInput("../x", "after", false).ok, "el cursor `after` se normaliza igual pero no exige ser una ruta segura (es solo una cadena a comparar)", () => canon(cursor));
    const bad = projectRepoMap(next, { detail: "todo" as never });
    check(!bad.ok && bad.code === "invalid_input", "detail inválido llamado directo → invalid_input (no lanza)", () => canon(bad));
  }

  // ---------------- Overview ----------------
  console.log("\n--- overview ---");
  {
    const o = ov(projectRepoMap(next, {}));
    checkEq([o.scope, o.budget], [{ subPath: null, files: 11 }, { maxChars: 24000, truncated: false }], "overview por defecto: scope y presupuesto (24.000 chars)");
    checkEq(o.workspace, { files: 11, analyzed: 6, inventoryTruncated: false, languages: [{ language: "css", files: 1 }, { language: "json", files: 2 }, { language: "other", files: 1 }, { language: "tsx", files: 2 }, { language: "typescript", files: 5 }], skipped: [{ reason: "binary", files: 1 }, { reason: "too_large", files: 1 }], analysisIssues: { withDiagnostics: 0, failed: 0 } }, "workspace: archivos, analizados, lenguajes y skipped (ordenados)");
    checkEq(o.project, { name: "demo", frameworks: [{ name: "next", version: "^16" }], scripts: { items: [{ name: "build", command: "next build" }, { name: "dev", command: "next dev" }], omitted: 0 }, dependencies: { items: ["next", "react"], omitted: 0 }, devDependencies: { items: ["typescript"], omitted: 0 } }, "project: nombre, frameworks, scripts y dependencias (ordenados por nombre)");
    checkEq(o.resolution, { file: "tsconfig.json", baseUrl: ".", aliases: { items: [{ pattern: "@/*", targets: ["./*"] }], omitted: 0 }, warnings: { items: [], omitted: 0 } }, "resolution: archivo de config, baseUrl y alias @/*");
    checkEq(o.structure, { items: [{ directory: ".", files: 4 }, { directory: "app", files: 3 }, { directory: "app/api", files: 3 }, { directory: "lib", files: 1 }], omitted: 0 }, "structure: directorios hasta 2 niveles con su cantidad de archivos");
    checkEq(o.next, { routes: { items: [{ path: "app/api/a/route.ts", methods: ["GET", "POST"] }, { path: "app/api/b/route.ts", methods: ["DELETE"], partial: true }], omitted: 0 }, pages: 1, layouts: 1 }, "next: rutas con sus métodos (partial por `export *`), páginas y layouts");
    checkEq(o.graph, { edges: 6, internal: 3, external: 2, unresolved: 1, dynamicNonLiteral: 0, truncated: false, externalPackages: { items: ["next", "node:fs"], omitted: 0 }, unresolvedEdges: { items: [{ from: "lib/util.ts", source: "./missing", reason: "not_found" }], omitted: 0 } }, "graph: conteos, paquetes externos (por nombre) y aristas sin resolver");
  }
  {
    const bare = await world({ "a.ts": "export const a = 1;\n" });
    const o = ov(projectRepoMap(bare, {}));
    check(o.project === null && o.next === undefined && o.resolution.file === null && o.graph.edges === 0, "sin package.json ni frameworks: project:null, sin bloque next, sin config", () => canon(o));
    const empty = ov(projectRepoMap(await world({}), {}));
    check(empty.workspace.files === 0 && empty.structure.items.length === 0 && empty.scope.files === 0, "repositorio vacío: overview válido con ceros", () => canon(empty));
  }
  {
    const f: Record<string, WorldFile> = {};
    const deps: Record<string, string> = {};
    const scripts: Record<string, string> = {};
    for (let i = 0; i < 100; i++) deps[`dep-${String(i).padStart(3, "0")}`] = "1";
    for (let i = 0; i < 30; i++) scripts[`script-${String(i).padStart(2, "0")}`] = "echo";
    for (let i = 0; i < 60; i++) f[`d${String(i).padStart(2, "0")}/x.ts`] = `import "./nope${i}";\nimport "@/missing${i}";\n`;
    const aliases = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`@a${i}/*`, [`./a${i}/*`]]));
    const big = await world(f, { tsconfig: JSON.stringify({ compilerOptions: { baseUrl: ".", paths: aliases } }), pkg: { name: "big", scripts, dependencies: deps, devDependencies: {} } });
    const o = ov(projectRepoMap(big, {}));
    check(o.project?.dependencies.items.length === 40 && o.project.dependencies.omitted === 60 && o.project.scripts.items.length === 15 && o.project.scripts.omitted === 15 && o.structure.items.length === 40 && o.structure.omitted === 20 && o.resolution.aliases.items.length === 20 && o.resolution.aliases.omitted === 10 && o.graph.unresolvedEdges.items.length === 15 && o.graph.unresolvedEdges.omitted === 105 && len(o) <= 24000, "listas acotadas: cada una declara cuántos omitió (omitted) y el total sigue dentro del presupuesto", () => canon({ deps: o.project?.dependencies.omitted, structure: o.structure.omitted, aliases: o.resolution.aliases.omitted, unresolved: o.graph.unresolvedEdges.omitted, len: len(o) }));
    const tiny = ov(projectRepoMap(big, {}, { maxChars: 2000 }));
    check(len(tiny) <= 2000 && tiny.budget.truncated === true && tiny.graph.edges === o.graph.edges, "overview con presupuesto mínimo (2.000): se reducen los topes en escalera, entra, y budget.truncated lo declara (los conteos no cambian)", () => `len=${len(tiny)} ${canon(tiny.budget)}`);
  }
  {
    const scoped = ov(projectRepoMap(next, { subPath: "app/api" }));
    check(scoped.scope.files === 3 && scoped.workspace.files === 3 && scoped.workspace.analyzed === 3 && scoped.graph.edges === 2 && scoped.graph.internal === 1 && scoped.graph.external === 1 && scoped.project?.name === "demo" && scoped.resolution.file === "tsconfig.json" && scoped.next?.routes.items.length === 2 && scoped.next.pages === 0, "overview con subPath: workspace, estructura, rutas y aristas se acotan al subárbol; project y resolution siguen siendo globales", () => canon(scoped));
    checkEq(scoped.structure.items, [{ directory: "app/api/a", files: 1 }, { directory: "app/api/b", files: 2 }], "estructura bajo subPath: 2 niveles contados desde el subárbol");
  }
  {
    registerSecret("super-secret-token-123");
    const secret = await world({ "a.ts": "export {};\n" }, { pkg: { name: "s", scripts: { deploy: "deploy --token super-secret-token-123" }, dependencies: {}, devDependencies: {} } });
    const o = ov(projectRepoMap(secret, {}));
    check(!canon(o).includes("super-secret-token-123") && canon(o).includes("[REDACTED]"), "los comandos de scripts pasan por redactSecrets (un secreto registrado nunca sale en el mapa)", () => canon(o.project));
  }

  // ---------------- files ----------------
  console.log("\n--- files ---");
  {
    const r = files(projectRepoMap(next, { detail: "files" }));
    const entry = (p: string) => r.files.find((e) => e.path === p);
    checkEq(entry("app/api/a/route.ts"), { path: "app/api/a/route.ts", language: "typescript", size: NEXT_FILES["app/api/a/route.ts"].toString().length, role: { role: "route", methods: ["GET", "POST"] }, exports: 2, symbols: 2, imports: { external: 1 } }, "entrada de un route: rol Next con métodos, conteos de exports/símbolos y de aristas");
    checkEq(entry("app/api/b/h.ts"), { path: "app/api/b/h.ts", language: "typescript", size: 31, exports: 1, symbols: 1, importedBy: 1 }, "entrada con importedBy (conteo) y sin campos vacíos");
    checkEq(entry("app/globals.css"), { path: "app/globals.css", language: "css", size: 0, importedBy: 1 }, "un asset sin análisis aparece con su importedBy");
    checkEq([entry("data.bin"), entry("huge.ts")], [{ path: "data.bin", language: "other", size: 0, skipped: "binary" }, { path: "huge.ts", language: "typescript", size: 0, skipped: "too_large" }], "archivos skipped por 7A: se listan con su motivo y sin conteos");
    check(eq(r.files.map((e) => e.path), [...r.files.map((e) => e.path)].sort()) && r.files.length === 11 && eq(r.scope, { subPath: null, files: 11 }) && eq(r.budget, { maxChars: 24000, truncated: false }), "orden por ruta, todos los archivos del inventario y budget sin truncar", () => canon(r.budget));
  }
  {
    const w = await world({ "ok.ts": "export const a = 1;\n", "roto.ts": "export function ( {\n", "fallo.ts": { text: "x", failed: "changed_since_inventory" }, "nuevo.ts": { text: "export {};\n", tracked: false } });
    const r = files(projectRepoMap(w, { detail: "files" }));
    const entry = (p: string) => r.files.find((e) => e.path === p);
    check(entry("roto.ts")?.parse === "diagnostics" && entry("fallo.ts")?.parse === "failed" && entry("nuevo.ts")?.tracked === false && entry("ok.ts")?.parse === undefined && entry("ok.ts")?.tracked === undefined, "parse:'diagnostics'/'failed' y tracked:false solo aparecen cuando corresponden", () => canon(r.files));
    const o = ov(projectRepoMap(w, {}));
    checkEq(o.workspace.analysisIssues, { withDiagnostics: 1, failed: 1 }, "el overview cuenta los problemas de análisis");
  }
  console.log("\n--- subPath: coincidencia por segmento ---");
  {
    const w = await world({ "src/a.ts": "export {};\n", "src/deep/b.ts": "export {};\n", "src2/c.ts": "export {};\n", "src.ts": "export {};\n", "README.md": "# x\n" });
    const paths = (input: RepoMapInput) => {
      const r = projectRepoMap(w, { detail: "files", ...input });
      return r.ok && r.detail === "files" ? r.files.map((e) => e.path) : `ERR:${r.ok ? "?" : r.code}`;
    };
    checkEq(paths({ subPath: "src" }), ["src/a.ts", "src/deep/b.ts"], "subPath carpeta: 'src' abarca src/** pero NO src2/ ni src.ts (coincide por segmento)");
    checkEq(paths({ subPath: "src/deep" }), ["src/deep/b.ts"], "subPath de un subárbol más profundo");
    checkEq(paths({ subPath: "src.ts" }), ["src.ts"], "subPath de un archivo exacto");
    checkEq(paths({ subPath: "./src/" }), ["src/a.ts", "src/deep/b.ts"], "subPath se normaliza antes de comparar");
    const missing = projectRepoMap(w, { subPath: "nada/aca" });
    check(!missing.ok && missing.code === "path_not_in_map" && !missing.error.includes("/home") && missing.error.includes("nada/aca"), "subPath sin archivos → path_not_in_map (con un mensaje que nombra la ruta relativa pedida)", () => canon(missing));
    check(files(projectRepoMap(w, { detail: "files", subPath: "src" })).scope.files === 2, "scope.files cuenta los archivos del subárbol", () => "scope");
  }
  console.log("\n--- Paginación por cursor ---");
  {
    const w = await world(manyFiles(200));
    const unpaged = projectRepoMap(w, { detail: "files" }, { maxChars: 1_000_000 });
    const allPaths = files(unpaged).files.map((e) => e.path);
    const { pages, paths } = allPages(w, { detail: "files" }, 2500);
    check(pages.length >= 4 && eq(paths, allPaths) && new Set(paths).size === paths.length && eq(paths, [...paths].sort()), `paginación completa de files (${pages.length} páginas, presupuesto 2.500): sin huecos ni duplicados y en orden`, () => `páginas=${pages.length} total=${paths.length}/${allPaths.length}`);
    check(pages.every((p) => len(p) <= 2500), "cada página respeta el presupuesto (JSON final ≤ 2.500)", () => canon(pages.map(len)));
    const first = files(pages[0]);
    check(first.budget.truncated && first.budget.omitted === 200 - first.files.length && first.budget.nextAfter === first.files[first.files.length - 1].path && !files(pages[pages.length - 1]).budget.truncated && files(pages[pages.length - 1]).budget.omitted === undefined, "budget: truncated, omitted (restantes) y nextAfter (última ruta incluida); la última página no trunca", () => canon(first.budget));
    const cursor = files(projectRepoMap(w, { detail: "files", after: "src/f00010.ts" }, { maxChars: 1_000_000 })).files.map((e) => e.path);
    check(cursor[0] === "src/f00011.ts" && cursor.length === 189, "`after` es estrictamente posterior (no repite la ruta del cursor)", () => canon(cursor.slice(0, 2)));
    check(eq(files(projectRepoMap(w, { detail: "files", after: "./src\\f00010.ts" }, { maxChars: 1_000_000 })).files.map((e) => e.path), cursor), "`after` se normaliza (./ y \\)", () => "after sin normalizar");
    const past = files(projectRepoMap(w, { detail: "files", after: "zzz" }));
    check(past.files.length === 0 && past.budget.truncated === false, "`after` más allá del final → lista vacía sin truncar", () => canon(past));
  }
  {
    const w = await world(manyFiles(1200));
    const { pages, paths } = allPages(w, { detail: "files" }, REPO_MAP_LIMITS.maxOutputChars);
    check(paths.length === 1200 && new Set(paths).size === 1200 && pages.length >= 7 && pages.every((p) => len(p) <= REPO_MAP_LIMITS.maxOutputChars && len(p) <= REPO_MAP_LIMITS.policyMaxOutputChars), `1.200 archivos con el presupuesto real: ${pages.length} páginas completas, todas ≤ 24.000 (y ≤ el backstop de 100.000)`, () => canon(pages.map(len)));
  }

  // ---------------- symbols ----------------
  console.log("\n--- symbols ---");
  {
    const w = await world({
      "a.ts": 'import { b } from "./b";\nimport "react";\nimport "./nope";\nexport { c } from "./b";\nexport * from "./b";\nexport type { T } from "./b";\nexport function f(x: string): void;\nexport function f(x: number): void;\nexport function f(x: any) {}\nclass K { static s() {} private p() {} get g() { return 1; } }\nexport default K;\n',
      "b.ts": "export const b = 1, c = 2;\nexport type T = string;\n",
      "css.css": "",
    });
    const r = symbols(projectRepoMap(w, { detail: "symbols", subPath: "a.ts" }));
    const entry = r.files[0];
    checkEq(entry.symbols, [{ name: "f", kind: "function", line: 7, exported: true, overloads: 2 }, { name: "K", kind: "class", line: 10, exported: true, members: [{ name: "s", kind: "method", line: 10, static: true }, { name: "p", kind: "method", line: 10, visibility: "private" }, { name: "g", kind: "get", line: 10 }] }], "symbols: funciones con overloads, clases con miembros (static / visibilidad) y exported por `export default K`");
    checkEq(entry.reexports, [{ name: "c", source: "./b", importedName: "c" }, { name: "*", source: "./b", all: true }, { name: "T", source: "./b", importedName: "T", typeOnly: true }], "reexports: nombre, source, importedName, all (export *) y typeOnly");
    checkEq(entry.imports, { internal: ["b.ts"], external: ["react"], unresolved: [{ source: "./nope", reason: "not_found" }] }, "imports: archivos internos, paquetes externos y sin resolver (únicos y ordenados)");
    checkEq(entry.importedBy, undefined, "importedBy ausente cuando nadie importa el archivo");
    const b = symbols(projectRepoMap(w, { detail: "symbols", subPath: "b.ts" })).files[0];
    checkEq(b.importedBy, { paths: ["a.ts"] }, "importedBy de b.ts: sus importadores directos");
    const all = symbols(projectRepoMap(w, { detail: "symbols" }));
    check(eq(all.files.map((e) => e.path), ["a.ts", "b.ts"]) && all.scope.files === 3, "solo se listan archivos ANALIZADOS (el css queda afuera) pero scope.files cuenta el inventario del subárbol", () => canon(all.scope));
  }
  {
    const f: Record<string, WorldFile> = { "target.ts": "export const t = 1;\n" };
    for (let i = 0; i < 30; i++) f[`imp/i${String(i).padStart(2, "0")}.ts`] = 'import "../target";\n';
    const w = await world(f);
    const entry = symbols(projectRepoMap(w, { detail: "symbols", subPath: "target.ts" })).files[0];
    check(entry.importedBy?.paths.length === 25 && entry.importedBy.omitted === 5 && entry.importedBy.paths[0] === "imp/i00.ts", "importedBy acotado a 25 con omitted (los 5 restantes) y orden por ruta", () => canon(entry.importedBy));
  }
  {
    const w = await world({ "ok.ts": "export const a = 1;\n", "roto.ts": "export function ( {\n const = ;\n const = ;\n const = ;\n const = ;\n", "fallo.ts": { text: "x", failed: "unsafe_path" } });
    const r = symbols(projectRepoMap(w, { detail: "symbols" }));
    const roto = r.files.find((e) => e.path === "roto.ts");
    const fallo = r.files.find((e) => e.path === "fallo.ts");
    check(roto?.parseIssue?.status === "diagnostics" && roto.parseIssue.items.length <= 3 && roto.parseIssue.count >= 3 && fallo?.parseIssue?.status === "failed" && fallo.parseIssue.code === "unsafe_path" && r.files.find((e) => e.path === "ok.ts")?.parseIssue === undefined, "parseIssue: diagnostics (≤3 ítems) y failed (con su código); un archivo sano no lo tiene", () => canon([roto?.parseIssue, fallo?.parseIssue]));
  }
  console.log("\n--- Escalera de recorte de una entrada gigante ---");
  {
    const lines: string[] = ["export class Giant {"];
    for (let i = 0; i < 80; i++) lines.push(`  method${i}() {}`);
    lines.push("}");
    for (let i = 0; i < 200; i++) lines.push(`${i % 2 === 0 ? "export " : ""}function fn${i}(a: number) { return a; }`);
    const w = await world({ "src/giant.ts": lines.join("\n"), "src/small.ts": "export const a = 1;\n" });
    const full = projectRepoMap(w, { detail: "symbols" }, { maxChars: 1_000_000 });
    const fullEntry = symbols(full).files.find((e) => e.path === "src/giant.ts");
    check(fullEntry !== undefined && fullEntry.trimmed === undefined && len(fullEntry) > 6000, "con presupuesto holgado la entrada gigante va completa (sin trimmed)", () => `len=${len(fullEntry)}`);
    const r = symbols(projectRepoMap(w, { detail: "symbols" }, { maxChars: 6000 }));
    const giant = r.files.find((e) => e.path === "src/giant.ts");
    const small = r.files.find((e) => e.path === "src/small.ts");
    check(giant !== undefined && len(giant) <= 2000 && giant.trimmed?.[0] === "members" && giant.trimmed.includes("unexportedSymbols") && /^symbols:\d+$/.test(giant.trimmed[giant.trimmed.length - 1]) && small?.trimmed === undefined && len(r) <= 6000, "entrada gigante: se recorta por la escalera (miembros → no exportados → mitad de símbolos), queda ≤ maxChars/3, declara qué recortó, y las entradas chicas no se tocan", () => canon({ len: giant && len(giant), trimmed: giant?.trimmed }));
    const again = symbols(projectRepoMap(w, { detail: "symbols" }, { maxChars: 6000 })).files.find((e) => e.path === "src/giant.ts");
    const fromCursor = symbols(projectRepoMap(w, { detail: "symbols", after: "src/a" }, { maxChars: 6000 })).files.find((e) => e.path === "src/giant.ts");
    check(eq(giant, again) && eq(giant, fromCursor), "el recorte es función de la entrada y del presupuesto, no de la posición en la página (mismo resultado con otro cursor)", () => "difiere");
  }

  // ---------------- Presupuesto ----------------
  console.log("\n--- Presupuesto de salida ---");
  {
    const gi: Record<string, WorldFile> = { "g.ts": `export class G {\n${Array.from({ length: 80 }, (_, i) => `  m${i}() {}`).join("\n")}\n}\n` };
    const fixtures: Array<[string, RepoMapSnapshotData]> = [["next", next], ["200 archivos", await world(manyFiles(200))], ["gigante", await world(gi)], ["vacío", await world({})]];
    let combos = 0;
    let exceeded: string[] = [];
    const wrongErrors: string[] = [];
    for (const [name, data] of fixtures) {
      for (const detail of ["overview", "files", "symbols"] as const) {
        for (const maxChars of [2000, 3000, 5000, 12000, 24000]) {
          const pages = allPages(data, { detail }, maxChars).pages;
          for (const page of pages) {
            combos += 1;
            if (len(page) > maxChars) exceeded.push(`${name}/${detail}/${maxChars}:${len(page)}`);
            if (!page.ok && page.code !== "output_too_large") wrongErrors.push(`${name}/${detail}/${maxChars}:${page.code}`);
          }
        }
      }
    }
    check(exceeded.length === 0 && wrongErrors.length === 0 && combos > 100, `propiedad: ${combos} respuestas (3 niveles × 5 presupuestos × 4 repos, todas las páginas) — ninguna supera su presupuesto y los únicos errores posibles son output_too_large`, () => canon({ exceeded: exceeded.slice(0, 5), wrongErrors: wrongErrors.slice(0, 5) }));
  }
  {
    const longPath = `${"d".repeat(3000)}.ts`;
    const w = await world({ [longPath]: "export {};\n" });
    const r = projectRepoMap(w, { detail: "files" }, { maxChars: 2000 });
    check(!r.ok && r.code === "output_too_large" && !r.error.includes("ddd"), "si ni la primera entrada entra en el presupuesto → output_too_large explícito (nunca una lista vacía que parezca 'sin más datos')", () => canon(r).slice(0, 200));
    const clamped = projectRepoMap(await world({ "a.ts": "export {};\n" }), {}, { maxChars: 10 });
    check(clamped.ok && clamped.budget.maxChars === REPO_MAP_LIMITS.minOutputChars, "un presupuesto menor al piso se sube a REPO_MAP_LIMITS.minOutputChars (2.000)", () => canon(clamped).slice(0, 120));
  }
  check(REPO_MAP_LIMITS.maxOutputChars === 24_000 && REPO_MAP_LIMITS.policyMaxOutputChars === 100_000 && REPO_MAP_LIMITS.maxOutputChars < REPO_MAP_LIMITS.policyMaxOutputChars && REPO_MAP_LIMITS.buildTimeoutMs === 60_000 && REPO_MAP_LIMITS.buildTimeoutMs < REPO_MAP_LIMITS.policyTimeoutMs && REPO_MAP_LIMITS.minOutputChars <= REPO_MAP_LIMITS.maxOutputChars && REPO_MAP_LIMITS.maxAttempts === 3, "límites: presupuesto 24.000 < backstop 100.000; timeout interno 60 s < política 90 s; 3 intentos", () => canon(REPO_MAP_LIMITS));

  // ---------------- Determinismo y pureza ----------------
  console.log("\n--- Determinismo y pureza ---");
  {
    const shuffled: RepoMapSnapshotData = {
      inventory: { ...next.inventory, files: [...next.inventory.files].reverse() },
      analysis: { files: [...next.analysis.files].reverse() },
      graph: { ...next.graph, edges: [...next.graph.edges].reverse(), importedBy: [...next.graph.importedBy].reverse().map((e) => ({ path: e.path, by: [...e.by].reverse() })) },
    };
    const inputs: RepoMapInput[] = [{}, { detail: "files" }, { detail: "symbols" }, { detail: "overview", subPath: "app" }, { detail: "symbols", subPath: "lib/util.ts" }, { detail: "files", after: "app/page.tsx" }];
    check(inputs.every((input) => canon(projectRepoMap(next, input)) === canon(projectRepoMap(next, input)) && canon(projectRepoMap(next, input)) === canon(projectRepoMap(shuffled, input))), "determinismo: misma salida en dos llamadas y con el inventario, el análisis y las aristas en orden inverso (6 consultas distintas)", () => "difiere");
    const before = canon(next);
    for (const input of inputs) projectRepoMap(next, input);
    // Varias aristas sin resolver en varios archivos: invertir el orden del grafo NO puede cambiar el resultado.
    const multi = await world({ "b.ts": 'import "./z-falta";\nimport "./a-falta";\n', "a.ts": 'import "./m-falta";\nimport "./c-falta";\n', "c.ts": 'import "./k-falta";\n' });
    const multiShuffled: RepoMapSnapshotData = { ...multi, graph: { ...multi.graph, edges: [...multi.graph.edges].reverse() } };
    const multiOverview = ov(projectRepoMap(multi, {}));
    check(multiOverview.graph.unresolvedEdges.items.length === 5 && canon(projectRepoMap(multi, {})) === canon(projectRepoMap(multiShuffled, {})) && eq(multiOverview.graph.unresolvedEdges.items.map((e) => `${e.from}|${e.source}`), ["a.ts|./c-falta", "a.ts|./m-falta", "b.ts|./a-falta", "b.ts|./z-falta", "c.ts|./k-falta"]), "las aristas sin resolver salen ordenadas por (from, source) y el resultado no depende del orden del grafo (5 aristas en 3 archivos, grafo invertido)", () => canon(multiOverview.graph.unresolvedEdges.items));
    check(canon(next) === before, "las proyecciones no mutan el snapshot que reciben", () => "el snapshot cambió");
    check(!/\d{4}-\d{2}-\d{2}T/.test(canon(projectRepoMap(next, {}))), "la salida no incluye timestamps", () => "hay una fecha ISO en la salida");
  }

  completed = true;
  console.log(`\n${results.filter(Boolean).length}/${results.length} casos OK.`);
  if (results.some((r) => !r)) process.exit(1);
}

main().catch((error) => {
  console.error("Error inesperado en la prueba:", error);
  process.exit(1);
});
