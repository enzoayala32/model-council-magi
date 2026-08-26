/**
 * Fase 1.5 — pruebas de estrés del Coding Agent.
 *
 * NO conecta nada con FileProposalsPanel, NO toca el Council, NO cambia
 * arquitectura. Solo ejercita lo que ya existe (workspace.ts, tools.ts,
 * loop.ts) con 5 escenarios deliberadamente diseñados para encontrar
 * fallas: recuperación real de errores de TypeScript, múltiples archivos,
 * tarea imposible / detección de sin-progreso, seguridad del workspace,
 * e integridad del repo principal después de todo.
 *
 * Uso: npm run agent:stress
 */
import { createAgentWorkspace, destroyAgentWorkspace, sweepOrphanedWorkspaces, getRepoRoot } from "./workspace";
import { runAgentLoop, resolveCodingModelId, type AgentLoopResult } from "./loop";
import { createAgentTools } from "./tools";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";

const execFileAsync = promisify(execFile);

for (const file of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(file);
  } catch {
    // no existe ese archivo puntual
  }
}

type TestReport = {
  name: string;
  pass: boolean;
  task?: string;
  steps?: number;
  toolsUsed?: string[];
  stopReason?: string;
  errors?: string[];
  selfRecovered?: boolean;
  workspaceState?: string;
  observations: string;
  transcript?: string[];
};

