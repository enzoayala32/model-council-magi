/**
 * Fase 8B — Selector determinista de contexto.
 *
 * Entrada: la tarea + un snapshot de solo lectura del Repository Map (7A/7B/7C)
 * + rutas que el agente ya tocó. Salida: candidatos rankeados con razones.
 * Sin LLM, sin filesystem, sin reloj, sin aleatoriedad.
 *
 * Contrato explícito (ver revisión de 8B):
 * - Los pesos son RANKING heurístico, nunca probabilidades calibradas.
 * - `score` es la suma de los pesos de las señales; una misma señal aporta
 *   como máximo una vez por archivo (se toma el peso máximo, no la suma).
 * - Se incluye un candidato solo si `score > minScore` (estrictamente
 *   mayor: la evidencia de 8B muestra que `role` con peso 10, solo, NO
 *   alcanza; `test_pair` 15 + término 5 sí).
 * - `explicit_path` toma el máximo entre menciones (100 ruta exacta, 70
 *   nombre único, 25 nombre ambiguo), nunca la suma.
 * - Un vecino a DOS saltos pesa 8 y por sí solo no puede crear candidato;
 *   es apoyo. Un vecino directo pesa 20.
 * - Máximo 30 vecinos POR SEMILLA, repartidos entre imports e importadores
 *   (15/15 y el resto se completa con la dirección que tenga más). No es
 *   "los primeros 30 de la unión ordenada": esa lectura literal fue
 *   descartada en la evidencia `salidas/09-*`.
 * - Rutas sensibles/inseguras se excluyen ANTES de puntuar y nunca se
 *   devuelven como candidatas.
 * - Orden final: score descendente y, a igual score, unidades de código de
 *   la ruta (nunca `localeCompare`, que depende del locale de la máquina).
 */
import type { RepoMapSnapshotData } from "../repo-map-views";
import type { FileAnalysis, SymbolInfo } from "../repo-symbols";
import { filterSensitivePaths, sensitiveRuleOf, type SensitivePathExclusion } from "./sensitive-paths";
import { scanTask, type PathMention, type TaskScan } from "./signals";

export const SIGNAL_WEIGHTS = {
  explicitExactPath: 100,
  explicitUniqueBaseName: 70,
  explicitAmbiguousBaseName: 25,
  touched: 100,
  symbolExported: 60,
  symbolInternal: 35,
  termFileName: 12,
  termDirectory: 5,
  termCap: 40,
  graphDirect: 20,
  graphTwoHop: 8,
  role: 10,
  testPair: 15,
} as const;

export const SELECT_LIMITS = {
  minScore: 10,
  maxCandidates: 50,
  ambiguousBaseNameFiles: 20,
  maxPathMentions: 50,
  seedMinScore: 60,
  maxSeeds: 10,
  twoHopSeeds: 3,
  neighborsPerSeed: 30,
  neighborsPerDirection: 15,
  symbolNoiseFiles: 8,
  excludedReported: 100,
} as const;

export type ContextSignal =
  | "explicit_path"
  | "touched"
  | "symbol_mention"
  | "term_match"
  | "graph_neighbor"
  | "role"
  | "test_pair";

const SIGNAL_ORDER: readonly ContextSignal[] = ["explicit_path", "touched", "symbol_mention", "term_match", "graph_neighbor", "role", "test_pair"];

export type ContextReason = {
  signal: ContextSignal;
  weight: number;
  detail?: string;
};

export type ContextCandidate = {
  path: string;
  score: number;
  reasons: ContextReason[];
  rank: number;
};

export type ContextConfidence = "high" | "medium" | "low";

export type ContextSelectionStats = {
  filesConsidered: number;
  analyzableFiles: number;
  sensitiveExcluded: number;
  candidatesBeforeCap: number;
  candidatesReturned: number;
  cap: number;
  truncated: boolean;
  seeds: number;
  graphNeighborsAdded: number;
  twoHopNeighborsAdded: number;
  partialSnapshot: boolean;
  signalsFired: Record<ContextSignal, number>;
};

