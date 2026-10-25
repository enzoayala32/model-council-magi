/**
 * Fase 8B — selector determinista de contexto.
 *
 * Sin LLM, red ni filesystem. Reconstruye los escenarios de la evidencia de
 * 8B (`salidas/07`, `08`, `09`): umbral estricto, formas de ruta, tope de
 * vecinos 30 por semilla con reparto 15/15, pares de test y rutas sensibles.
 *
 * Uso: npm run agent:test-context-select
 */
import { SELECT_LIMITS, SIGNAL_WEIGHTS, selectContext, type ContextCandidate, type ContextSelection } from "./select";
import { scanTask } from "./signals";
import { makeSnapshot, type FixtureFile } from "./test-fixtures";
import type { RepoMapSnapshotData } from "../repo-map-views";

const results: boolean[] = [];
function check(ok: boolean, message: string, detail?: () => unknown) {
  console.log(ok ? `✅ ${message}` : `❌ ${message}${detail ? `\n   ${JSON.stringify(detail())}` : ""}`);
  results.push(ok);
}
const canon = (value: unknown) => JSON.stringify(value);
function checkEq(actual: unknown, expected: unknown, message: string) {
  check(canon(actual) === canon(expected), message, () => ({ esperado: expected, actual }));
}
const eq = (a: unknown, b: unknown) => canon(a) === canon(b);

function run(files: readonly FixtureFile[], edges: readonly (readonly [string, string])[], task: string, options: { touchedPaths?: string[]; maxCandidates?: number; snapshot?: RepoMapSnapshotData } = {}): ContextSelection {
  return selectContext({ task, snapshot: options.snapshot ?? makeSnapshot(files, edges), touchedPaths: options.touchedPaths, maxCandidates: options.maxCandidates });
}
function candidate(selection: ContextSelection, path: string): ContextCandidate | undefined {
  return selection.candidates.find((item) => item.path === path);
}
function paths(selection: ContextSelection): string[] {
  return selection.candidates.map((item) => item.path);
}
function weightOf(selection: ContextSelection, path: string, signal: string): number | null {
  const found = candidate(selection, path)?.reasons.find((reason) => reason.signal === signal);
  return found ? found.weight : null;
}

