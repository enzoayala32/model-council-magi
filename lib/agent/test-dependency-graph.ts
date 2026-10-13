/**
 * Prueba de aceptación de la Fase 7C (parte pura): `buildDependencyGraph`
 * sobre inventarios y análisis ARMADOS EN MEMORIA — sin disco, sin Git, sin
 * modelo. Todo el grafo es una función de `inventory + analysis + config`;
 * esta suite lo demuestra: ninguno de estos archivos existe en el disco.
 *
 * Cubre resolución (relativos, extensiones, index, barrels, aliases,
 * assets), los 7 kinds de edge, externos, las razones de unresolved,
 * seguridad de destinos, dedupe, `importedBy`, ciclos, determinismo, tope
 * de edges y cancelación.
 *
 * Uso: npm run agent:test-dependency-graph
 */
import { detectLanguage, type InventoryFile, type RepoInventory, type SkipReason } from "./repo-inventory";
import type { RepoAnalysis } from "./repo-analysis";
import { analyzeSourceText, failedAnalysis, isParseableLanguage, type FileAnalysis } from "./repo-symbols";
import { defaultResolutionConfig, parseResolutionConfig, type ResolutionConfig } from "./resolution-config";
import { buildDependencyGraph, DependencyGraphError, MAX_GRAPH_EDGES, MAX_SPECIFIER_CHARS, type DependencyEdge, type DependencyGraph } from "./dependency-graph";

/** Copia del tsconfig real del proyecto (con comentarios, como los admite TS). */
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

type WorldFile = string | { text?: string; skipped?: SkipReason; failed?: "unsafe_path" | "not_regular_file" | "changed_since_inventory" };
type WorldOptions = { tsconfig?: string; maxEdges?: number; shuffle?: boolean; signal?: AbortSignal };

function cfgFrom(tsconfig: string): ResolutionConfig {
  const parsed = parseResolutionConfig("tsconfig.json", new Map([["tsconfig.json", tsconfig]]));
  if (!parsed.config) throw new Error(`tsconfig de prueba inválido: ${parsed.warnings.join(" | ")}`);
  return parsed.config;
}

async function world(files: Record<string, WorldFile>, options: WorldOptions = {}) {
  const inventoryFiles: InventoryFile[] = [];
  const analyses: FileAnalysis[] = [];
  for (const [filePath, spec] of Object.entries(files)) {
    const text = typeof spec === "string" ? spec : (spec.text ?? "");
    const skipped = typeof spec === "string" ? undefined : spec.skipped;
    const failed = typeof spec === "string" ? undefined : spec.failed;
    const { extension, language } = detectLanguage(filePath);
    inventoryFiles.push({ path: filePath, extension, language, size: text.length, tracked: true, ...(skipped ? { skipped: { reason: skipped } } : {}) });
    if (!skipped && isParseableLanguage(language)) analyses.push(failed ? failedAnalysis(filePath, language, failed) : analyzeSourceText(filePath, language, text));
  }
  const byPath = <T extends { path: string }>(a: T, b: T) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  inventoryFiles.sort(byPath);
  analyses.sort(byPath);
  if (options.shuffle) {
    inventoryFiles.reverse();
    analyses.reverse();
  }
  const inventory: RepoInventory = { files: inventoryFiles, package: null, frameworks: [], truncated: false, stats: { files: inventoryFiles.length, analyzable: inventoryFiles.length, skipped: 0, deletedInWorktree: 0 } };
  const analysis: RepoAnalysis = { files: analyses, stats: { analyzed: analyses.length, ok: analyses.length, withDiagnostics: 0, failed: 0 } };
  const config = options.tsconfig ? cfgFrom(options.tsconfig) : defaultResolutionConfig();
  const graph = await buildDependencyGraph(inventory, analysis, config, { maxEdges: options.maxEdges, signal: options.signal });
  return { inventory, analysis, config, graph };
}

function sum(edge: DependencyEdge | undefined): string {
  if (!edge) return "(sin edge)";
  if (edge.resolution === "internal") return `→${edge.to}`;
  if (edge.resolution === "external") return `ext:${edge.package}${edge.builtin ? "/builtin" : ""}`;
  return `✗${edge.reason}`;
}