export type ContextSelection = {
  candidates: ContextCandidate[];
  excluded: SensitivePathExclusion[];
  confidence: ContextConfidence;
  stats: ContextSelectionStats;
  task: { mentions: number; terms: number; truncated: boolean };
};

export type SelectContextInput = {
  task: string;
  snapshot: RepoMapSnapshotData;
  /** Rutas que las tools ya escribieron/editaron en esta corrida. */
  touchedPaths?: readonly string[];
  maxCandidates?: number;
  /** SOLO tests: permite reutilizar un scan ya hecho. */
  scan?: TaskScan;
};

const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function dirnameOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

function basenameOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? path : path.slice(index + 1);
}

function extensionOf(path: string): string {
  const base = basenameOf(path);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot) : "";
}

function stripExtension(path: string): string {
  const base = basenameOf(path);
  const ext = extensionOf(path);
  return ext ? base.slice(0, -ext.length) : base;
}

function reasonKey(reason: ContextReason): string {
  return `${reason.signal}:${reason.weight}:${reason.detail ?? ""}`;
}

function sortReasons(reasons: ContextReason[]): ContextReason[] {
  return reasons.sort((a, b) => {
    if (a.weight !== b.weight) return b.weight - a.weight;
    const signalOrder = SIGNAL_ORDER.indexOf(a.signal) - SIGNAL_ORDER.indexOf(b.signal);
    if (signalOrder !== 0) return signalOrder;
    return compareCodeUnits(a.detail ?? "", b.detail ?? "");
  });
}

/** Índice de símbolos por nombre lower-case. Un nombre que aparece en más
 * de `symbolNoiseFiles` archivos es ruido (p. ej. `value`, `config`) y no
 * genera señal. */
type SymbolEntry = { path: string; name: string; exported: boolean };
function buildSymbolIndex(analyses: readonly FileAnalysis[]): Map<string, SymbolEntry[]> {
  const index = new Map<string, SymbolEntry[]>();
  for (const analysis of analyses) {
    for (const symbol of analysis.symbols) {
      if (symbol.name.length < 2) continue;
      const key = symbol.name.toLowerCase();
      const list = index.get(key);
      const entry: SymbolEntry = { path: analysis.path, name: symbol.name, exported: symbol.exported };
      if (list) {
        if (!list.some((candidate) => candidate.path === entry.path && candidate.name === entry.name)) list.push(entry);
      } else index.set(key, [entry]);
    }
  }
  for (const list of index.values()) list.sort((a, b) => compareCodeUnits(a.path, b.path));
  return index;
}

function buildTestPairIndex(paths: readonly string[]): Map<string, string[]> {
  const byPath = new Set(paths);
  const index = new Map<string, string[]>();
  for (const path of paths) {
    const dir = dirnameOf(path);
    const base = basenameOf(path);
    const ext = extensionOf(path);
    const stem = stripExtension(path);
    if (!ext) continue;
    // No encadenar tests de tests.
    if (/\.(test|spec)$/i.test(stem)) continue;
    const candidates = [
      `${dir ? `${dir}/` : ""}${stem}.test${ext}`,
      `${dir ? `${dir}/` : ""}${stem}.spec${ext}`,
      `${dir ? `${dir}/` : ""}__tests__/${base}`,
      `${dir ? `${dir}/` : ""}__tests__/${stem}.test${ext}`,
      `${dir ? `${dir}/` : ""}__tests__/${stem}.spec${ext}`,
      `${dir ? `${dir}/` : ""}${stem}_test${ext}`,
    ];
    const existing = candidates.filter((candidate) => byPath.has(candidate)).sort(compareCodeUnits);
    if (existing.length > 0) index.set(path, existing);
  }
  return index;
}

type GraphIndex = {
  outgoing: Map<string, string[]>;
  incoming: Map<string, string[]>;
  partial: boolean;
};