function extractToolsUsed(transcript: string[]): string[] {
  const tools = new Set<string>();
  for (const line of transcript) {
    const match = line.match(/^🔧 (\w+)\(/);
    if (match) tools.add(match[1]);
  }
  return Array.from(tools);
}

function countErrorsInTranscript(transcript: string[]): string[] {
  return transcript.filter((l) => l.startsWith("❌"));
}

function printTestHeader(name: string) {
  console.log(`\n${"=".repeat(70)}`);
  console.log(`${name}`);
  console.log("=".repeat(70));
}

/** PRUEBA 1 — Corrección autónoma de TypeScript.
 * Tarea diseñada para forzar un error de tipos REAL y determinista (no
 * simulado): la tarea le pide al modelo introducir el error a propósito,
 * en un archivo descartable de agent-stress-out/, así el error viene de tsc de
 * verdad y el test es reproducible sin depender de que el modelo "se
 * equivoque solo" en algún archivo real del proyecto. */
async function testTypeScriptRecovery(repoRoot: string): Promise<TestReport> {
  printTestHeader("PRUEBA 1 — Corrección autónoma de TypeScript");
  const task =
    'En una carpeta nueva llamada agent-stress-out/ (creala si no existe) dentro del proyecto, creá un archivo agent-stress-out/stress-ts-recovery.ts con: (1) una función `function add(a: number, b: number): number { return a + b; }`, y (2) debajo, una línea que la llame así, a propósito con un error de tipos: `const result = add("5", 10);`. Ejecutá run_typecheck — va a fallar. Analizá el error real que te devuelve, corregí la llamada para que use `add(5, 10)` (números, no strings), y ejecutá run_typecheck de nuevo para confirmar que ahora compila limpio. No toques ningún otro archivo del proyecto.';
  console.log(`Tarea: ${task}\n`);

  const taskId = `stress-test1-${Date.now()}`;
  const workspace = await createAgentWorkspace(taskId, repoRoot);
  let result: AgentLoopResult | null = null;
  try {
    result = await runAgentLoop({ task, workspaceRoot: workspace.worktreePath, repoRoot: workspace.repoRoot });
    for (const line of result.transcript) console.log(line);

    const toolsUsed = extractToolsUsed(result.transcript);
    const typecheckLines = result.transcript.filter((l) => l.includes("run_typecheck"));
    const sawFailThenPass =
      result.transcript.some((l) => l.startsWith("❌ run_typecheck")) &&
      result.transcript.some((l) => l.startsWith("✅ run_typecheck"));
    const touchedTargetFile = result.touchedFiles.some((f) => f.includes("stress-ts-recovery"));
    const lastRunWasClean = result.transcript.filter((l) => l.startsWith("✅ run_typecheck") || l.startsWith("❌ run_typecheck")).pop()?.startsWith("✅");
    // Usamos touchedFiles (lo que la tool reportó de verdad) para el
    // veredicto, no `proposals` (depende de que git detecte el cambio —
    // ver nota de gitignore más abajo si no coinciden).
    const pass = result.stopReason === "completed" && sawFailThenPass && touchedTargetFile && Boolean(lastRunWasClean);
    const proposal = result.proposals.find((p) => p.relPath.includes("stress-ts-recovery"));
    const gitignoreWarning = touchedTargetFile && !proposal
      ? " NOTA: el archivo se escribió y compiló bien pero no generó proposal — probablemente está gitignored (ver advertencia ⚠️ en el transcript)."
      : "";

    return {
      name: "Prueba 1 — TypeScript recovery",
      pass,
      task,
      steps: result.steps,
      toolsUsed,
      stopReason: result.stopReason,
      errors: countErrorsInTranscript(result.transcript),
      selfRecovered: sawFailThenPass,
      workspaceState: "destruido al final (ver Prueba 5 para confirmación)",
      observations: pass
        ? `Ciclo completo observado: modificación → typecheck falló → el modelo lo analizó y corrigió → typecheck volvió a correr y pasó. ${typecheckLines.length} llamadas a run_typecheck en total.${gitignoreWarning}`
        : `NO se completó el ciclo esperado. sawFailThenPass=${sawFailThenPass}, touchedTargetFile=${touchedTargetFile}, stopReason=${result.stopReason}.${gitignoreWarning}`,
      transcript: result.transcript,
    };
  } catch (error) {
    return {
      name: "Prueba 1 — TypeScript recovery",
      pass: false,
      task,
      observations: `Excepción no controlada: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    await destroyAgentWorkspace(workspace);
  }
}

/** PRUEBA 2 — Modificación de múltiples archivos relacionados. */
async function testMultiFile(repoRoot: string): Promise<TestReport> {
  printTestHeader("PRUEBA 2 — Modificación de múltiples archivos");
  const task =
    'En la carpeta agent-stress-out/ (creala si no existe), creá dos archivos: agent-stress-out/stress-utils.ts que exporte `export function double(n: number): number { return n * 2; }`, y agent-stress-out/stress-main.ts que importe `double` desde "./stress-utils" y haga `console.log(double(21));`. Ejecutá run_typecheck para confirmar que ambos archivos compilan juntos sin errores, y corregí cualquier error que encuentres. No toques ningún otro archivo del proyecto.';
  console.log(`Tarea: ${task}\n`);

  const taskId = `stress-test2-${Date.now()}`;
  const workspace = await createAgentWorkspace(taskId, repoRoot);
  try {
    const result = await runAgentLoop({ task, workspaceRoot: workspace.worktreePath, repoRoot: workspace.repoRoot });
    for (const line of result.transcript) console.log(line);

    const toolsUsed = extractToolsUsed(result.transcript);
    const touchedUtils = result.touchedFiles.some((f) => f.includes("stress-utils"));
    const touchedMain = result.touchedFiles.some((f) => f.includes("stress-main"));
    const lastRunWasClean = result.transcript.filter((l) => l.startsWith("✅ run_typecheck") || l.startsWith("❌ run_typecheck")).pop()?.startsWith("✅");
    const pass = result.stopReason === "completed" && touchedUtils && touchedMain && Boolean(lastRunWasClean);
    const gitignoreWarning = (touchedUtils || touchedMain) && result.proposals.length === 0
      ? " NOTA: los archivos se escribieron y compilaron bien pero no generaron proposals — probablemente gitignored (ver advertencia ⚠️ en el transcript)."
      : "";

    return {
      name: "Prueba 2 — Multi-file",
      pass,
      task,
      steps: result.steps,
      toolsUsed,
      stopReason: result.stopReason,
      errors: countErrorsInTranscript(result.transcript),
      workspaceState: "destruido al final",
      observations: pass
        ? `Ambos archivos fueron escritos y el último run_typecheck pasó limpio. El agente mantuvo contexto entre archivos dentro del mismo loop.${gitignoreWarning}`
        : `touchedUtils=${touchedUtils}, touchedMain=${touchedMain}, lastRunWasClean=${lastRunWasClean}, stopReason=${result.stopReason}.${gitignoreWarning}`,
      transcript: result.transcript,
    };
  } catch (error) {
    return {
      name: "Prueba 2 — Multi-file",
      pass: false,
      task,
      observations: `Excepción no controlada: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    await destroyAgentWorkspace(workspace);
  }
}

/** PRUEBA 3 — Tarea imposible / detección de falta de progreso.
 * El archivo pedido no existe en ningún lado — el modelo no tiene forma
 * de "completar" la tarea de verdad, así que tiene que terminar por
 * alguno de los límites explícitos (no_progress, max_steps, timeout),
 * nunca colgado. */
async function testNoProgressLimits(repoRoot: string): Promise<TestReport> {
  printTestHeader("PRUEBA 3 — Tarea imposible / falta de progreso");
  const task =
    "Buscá y arreglá un bug en el archivo agent-stress-out/ARCHIVO_QUE_NO_EXISTE_STRESS_TEST_12345.ts. Ese archivo definitivamente existe en algún lado del proyecto — si no lo encontrás a la primera, seguí buscando de otras formas (otros nombres, otras carpetas) hasta encontrarlo.";
  console.log(`Tarea (deliberadamente imposible): ${task}\n`);

  const taskId = `stress-test3-${Date.now()}`;
  const workspace = await createAgentWorkspace(taskId, repoRoot);
  const before = Date.now();
  try {
    const result = await runAgentLoop({ task, workspaceRoot: workspace.worktreePath, repoRoot: workspace.repoRoot });
    const elapsedMs = Date.now() - before;
    for (const line of result.transcript) console.log(line);

    const toolsUsed = extractToolsUsed(result.transcript);
    const validStopReasons = ["no_progress", "max_steps", "timeout"];
    const pass = validStopReasons.includes(result.stopReason) && result.proposals.length === 0;

    return {
      name: "Prueba 3 — No-progress / límites",
      pass,
      task,
      steps: result.steps,
      toolsUsed,
      stopReason: result.stopReason,
      errors: countErrorsInTranscript(result.transcript),
      workspaceState: "destruido al final",
      observations: pass
        ? `Terminó correctamente por "${result.stopReason}" después de ${result.steps} pasos (${(elapsedMs / 1000).toFixed(1)}s) — no entró en loop infinito, no propuso ningún archivo (correcto, no había nada real que arreglar).`
        : `INESPERADO: stopReason="${result.stopReason}", proposals=${result.proposals.length}. Se esperaba uno de ${validStopReasons.join("/")} y cero propuestas.`,
      transcript: result.transcript,
    };
  } catch (error) {
    return {
      name: "Prueba 3 — No-progress / límites",
      pass: false,
      task,
      observations: `Excepción no controlada: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    await destroyAgentWorkspace(workspace);
  }
}

/** PRUEBA 4 — Seguridad del workspace. No necesita ningún modelo — llama
 * las tools directamente con vectores de escape maliciosos. */
/** Las tools de AI SDK exponen `execute(input, options)` pensado para el
 * loop real (options trae abortSignal, etc.) y un tipo de retorno que
 * incluye AsyncIterable (para tools que soportan streaming) — en la
 * práctica ninguna de nuestras tools transmite por streaming, siempre
 * devuelven un objeto plano, así que este helper solo evita repetir el
 * mismo cast en cada llamada directa (sin pasar por el loop del modelo).
 */
async function callTool<T>(toolDef: unknown, input: unknown): Promise<T> {
  const execute = (toolDef as { execute?: (input: unknown, options: unknown) => Promise<T> }).execute;
  if (!execute) throw new Error("Tool sin execute()");
  return execute(input, {});
}

async function testWorkspaceSecurity(repoRoot: string): Promise<TestReport> {
  printTestHeader("PRUEBA 4 — Seguridad del workspace");
  const taskId = `stress-test4-security-${Date.now()}`;
  const workspace = await createAgentWorkspace(taskId, repoRoot);
  const tools = createAgentTools(workspace.worktreePath, () => {});
  const vectors: Array<{ name: string; blocked: boolean; detail: string }> = [];

  function record(name: string, blocked: boolean, detail: string) {
    vectors.push({ name, blocked, detail });
    console.log(`${blocked ? "✅ BLOQUEADO" : "❌ NO BLOQUEADO"} — ${name}: ${detail}`);
  }

  try {
    type BasicResult = { ok: boolean; error?: string };
    type FilesResult = { ok: boolean; files?: string[]; error?: string };
    type MatchesResult = { ok: boolean; matches?: unknown[]; error?: string };

    const r1 = await callTool<BasicResult>(tools.read_file, { path: "../../../../etc/passwd" });
    record("path traversal ../../../../etc/passwd", r1.ok === false, r1.ok ? "LEYÓ EL ARCHIVO" : (r1.error ?? ""));

    const r2 = await callTool<BasicResult>(tools.read_file, { path: "/etc/passwd" });
    record("ruta absoluta /etc/passwd", r2.ok === false, r2.ok ? "LEYÓ EL ARCHIVO" : (r2.error ?? ""));

    await fs.symlink("/etc/passwd", path.join(workspace.worktreePath, "evil-symlink")).catch(() => {});
    const r3 = await callTool<BasicResult>(tools.read_file, { path: "evil-symlink" });
    record("symlink de archivo apuntando afuera", r3.ok === false, r3.ok ? "LEYÓ EL ARCHIVO" : (r3.error ?? ""));

    await fs.symlink("/etc", path.join(workspace.worktreePath, "evil-dir-symlink"), "dir").catch(() => {});
    const r3b = await callTool<FilesResult>(tools.list_files, { subPath: "evil-dir-symlink" });
    record("symlink de directorio apuntando afuera (list_files)", r3b.ok === false, r3b.ok ? `LISTÓ ${r3b.files?.length}` : (r3b.error ?? ""));

    const r4 = await callTool<BasicResult>(tools.read_file, { path: "lib/agent/../../../../../../etc/passwd" });
    record("combinación de .. mezclada con ruta real", r4.ok === false, r4.ok ? "LEYÓ EL ARCHIVO" : (r4.error ?? ""));

    const r5 = await callTool<BasicResult>(tools.write_file, { path: "../../evil-write-test.txt", content: "pwned" });
    record("write_file con path traversal", r5.ok === false, r5.ok ? "ESCRIBIÓ EL ARCHIVO" : (r5.error ?? ""));

    const r6 = await callTool<BasicResult>(tools.edit_file, { path: "../outside.txt", oldStr: "x", newStr: "y" });
    record("edit_file con path traversal", r6.ok === false, r6.ok ? "EDITÓ ALGO AFUERA" : (r6.error ?? ""));

    const r7 = await callTool<MatchesResult>(tools.search_files, { query: "root", subPath: "../../../.." });
    record("search_files con subPath traversal", r7.ok === false, r7.ok ? `ENCONTRÓ ${r7.matches?.length}` : (r7.error ?? ""));

    const r8 = await callTool<FilesResult>(tools.list_files, { subPath: "../../../.." });
    record("list_files con subPath traversal", r8.ok === false, r8.ok ? `LISTÓ ${r8.files?.length}` : (r8.error ?? ""));

    const pass = vectors.every((v) => v.blocked);
    return {
      name: "Prueba 4 — Seguridad del workspace",
      pass,
      steps: vectors.length,
      toolsUsed: ["read_file", "write_file", "edit_file", "search_files", "list_files"],
      workspaceState: "destruido al final",
      observations:
        `${vectors.filter((v) => v.blocked).length}/${vectors.length} vectores bloqueados. ` +
        `NOTA: corrido en el sandbox Linux — el traversal estilo Windows con \\ y las junctions NTFS no se pueden probar de forma representativa acá; ` +
        `si tenés dudas puntuales sobre Windows, decime y armamos un test específico para tu máquina.`,
    };
  } finally {
    await destroyAgentWorkspace(workspace);
  }
}

/** PRUEBA 5 — Integridad del proyecto principal después de todo. */
function parsePorcelainPaths(porcelain: string): Set<string> {
  return new Set(
    porcelain
      .split("\n")
      .filter(Boolean)
      .map((line) => line.slice(3).trim()),
  );
}

async function testProjectIntegrity(repoRoot: string, statusBefore: string): Promise<TestReport> {
  printTestHeader("PRUEBA 5 — Integridad del proyecto principal");
  const { stdout: statusAfter } = await execFileAsync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: repoRoot });
  const { stdout: diffAfter } = await execFileAsync("git", ["diff"], { cwd: repoRoot });
  const { stdout: worktreesAfter } = await execFileAsync("git", ["worktree", "list", "--porcelain"], { cwd: repoRoot });
  const worktreeCount = worktreesAfter.split("\n\n").filter(Boolean).length;

  // Comparación por CONJUNTO de rutas, no por string exacto — el orden de
  // `git status --porcelain` puede variar sin que haya ningún cambio real.
  const pathsBefore = parsePorcelainPaths(statusBefore);
  const pathsAfter = parsePorcelainPaths(statusAfter);
  const newlyDirty = Array.from(pathsAfter).filter((p) => !pathsBefore.has(p));
  const noLongerDirty = Array.from(pathsBefore).filter((p) => !pathsAfter.has(p));

  const onlyMainWorktree = worktreeCount === 1;
  // Lo único que de verdad podríamos haber roto nosotros es "algo nuevo
  // quedó sucio". Que algo DEJE de aparecer como sucio es raro — ninguna
  // operación que corre este script toca el working tree del repo
  // principal (solo `git worktree add/remove/list`, `status`, `diff`,
  // `show`, `branch -D` — nada de checkout/restore/stash) — pero no
  // tenemos un snapshot del CONTENIDO de antes, así que no podemos
  // confirmarlo solos: se lo marcamos al usuario para que lo revise él.
  const pass = newlyDirty.length === 0 && onlyMainWorktree;

  console.log(`git status --porcelain (antes): ${JSON.stringify(statusBefore.trim())}`);
  console.log(`git status --porcelain (después): ${JSON.stringify(statusAfter.trim())}`);
  console.log(`Rutas nuevas ensuciadas por la corrida: ${newlyDirty.length ? newlyDirty.join(", ") : "ninguna"}`);
  console.log(`Rutas que estaban sucias antes y ya no aparecen: ${noLongerDirty.length ? noLongerDirty.join(", ") : "ninguna"}`);
  console.log(`git diff (después): ${diffAfter.trim() === "" ? "(vacío)" : diffAfter.slice(0, 500)}`);
  console.log(`worktrees activos: ${worktreeCount} (esperado: 1, solo el principal)`);

  const noLongerDirtyNote = noLongerDirty.length
    ? ` ATENCIÓN: ${noLongerDirty.join(", ")} aparecían modificados ANTES de correr las pruebas y ya no aparecen — ninguna operación de este script toca el working tree del repo principal (solo git worktree add/remove/list, status, diff, show, branch -D), así que es poco probable que haya sido causado por esto, pero no tenemos un snapshot del contenido para confirmarlo. Revisá vos mismo con \`git diff ${noLongerDirty.join(" ")}\` para confirmar que el contenido sigue siendo el que esperás.`
    : "";

  return {
    name: "Prueba 5 — Integridad del proyecto",
    pass,
    workspaceState: onlyMainWorktree ? "sin worktrees huérfanos" : `${worktreeCount} worktrees activos (¡debería ser 1!)`,
    observations: pass
      ? `Ningún archivo nuevo quedó sucio por la corrida, sin worktrees huérfanos.${noLongerDirtyNote}`
      : `Se ensuciaron rutas nuevas que no estaban antes: ${newlyDirty.join(", ")}. onlyMainWorktree=${onlyMainWorktree}.${noLongerDirtyNote}`,
  };
}

function printReport(report: TestReport) {
  console.log(`\n### ${report.name}`);
  if (report.task) console.log(`- tarea ejecutada: ${report.task}`);
  if (report.steps !== undefined) console.log(`- pasos: ${report.steps}`);
  if (report.toolsUsed) console.log(`- tools utilizadas: ${report.toolsUsed.join(", ") || "ninguna"}`);
  if (report.stopReason) console.log(`- motivo de finalización: ${report.stopReason}`);
  console.log(`- errores encontrados: ${report.errors?.length ? report.errors.join(" | ") : "ninguno"}`);
  if (report.selfRecovered !== undefined) console.log(`- se recuperó automáticamente: ${report.selfRecovered ? "sí" : "no"}`);
  if (report.workspaceState) console.log(`- estado del workspace: ${report.workspaceState}`);
  console.log(`- resultado: ${report.pass ? "PASS" : "FAIL"}`);
  console.log(`- observaciones: ${report.observations}`);
}

async function main() {
  console.log("== Coding Agent — Fase 1.5: pruebas de estrés ==\n");
  const { modelId, source } = resolveCodingModelId();
  console.log(`Modelo: ${modelId} (${source === "env" ? "de OPENROUTER_CODING_MODEL en .env" : "default"})`);

  const repoRoot = await getRepoRoot();
  const { stdout: statusBefore } = await execFileAsync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: repoRoot });
  console.log(`git status --porcelain (antes de empezar): ${JSON.stringify(statusBefore.trim())}`);

  // Diagnóstico explícito en vez de sospecha: confirmamos si la carpeta que
  // usan las Pruebas 1/2/3 está gitignorada (local o GLOBALMENTE) en esta
  // máquina puntual, antes de correr nada — así el reporte final no deja
  // lugar a dudas sobre por qué faltaría una proposal aunque el archivo se
  // haya escrito y compilado bien.
  try {
    await execFileAsync("git", ["check-ignore", "-v", "agent-stress-out/"], { cwd: repoRoot });
    console.log(
      '⚠️  "agent-stress-out/" está gitignorada en esta máquina (local o globalmente) — si las Pruebas 1/2 escriben archivos ahí, van a compilar bien pero NO van a generar proposals (no es un bug del agente, es una limitación esperada de comparar contra git status). Revisá el mensaje de arriba para ver qué regla la está ignorando.',
    );
  } catch {
    console.log('"agent-stress-out/" NO está gitignorada en esta máquina — cualquier proposal faltante en Pruebas 1/2 sería un bug real, no este caso conocido.');
  }

  const { swept } = await sweepOrphanedWorkspaces(repoRoot);
  if (swept.length) console.log(`Barrido de arranque: se limpiaron ${swept.length} workspace(s) huérfano(s).`);

  const reports: TestReport[] = [];

  reports.push(await testTypeScriptRecovery(repoRoot));
  reports.push(await testMultiFile(repoRoot));
  reports.push(await testNoProgressLimits(repoRoot));
  reports.push(await testWorkspaceSecurity(repoRoot));
  reports.push(await testProjectIntegrity(repoRoot, statusBefore));

  console.log(`\n\n${"#".repeat(70)}`);
  console.log("REPORTE DETALLADO");
  console.log("#".repeat(70));
  for (const report of reports) printReport(report);

  console.log(`\n\n${"#".repeat(70)}`);
  console.log("TABLA RESUMEN");
  console.log("#".repeat(70));
  console.log("| Prueba | Resultado | Observaciones |");
  console.log("|---|---|---|");
  for (const report of reports) {
    console.log(`| ${report.name} | ${report.pass ? "PASS" : "FAIL"} | ${report.observations.slice(0, 100)}${report.observations.length > 100 ? "…" : ""} |`);
  }

  const allPass = reports.every((r) => r.pass);
  console.log(`\n${"#".repeat(70)}`);
  console.log(allPass ? "✅ FASE 1.5 APROBADA — todas las pruebas pasaron." : "❌ FASE 1.5 NO APROBADA — revisar las pruebas que fallaron antes de avanzar a Fase 2.");
  console.log("#".repeat(70));
}

main().catch((error) => {
  console.error("Falló el harness de estrés:", error);
  process.exit(1);
});
