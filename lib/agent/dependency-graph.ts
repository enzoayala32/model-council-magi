/**
 * Fase 7C — Dependency Graph: de `import "./foo"` a una relación entre
 * archivos REALES del repositorio.
 *
 * Es una función determinista de `inventory (7A) + analysis (7B) + config`.
 * Una vez cargada la config, TODO es puro y en memoria:
 * - La resolución usa `ts.resolveModuleName` (no hay resolver propio) con un
 *   host VIRTUAL: raíz `/ws`, y "filesystem" = el inventario. No puede leer
 *   el disco real ni salirse del workspace por construcción.
 * - No vuelve a recorrer Git ni a descubrir archivos; un cambio posterior
 *   del filesystem no altera el resultado (snapshot coherente: staleness es
 *   problema de 7D).
 *
 * Es FACTUAL: no decide qué archivos son importantes (Fase 8), no detecta
 * ciclos (los soporta: cada arista se resuelve de forma independiente y
 * `importedBy` es solo inserción en un conjunto) y no guarda cache.
 *
 * Assets (css, svg, png…): TS no resuelve `./x.css`, pero con
 * `allowArbitraryExtensions` sí resuelve `./x.d.css.ts`. El host responde que
 * `x.d.css.ts` existe cuando el inventario tiene `x.css` (solo existencia: el
 * asset nunca se lee) y el nombre virtual se mapea de vuelta a `x.css`.
 */
import { builtinModules } from "node:module";
import ts from "typescript";
import { isSyntacticallySafe, type RepoInventory } from "./repo-inventory";
import type { RepoAnalysis } from "./repo-analysis";
import type { FileAnalysis } from "./repo-symbols";
import { VIRTUAL_ROOT, type ResolutionConfig } from "./resolution-config";

export const MAX_GRAPH_EDGES = 100_000;
export const MAX_SPECIFIER_CHARS = 1024;
/** Cada cuántos archivos se cede el event loop (y se revisa el `signal`). */
const YIELD_EVERY_FILES = 200;

export type EdgeKind = "static" | "side-effect" | "dynamic" | "require" | "import-equals" | "reexport" | "reexport-all";

export type UnresolvedReason = "not_found" | "alias_target_missing" | "unmapped_alias" | "escapes_workspace" | "absolute_path" | "unsafe_target" | "unsupported_specifier";

export type DependencyEdge = {
  from: string;
  /** Specifier crudo, tal como aparece en el código. */
  source: string;
  kind: EdgeKind;
  isTypeOnly: boolean;
  /** Línea de la PRIMERA aparición (las repeticiones se deduplican). */
  line: number;
} & (
  | { resolution: "internal"; to: string }
  | { resolution: "external"; package: string; builtin?: true }
  | { resolution: "unresolved"; reason: UnresolvedReason }
);

export type DependencyGraph = {
  /** Por `from` (path), luego imports y después re-exports, en el orden de 7B. */
  edges: DependencyEdge[];
  /** Solo destinos de edges internos; `by` único y ordenado. Puede incluir archivos sin análisis (css, too_large…). */
  importedBy: { path: string; by: string[] }[];
  config: {
    file: "tsconfig.json" | "jsconfig.json" | null;
    baseUrl?: string;
    aliases: { pattern: string; targets: string[] }[];
    warnings: string[];
  };
  stats: { edges: number; internal: number; external: number; unresolved: number; dynamicNonLiteral: number };
  /** `true` si se alcanzó el tope de edges (el recorte es determinista). */
  truncated: boolean;
};

export type DependencyGraphOptions = {
  signal?: AbortSignal;
  /** Tope de edges (default `MAX_GRAPH_EDGES`); parametrizable para poder testear el recorte con pocos datos. */
  maxEdges?: number;
};

export class DependencyGraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DependencyGraphError";
  }
}

