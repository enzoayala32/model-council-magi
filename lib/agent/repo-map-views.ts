/**
 * Fase 7D — Proyecciones PURAS del Repository Map: `snapshot + consulta →
 * resultado`. Sin filesystem, sin Git, sin TypeScript, sin estado: dos
 * llamadas con los mismos datos devuelven JSON idéntico.
 *
 * Factual y determinista: todo se ordena por ruta (unidades de código),
 * sin timestamps ni ranking de "importancia". Elegir qué archivos le
 * importan al modelo es Fase 8.
 *
 * Presupuesto de salida: el resultado serializado (metadatos, truncamiento y
 * paginación incluidos) NUNCA supera `maxChars`; se verifica sobre el JSON
 * final. Si no cabe ni la entrada más recortada, el resultado es un error
 * explícito (`output_too_large`), nunca una salida a medias presentada como
 * completa.
 */
import { z } from "zod";
import type { InventoryFile, InventoryLanguage, RepoInventory, SkipReason } from "./repo-inventory";
import type { RepoAnalysis } from "./repo-analysis";
import type { FileAnalysis, SymbolKind } from "./repo-symbols";
import type { DependencyEdge, DependencyGraph, UnresolvedReason } from "./dependency-graph";
import type { HttpMethod } from "./next-roles";
import { redactSecrets } from "../provider-resilience/redact";

/** Límites del tool. Viven acá (módulo liviano) para que `tools.ts` arme su política sin cargar el service. */
export const REPO_MAP_LIMITS = {
  /** Presupuesto interno de salida del resultado serializado. */
  maxOutputChars: 24_000,
  /** Piso del presupuesto configurable: con menos no entra ni el envelope. */
  minOutputChars: 2_000,
  /** Límite defensivo de la política del tool (siempre >> presupuesto interno). */
  policyMaxOutputChars: 100_000,
  /** Timeout interno de la reconstrucción (aborta el trabajo real). */
  buildTimeoutMs: 60_000,
  /** Timeout de la política del tool (siempre > timeout interno). */
  policyTimeoutMs: 90_000,
  /** Espera máxima a que terminen mutaciones de archivo en vuelo. */
  quiesceTimeoutMs: 2_000,
  /** Intentos máximos para resolver carreras con mutaciones. */
  maxAttempts: 3,
} as const;

const MAX_PATH_INPUT_CHARS = 1024;
const IMPORTED_BY_CAP = 25;
const DIAGNOSTIC_ITEMS_CAP = 3;
const SCRIPT_COMMAND_MAX_CHARS = 200;
const WARNING_MAX_CHARS = 300;
const ALIAS_TARGETS_CAP = 5;
const OVERVIEW_CAPS = { scripts: 15, dependencies: 40, devDependencies: 40, aliases: 20, warnings: 5, structure: 40, routes: 40, externalPackages: 40, unresolvedEdges: 15 } as const;
/** Escala de topes del overview cuando no entra en el presupuesto (se prueba en este orden). */
const OVERVIEW_SCALES = [1, 0.5, 0.25, 0] as const;

export const REPO_MAP_DETAILS = ["overview", "files", "symbols"] as const;
export type RepoMapDetail = (typeof REPO_MAP_DETAILS)[number];

export const repoMapInputSchema = z.object({
  detail: z.enum(REPO_MAP_DETAILS).optional().describe("overview (por defecto): resumen del proyecto. files: archivos con conteos de relaciones. symbols: símbolos, exports e imports por archivo."),
  subPath: z.string().optional().describe("Limita la consulta a un archivo o carpeta (ruta relativa al proyecto)."),
  after: z.string().optional().describe("Continuar una respuesta truncada: devuelve solo archivos con ruta posterior a esta (usá budget.nextAfter)."),
});
export type RepoMapInput = z.infer<typeof repoMapInputSchema>;

export type RepoMapErrorCode = "invalid_input" | "path_not_in_map" | "unsafe_path" | "unsupported_workspace" | "busy" | "unstable" | "build_failed" | "build_timeout" | "cancelled" | "output_too_large";
/** Superset del `{ ok, error }` de los demás tools. */
export type RepoMapError = { ok: false; error: string; code: RepoMapErrorCode };