function main() {
  console.log("== Fase 8B — selector de contexto ==\n");

  console.log("--- Menciones explícitas ---");
  {
    const files: FixtureFile[] = [{ path: "src/a.ts" }, { path: "src/b.ts" }];
    const selection = run(files, [], "revisá src/a.ts y nada más");
    checkEq(paths(selection), ["src/a.ts"], "ruta exacta: solo el archivo mencionado");
    checkEq(candidate(selection, "src/a.ts")?.score, SIGNAL_WEIGHTS.explicitExactPath, "ruta exacta pesa 100");
    checkEq(selection.confidence, "high", "score alto → confianza high");
    checkEq(selection.stats.signalsFired.explicit_path, 1, "señal explicit_path contada");
  }
  {
    const selection = run([{ path: "src/a.ts" }, { path: "lib/b.ts" }], [], "abrí b.ts");
    checkEq(paths(selection), ["lib/b.ts"], "nombre de archivo único: se resuelve sin ruta");
    checkEq(candidate(selection, "lib/b.ts")?.score, SIGNAL_WEIGHTS.explicitUniqueBaseName, "nombre único pesa 70");
  }
  {
    const selection = run([{ path: "lib/x/a.ts" }, { path: "lib/y/a.ts" }, { path: "lib/z.ts" }], [], "mirá a.ts");
    checkEq(paths(selection), ["lib/x/a.ts", "lib/y/a.ts"], "nombre ambiguo: devuelve todos, en orden de ruta");
    checkEq(candidate(selection, "lib/x/a.ts")?.score, SIGNAL_WEIGHTS.explicitAmbiguousBaseName, "nombre ambiguo pesa 25");
    checkEq(candidate(selection, "lib/x/a.ts")?.reasons[0].detail, "name:a.ts (ambiguo: 2 archivos)", "la razón explica la ambigüedad");
  }
  {
    const selection = run([{ path: "src/Loop.ts" }], [], "abrí src/loop.ts");
    checkEq(paths(selection), ["src/Loop.ts"], "ruta con mayúsculas distintas: única coincidencia case-insensitive");
    checkEq(candidate(selection, "src/Loop.ts")?.score, 100, "coincidencia CI única pesa como exacta y suprime el término del nombre");
    checkEq(weightOf(selection, "src/Loop.ts", "explicit_path"), 100, "la señal explicit_path en sí pesa 100");
    check(candidate(selection, "src/Loop.ts")?.reasons[0].detail?.includes("mayúsculas") === true, "la razón aclara que fue CI", () => candidate(selection, "src/Loop.ts")?.reasons);
  }
  {
    const selection = run([{ path: "src/A.ts" }, { path: "src/a.ts" }], [], "abrí src/a.ts");
    checkEq(candidate(selection, "src/a.ts")?.score, 100, "si hay coincidencia exacta, gana la exacta (no se reparte)");
    check(candidate(selection, "src/A.ts") === undefined, "la variante con otra mayúscula no se agrega si la exacta existe");
  }
  {
    const selection = run([{ path: "src/A.ts" }, { path: "src/a.ts" }], [], "abrí SRC/A.TS");
    checkEq(selection.candidates.length, 0, "ruta CI ambigua: no se resuelve si no es única (no se adivina)");
  }
  {
    const selection = run([{ path: "src/A.ts" }, { path: "src/a.ts" }], [], "abrí A.TS");
    checkEq(candidate(selection, "src/A.ts")?.score, 25, "nombre CI ambiguo: 25 para cada archivo");
    checkEq(candidate(selection, "src/a.ts")?.score, 25, "nombre CI ambiguo: también el otro");
  }
  {
    const selection = run([{ path: "b.ts" }], [], "mirá ./b.ts");
    checkEq(paths(selection), ["b.ts"], "./b.ts se resuelve al archivo real");
    checkEq(candidate(selection, "b.ts")?.score, 100, "./ con ruta existente pesa 100");
  }
  {
    const selection = run([{ path: "src/a.ts" }], [], "ver [el archivo](src/a.ts)");
    checkEq(paths(selection), ["src/a.ts"], "enlace Markdown: se extrae la ruta destino");
    checkEq(candidate(selection, "src/a.ts")?.score, 100, "enlace Markdown pesa como ruta exacta");
  }
  {
    const scan = scanTask("revisá src/a.ts.");
    checkEq(scan.fullPaths, ["src/a.ts.", "src/a.ts"], "el scan conserva variantes crudas y limpias (evidencia 8B)");
    checkEq(scan.mentions.map((mention) => mention.path), ["src/a.ts", "src/a.ts"], "las dos variantes resuelven a la misma ruta");
  }
  {
    const selection = run([{ path: "src/a.ts" }], [], "leé /etc/passwd, C:\\Windows\\x y ../secret y https://x/y.ts");
    checkEq(selection.task.mentions, 0, "rutas absolutas/UNC/traversal/URL no producen menciones");
    checkEq(selection.candidates.length, 0, "no se selecciona nada por una mención insegura");
  }

  console.log("\n--- Umbral estricto: score > 10 ---");
  {
    const roleOnly = run([{ path: "app/api/health/endpoint.ts", role: "route" }], [], "route");
    checkEq(roleOnly.candidates.length, 0, "role solo (10) NO alcanza: el umbral es estricto");
    checkEq(roleOnly.stats.candidatesBeforeCap, 1, "el archivo se puntuó, pero se filtró por umbral");
  }
  {
    const dirOnly = run([{ path: "agent/foo.ts" }], [], "agent");
    checkEq(dirOnly.candidates.length, 0, "término solo en directorio (5) NO alcanza");
  }
  {
    const fileTerm = run([{ path: "lib/billing.ts" }], [], "billing");
    checkEq(paths(fileTerm), ["lib/billing.ts"], "término en nombre de archivo (12) sí alcanza");
    checkEq(candidate(fileTerm, "lib/billing.ts")?.score, SIGNAL_WEIGHTS.termFileName, "peso 12");
  }
  {
    const rolePlusTerm = run([{ path: "app/users/page.tsx", role: "page" }], [], "page");
    checkEq(candidate(rolePlusTerm, "app/users/page.tsx")?.score, SIGNAL_WEIGHTS.termFileName + SIGNAL_WEIGHTS.role, "role + término sí suma (12 + 10)");
    checkEq(weightOf(rolePlusTerm, "app/users/page.tsx", "role"), 10, "la razón role queda visible");
  }
  {
    const testPair = run([{ path: "lib/core.ts" }, { path: "lib/__tests__/core.test.ts" }], [], "x", { touchedPaths: ["lib/core.ts"] });
    checkEq(candidate(testPair, "lib/__tests__/core.test.ts")?.score, SIGNAL_WEIGHTS.testPair, "test_pair (15) solo ya supera el umbral");
    checkEq(weightOf(testPair, "lib/__tests__/core.test.ts", "test_pair"), 15, "peso test_pair 15");
  }
  {
    const termCap = run([{ path: "lib/billing-invoice-payment-refund.ts" }], [], "billing invoice payment refund");
    checkEq(candidate(termCap, "lib/billing-invoice-payment-refund.ts")?.score, SIGNAL_WEIGHTS.termCap, "términos en nombre se topan en 40");
  }

  console.log("\n--- Símbolos ---");
  {
    const exported = run([{ path: "lib/math.ts", symbols: [{ name: "calculateTotal", exported: true }] }], [], "calculateTotal");
    checkEq(candidate(exported, "lib/math.ts")?.score, SIGNAL_WEIGHTS.symbolExported, "símbolo exportado pesa 60");
    const internal = run([{ path: "lib/math.ts", symbols: [{ name: "calculateTotal", exported: false }] }], [], "calculateTotal");
    checkEq(candidate(internal, "lib/math.ts")?.score, SIGNAL_WEIGHTS.symbolInternal, "símbolo interno pesa 35");
  }
  {
    const noisy = Array.from({ length: SELECT_LIMITS.symbolNoiseFiles + 1 }, (_, index) => ({ path: `lib/f${index}.ts`, symbols: [{ name: "value", exported: true }] }));
    const selection = run(noisy, [], "value");
    checkEq(selection.candidates.length, 0, "un símbolo repetido en demasiados archivos se considera ruido");
  }

  console.log("\n--- Grafo: vecinos directos y a dos saltos ---");
  {
    const files: FixtureFile[] = [{ path: "lib/seed.ts" }, { path: "lib/direct.ts" }, { path: "lib/two.ts" }, { path: "lib/other.ts" }];
    const selection = run(files, [["lib/direct.ts", "lib/seed.ts"], ["lib/two.ts", "lib/direct.ts"]], "editá lib/seed.ts");
    checkEq(weightOf(selection, "lib/seed.ts", "explicit_path"), 100, "semilla explícita (peso 100)");
    checkEq(candidate(selection, "lib/seed.ts")?.score, 100, "la semilla explícita no duplica el término de su propio nombre");
    checkEq(candidate(selection, "lib/direct.ts")?.score, SIGNAL_WEIGHTS.graphDirect, "vecino directo pesa 20 y es candidato");
    checkEq(candidate(selection, "lib/two.ts"), undefined, "vecino a 2 saltos (8) NO alcanza solo");
    checkEq(selection.stats.twoHopNeighborsAdded, 1, "el vecino a 2 saltos se contó como apoyo");
  }
  {
    const files: FixtureFile[] = [{ path: "lib/seed.ts" }, { path: "lib/cycle.ts" }];
    const selection = run(files, [["lib/seed.ts", "lib/cycle.ts"], ["lib/cycle.ts", "lib/seed.ts"]], "lib/seed.ts");
    checkEq(candidate(selection, "lib/cycle.ts")?.score, SIGNAL_WEIGHTS.graphDirect, "ciclo: el vecino directo no se duplica");
    checkEq(selection.stats.graphNeighborsAdded, 1, "un solo vecino agregado en el ciclo");
  }

  console.log("\n--- Tope de 30 vecinos por semilla, reparto 15/15 (evidencia 09) ---");
  {
    const files: FixtureFile[] = [{ path: "lib/seed.ts" }, ...Array.from({ length: 40 }, (_, index) => ({ path: `lib/importers/i${String(index).padStart(2, "0")}.ts` }))];
    const edges: Array<readonly [string, string]> = files.slice(1).map((file) => [file.path, "lib/seed.ts"] as const);
    const selection = run(files, edges, "lib/seed.ts");
    checkEq(selection.stats.graphNeighborsAdded, 30, "0 imports / 40 importadores → 30 vecinos");
    checkEq(selection.candidates.length, 31, "semilla + 30 vecinos");
    checkEq(paths(selection).filter((path) => path.startsWith("lib/importers/")).length, 30, "todos son importadores");
  }
  {
    const imports = Array.from({ length: 5 }, (_, index) => ({ path: `lib/imports/i${index}.ts` }));
    const importers = Array.from({ length: 40 }, (_, index) => ({ path: `lib/importers/i${String(index).padStart(2, "0")}.ts` }));
    const files: FixtureFile[] = [{ path: "lib/seed.ts" }, ...imports, ...importers];
    const edges: Array<readonly [string, string]> = [
      ...imports.map((file) => ["lib/seed.ts", file.path] as const),
      ...importers.map((file) => [file.path, "lib/seed.ts"] as const),
    ];
    const selection = run(files, edges, "lib/seed.ts");
    checkEq(selection.stats.graphNeighborsAdded, 30, "5 imports / 40 importadores → 30 vecinos");
    checkEq(paths(selection).filter((path) => path.startsWith("lib/imports/")).length, 5, "entran los 5 imports");
    checkEq(paths(selection).filter((path) => path.startsWith("lib/importers/")).length, 25, "se completa con 25 importadores");
  }
  {
    const imports = Array.from({ length: 20 }, (_, index) => ({ path: `lib/imports/i${String(index).padStart(2, "0")}.ts` }));
    const importers = Array.from({ length: 20 }, (_, index) => ({ path: `lib/importers/i${String(index).padStart(2, "0")}.ts` }));
    const files: FixtureFile[] = [{ path: "lib/seed.ts" }, ...imports, ...importers];
    const edges: Array<readonly [string, string]> = [
      ...imports.map((file) => ["lib/seed.ts", file.path] as const),
      ...importers.map((file) => [file.path, "lib/seed.ts"] as const),
    ];
    const selection = run(files, edges, "lib/seed.ts");
    checkEq(selection.stats.graphNeighborsAdded, 30, "20/20 → 30 vecinos");
    checkEq(paths(selection).filter((path) => path.startsWith("lib/imports/")).length, 15, "15 imports");
    checkEq(paths(selection).filter((path) => path.startsWith("lib/importers/")).length, 15, "15 importadores");
  }

  console.log("\n--- Rutas sensibles y ya tocadas ---");
  {
    const selection = run([{ path: ".env" }, { path: "src/a.ts" }, { path: ".ssh/config" }], [], "src/a.ts y .env");
    checkEq(paths(selection), ["src/a.ts"], "una ruta sensible mencionada no se devuelve");
    checkEq(selection.excluded.map((entry) => entry.path), [".env", ".ssh/config"], "las exclusiones se reportan sin contenido");
    checkEq(selection.stats.sensitiveExcluded, 2, "conteo de excluidas");
    checkEq(selection.stats.filesConsidered, 3, "se consideraron todas las entradas del inventario");
  }
  {
    const selection = run([{ path: "src/a.ts" }, { path: "src/t.ts" }], [], "x", { touchedPaths: ["src\\t.ts", ".env"] });
    checkEq(paths(selection), ["src/t.ts"], "ruta tocada con \\ se normaliza y es candidata");
    checkEq(candidate(selection, "src/t.ts")?.score, 100, "touched pesa 100");
    checkEq(candidate(selection, "src/t.ts")?.reasons[0].signal, "touched", "la razón es touched");
  }

  console.log("\n--- Tope de candidatos, determinismo y robustez ---");
  {
    const files: FixtureFile[] = Array.from({ length: 60 }, (_, index) => ({ path: `lib/widget-${String(index).padStart(2, "0")}.ts` }));
    const selection = run(files, [], "widget", { maxCandidates: 3 });
    checkEq(selection.candidates.length, 3, "maxCandidates respeta el tope");
    checkEq(selection.candidates.map((item) => item.rank), [1, 2, 3], "ranks 1..3");
    check(selection.stats.truncated === true && selection.stats.candidatesBeforeCap === 60, "truncated y total antes del tope", () => selection.stats);
    checkEq(selection.candidates.map((item) => item.path), ["lib/widget-00.ts", "lib/widget-01.ts", "lib/widget-02.ts"], "empate de score → orden por unidades de código");
  }
  {
    const huge = run([{ path: "a.ts" }], [], "a.ts", { maxCandidates: 1000 });
    checkEq(huge.stats.cap, 200, "maxCandidates se acota a 200");
  }
  {
    const files: FixtureFile[] = [{ path: "src/a.ts" }, { path: "lib/b.ts", symbols: [{ name: "foo", exported: true }] }];
    const snapshot = makeSnapshot(files, [["lib/b.ts", "src/a.ts"]]);
    const first = selectContext({ task: "revisá src/a.ts y foo", snapshot });
    const second = selectContext({ task: "revisá src/a.ts y foo", snapshot });
    check(eq(first, second), "dos ejecuciones con la misma entrada son idénticas", () => first);
  }
  {
    const empty = selectContext({ task: "", snapshot: makeSnapshot([]) });
    check(empty.candidates.length === 0 && empty.confidence === "low", "snapshot vacío → selección vacía, sin lanzar", () => empty);
  }
  {
    const partial = selectContext({ task: "src/a.ts", snapshot: makeSnapshot([{ path: "src/a.ts" }], [], { truncated: true }) });
    checkEq(partial.confidence, "medium", "snapshot truncado baja la confianza a medium");
    checkEq(partial.stats.partialSnapshot, true, "partialSnapshot marcado");
  }

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} casos OK.`);
  if (passed !== results.length) process.exit(1);
}

main();