type Resolution = { resolution: "internal"; to: string } | { resolution: "external"; package: string; builtin?: true } | { resolution: "unresolved"; reason: UnresolvedReason };

const NODE_BUILTINS = new Set(builtinModules);
/** Destinos que 7A marcó como no seguros / no regulares: un import que resuelve ahí es `unsafe_target`. */
const BLOCKING_SKIPS = new Set(["symlink", "unsafe_path", "submodule", "not_file", "unreadable"]);
const KNOWN_CODE_EXTENSIONS = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "json"]);
/** `foo.d.css.ts` → asset virtual `foo.css`. */
const ARBITRARY_EXTENSION = /^(.*)\.d\.([^./]+)\.ts$/;
const URL_SCHEME = /^([A-Za-z][A-Za-z0-9+.-]+):/;
const PACKAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/;
const PACKAGE_SCOPE = /^@[A-Za-z0-9][A-Za-z0-9._~-]*$/;

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `react` → react, `next/server` → next, `@a/b/c` → @a/b. `null` si no puede ser un paquete npm (`@/x`, `~/x`). */
function packageNameOf(specifier: string): string | null {
  const segments = specifier.split("/");
  if (specifier.startsWith("@")) {
    if (segments.length < 2 || !PACKAGE_SCOPE.test(segments[0]) || !PACKAGE_NAME.test(segments[1])) return null;
    return `${segments[0]}/${segments[1]}`;
  }
  return PACKAGE_NAME.test(segments[0]) ? segments[0] : null;
}

function isRelativeSpecifier(specifier: string): boolean {
  return specifier === "." || specifier === ".." || specifier.startsWith("./") || specifier.startsWith("../");
}

function isNodeBuiltin(specifier: string): boolean {
  return NODE_BUILTINS.has(specifier) || NODE_BUILTINS.has(specifier.split("/")[0]);
}

/** ¿El specifier coincide con un patrón de `paths` que NO sea el comodín `*` suelto? (solo para el MOTIVO de un unresolved; no resuelve nada). */
function matchesAliasPattern(specifier: string, aliases: ResolutionConfig["aliases"]): boolean {
  for (const { pattern } of aliases) {
    if (pattern === "*") continue;
    const star = pattern.indexOf("*");
    if (star === -1) {
      if (specifier === pattern) return true;
      continue;
    }
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (specifier.length >= prefix.length + suffix.length && specifier.startsWith(prefix) && specifier.endsWith(suffix)) return true;
  }
  return false;
}

type EdgeSeed = { source: string; kind: EdgeKind; isTypeOnly: boolean; line: number };

/** Imports y después re-exports CON `source`, en el orden de 7B. `export { x }` (sin source) no es una dependencia de archivo. */
function edgeSeeds(file: FileAnalysis): EdgeSeed[] {
  const seeds: EdgeSeed[] = file.imports.map((entry) => ({ source: entry.source, kind: entry.kind, isTypeOnly: entry.isTypeOnly, line: entry.line }));
  for (const entry of file.exports) {
    if (entry.source === undefined) continue;
    seeds.push({ source: entry.source, kind: entry.kind === "reexport" ? "reexport" : "reexport-all", isTypeOnly: entry.isTypeOnly, line: entry.line });
  }
  return seeds;
}