function buildGraphIndex(snapshot: RepoMapSnapshotData): GraphIndex {
  const outgoing = new Map<string, Set<string>>();
  const incoming = new Map<string, Set<string>>();
  for (const edge of snapshot.graph.edges) {
    if (edge.resolution !== "internal" || !edge.to) continue;
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, new Set());
    outgoing.get(edge.from)!.add(edge.to);
    if (!incoming.has(edge.to)) incoming.set(edge.to, new Set());
    incoming.get(edge.to)!.add(edge.from);
  }
  for (const entry of snapshot.graph.importedBy) {
    if (!incoming.has(entry.path)) incoming.set(entry.path, new Set());
    for (const from of entry.by) incoming.get(entry.path)!.add(from);
  }
  const sorted = (map: Map<string, Set<string>>) => {
    const result = new Map<string, string[]>();
    for (const [key, values] of map) result.set(key, [...values].sort(compareCodeUnits));
    return result;
  };
  return { outgoing: sorted(outgoing), incoming: sorted(incoming), partial: snapshot.graph.truncated || snapshot.inventory.truncated };
}

/**
 * Vecinos de una semilla con el tope de 30 POR SEMILLA y reparto entre
 * ambas direcciones: primero hasta 15 de cada lado; el resto se completa
 * con la dirección que tenga excedente, preservando orden por ruta.
 */
function balancedNeighbors(seed: string, graph: GraphIndex, limit = SELECT_LIMITS.neighborsPerSeed): string[] {
  const outgoing = (graph.outgoing.get(seed) ?? []).filter((path) => path !== seed);
  const incoming = (graph.incoming.get(seed) ?? []).filter((path) => path !== seed);
  const selected: string[] = [];
  const seen = new Set<string>();
  const add = (path: string) => {
    if (seen.has(path) || selected.length >= limit) return;
    seen.add(path);
    selected.push(path);
  };
  for (const path of outgoing.slice(0, SELECT_LIMITS.neighborsPerDirection)) add(path);
  for (const path of incoming.slice(0, SELECT_LIMITS.neighborsPerDirection)) add(path);
  for (const path of outgoing.slice(SELECT_LIMITS.neighborsPerDirection)) add(path);
  for (const path of incoming.slice(SELECT_LIMITS.neighborsPerDirection)) add(path);
  return selected.sort(compareCodeUnits);
}

type WorkingCandidate = { path: string; reasons: ContextReason[] };

function candidateScore(candidate: WorkingCandidate): number {
  return candidate.reasons.reduce((sum, reason) => sum + reason.weight, 0);
}

function computeConfidence(candidates: readonly ContextCandidate[], partialSnapshot: boolean): ContextConfidence {
  if (candidates.length === 0) return "low";
  if (candidates[0].score >= SIGNAL_WEIGHTS.explicitUniqueBaseName) return partialSnapshot ? "medium" : "high";
  return "medium";
}

/**
 * Selecciona candidatos. Nunca lanza por datos mal formados: un snapshot
 * vacío devuelve una selección vacía con `confidence: "low"`.
 */