export function repoMapError(code: RepoMapErrorCode, error: string): RepoMapError {
  return { ok: false, error, code };
}

/** Lista acotada: nunca se recorta en silencio, `omitted` dice cuántos quedaron afuera. */
export type Capped<T> = { items: T[]; omitted: number };
export type RepoMapScope = { subPath: string | null; files: number };
export type RepoMapBudget = { maxChars: number; truncated: boolean; omitted?: number; nextAfter?: string };

export type RepoMapRole = { role: "route" | "page" | "layout"; methods?: HttpMethod[]; partial?: true };

export type RepoMapOverview = {
  ok: true;
  detail: "overview";
  scope: RepoMapScope;
  budget: RepoMapBudget;
  workspace: {
    files: number;
    analyzed: number;
    inventoryTruncated: boolean;
    languages: { language: InventoryLanguage; files: number }[];
    skipped: { reason: SkipReason; files: number }[];
    analysisIssues: { withDiagnostics: number; failed: number };
  };
  project: {
    name: string | null;
    frameworks: { name: string; version: string | null }[];
    scripts: Capped<{ name: string; command: string }>;
    dependencies: Capped<string>;
    devDependencies: Capped<string>;
  } | null;
  resolution: { file: "tsconfig.json" | "jsconfig.json" | null; baseUrl?: string; aliases: Capped<{ pattern: string; targets: string[] }>; warnings: Capped<string> };
  structure: Capped<{ directory: string; files: number }>;
  next?: { routes: Capped<{ path: string; methods: HttpMethod[]; partial?: true }>; pages: number; layouts: number };
  graph: {
    edges: number;
    internal: number;
    external: number;
    unresolved: number;
    dynamicNonLiteral: number;
    truncated: boolean;
    externalPackages: Capped<string>;
    unresolvedEdges: Capped<{ from: string; source: string; reason: UnresolvedReason }>;
  };
};

export type RepoMapFileEntry = {
  path: string;
  language: InventoryLanguage;
  size: number | null;
  tracked?: false;
  skipped?: SkipReason;
  parse?: "diagnostics" | "failed";
  role?: RepoMapRole;
  exports?: number;
  symbols?: number;
  /** Conteos de aristas (dependencias distintas), sin ceros. */
  imports?: { internal?: number; external?: number; unresolved?: number };
  importedBy?: number;
};
export type RepoMapFiles = { ok: true; detail: "files"; scope: RepoMapScope; budget: RepoMapBudget; files: RepoMapFileEntry[] };

export type RepoMapSymbolEntry = {
  path: string;
  role?: RepoMapRole;
  parseIssue?: { status: "diagnostics"; count: number; items: { line: number; message: string }[] } | { status: "failed"; code: string };
  symbols: {
    name: string;
    kind: SymbolKind;
    line: number;
    exported?: true;
    overloads?: number;
    members?: { name: string; kind: string; line: number; static?: true; visibility?: string }[];
  }[];
  reexports?: { name: string; source: string; importedName?: string; typeOnly?: true; all?: true }[];
  imports?: { internal?: string[]; external?: string[]; unresolved?: { source: string; reason: UnresolvedReason }[] };
  importedBy?: { paths: string[]; omitted?: number };
  /** Qué se recortó DENTRO de la entrada para que entre (escalera determinista). */
  trimmed?: string[];
};
export type RepoMapSymbols = { ok: true; detail: "symbols"; scope: RepoMapScope; budget: RepoMapBudget; files: RepoMapSymbolEntry[] };

export type RepoMapResult = RepoMapOverview | RepoMapFiles | RepoMapSymbols | RepoMapError;

/** Datos que proyectan las vistas: el resultado de 7A + 7B + 7C. */
export type RepoMapSnapshotData = {
  inventory: RepoInventory;
  analysis: Pick<RepoAnalysis, "files">;
  graph: DependencyGraph;
};

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const jsonLength = (value: unknown): number => JSON.stringify(value).length;

/**
 * Normaliza `subPath` / `after`: separadores `/`, sin `./` ni `//` ni `/` final.
 * `null` = "todo el repositorio". `strict` (solo `subPath`) además rechaza rutas
 * absolutas y `..`; el cursor `after` es solo una cadena a comparar.
 */