/** Construye el resolver: host virtual a partir del inventario + `ts.resolveModuleName`. */
function createResolver(inventory: Pick<RepoInventory, "files">, analysisFiles: readonly FileAnalysis[], config: ResolutionConfig) {
  const fileSet = new Set<string>();
  const dirSet = new Set<string>([VIRTUAL_ROOT]);
  const blocked = new Set<string>();

  for (const file of inventory.files) {
    // Un path que no es sintácticamente seguro (`..`, absoluto…) jamás entra al host virtual.
    if (!isSyntacticallySafe(file.path)) continue;
    const virtual = `${VIRTUAL_ROOT}/${file.path}`;
    fileSet.add(virtual);
    const segments = file.path.split("/");
    for (let i = 1; i < segments.length; i++) dirSet.add(`${VIRTUAL_ROOT}/${segments.slice(0, i).join("/")}`);
    if (file.skipped && BLOCKING_SKIPS.has(file.skipped.reason)) blocked.add(virtual);
  }
  for (const analysis of analysisFiles) {
    if (analysis.parse.status === "failed" && (analysis.parse.code === "unsafe_path" || analysis.parse.code === "not_regular_file")) blocked.add(`${VIRTUAL_ROOT}/${analysis.path}`);
  }

  /** `foo.d.css.ts` existe (virtual) si el inventario tiene `foo.css`; solo para extensiones que no son de código. */
  const virtualAsset = (p: string): string | null => {
    const match = ARBITRARY_EXTENSION.exec(p);
    if (!match || KNOWN_CODE_EXTENSIONS.has(match[2])) return null;
    const asset = `${match[1]}.${match[2]}`;
    return fileSet.has(asset) ? asset : null;
  };
  const host: ts.ModuleResolutionHost = {
    fileExists: (p) => fileSet.has(p) || virtualAsset(p) !== null,
    directoryExists: (p) => dirSet.has(p),
    readFile: () => undefined, // jamás se interpreta package.json
    getCurrentDirectory: () => VIRTUAL_ROOT,
    useCaseSensitiveFileNames: true,
  };
  const options = config.compilerOptions;
  const cache = ts.createModuleResolutionCache(VIRTUAL_ROOT, (name) => name, options);

  const fromTypeScript = (specifier: string, from: string): Resolution | null => {
    let resolved: ts.ResolvedModuleFull | undefined;
    try {
      resolved = ts.resolveModuleName(specifier, `${VIRTUAL_ROOT}/${from}`, options, host, cache).resolvedModule;
    } catch {
      return { resolution: "unresolved", reason: "unsupported_specifier" };
    }
    if (!resolved) return null;
    if (resolved.isExternalLibraryImport) return { resolution: "external", package: packageNameOf(specifier) ?? specifier };
    const real = fileSet.has(resolved.resolvedFileName) ? resolved.resolvedFileName : (virtualAsset(resolved.resolvedFileName) ?? resolved.resolvedFileName);
    // Defensa en profundidad: el resultado TIENE que colgar de la raíz virtual.
    if (!real.startsWith(`${VIRTUAL_ROOT}/`)) return { resolution: "unresolved", reason: "escapes_workspace" };
    if (blocked.has(real)) return { resolution: "unresolved", reason: "unsafe_target" };
    return { resolution: "internal", to: real.slice(VIRTUAL_ROOT.length + 1) };
  };

  return function resolve(specifier: string, from: string): Resolution {
    const unresolved = (reason: UnresolvedReason): Resolution => ({ resolution: "unresolved", reason });
    // 1) Antes de resolver: nada raro entra al resolver.
    if (specifier.length === 0 || specifier.length > MAX_SPECIFIER_CHARS || specifier.includes("\0")) return unresolved("unsupported_specifier");
    if (specifier.startsWith("/") || specifier.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(specifier)) return unresolved("absolute_path");
    if (specifier.startsWith("#")) return unresolved("unsupported_specifier");
    const scheme = URL_SCHEME.exec(specifier);
    if (scheme) {
      if (scheme[1] === "node") return { resolution: "external", package: specifier, builtin: true };
      if (scheme[1] === "file") return unresolved("unsupported_specifier");
      return { resolution: "external", package: specifier };
    }

    // 2) Relativos: detectar escapes del workspace antes de llamar a TS.
    if (isRelativeSpecifier(specifier)) {
      const base = from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : ".";
      const joined = normalizePosix(`${base}/${specifier}`);
      if (joined === ".." || joined.startsWith("../")) return unresolved("escapes_workspace");
      return fromTypeScript(specifier, from) ?? unresolved("not_found");
    }

    // 3) Bare: aliases / baseUrl vía TS; si no resuelve, ¿paquete, builtin o alias roto?
    const viaTypeScript = fromTypeScript(specifier, from);
    if (viaTypeScript) return viaTypeScript;
    if (isNodeBuiltin(specifier)) return { resolution: "external", package: specifier, builtin: true };
    if (matchesAliasPattern(specifier, config.aliases)) return unresolved("alias_target_missing");
    const pkg = packageNameOf(specifier);
    if (pkg === null) return unresolved("unmapped_alias");
    return { resolution: "external", package: pkg };
  };
}

