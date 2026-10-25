/**
 * Fixtures SOLO para los tests de Fase 8 (no se importa desde la app).
 * Construye snapshots sintéticos con la forma exacta de `RepoMapSnapshotData`
 * para probar el selector y el motor sin tocar disco, git ni TypeScript.
 */
import type { RepoMapSnapshotData } from "../repo-map-views";
import type { DependencyEdge, DependencyGraph } from "../dependency-graph";
import type { FileAnalysis } from "../repo-symbols";
import type { FrameworkInfo, InventoryFile, InventoryLanguage } from "../repo-inventory";

export type FixtureFile = {
  path: string;
  symbols?: Array<{ name: string; exported?: boolean }>;
  role?: "route" | "page" | "layout";
  skipped?: InventoryFile["skipped"];
};

function languageOf(relPath: string): InventoryLanguage {
  const lower = relPath.toLowerCase();
  if (lower.endsWith(".tsx")) return "tsx";
  if (lower.endsWith(".jsx")) return "jsx";
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return "javascript";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".md")) return "markdown";
  if (lower.endsWith(".css")) return "css";
  if (lower.endsWith(".html")) return "html";
  if (lower.endsWith(".yml") || lower.endsWith(".yaml")) return "yaml";
  if (lower.endsWith(".sh")) return "shell";
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".sql")) return "sql";
  return "typescript";
}

function analysisOf(file: FixtureFile): FileAnalysis | null {
  const language = languageOf(file.path);
  if (!["typescript", "tsx", "javascript", "jsx"].includes(language)) return null;
  return {
    path: file.path,
    language: language as FileAnalysis["language"],
    parse: { status: "ok" },
    imports: [],
    exports: [],
    symbols: (file.symbols ?? []).map((symbol) => ({
      name: symbol.name,
      kind: "function" as const,
      line: 1,
      exported: symbol.exported === true,
    })),
    ...(file.role ? { next: { router: "app" as const, role: file.role } } : {}),
  };
}

export type SnapshotOptions = {
  truncated?: boolean;
  graphTruncated?: boolean;
  frameworks?: FrameworkInfo[];
};

/** `edges` son pares `[from, to]` internos: `from` importa a `to`. */
export function makeSnapshot(files: readonly FixtureFile[], edges: readonly (readonly [string, string])[] = [], options: SnapshotOptions = {}): RepoMapSnapshotData {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const inventoryFiles: InventoryFile[] = sorted.map((file) => ({
    path: file.path,
    extension: file.path.includes(".") ? file.path.slice(file.path.lastIndexOf(".")).toLowerCase() : "",
    language: languageOf(file.path),
    size: 10,
    tracked: true,
    ...(file.skipped ? { skipped: file.skipped } : {}),
  }));
  const analyses = sorted.map(analysisOf).filter((analysis): analysis is FileAnalysis => analysis !== null);
  const dependencyEdges: DependencyEdge[] = edges.map(([from, to]) => ({
    from,
    source: `./${to}`,
    kind: "static",
    isTypeOnly: false,
    line: 1,
    resolution: "internal",
    to,
  }));
  const importedBy = new Map<string, string[]>();
  for (const [from, to] of edges) {
    const list = importedBy.get(to);
    if (list) {
      if (!list.includes(from)) list.push(from);
    } else importedBy.set(to, [from]);
  }
  const graph: DependencyGraph = {
    edges: dependencyEdges,
    importedBy: [...importedBy.entries()]
      .map(([path, by]) => ({ path, by: [...by].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)) }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    config: { file: null, aliases: [], warnings: [] },
    stats: {
      edges: dependencyEdges.length,
      internal: dependencyEdges.length,
      external: 0,
      unresolved: 0,
      dynamicNonLiteral: 0,
    },
    truncated: options.graphTruncated === true,
  };
  return {
    inventory: {
      files: inventoryFiles,
      package: null,
      frameworks: options.frameworks ?? [],
      truncated: options.truncated === true,
      stats: {
        files: inventoryFiles.length,
        analyzable: inventoryFiles.filter((file) => !file.skipped).length,
        skipped: inventoryFiles.filter((file) => file.skipped).length,
        deletedInWorktree: 0,
      },
    },
    analysis: { files: analyses },
    graph,
  };
}