export function normalizeRelativeInput(raw: string | undefined, label: "subPath" | "after", strict: boolean): { ok: true; value: string | null } | RepoMapError {
  if (raw === undefined) return { ok: true, value: null };
  if (raw.includes("\0")) return repoMapError("invalid_input", `${label} contiene un carácter nulo.`);
  if (raw.length > MAX_PATH_INPUT_CHARS) return repoMapError("invalid_input", `${label} es demasiado largo (máximo ${MAX_PATH_INPUT_CHARS} caracteres).`);
  const slashed = raw.replace(/\\/g, "/");
  if (strict && (slashed.startsWith("/") || /^[A-Za-z]:\//.test(slashed))) return repoMapError("unsafe_path", `${label} tiene que ser una ruta relativa al proyecto.`);
  const segments = slashed.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (strict && segments.includes("..")) return repoMapError("unsafe_path", `${label} no puede salir del proyecto ('..').`);
  return { ok: true, value: segments.length === 0 ? null : segments.join("/") };
}

/** Coincidencia por SEGMENTO: `src` abarca `src/x.ts` pero no `src2/x.ts`. */
function inScope(filePath: string, subPath: string | null): boolean {
  return subPath === null || filePath === subPath || filePath.startsWith(`${subPath}/`);
}

type Index = {
  files: InventoryFile[];
  analyses: FileAnalysis[];
  analysisByPath: Map<string, FileAnalysis>;
  edgesByFrom: Map<string, DependencyEdge[]>;
  importedByPath: Map<string, string[]>;
};

function buildIndex(data: RepoMapSnapshotData): Index {
  const files = [...data.inventory.files].sort((a, b) => compareCodeUnits(a.path, b.path));
  const analyses = [...data.analysis.files].sort((a, b) => compareCodeUnits(a.path, b.path));
  const edgesByFrom = new Map<string, DependencyEdge[]>();
  for (const edge of data.graph.edges) {
    const list = edgesByFrom.get(edge.from);
    if (list) list.push(edge);
    else edgesByFrom.set(edge.from, [edge]);
  }
  return {
    files,
    analyses,
    analysisByPath: new Map(analyses.map((analysis) => [analysis.path, analysis])),
    edgesByFrom,
    importedByPath: new Map(data.graph.importedBy.map((entry) => [entry.path, [...entry.by].sort(compareCodeUnits)])),
  };
}

function capped<T>(all: T[], limit: number): Capped<T> {
  return { items: all.slice(0, limit), omitted: Math.max(0, all.length - limit) };
}

function roleOf(analysis: FileAnalysis | undefined): RepoMapRole | undefined {
  const next = analysis?.next;
  if (!next) return undefined;
  const role: RepoMapRole = { role: next.role };
  if (next.httpMethods) role.methods = [...next.httpMethods];
  if (next.httpMethodsPartial) role.partial = true;
  return role;
}

// ---------------------------------------------------------------- overview

function buildOverview(data: RepoMapSnapshotData, index: Index, subPath: string | null, scale: number, maxChars: number): RepoMapOverview {
  const cap = (limit: number) => Math.floor(limit * scale);
  const scopedFiles = index.files.filter((file) => inScope(file.path, subPath));
  const scopedAnalyses = index.analyses.filter((analysis) => inScope(analysis.path, subPath));

  const languageCounts = new Map<InventoryLanguage, number>();
  const skippedCounts = new Map<SkipReason, number>();
  for (const file of scopedFiles) {
    languageCounts.set(file.language, (languageCounts.get(file.language) ?? 0) + 1);
    if (file.skipped) skippedCounts.set(file.skipped.reason, (skippedCounts.get(file.skipped.reason) ?? 0) + 1);
  }

  const pkg = data.inventory.package;
  const frameworks = data.inventory.frameworks.map((framework) => ({ name: framework.name as string, version: framework.version }));
  const project: RepoMapOverview["project"] =
    pkg === null && frameworks.length === 0
      ? null
      : {
          name: pkg?.name ?? null,
          frameworks,
          scripts: capped(
            Object.entries(pkg?.scripts ?? {})
              .sort(([a], [b]) => compareCodeUnits(a, b))
              .map(([name, command]) => ({ name, command: redactSecrets(command).slice(0, SCRIPT_COMMAND_MAX_CHARS) })),
            cap(OVERVIEW_CAPS.scripts),
          ),
          dependencies: capped(Object.keys(pkg?.dependencies ?? {}).sort(compareCodeUnits), cap(OVERVIEW_CAPS.dependencies)),
          devDependencies: capped(Object.keys(pkg?.devDependencies ?? {}).sort(compareCodeUnits), cap(OVERVIEW_CAPS.devDependencies)),
        };

  const config = data.graph.config;
  const resolution: RepoMapOverview["resolution"] = {
    file: config.file,
    ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
    aliases: capped(
      config.aliases.map((alias) => ({ pattern: alias.pattern, targets: alias.targets.slice(0, ALIAS_TARGETS_CAP) })),
      cap(OVERVIEW_CAPS.aliases),
    ),
    warnings: capped(
      config.warnings.map((warning) => warning.slice(0, WARNING_MAX_CHARS)),
      cap(OVERVIEW_CAPS.warnings),
    ),
  };

  // Estructura: directorios hasta 2 niveles por debajo del scope.
  const isDirectoryScope = subPath !== null && index.files.some((file) => file.path.startsWith(`${subPath}/`));
  const baseParts = subPath === null ? [] : isDirectoryScope ? subPath.split("/") : subPath.split("/").slice(0, -1);
  const directoryCounts = new Map<string, number>();
  for (const file of scopedFiles) {
    const dirParts = file.path.split("/").slice(0, -1);
    const directory = [...baseParts, ...dirParts.slice(baseParts.length, baseParts.length + 2)].join("/") || ".";
    directoryCounts.set(directory, (directoryCounts.get(directory) ?? 0) + 1);
  }
  const structure = capped(
    [...directoryCounts.entries()].sort(([a], [b]) => compareCodeUnits(a, b)).map(([directory, files]) => ({ directory, files })),
    cap(OVERVIEW_CAPS.structure),
  );

  const routeAnalyses = scopedAnalyses.filter((analysis) => analysis.next?.role === "route");
  const hasNext = scopedAnalyses.some((analysis) => analysis.next !== undefined);
  const next: RepoMapOverview["next"] = hasNext
    ? {
        routes: capped(
          routeAnalyses.map((analysis) => ({ path: analysis.path, methods: [...(analysis.next?.httpMethods ?? [])], ...(analysis.next?.httpMethodsPartial ? { partial: true as const } : {}) })),
          cap(OVERVIEW_CAPS.routes),
        ),
        pages: scopedAnalyses.filter((analysis) => analysis.next?.role === "page").length,
        layouts: scopedAnalyses.filter((analysis) => analysis.next?.role === "layout").length,
      }
    : undefined;

  const scopedEdges = data.graph.edges.filter((edge) => inScope(edge.from, subPath));
  const packages = new Set<string>();
  const unresolvedEdges: { from: string; source: string; reason: UnresolvedReason }[] = [];
  let internal = 0;
  let external = 0;
  let unresolved = 0;
  for (const edge of scopedEdges) {
    if (edge.resolution === "internal") internal += 1;
    else if (edge.resolution === "external") {
      external += 1;
      packages.add(edge.package);
    } else {
      unresolved += 1;
      unresolvedEdges.push({ from: edge.from, source: edge.source, reason: edge.reason });
    }
  }

  return {
    ok: true,
    detail: "overview",
    scope: { subPath, files: scopedFiles.length },
    budget: { maxChars, truncated: scale < 1 },
    workspace: {
      files: scopedFiles.length,
      analyzed: scopedAnalyses.length,
      inventoryTruncated: data.inventory.truncated,
      languages: [...languageCounts.entries()].sort(([a], [b]) => compareCodeUnits(a, b)).map(([language, files]) => ({ language, files })),
      skipped: [...skippedCounts.entries()].sort(([a], [b]) => compareCodeUnits(a, b)).map(([reason, files]) => ({ reason, files })),
      analysisIssues: {
        withDiagnostics: scopedAnalyses.filter((analysis) => analysis.parse.status === "diagnostics").length,
        failed: scopedAnalyses.filter((analysis) => analysis.parse.status === "failed").length,
      },
    },
    project,
    resolution,
    structure,
    ...(next ? { next } : {}),
    graph: {
      edges: scopedEdges.length,
      internal,
      external,
      unresolved,
      dynamicNonLiteral: scopedAnalyses.reduce((sum, analysis) => sum + (analysis.dynamicNonLiteral ?? 0), 0),
      truncated: data.graph.truncated,
      externalPackages: capped([...packages].sort(compareCodeUnits), cap(OVERVIEW_CAPS.externalPackages)),
      // Orden propio (no el del grafo): el resultado no puede depender del orden de entrada.
      unresolvedEdges: capped(
        unresolvedEdges.sort((a, b) => compareCodeUnits(a.from, b.from) || compareCodeUnits(a.source, b.source) || compareCodeUnits(a.reason, b.reason)),
        cap(OVERVIEW_CAPS.unresolvedEdges),
      ),
    },
  };
}

function fitOverview(data: RepoMapSnapshotData, index: Index, subPath: string | null, maxChars: number): RepoMapOverview | RepoMapError {
  for (const scale of OVERVIEW_SCALES) {
    const overview = buildOverview(data, index, subPath, scale, maxChars);
    if (jsonLength(overview) <= maxChars) return overview;
  }
  return repoMapError("output_too_large", `El resumen del proyecto no entra en el presupuesto de salida (${maxChars} caracteres).`);
}

// ---------------------------------------------------------------- files / symbols

function fileEntry(file: InventoryFile, index: Index): RepoMapFileEntry {
  const analysis = index.analysisByPath.get(file.path);
  const entry: RepoMapFileEntry = { path: file.path, language: file.language, size: file.size };
  if (!file.tracked) entry.tracked = false;
  if (file.skipped) entry.skipped = file.skipped.reason;
  if (analysis && analysis.parse.status !== "ok") entry.parse = analysis.parse.status;
  const role = roleOf(analysis);
  if (role) entry.role = role;
  if (analysis && analysis.exports.length > 0) entry.exports = analysis.exports.length;
  if (analysis && analysis.symbols.length > 0) entry.symbols = analysis.symbols.length;
  const counts = { internal: 0, external: 0, unresolved: 0 };
  for (const edge of index.edgesByFrom.get(file.path) ?? []) counts[edge.resolution] += 1;
  if (counts.internal + counts.external + counts.unresolved > 0) {
    entry.imports = {
      ...(counts.internal > 0 ? { internal: counts.internal } : {}),
      ...(counts.external > 0 ? { external: counts.external } : {}),
      ...(counts.unresolved > 0 ? { unresolved: counts.unresolved } : {}),
    };
  }
  const importers = index.importedByPath.get(file.path);
  if (importers && importers.length > 0) entry.importedBy = importers.length;
  return entry;
}

function fullSymbolEntry(analysis: FileAnalysis, index: Index): RepoMapSymbolEntry {
  const entry: RepoMapSymbolEntry = { path: analysis.path, symbols: [] };
  const role = roleOf(analysis);
  if (role) entry.role = role;
  if (analysis.parse.status === "diagnostics") entry.parseIssue = { status: "diagnostics", count: analysis.parse.count, items: analysis.parse.items.slice(0, DIAGNOSTIC_ITEMS_CAP) };
  else if (analysis.parse.status === "failed") entry.parseIssue = { status: "failed", code: analysis.parse.code };

  entry.symbols = analysis.symbols.map((symbol) => {
    const out: RepoMapSymbolEntry["symbols"][number] = { name: symbol.name, kind: symbol.kind, line: symbol.line };
    if (symbol.exported) out.exported = true;
    if (symbol.overloads !== undefined) out.overloads = symbol.overloads;
    if (symbol.members && symbol.members.length > 0) {
      out.members = symbol.members.map((member) => ({ name: member.name, kind: member.kind, line: member.line, ...(member.isStatic ? { static: true as const } : {}), ...(member.visibility ? { visibility: member.visibility } : {}) }));
    }
    return out;
  });

  const reexports = analysis.exports.filter((exported) => exported.source !== undefined);
  if (reexports.length > 0) {
    entry.reexports = reexports.map((exported) => ({
      name: exported.name,
      source: exported.source as string,
      ...(exported.importedName !== undefined ? { importedName: exported.importedName } : {}),
      ...(exported.isTypeOnly ? { typeOnly: true as const } : {}),
      ...(exported.kind === "star" || exported.kind === "namespace-reexport" ? { all: true as const } : {}),
    }));
  }

  const internal = new Set<string>();
  const external = new Set<string>();
  const unresolved = new Map<string, { source: string; reason: UnresolvedReason }>();
  for (const edge of index.edgesByFrom.get(analysis.path) ?? []) {
    if (edge.resolution === "internal") internal.add(edge.to);
    else if (edge.resolution === "external") external.add(edge.package);
    else unresolved.set(`${edge.source}\0${edge.reason}`, { source: edge.source, reason: edge.reason });
  }
  if (internal.size + external.size + unresolved.size > 0) {
    entry.imports = {
      ...(internal.size > 0 ? { internal: [...internal].sort(compareCodeUnits) } : {}),
      ...(external.size > 0 ? { external: [...external].sort(compareCodeUnits) } : {}),
      ...(unresolved.size > 0 ? { unresolved: [...unresolved.values()].sort((a, b) => compareCodeUnits(a.source, b.source) || compareCodeUnits(a.reason, b.reason)) } : {}),
    };
  }

  const importers = index.importedByPath.get(analysis.path);
  if (importers && importers.length > 0) {
    entry.importedBy = importers.length > IMPORTED_BY_CAP ? { paths: importers.slice(0, IMPORTED_BY_CAP), omitted: importers.length - IMPORTED_BY_CAP } : { paths: importers };
  }
  return entry;
}

/**
 * Escalera DETERMINISTA de recorte de UNA entrada de `symbols` que sola supera
 * `limit` (función de la entrada y del límite, nunca de la posición en la
 * página): 1) miembros de clases, 2) símbolos no exportados, 3) imports sin
 * resolver, 4) lista de importadores (se conserva el conteo), 5) imports,
 * 6) cortar la lista de símbolos a la mitad hasta que entre, 7) entrada mínima.
 * Todo lo recortado queda declarado en `trimmed`.
 */
function fitSymbolEntry(full: RepoMapSymbolEntry, limit: number): RepoMapSymbolEntry {
  if (jsonLength(full) <= limit) return full;
  const entry: RepoMapSymbolEntry = JSON.parse(JSON.stringify(full));
  const trimmed: string[] = [];
  const fits = () => {
    entry.trimmed = [...trimmed];
    return jsonLength(entry) <= limit;
  };
  const steps: Array<[string, () => boolean]> = [
    ["members", () => { let changed = false; for (const symbol of entry.symbols) if (symbol.members) { delete symbol.members; changed = true; } return changed; }],
    ["unexportedSymbols", () => { const before = entry.symbols.length; entry.symbols = entry.symbols.filter((symbol) => symbol.exported); return entry.symbols.length !== before; }],
    ["unresolvedImports", () => { if (entry.imports?.unresolved) { delete entry.imports.unresolved; return true; } return false; }],
    ["importedBy", () => { if (entry.importedBy && entry.importedBy.paths.length > 0) { entry.importedBy = { paths: [], omitted: entry.importedBy.paths.length + (entry.importedBy.omitted ?? 0) }; return true; } return false; }],
    ["imports", () => { if (entry.imports) { delete entry.imports; return true; } return false; }],
  ];
  for (const [label, apply] of steps) {
    if (!apply()) continue;
    trimmed.push(label);
    if (fits()) return entry;
  }
  let kept = entry.symbols.length;
  let marker: string | null = null;
  while (kept > 0) {
    kept = Math.floor(kept / 2);
    entry.symbols = entry.symbols.slice(0, kept);
    if (marker) trimmed.pop();
    marker = `symbols:${kept}`;
    trimmed.push(marker);
    if (fits()) return entry;
  }
  const minimal: RepoMapSymbolEntry = { path: full.path, symbols: [], trimmed: [...trimmed, "entry"] };
  return minimal;
}

/**
 * Pagina por cursor de ruta con presupuesto sobre el JSON FINAL: elige el
 * prefijo más largo que entra, arma el resultado y lo mide; si se pasó, saca
 * entradas del final hasta que entre. Devuelve error si ni la primera entrada
 * cabe (nunca un resultado vacío presentado como "sin más datos").
 */
function paginate<E extends { path: string }, R extends { budget: RepoMapBudget }>(entries: E[], maxChars: number, assemble: (page: E[], budget: RepoMapBudget) => R): R | RepoMapError {
  const total = entries.length;
  const longestPath = entries.reduce((max, entry) => Math.max(max, entry.path.length), 0);
  const reserve = jsonLength(assemble([], { maxChars, truncated: true, omitted: total, nextAfter: "x".repeat(longestPath) }));
  const available = maxChars - reserve;
  const sizes = entries.map((entry) => jsonLength(entry));
  let count = 0;
  let used = 0;
  while (count < total) {
    const next = used + sizes[count] + (count > 0 ? 1 : 0);
    if (next > available) break;
    used = next;
    count += 1;
  }
  const build = (n: number): R => {
    const page = entries.slice(0, n);
    return assemble(page, n === total ? { maxChars, truncated: false } : { maxChars, truncated: true, omitted: total - n, nextAfter: page[n - 1]?.path });
  };
  for (let n = count; n >= 0; n--) {
    if (n === 0 && total > 0) break;
    const result = build(n);
    if (jsonLength(result) <= maxChars) return result;
  }
  return repoMapError("output_too_large", `Ni la primera entrada entra en el presupuesto de salida (${maxChars} caracteres).`);
}

// ---------------------------------------------------------------- entrada pública

/**
 * Proyecta el snapshot según la consulta. Pura y determinista. Las entradas
 * inválidas devuelven un error con `code` (nunca lanza).
 */
export function projectRepoMap(data: RepoMapSnapshotData, input: RepoMapInput, options: { maxChars?: number } = {}): RepoMapResult {
  const maxChars = Math.max(REPO_MAP_LIMITS.minOutputChars, Math.floor(options.maxChars ?? REPO_MAP_LIMITS.maxOutputChars));
  const detail: RepoMapDetail = input.detail ?? "overview";
  if (!REPO_MAP_DETAILS.includes(detail)) return repoMapError("invalid_input", `detail debe ser uno de: ${REPO_MAP_DETAILS.join(", ")}.`);
  const sub = normalizeRelativeInput(input.subPath, "subPath", true);
  if (!sub.ok) return sub;
  const cursor = normalizeRelativeInput(input.after, "after", false);
  if (!cursor.ok) return cursor;

  const index = buildIndex(data);
  const subPath = sub.value;
  const scopedFiles = index.files.filter((file) => inScope(file.path, subPath));
  if (subPath !== null && scopedFiles.length === 0) {
    return repoMapError("path_not_in_map", `No hay archivos del mapa bajo '${subPath}' (la ruta no existe o git la ignora).`);
  }
  const scope: RepoMapScope = { subPath, files: scopedFiles.length };

  if (detail === "overview") return fitOverview(data, index, subPath, maxChars);

  const after = cursor.value;
  if (detail === "files") {
    const entries = scopedFiles.filter((file) => after === null || file.path > after).map((file) => fileEntry(file, index));
    return paginate<RepoMapFileEntry, RepoMapFiles>(entries, maxChars, (page, budget) => ({ ok: true, detail: "files", scope, budget, files: page }));
  }

  const entryLimit = Math.floor(maxChars / 3);
  const entries = index.analyses
    .filter((analysis) => inScope(analysis.path, subPath) && (after === null || analysis.path > after))
    .map((analysis) => fitSymbolEntry(fullSymbolEntry(analysis, index), entryLimit));
  return paginate<RepoMapSymbolEntry, RepoMapSymbols>(entries, maxChars, (page, budget) => ({ ok: true, detail: "symbols", scope, budget, files: page }));
}