/** Normalización POSIX mínima de `a/b/../c` (sin tocar el disco ni depender de la plataforma). */
function normalizePosix(p: string): string {
  const out: string[] = [];
  for (const segment of p.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else out.push("..");
    } else out.push(segment);
  }
  return out.length === 0 ? "." : out.join("/");
}

/**
 * Construye el grafo de dependencias. Async solo para ceder el event loop
 * cada ~200 archivos y respetar `signal`: la resolución en sí es CPU en
 * memoria. Una cancelación lanza `DependencyGraphError` (nunca devuelve un
 * grafo parcial como si estuviera completo).
 */
export async function buildDependencyGraph(inventory: Pick<RepoInventory, "files">, analysis: Pick<RepoAnalysis, "files">, config: ResolutionConfig, options: DependencyGraphOptions = {}): Promise<DependencyGraph> {
  const { signal } = options;
  const maxEdges = options.maxEdges ?? MAX_GRAPH_EDGES;
  const cancelled = () => new DependencyGraphError("La construcción del grafo de dependencias fue cancelada.");
  if (signal?.aborted) throw cancelled();

  const files = [...analysis.files].sort((a, b) => compareCodeUnits(a.path, b.path));
  const resolve = createResolver(inventory, files, config);
  const edges: DependencyEdge[] = [];
  const importers = new Map<string, Set<string>>();
  const counts = { internal: 0, external: 0, unresolved: 0 };
  let dynamicNonLiteral = 0;
  let truncated = false;

  outer: for (let index = 0; index < files.length; index++) {
    if (index > 0 && index % YIELD_EVERY_FILES === 0) {
      await new Promise<void>((resolveTick) => setImmediate(resolveTick));
      if (signal?.aborted) throw cancelled();
    }
    const file = files[index];
    dynamicNonLiteral += file.dynamicNonLiteral ?? 0;
    const seen = new Set<string>();
    for (const seed of edgeSeeds(file)) {
      // Dedupe: (from, source, kind, isTypeOnly), con la línea de la primera aparición.
      const key = `${seed.source}\0${seed.kind}\0${seed.isTypeOnly}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (edges.length >= maxEdges) {
        truncated = true;
        break outer;
      }
      const resolution = resolve(seed.source, file.path);
      edges.push({ from: file.path, source: seed.source, kind: seed.kind, isTypeOnly: seed.isTypeOnly, line: seed.line, ...resolution });
      counts[resolution.resolution] += 1;
      if (resolution.resolution === "internal") {
        let by = importers.get(resolution.to);
        if (!by) importers.set(resolution.to, (by = new Set()));
        by.add(file.path);
      }
    }
  }
  if (signal?.aborted) throw cancelled();

  const importedBy = [...importers.entries()].sort(([a], [b]) => compareCodeUnits(a, b)).map(([path, by]) => ({ path, by: [...by].sort(compareCodeUnits) }));
  return {
    edges,
    importedBy,
    config: {
      file: config.file,
      ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
      aliases: config.aliases.map((alias) => ({ pattern: alias.pattern, targets: [...alias.targets] })),
      warnings: [...config.warnings],
    },
    stats: { edges: edges.length, ...counts, dynamicNonLiteral },
    truncated,
  };
}