/** Importa cada `source` (side-effect) desde `from` y devuelve `source → resumen`. */
async function many(sources: string[], files: Record<string, WorldFile> = {}, options: WorldOptions = {}, from = "main.ts"): Promise<Record<string, string>> {
  const text = sources.map((source) => `import ${JSON.stringify(source)};`).join("\n");
  const { graph } = await world({ [from]: text, ...files }, options);
  return Object.fromEntries(sources.map((source) => [source, sum(graph.edges.find((edge) => edge.from === from && edge.source === source))]));
}

const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const results: boolean[] = [];
function check(ok: boolean, message: string, failDetail: () => string) {
  console.log(ok ? `✅ ${message}` : `❌ ${message}\n   Falló. ${failDetail()}`);
  results.push(ok);
}
function checkEq(actual: unknown, expected: unknown, message: string) {
  check(eq(actual, expected), message, () => `esperado=${JSON.stringify(expected)}\n   actual  =${JSON.stringify(actual)}`);
}
const X = "export const x = 1;\n";

async function main() {
  console.log("== Fase 7C — prueba de aceptación (grafo de dependencias, parte pura) ==\n");

  // ---------------- Resolución ----------------
  console.log("--- Resolución: relativos, extensiones, index ---");
  checkEq(await many(["./foo", "./sub/bar", "./lib//u", "./lib/../lib/u"], { "foo.ts": X, "sub/bar.ts": X, "lib/u.ts": X }), { "./foo": "→foo.ts", "./sub/bar": "→sub/bar.ts", "./lib//u": "→lib/u.ts", "./lib/../lib/u": "→lib/u.ts" }, "relativos ./x, ./sub/x y con normalización (// y /../)");
  checkEq(await many(["../foo", "../../top"], { "src/foo.ts": X, "top.ts": X }, {}, "src/deep/main.ts"), { "../foo": "→src/foo.ts", "../../top": "→top.ts" }, "relativos hacia arriba (../x y ../../x)");
  checkEq(await many(["./a", "./b", "./c", "./d"], { "a.ts": X, "b.tsx": X, "c.js": X, "d.jsx": X }), { "./a": "→a.ts", "./b": "→b.tsx", "./c": "→c.js", "./d": "→d.jsx" }, "extensiones .ts / .tsx / .js / .jsx sin escribir la extensión");
  checkEq(await many(["./types", "./data.json"], { "types.d.ts": X, "data.json": "{}" }), { "./types": "→types.d.ts", "./data.json": "→data.json" }, ".d.ts y .json (resolveJsonModule)");
  checkEq(await many(["./esm.js", "./foo.ts", "./foo.js"], { "esm.ts": X, "foo.ts": X }), { "./esm.js": "→esm.ts", "./foo.ts": "→foo.ts", "./foo.js": "→foo.ts" }, "estilo ESM: ./x.js → x.ts; extensión .ts explícita");
  checkEq(await many(["./both"], { "both.ts": X, "both/index.ts": X }), { "./both": "→both.ts" }, "archivo vs directorio: gana el archivo (both.ts sobre both/index.ts)");
  checkEq(await many(["./dir", "./dir2", "./dir3"], { "dir/index.ts": X, "dir2/index.tsx": X, "dir3/index.js": X }), { "./dir": "→dir/index.ts", "./dir2": "→dir2/index.tsx", "./dir3": "→dir3/index.js" }, "directorios → index.ts / index.tsx / index.js");
  {
    const { graph } = await world({
      "a.ts": 'import "./barrel";\n',
      "barrel/index.ts": 'export * from "./inner";\n',
      "barrel/inner/index.ts": 'export { x } from "./x";\n',
      "barrel/inner/x.ts": X,
    });
    checkEq(graph.edges.map((e) => `${e.from}|${e.kind}|${sum(e)}`), ["a.ts|side-effect|→barrel/index.ts", "barrel/index.ts|reexport-all|→barrel/inner/index.ts", "barrel/inner/index.ts|reexport|→barrel/inner/x.ts"], "cadena de barrels (index → index → archivo): una dependencia de ARCHIVO por eslabón");
  }
  checkEq(await many(["./Foo", "./foo"], { "Foo.ts": X }), { "./Foo": "→Foo.ts", "./foo": "✗not_found" }, "la resolución distingue mayúsculas (como Git): ./foo ≠ Foo.ts");

  console.log("\n--- Resolución: aliases ---");
  checkEq(await many(["@/lib/u", "@/lib/missing"], { "lib/u.ts": X }, { tsconfig: REAL_TSCONFIG }), { "@/lib/u": "→lib/u.ts", "@/lib/missing": "✗alias_target_missing" }, "tsconfig REAL: @/* → ./* (resuelve) y alias con target inexistente → alias_target_missing");
  checkEq(
    await many(["~lib/u", "~lib/a", "@exact"], { "lib/u.ts": X, "alt/a.ts": X, "a.ts": X }, { tsconfig: '{"compilerOptions":{"paths":{"~lib/*":["./lib/*","./alt/*"],"@exact":["./a.ts"]}}}' }),
    { "~lib/u": "→lib/u.ts", "~lib/a": "→alt/a.ts", "@exact": "→a.ts" },
    "múltiples targets (cae al siguiente), alias exacto y paths SIN baseUrl",
  );
  checkEq(await many(["lib/u", "lib/nope"], { "lib/u.ts": X }, { tsconfig: '{"compilerOptions":{"baseUrl":"."}}' }), { "lib/u": "→lib/u.ts", "lib/nope": "ext:lib" }, "baseUrl: un bare 'lib/u' resuelve a archivo interno (y 'lib/nope' se ve como paquete: límite documentado)");
  checkEq(await many(["@/lib/u", "~/x", "#sub"], { "lib/u.ts": X }), { "@/lib/u": "✗unmapped_alias", "~/x": "✗unmapped_alias", "#sub": "✗unsupported_specifier" }, "alias sin configuración (@/, ~/) → unmapped_alias; #sub → unsupported_specifier");
  checkEq(await many(["react", "@x/foo"], {}, { tsconfig: '{"compilerOptions":{"paths":{"*":["./types/*"],"@x/*":["./x/*"]}}}' }), { react: "ext:react", "@x/foo": "✗alias_target_missing" }, "el comodín '*' suelto NO convierte un paquete en alias roto; un patrón con prefijo sí");
  checkEq(await many(["./b"], { "gen/b.ts": X }, { tsconfig: '{"compilerOptions":{"rootDirs":["src","gen"]}}' }, "src/a.ts"), { "./b": "→gen/b.ts" }, "rootDirs: ./b desde src/ resuelve a gen/b.ts");

  console.log("\n--- Resolución: assets (css, svg, png) ---");
  checkEq(
    await many(["./globals.css", "./icon.svg", "./x.module.css", "./pic.png", "./missing.css"], { "globals.css": "", "icon.svg": "", "x.module.css": "", "pic.png": { skipped: "binary" } }),
    { "./globals.css": "→globals.css", "./icon.svg": "→icon.svg", "./x.module.css": "→x.module.css", "./pic.png": "→pic.png", "./missing.css": "✗not_found" },
    "assets: css, svg, module css y un png binario resuelven al archivo real; el inexistente → not_found",
  );
  checkEq(await many(["@/styles/g.css"], { "styles/g.css": "" }, { tsconfig: REAL_TSCONFIG }), { "@/styles/g.css": "→styles/g.css" }, "alias a un asset (@/styles/g.css)");
  {
    const { graph } = await world({ "main.ts": 'import "./globals.css";\n', "globals.css": "" });
    check(graph.edges[0].kind === "side-effect" && graph.edges[0].resolution === "internal" && eq(graph.importedBy, [{ path: "globals.css", by: ["main.ts"] }]), "el import de un asset es una arista side-effect y el asset aparece en importedBy aunque no tenga análisis", () => JSON.stringify(graph));
    checkEq(await many(["./x.css"], { "x.css": "", "x.d.css.ts": X }), { "./x.css": "→x.d.css.ts" }, "si existe un x.d.css.ts REAL, se respeta la semántica de TS (resuelve a la declaración)");
  }

  // ---------------- Kinds ----------------
  console.log("\n--- Kinds de edge e isTypeOnly ---");
  {
    const text = [
      'import a from "./a";',
      'import "./b";',
      'const l = await import("./c");',
      'const r = require("./d");',
      'import e = require("./e");',
      'export { x } from "./f";',
      'export * from "./g";',
      'export * as ns from "./h";',
      'import type { T } from "./i";',
      'export type { U } from "./j";',
      'export type * from "./k";',
      'export { local };',
      "const local = 1;",
    ].join("\n");
    const files: Record<string, WorldFile> = { "main.ts": text };
    for (const name of "abcdefghijk") files[`${name}.ts`] = X;
    const { graph } = await world(files);
    checkEq(
      graph.edges.map((e) => `${e.source}|${e.kind}|${e.isTypeOnly ? "type" : "value"}|${e.line}`),
      ["./a|static|value|1", "./b|side-effect|value|2", "./c|dynamic|value|3", "./d|require|value|4", "./e|import-equals|value|5", "./i|static|type|9", "./f|reexport|value|6", "./g|reexport-all|value|7", "./h|reexport-all|value|8", "./j|reexport|type|10", "./k|reexport-all|type|11"],
      "los 7 kinds (static, side-effect, dynamic, require, import-equals, reexport, reexport-all) con isTypeOnly y su línea; `export { local }` NO es una dependencia; imports primero y re-exports después",
    );
  }

  // ---------------- Externos ----------------
  console.log("\n--- Externos ---");
  {
    const out = await many(["react", "next/server", "@a/b/c", "@scope/pkg"]);
    checkEq(out, { react: "ext:react", "next/server": "ext:next", "@a/b/c": "ext:@a/b", "@scope/pkg": "ext:@scope/pkg" }, "paquetes: react, next/server → next, @a/b/c → @a/b, @scope/pkg");
  }
  checkEq(await many(["node:fs", "fs/promises", "fs", "node:fs/promises"]), { "node:fs": "ext:node:fs/builtin", "fs/promises": "ext:fs/promises/builtin", fs: "ext:fs/builtin", "node:fs/promises": "ext:node:fs/promises/builtin" }, "builtins de Node (con y sin prefijo node:) → external + builtin");
  checkEq(await many(["https://cdn.example.com/x.js", "data:text/javascript,1", "bun:sqlite", "file:///x"]), { "https://cdn.example.com/x.js": "ext:https://cdn.example.com/x.js", "data:text/javascript,1": "ext:data:text/javascript,1", "bun:sqlite": "ext:bun:sqlite", "file:///x": "✗unsupported_specifier" }, "esquemas URL (https:, data:, bun:) → externos; file: → unsupported_specifier");
  checkEq(await many(["pkg", "pkg/sub"], { "node_modules/pkg/index.js": "module.exports = 1;\n" }), { pkg: "ext:pkg", "pkg/sub": "ext:pkg" }, "node_modules VERSIONADO en el repo: TS lo marca isExternalLibraryImport → external (no internal)");
  {
    const { graph } = await world({ "main.ts": 'import "node:fs";\nimport "react";\n' });
    check(graph.edges[0].resolution === "external" && graph.edges[0].package === "node:fs" && graph.edges[0].builtin === true && graph.edges[1].resolution === "external" && !("builtin" in graph.edges[1]), "el campo builtin solo existe en los builtins", () => JSON.stringify(graph.edges));
  }

  // ---------------- Unresolved y seguridad ----------------
  console.log("\n--- Unresolved y seguridad (antes de resolver) ---");
  checkEq(await many(["./missing", "./sub/missing"]), { "./missing": "✗not_found", "./sub/missing": "✗not_found" }, "relativo inexistente → not_found");
  checkEq(await many(["../x", "../../x", "../up/x"], { "x.ts": X }, {}, "a/b.ts"), { "../x": "→x.ts", "../../x": "✗escapes_workspace", "../up/x": "✗not_found" }, "desde a/b.ts: ../x llega a x.ts (la raíz), ../../x sale del workspace y ../up/x no existe");
  checkEq(await many(["../x", "../../x", "./../../y"], { "x.ts": X }, {}, "a.ts"), { "../x": "✗escapes_workspace", "../../x": "✗escapes_workspace", "./../../y": "✗escapes_workspace" }, "un relativo que sube por encima de la raíz → escapes_workspace (sin llamar a TS)");
  checkEq(await many(["/etc/x", "C:\\Windows\\x", "C:/x", "\\\\srv\\share\\x", "//cdn.example.com/x"]), { "/etc/x": "✗absolute_path", "C:\\Windows\\x": "✗absolute_path", "C:/x": "✗absolute_path", "\\\\srv\\share\\x": "✗absolute_path", "//cdn.example.com/x": "✗absolute_path" }, "rutas absolutas (POSIX, unidad de Windows, UNC, //host) → absolute_path");
  {
    const long = `./${"a".repeat(MAX_SPECIFIER_CHARS + 1)}`;
    const edges = await many(["", "a\u0000b", long]);
    checkEq(Object.values(edges), ["✗unsupported_specifier", "✗unsupported_specifier", "✗unsupported_specifier"], `vacío, con NUL y de más de ${MAX_SPECIFIER_CHARS} caracteres → unsupported_specifier`);
  }

  console.log("\n--- Destinos bloqueados y no analizados ---");
  {
    const files: Record<string, WorldFile> = {
      "link.ts": { skipped: "symlink" },
      "esc.ts": { skipped: "unsafe_path" },
      "nf.ts": { skipped: "not_file" },
      "ur.ts": { skipped: "unreadable" },
      "swapped.ts": { failed: "unsafe_path" },
      "notreg.ts": { failed: "not_regular_file" },
      "gone.ts": { failed: "changed_since_inventory" },
      "big.ts": { skipped: "too_large" },
      "pic.png": { skipped: "binary" },
    };
    const out = await many(["./link", "./esc", "./nf", "./ur", "./swapped", "./notreg", "./gone", "./big", "./pic.png"], files);
    checkEq(out, { "./link": "✗unsafe_target", "./esc": "✗unsafe_target", "./nf": "✗unsafe_target", "./ur": "✗unsafe_target", "./swapped": "✗unsafe_target", "./notreg": "✗unsafe_target", "./gone": "→gone.ts", "./big": "→big.ts", "./pic.png": "→pic.png" }, "symlink / unsafe_path / not_file / unreadable (7A) y failed:unsafe_path / not_regular_file (7B) → unsafe_target; too_large, binary y changed_since_inventory siguen siendo destinos válidos");
  }
  {
    const { graph } = await world({
      "main.ts": 'import "./big";\nimport "./style.css";\n',
      "big.ts": { skipped: "too_large" },
      "style.css": "",
    });
    checkEq(graph.importedBy, [{ path: "big.ts", by: ["main.ts"] }, { path: "style.css", by: ["main.ts"] }], "importedBy incluye destinos SIN análisis (too_large, css)");
  }
  {
    const { graph } = await world({ "main.ts": 'import "./ghost";\nimport "./later";\n', "ghost.ts": { skipped: "too_large" }, "gone.ts": { failed: "changed_since_inventory" } });
    check(sum(graph.edges[0]) === "→ghost.ts" && sum(graph.edges[1]) === "✗not_found" && graph.edges.every((e) => e.from === "main.ts"), "snapshot: lo que no está en el inventario no aparece (./later → not_found); un archivo con análisis fallido no aporta edges salientes", () => JSON.stringify(graph.edges));
  }

  // ---------------- Dedupe ----------------
  console.log("\n--- Dedupe ---");
  {
    const text = ['import "./foo";', 'import "./foo";', 'import "./foo.ts";', 'import type { A } from "./foo";', 'import { B } from "./foo";', 'const d = import("./foo");', 'export { a, b } from "./foo";', 'export { c } from "./foo";'].join("\n");
    const { graph } = await world({ "main.ts": text, "foo.ts": "export const A = 1, B = 1, a = 1, b = 1, c = 1;\n" });
    checkEq(
      graph.edges.map((e) => `${e.source}|${e.kind}|${e.isTypeOnly ? "type" : "value"}|${e.line}`),
      ["./foo|side-effect|value|1", "./foo.ts|side-effect|value|3", "./foo|static|type|4", "./foo|static|value|5", "./foo|dynamic|value|6", "./foo|reexport|value|7"],
      "dedupe por (from, source, kind, isTypeOnly) con la línea de la 1ª aparición: import repetido = 1 edge; './foo' y './foo.ts' = 2; type-only/valor y static/dynamic se separan; `export { a, b } from` + `export { c } from` = 1",
    );
  }

  // ---------------- importedBy ----------------
  console.log("\n--- importedBy ---");
  {
    const { graph } = await world({
      "a.ts": 'import "react";\nimport "./b";\nimport "./c";\nconst l = import("./c");\nimport "./style.css";\n',
      "b.ts": 'import "./c";\n',
      "c.ts": X,
      "d.ts": 'import "./c";\nimport "./missing";\n',
      "style.css": "",
    });
    checkEq(graph.importedBy, [{ path: "b.ts", by: ["a.ts"] }, { path: "c.ts", by: ["a.ts", "b.ts", "d.ts"] }, { path: "style.css", by: ["a.ts"] }], "importedBy: inverso exacto, por path, `by` único (a.ts importa c.ts dos veces) y ordenado; sin externos ni unresolved; sin entrada para archivos que nadie importa");
  }

  // ---------------- Ciclos ----------------
  console.log("\n--- Ciclos (se soportan, no se detectan) ---");
  {
    const two = await world({ "a.ts": 'import "./b";\n', "b.ts": 'import "./a";\n' });
    checkEq([two.graph.edges.map((e) => `${e.from}${sum(e)}`), two.graph.importedBy], [["a.ts→b.ts", "b.ts→a.ts"], [{ path: "a.ts", by: ["b.ts"] }, { path: "b.ts", by: ["a.ts"] }]], "ciclo A ↔ B: ambas edges e importedBy correcto, sin loop");
    const self = await world({ "a.ts": 'import "./a";\n' });
    checkEq([self.graph.edges.map((e) => `${e.from}${sum(e)}`), self.graph.importedBy], [["a.ts→a.ts"], [{ path: "a.ts", by: ["a.ts"] }]], "auto-import (A → A)");
    const three = await world({ "a.ts": 'import "./b";\n', "b.ts": 'import "./c";\n', "c.ts": 'import "./a";\n' });
    checkEq(three.graph.edges.map((e) => `${e.from}${sum(e)}`), ["a.ts→b.ts", "b.ts→c.ts", "c.ts→a.ts"], "ciclo de 3 archivos (A → B → C → A)");
    const typeOnly = await world({ "a.ts": 'import type { B } from "./b";\n', "b.ts": 'import type { A } from "./a";\n' });
    check(typeOnly.graph.edges.length === 2 && typeOnly.graph.edges.every((e) => e.isTypeOnly && e.resolution === "internal"), "ciclo type-only: las dos edges conservan isTypeOnly:true", () => JSON.stringify(typeOnly.graph.edges));
    const barrel = await world({ "a.ts": 'import "./barrel";\n', "barrel/index.ts": 'export * from "../a";\n' });
    checkEq(barrel.graph.edges.map((e) => `${e.from}|${e.kind}|${sum(e)}`), ["a.ts|side-effect|→barrel/index.ts", "barrel/index.ts|reexport-all|→a.ts"], "ciclo a través de un barrel (a → barrel/index → a)");
    const mutual = await world({ "x.ts": 'export * from "./y";\n', "y.ts": 'export * from "./x";\n' });
    checkEq(mutual.graph.edges.map((e) => `${e.from}|${e.kind}|${sum(e)}`), ["x.ts|reexport-all|→y.ts", "y.ts|reexport-all|→x.ts"], "`export *` mutuo (x ↔ y)");
    const ring: Record<string, string> = {};
    const N = 2000;
    for (let i = 0; i < N; i++) ring[`n${String(i).padStart(4, "0")}.ts`] = `import "./n${String((i + 1) % N).padStart(4, "0")}";\n`;
    const big = await world(ring);
    check(big.graph.edges.length === N && big.graph.edges.every((e) => e.resolution === "internal") && big.graph.importedBy.length === N, `anillo de ${N} archivos: sin stack overflow ni loop (nada recorre el grafo)`, () => JSON.stringify(big.graph.stats));
  }

  // ---------------- Determinismo, stats y contrato ----------------
  console.log("\n--- Determinismo, stats y contrato ---");
  {
    const files: Record<string, WorldFile> = {
      "b.ts": 'import "./a";\nimport "react";\nconst d = import("./c");\n',
      "a.ts": 'import "@/c";\nexport * from "./b";\nimport "node:fs";\nimport "./nope";\n',
      "c.ts": X,
      "z/y.tsx": 'import "../a";\nimport "./g.css";\n',
      "z/g.css": "",
    };
    const normal = await world(files, { tsconfig: REAL_TSCONFIG });
    const shuffled = await world(files, { tsconfig: REAL_TSCONFIG, shuffle: true });
    const again = await world(files, { tsconfig: REAL_TSCONFIG });
    check(JSON.stringify(normal.graph) === JSON.stringify(shuffled.graph) && JSON.stringify(normal.graph) === JSON.stringify(again.graph), "determinismo: mismo grafo (JSON idéntico) con el orden de entrada invertido y en una segunda corrida", () => `${JSON.stringify(normal.graph.edges.map((e) => e.from))}\n   ${JSON.stringify(shuffled.graph.edges.map((e) => e.from))}`);
    const g = normal.graph;
    check(g.edges.map((e) => e.from).join() === [...g.edges.map((e) => e.from)].sort().join() && g.stats.edges === g.edges.length && g.stats.edges === g.stats.internal + g.stats.external + g.stats.unresolved && g.stats.internal === 6 && g.stats.external === 2 && g.stats.unresolved === 1, "edges ordenados por `from`; stats coherentes (edges = internal + external + unresolved)", () => JSON.stringify(g.stats));
    checkEq(g.config, { file: "tsconfig.json", baseUrl: ".", aliases: [{ pattern: "@/*", targets: ["./*"] }], warnings: [] }, "graph.config resume la configuración usada (archivo, baseUrl, aliases, warnings)");
    const d = await world({ "a.ts": X });
    checkEq(d.graph.config, { file: null, aliases: [], warnings: [] }, "sin config: file:null, aliases vacíos y sin baseUrl");
    check(d.graph.truncated === false && d.graph.stats.dynamicNonLiteral === 0, "sin recorte ni dinámicos no literales por defecto", () => JSON.stringify(d.graph.stats));
  }
  {
    const { graph } = await world({ "a.ts": "const a = await import(x);\nconst b = require(y);\n", "b.ts": "const c = import(`./${z}`);\nexport {};\n" });
    check(graph.stats.dynamicNonLiteral === 3 && graph.edges.length === 0, "dynamicNonLiteral se acumula entre archivos y no genera edges", () => JSON.stringify(graph.stats));
  }

  // ---------------- Límites y cancelación ----------------
  console.log("\n--- Límites y cancelación ---");
  check(MAX_GRAPH_EDGES === 100_000, "MAX_GRAPH_EDGES = 100.000", () => String(MAX_GRAPH_EDGES));
  {
    const files: Record<string, WorldFile> = { "a.ts": 'import "./b";\nimport "react";\n', "b.ts": 'import "./c";\nimport "vue";\nimport "svelte";\n', "c.ts": "const a = import(x);\nimport \"x\";\n" };
    const cut = await world(files, { maxEdges: 3 });
    const cutAgain = await world(files, { maxEdges: 3 });
    check(cut.graph.truncated === true && cut.graph.edges.length === 3 && cut.graph.stats.edges === 3 && cut.graph.stats.internal + cut.graph.stats.external + cut.graph.stats.unresolved === 3 && eq(cut.graph.edges.map((e) => `${e.from} ${sum(e)}`), ["a.ts →b.ts", "a.ts ext:react", "b.ts →c.ts"]) && cut.graph.stats.dynamicNonLiteral === 0 && JSON.stringify(cut.graph) === JSON.stringify(cutAgain.graph), "tope de edges: se corta de forma determinista (3 edges), truncated:true, stats reflejan lo producido y no cuentan archivos no visitados", () => JSON.stringify(cut.graph));
    const exact = await world(files, { maxEdges: 6 });
    check(exact.graph.truncated === false && exact.graph.edges.length === 6, "con exactamente el tope de edges disponible NO se marca truncated", () => JSON.stringify(exact.graph.stats));
  }
  {
    const controller = new AbortController();
    controller.abort();
    const err = await world({ "a.ts": X }, { signal: controller.signal }).then(() => null, (e) => e);
    check(err instanceof DependencyGraphError, "signal ya abortado → DependencyGraphError (no un grafo)", () => String(err));
    const many450: Record<string, string> = {};
    for (let i = 0; i < 450; i++) many450[`f${String(i).padStart(3, "0")}.ts`] = 'import "react";\n';
    const mid = new AbortController();
    const pending = world(many450, { signal: mid.signal }).then(() => null, (e) => e);
    mid.abort(); // el constructor cede el event loop cada ~200 archivos y ahí ve la cancelación
    const err2 = await pending;
    check(err2 instanceof DependencyGraphError, "cancelación durante la construcción (450 archivos) → DependencyGraphError", () => String(err2));
  }

  console.log(`\n${results.filter(Boolean).length}/${results.length} casos OK.`);
  if (results.some((r) => !r)) process.exit(1);
}

main().catch((error) => {
  console.error("Error inesperado en la prueba:", error);
  process.exit(1);
});