export function selectContext(input: SelectContextInput): ContextSelection {
  const scan = input.scan ?? scanTask(input.task);
  const maxCandidates = Math.max(1, Math.min(200, input.maxCandidates ?? SELECT_LIMITS.maxCandidates));

  const inventoryFiles = [...(input.snapshot.inventory?.files ?? [])].sort((a, b) => compareCodeUnits(a.path, b.path));
  // Deduplicar por path: el inventario no debería traer duplicados, pero un
  // snapshot sintético sí podría; nos quedamos con la primera entrada.
  const uniqueFiles = inventoryFiles.filter((file, index) => index === 0 || file.path !== inventoryFiles[index - 1].path);
  const { allowed, excluded } = filterSensitivePaths(uniqueFiles);
  const knownPaths = new Set(allowed.map((file) => file.path));
  const analyzableFiles = allowed.filter((file) => !file.skipped).length;

  const analyses = [...(input.snapshot.analysis?.files ?? [])].filter((analysis) => knownPaths.has(analysis.path));
  const analysisByPath = new Map(analyses.map((analysis) => [analysis.path, analysis]));
  const symbolIndex = buildSymbolIndex(analyses);
  const graph = buildGraphIndex(input.snapshot);
  const testPairIndex = buildTestPairIndex([...knownPaths]);

  const byPath = new Map<string, string>();
  const byLowerPath = new Map<string, string[]>();
  const byBaseName = new Map<string, string[]>();
  const byLowerBaseName = new Map<string, string[]>();
  for (const file of allowed) {
    byPath.set(file.path, file.path);
    const lowerPath = file.path.toLowerCase();
    const pathList = byLowerPath.get(lowerPath);
    if (pathList) pathList.push(file.path);
    else byLowerPath.set(lowerPath, [file.path]);
    const base = basenameOf(file.path);
    const baseList = byBaseName.get(base);
    if (baseList) baseList.push(file.path);
    else byBaseName.set(base, [file.path]);
    const lowerBase = base.toLowerCase();
    const lowerList = byLowerBaseName.get(lowerBase);
    if (lowerList) lowerList.push(file.path);
    else byLowerBaseName.set(lowerBase, [file.path]);
  }
  for (const list of [...byLowerPath.values(), ...byBaseName.values(), ...byLowerBaseName.values()]) list.sort(compareCodeUnits);

  const working = new Map<string, WorkingCandidate>();
  const suppressedBasenameTerms = new Set<string>();

  function ensure(path: string): WorkingCandidate | null {
    if (!knownPaths.has(path)) return null;
    const existing = working.get(path);
    if (existing) return existing;
    const created: WorkingCandidate = { path, reasons: [] };
    working.set(path, created);
    return created;
  }

  /** Agrega una señal; si ya existe la misma señal para el archivo, toma el
   * peso MÁXIMO (no suma). */
  function add(path: string, signal: ContextSignal, weight: number, detail?: string): void {
    const candidate = ensure(path);
    if (!candidate) return;
    const existing = candidate.reasons.find((reason) => reason.signal === signal);
    if (!existing) {
      candidate.reasons.push({ signal, weight, ...(detail ? { detail } : {}) });
      return;
    }
    if (weight > existing.weight) {
      existing.weight = weight;
      if (detail) existing.detail = detail;
    }
  }

  // ---------------------------------------------------------------- 1) menciones explícitas
  const seenMentions = new Set<string>();
  let mentionCount = 0;
  for (const mention of scan.mentions) {
    if (mentionCount >= SELECT_LIMITS.maxPathMentions) break;
    const path = mention.path;
    if (!path) continue;
    const key = `${mention.hadSlash ? "p" : "b"}:${path}`;
    if (seenMentions.has(key)) continue;
    seenMentions.add(key);
    mentionCount += 1;

    if (mention.hadSlash) {
      const exact = byPath.get(path);
      if (exact) {
        add(exact, "explicit_path", SIGNAL_WEIGHTS.explicitExactPath, `path:${path}`);
        suppressedBasenameTerms.add(exact);
        continue;
      }
      const insensitive = byLowerPath.get(path.toLowerCase());
      if (insensitive && insensitive.length === 1) {
        add(insensitive[0], "explicit_path", SIGNAL_WEIGHTS.explicitExactPath, `path:${path} (mayúsculas distintas)`);
        suppressedBasenameTerms.add(insensitive[0]);
      }
      continue;
    }

    const exactBase = byBaseName.get(path);
    if (exactBase && exactBase.length === 1) {
      add(exactBase[0], "explicit_path", SIGNAL_WEIGHTS.explicitUniqueBaseName, `name:${path}`);
      suppressedBasenameTerms.add(exactBase[0]);
      continue;
    }
    if (exactBase && exactBase.length > 1) {
      for (const filePath of exactBase.slice(0, SELECT_LIMITS.ambiguousBaseNameFiles)) {
        add(filePath, "explicit_path", SIGNAL_WEIGHTS.explicitAmbiguousBaseName, `name:${path} (ambiguo: ${exactBase.length} archivos)`);
      }
      continue;
    }
    const insensitiveBase = byLowerBaseName.get(path.toLowerCase());
    if (insensitiveBase && insensitiveBase.length === 1) {
      add(insensitiveBase[0], "explicit_path", SIGNAL_WEIGHTS.explicitUniqueBaseName, `name:${path} (mayúsculas distintas)`);
      suppressedBasenameTerms.add(insensitiveBase[0]);
    } else if (insensitiveBase && insensitiveBase.length > 1) {
      for (const filePath of insensitiveBase.slice(0, SELECT_LIMITS.ambiguousBaseNameFiles)) {
        add(filePath, "explicit_path", SIGNAL_WEIGHTS.explicitAmbiguousBaseName, `name:${path} (ambiguo: ${insensitiveBase.length} archivos, mayúsculas distintas)`);
      }
    }
  }

  // ---------------------------------------------------------------- 2) rutas ya tocadas
  for (const rawPath of input.touchedPaths ?? []) {
    const path = rawPath.replace(/\\/g, "/").replace(/^\.\//, "");
    if (sensitiveRuleOf(path)) continue;
    add(path, "touched", SIGNAL_WEIGHTS.touched, "editado en esta corrida");
  }

  // ---------------------------------------------------------------- 3) símbolos mencionados
  for (const term of scan.terms) {
    const entries = symbolIndex.get(term);
    if (!entries || entries.length === 0 || entries.length > SELECT_LIMITS.symbolNoiseFiles) continue;
    for (const entry of entries) {
      if (suppressedBasenameTerms.has(entry.path)) continue;
      add(
        entry.path,
        "symbol_mention",
        entry.exported ? SIGNAL_WEIGHTS.symbolExported : SIGNAL_WEIGHTS.symbolInternal,
        `${entry.exported ? "export" : "símbolo"}:${entry.name}`,
      );
    }
  }

  // ---------------------------------------------------------------- 4) términos en nombre/directorio
  for (const file of allowed) {
    if (scan.terms.length === 0) break;
    const segments = file.path.split("/");
    const base = segments[segments.length - 1].toLowerCase();
    const stem = stripExtension(base);
    const directories = segments.slice(0, -1).map((segment) => segment.toLowerCase());
    let filenameHits = 0;
    let directoryHits = 0;
    const filenameTerms: string[] = [];
    const directoryTerms: string[] = [];
    for (const term of scan.terms) {
      if (!suppressedBasenameTerms.has(file.path) && (base.includes(term) || stem.includes(term))) {
        filenameHits += 1;
        filenameTerms.push(term);
      }
      if (directories.some((segment) => segment === term)) {
        directoryHits += 1;
        directoryTerms.push(term);
      }
    }
    const weight = Math.min(SIGNAL_WEIGHTS.termCap, filenameHits * SIGNAL_WEIGHTS.termFileName + directoryHits * SIGNAL_WEIGHTS.termDirectory);
    if (weight > 0) {
      const details: string[] = [];
      if (filenameTerms.length) details.push(`nombre:${filenameTerms.join(",")}`);
      if (directoryTerms.length) details.push(`dir:${directoryTerms.join(",")}`);
      add(file.path, "term_match", weight, details.join("; "));
    }
  }

  // ---------------------------------------------------------------- 5) rol de Next.js
  const roleTerms = new Set(scan.terms);
  for (const [term, role] of [["route", "route"], ["page", "page"], ["layout", "layout"]] as const) {
    if (!roleTerms.has(term)) continue;
    for (const analysis of analyses) {
      if (analysis.next?.role === role) add(analysis.path, "role", SIGNAL_WEIGHTS.role, `rol:${role}`);
    }
  }

  // ---------------------------------------------------------------- 6) grafo (semillas fuertes)
  const scoredBeforeGraph = [...working.values()].map((candidate) => ({ path: candidate.path, score: candidateScore(candidate) }));
  const seeds = scoredBeforeGraph
    .filter((candidate) => candidate.score >= SELECT_LIMITS.seedMinScore)
    .sort((a, b) => b.score - a.score || compareCodeUnits(a.path, b.path))
    .slice(0, SELECT_LIMITS.maxSeeds);

  let graphNeighborsAdded = 0;
  let twoHopNeighborsAdded = 0;
  for (let seedIndex = 0; seedIndex < seeds.length; seedIndex++) {
    const seed = seeds[seedIndex];
    const direct = balancedNeighbors(seed.path, graph);
    for (const neighbor of direct) {
      if (!knownPaths.has(neighbor) || sensitiveRuleOf(neighbor)) continue;
      const before = working.has(neighbor);
      add(neighbor, "graph_neighbor", SIGNAL_WEIGHTS.graphDirect, "1 salto");
      if (!before) graphNeighborsAdded += 1;
    }
    if (seedIndex >= SELECT_LIMITS.twoHopSeeds) continue;
    for (const neighbor of direct) {
      if (!knownPaths.has(neighbor)) continue;
      const second = balancedNeighbors(neighbor, graph);
      for (const twoHop of second) {
        if (twoHop === seed.path || !knownPaths.has(twoHop) || sensitiveRuleOf(twoHop)) continue;
        const before = working.has(twoHop);
        add(twoHop, "graph_neighbor", SIGNAL_WEIGHTS.graphTwoHop, "2 saltos");
        if (!before) twoHopNeighborsAdded += 1;
      }
    }
  }

  // ---------------------------------------------------------------- 7) par de test
  for (const candidate of [...working.values()]) {
    if (candidateScore(candidate) < 30) continue;
    const tests = testPairIndex.get(candidate.path);
    if (!tests) continue;
    for (const testPath of tests) {
      if (testPath === candidate.path || sensitiveRuleOf(testPath)) continue;
      add(testPath, "test_pair", SIGNAL_WEIGHTS.testPair, "test del archivo");
    }
  }

  // ---------------------------------------------------------------- 8) orden, umbral y tope
  const candidatesBeforeCap = working.size;
  const scored = [...working.values()]
    .map((candidate) => ({ path: candidate.path, score: candidateScore(candidate), reasons: sortReasons([...candidate.reasons]) }))
    .filter((candidate) => candidate.score > SELECT_LIMITS.minScore)
    .sort((a, b) => b.score - a.score || compareCodeUnits(a.path, b.path));
  const selected = scored.slice(0, maxCandidates).map((candidate, index): ContextCandidate => ({ ...candidate, rank: index + 1 }));

  const signalsFired = Object.fromEntries(SIGNAL_ORDER.map((signal) => [signal, 0])) as Record<ContextSignal, number>;
  for (const candidate of selected) {
    for (const reason of candidate.reasons) signalsFired[reason.signal] += 1;
  }

  const partialSnapshot = Boolean(input.snapshot.inventory?.truncated || input.snapshot.graph?.truncated || input.snapshot.analysis?.files == null);

  return {
    candidates: selected,
    excluded: excluded.slice(0, SELECT_LIMITS.excludedReported),
    confidence: computeConfidence(selected, partialSnapshot),
    stats: {
      filesConsidered: uniqueFiles.length,
      analyzableFiles,
      sensitiveExcluded: excluded.length,
      candidatesBeforeCap,
      candidatesReturned: selected.length,
      cap: maxCandidates,
      truncated: scored.length > selected.length,
      seeds: seeds.length,
      graphNeighborsAdded,
      twoHopNeighborsAdded,
      partialSnapshot,
      signalsFired,
    },
    task: { mentions: mentionCount, terms: scan.terms.length, truncated: scan.truncated },
  };
}

/** Re-exportado para consumidores que solo necesitan la explicación de una
 * exclusión sin importar `sensitive-paths.ts` directamente. */
export type { SensitivePathExclusion };
