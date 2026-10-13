/**
 * Prueba de aceptación de la Fase 7D (integración con los tools reales):
 * el tool `repo_map` dentro de `createAgentTools`, su instrumentación
 * mínima sobre write/edit/delete/run_script/run_typecheck, la carga diferida
 * del módulo pesado, el comportamiento con tool calls en paralelo (como los
 * ejecuta el SDK), presupuesto/política y la integración con `runAgentLoop`.
 *
 * Sin modelo real ni red. `npx` / `npm` reales solo en los casos de exec.
 *
 * Uso: npm run agent:test-repo-map-tool
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createAgentTools, REPO_MAP_POLICY, type AgentToolEvent } from "./tools";
import { createRepoMapTracker } from "./repo-map-tracker";
import { createRepoMapService, defaultRepoMapPipeline, type RepoMapPipeline, type RepoMapService } from "./repo-map-service";
import { REPO_MAP_LIMITS, repoMapInputSchema, projectRepoMap, type RepoMapInput, type RepoMapResult } from "./repo-map-views";
import { runAgentLoop, __resetProviderPoolsForTests, type RunAgentLoopOptions } from "./loop";
import { createProject } from "./project-store";
import { createTask } from "./task-store";
import { listEvents } from "./event-log";

const execFileAsync = promisify(execFile);

const results: boolean[] = [];
function check(ok: boolean, message: string, failDetail: () => string) {
  console.log(ok ? `✅ ${message}` : `❌ ${message}\n   Falló. ${failDetail()}`);
  results.push(ok);
}
const canon = (value: unknown) => JSON.stringify(value);
const eq = (a: unknown, b: unknown) => canon(a) === canon(b);
function checkEq(actual: unknown, expected: unknown, message: string) {
  check(eq(actual, expected), message, () => `esperado=${canon(expected)}\n   actual  =${canon(actual)}`);
}

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
async function gitCommitAll(dir: string) {
  await execFileAsync("git", ["add", "-A"], { cwd: dir });
  await execFileAsync("git", ["commit", "-m", "commit"], { cwd: dir });
}
async function makeRepo(name: string, files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `consenso-ia-test7d-tool-${name}-`));
  await writeFiles(dir, files);
  await gitInit(dir);
  await gitCommitAll(dir);
  return dir;
}

type AnyTool = { execute: (input: unknown, options?: unknown) => Promise<any> };
function makeTools(dir: string, options: { scripts?: string[]; repoMap?: { tracker: ReturnType<typeof createRepoMapTracker>; service: RepoMapService } } = {}) {
  const events: AgentToolEvent[] = [];
  const tools = createAgentTools(dir, (event) => events.push(event), options.scripts ?? [], null, options.repoMap) as unknown as Record<string, AnyTool>;
  return { tools, events };
}
const call = (tool: AnyTool, input: unknown, signal?: AbortSignal) => tool.execute(input, { abortSignal: signal });
const map = (tools: Record<string, AnyTool>, input: RepoMapInput = {}, signal?: AbortSignal): Promise<RepoMapResult> => call(tools.repo_map, input, signal);
const paths = (result: RepoMapResult) => (result.ok && result.detail !== "overview" ? result.files.map((f) => f.path) : []);
const looksLikeAbsolutePath = (text: string) => /[A-Za-z]:\\|\/(home|Users|tmp|var|etc|private)\b/.test(text);

/** Instrumenta un service real con un contador de construcciones (inyectado en el tool). */
function countingService(dir: string) {
  const tracker = createRepoMapTracker();
  let builds = 0;
  const pipeline: RepoMapPipeline = (context) => {
    builds += 1;
    return defaultRepoMapPipeline(context);
  };
  return { tracker, service: createRepoMapService({ workspaceRoot: dir, tracker, pipeline }), get builds() { return builds; } };
}

function setOpenRouterCredentials(value: string) {
  delete process.env.OPENROUTER_API_KEY;
  for (const key of Object.keys(process.env)) if (key.startsWith("OPENROUTER_API_KEY_")) delete process.env[key];
  process.env.OPENROUTER_API_KEY = value;
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
  console.log("== Fase 7D — prueba de aceptación (repo_map con los tools reales) ==\n");

  // ================================================================ registro
  console.log("--- Registro del tool y contrato ---");
  const baseDir = await makeRepo("base", { "src/a.ts": "export const a = 1;\nexport function f() { return a; }\n", "README.md": "# hola\nTODO: algo\n" });
  {
    const { tools } = makeTools(baseDir);
    checkEq(Object.keys(tools).sort(), ["delete_file", "edit_file", "list_files", "read_file", "repo_map", "run_typecheck", "search_files", "write_file"], "el set de tools es EXACTAMENTE el de antes + repo_map (un único tool nuevo, sin gate por capacidad del modelo)");
    const withScripts = makeTools(baseDir, { scripts: ["build"] }).tools;
    check("run_script" in withScripts && "repo_map" in withScripts && Object.keys(withScripts).length === 9, "con scripts permitidos se suma run_script y repo_map sigue disponible", () => canon(Object.keys(withScripts)));
    const raw = createAgentTools(baseDir, () => undefined, [], null) as unknown as Record<string, { inputSchema: unknown; description: string }>;
    check(raw.repo_map.inputSchema === repoMapInputSchema && ["overview", "files", "symbols", "subPath", "after"].every((word) => raw.repo_map.description.includes(word)), "el schema es el de las vistas y la descripción explica detail / subPath / after", () => raw.repo_map.description);
    check(repoMapInputSchema.safeParse({}).success, "repo_map acepta {} (todo opcional) — apto para modelos débiles", () => "schema");
  }
  check(REPO_MAP_POLICY.timeoutMs === 90_000 && REPO_MAP_POLICY.maxOutputChars === 100_000 && REPO_MAP_LIMITS.maxOutputChars === 24_000 && REPO_MAP_LIMITS.maxOutputChars < REPO_MAP_POLICY.maxOutputChars && REPO_MAP_LIMITS.buildTimeoutMs < REPO_MAP_POLICY.timeoutMs && REPO_MAP_POLICY.maxOutputChars < 500_000, "política propia del tool: backstop 100.000 (≠ el 500.000 genérico) y 90 s, siempre por encima del presupuesto (24.000) y del timeout interno (60 s)", () => canon({ REPO_MAP_POLICY, REPO_MAP_LIMITS }));

  // ================================================================ regresión de los tools existentes
  console.log("\n--- Regresión: los tools existentes se comportan igual que antes de 7D ---");
  {
    // Valores capturados ejecutando el MISMO escenario con el tools.ts anterior a 7D (diferencial de una sola vez).
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "consenso-ia-test7d-regresion-"));
    await writeFiles(dir, { "src/a.ts": "export const a = 1;\nexport function f() { return a; }\n", "README.md": "# hola\nTODO: algo\n" });
    const { tools, events } = makeTools(dir);
    const out = async (name: string, input: unknown, signal?: AbortSignal) => canon(await call(tools[name], input, signal)).split(dir).join("<DIR>");
    // list_files arma las rutas con path.join (comportamiento PREVIO a 7D): en Windows salen con '\\'. Se normaliza solo para comparar.
    checkEq((await out("list_files", {})).replace(/\\\\/g, "/"), '{"ok":true,"files":["README.md","src/a.ts"],"truncated":false}', "list_files: salida idéntica (rutas comparadas con '/': list_files usa los separadores del sistema operativo)");
    checkEq(await out("write_file", { path: "src/b.ts", content: "export const b = 2;\n" }), '{"ok":true,"bytesWritten":20}', "write_file: salida idéntica");
    check((await out("edit_file", { path: "src/b.ts", oldStr: "= 2", newStr: "= 3" })).startsWith('{"ok":true'), "edit_file: ok", () => "edit");
    checkEq(await out("edit_file", { path: "src/b.ts", oldStr: "NO EXISTE", newStr: "x" }), '{"ok":false,"error":"oldStr no se encontró en src/b.ts. Releé el archivo con read_file y ajustá el texto."}', "edit_file con texto inexistente: mismo error");
    check((await out("delete_file", { path: "src/b.ts" })).startsWith('{"ok":true'), "delete_file: ok", () => "delete");
    checkEq(await out("delete_file", { path: "src/b.ts" }), '{"ok":false,"error":"src/b.ts no existe — no hay nada que borrar."}', "delete_file de algo inexistente: mismo error");
    check((await out("write_file", { path: "../evil.ts", content: "x" })).includes('"ok":false') && !(await fs.stat(path.join(dir, "..", "evil.ts")).then(() => true, () => false)), "write_file fuera del workspace sigue rechazado (y no escribe nada)", () => "escapó");
    checkEq(events, [{ type: "file_written", relPath: "src/b.ts" }, { type: "file_edited", relPath: "src/b.ts" }, { type: "file_deleted", relPath: "src/b.ts" }], "los AgentToolEvent son exactamente los de antes (mismas variantes, mismo orden): ninguna variante nueva");
  }

  // ================================================================ flujo de punta a punta
  console.log("\n--- Flujo de punta a punta con tools reales ---");
  {
    const dir = await makeRepo("flujo", { "src/a.ts": "export const a = 1;\n", "tsconfig.json": '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["./*"]}}}' });
    const { tools } = makeTools(dir);
    const first = await map(tools, {});
    check(first.ok && first.detail === "overview" && first.workspace.files === 2 && first.workspace.analyzed === 1, "repo_map overview (primera consulta: construye el mapa)", () => canon(first).slice(0, 200));
    await call(tools.write_file, { path: "src/nuevo.ts", content: 'import { a } from "@/src/a";\nexport const n = a;\n' });
    check(eq(paths(await map(tools, { detail: "files" })), ["src/a.ts", "src/nuevo.ts", "tsconfig.json"]), "write_file → el archivo nuevo aparece en el mapa", () => "creación");
    await call(tools.edit_file, { path: "src/nuevo.ts", oldStr: "export const n = a;", newStr: "export const n = a;\nexport function extra() {}" });
    const sym = await map(tools, { detail: "symbols", subPath: "src/nuevo.ts" });
    check(sym.ok && sym.detail === "symbols" && sym.files[0].symbols.some((s) => s.name === "extra") && eq(sym.files[0].imports?.internal, ["src/a.ts"]), "edit_file → el símbolo nuevo y el import con alias @/ se ven", () => canon(sym));
    await call(tools.delete_file, { path: "src/nuevo.ts" });
    check(!paths(await map(tools, { detail: "files" })).includes("src/nuevo.ts"), "delete_file → el archivo desaparece del mapa", () => "borrado");
    await call(tools.write_file, { path: "tsconfig.json", content: '{"compilerOptions":{}}' });
    await call(tools.write_file, { path: "src/c.ts", content: 'import "@/src/a";\n' });
    const noAlias = await map(tools, { detail: "symbols", subPath: "src/c.ts" });
    check(noAlias.ok && noAlias.detail === "symbols" && noAlias.files[0].imports?.unresolved?.[0]?.reason === "unmapped_alias", "reescribir tsconfig.json con write_file cambia la resolución en la próxima consulta", () => canon(noAlias));
    const oracle = projectRepoMap(await defaultRepoMapPipeline({ workspaceRoot: dir, signal: new AbortController().signal }), { detail: "symbols" });
    check(canon(await map(tools, { detail: "symbols" })) === canon(oracle), "tras toda la secuencia, el tool devuelve lo mismo que una reconstrucción desde cero", () => "difiere del oráculo");
  }
  {
    // Una operación FALLIDA invalida igual (puede haber dejado efectos parciales): cuesta una reconstrucción, nunca un dato viejo.
    const dir = await makeRepo("fallos", { "src/a.ts": "export const a = 1;\n" });
    const counting = countingService(dir);
    const { tools, events } = makeTools(dir, { repoMap: counting });
    await map(tools, {});
    check(counting.builds === 1, "primera consulta: 1 construcción", () => String(counting.builds));
    await map(tools, {});
    check(counting.builds === 1, "sin mutaciones: caché", () => String(counting.builds));
    const failedEdit = await call(tools.edit_file, { path: "src/a.ts", oldStr: "NO EXISTE", newStr: "x" });
    await map(tools, {});
    check(failedEdit.ok === false && events.length === 0 && counting.builds === 2, "un edit_file FALLIDO (sin evento) invalida igual: la próxima consulta reconstruye", () => canon({ builds: counting.builds, events }));
    const failedWrite = await call(tools.write_file, { path: "../afuera.ts", content: "x" });
    const failedDelete = await call(tools.delete_file, { path: "no-existe.ts" });
    await map(tools, {});
    check(failedWrite.ok === false && failedDelete.ok === false && counting.builds === 3, "write_file / delete_file fallidos también invalidan", () => String(counting.builds));
  }

  // ================================================================ exec bloquea
  console.log("\n--- run_script y run_typecheck bloquean las consultas mientras corren ---");
  {
    const dir = await makeRepo("script", { "package.json": JSON.stringify({ name: "t", scripts: { build: "node gen.js" } }), "gen.js": 'require("fs").writeFileSync("generado.ts", "export const g = 1;\\n");\n', "src/a.ts": "export const a = 1;\n" });
    const counting = countingService(dir);
    const { tools, events } = makeTools(dir, { scripts: ["build"], repoMap: counting });
    check((await map(tools, { detail: "files" })).ok && counting.builds === 1, "mapa inicial construido", () => String(counting.builds));
    const [script, during] = await Promise.all([call(tools.run_script, { name: "build" }), map(tools, { detail: "files" })]);
    check(script.ok === true && !during.ok && during.code === "busy" && !looksLikeAbsolutePath(canon(during)), "mientras run_script corre, repo_map responde busy (no sirve un mapa que el script puede estar cambiando)", () => canon({ script: script.ok, during }));
    const after = await map(tools, { detail: "files" });
    check(paths(after).includes("generado.ts") && counting.builds === 2 && events.length === 0, "al terminar, el archivo que generó el script (sin ningún evento) aparece: el exec invalidó el snapshot", () => canon({ builds: counting.builds, paths: paths(after) }));
  }
  {
    const dir = await makeRepo("typecheck", { ".gitignore": "node_modules\n", "tsconfig.json": JSON.stringify({ compilerOptions: { noEmit: true, strict: true, target: "ES2020", module: "esnext", moduleResolution: "bundler" }, include: ["**/*.ts"] }), "src/a.ts": "export const a: number = 1;\n" });
    let linked = true;
    try {
      await fs.symlink(path.join(process.cwd(), "node_modules"), path.join(dir, "node_modules"), "junction"); // como en los worktrees reales
    } catch {
      linked = false;
      console.log("⚠️  No se pudo crear el symlink a node_modules en este entorno — se omite el caso de run_typecheck real.");
    }
    if (linked) {
      const counting = countingService(dir);
      const { tools } = makeTools(dir, { repoMap: counting });
      await map(tools, {});
      const [typecheck, during] = await Promise.all([call(tools.run_typecheck, {}), map(tools, {})]);
      check(typecheck.ok === true && !during.ok && during.code === "busy", "mientras run_typecheck (tsc real) corre, repo_map responde busy", () => canon({ typecheck: typecheck.ok, during }));
      await map(tools, {});
      check(counting.builds === 2, "al terminar el typecheck el snapshot se invalida (puede haber creado archivos como tsbuildinfo)", () => String(counting.builds));
    }
  }

  // ================================================================ paralelismo del SDK
  console.log("\n--- Tool calls en paralelo (el SDK usa Promise.all por paso) ---");
  {
    const dir = await makeRepo("paralelo", { "src/a.ts": "export const a = 1;\n" });
    const { tools } = makeTools(dir);
    await map(tools, {});
    const [edit, view] = await Promise.all([call(tools.edit_file, { path: "src/a.ts", oldStr: "export const a = 1;", newStr: "export const a = 1;\nexport const agregado = 2;" }), map(tools, { detail: "symbols", subPath: "src/a.ts" })]);
    check(edit.ok === true && view.ok && view.detail === "symbols" && view.files[0].symbols.some((s) => s.name === "agregado"), "edit_file + repo_map en el MISMO paso: repo_map espera a que termine la edición y devuelve el estado posterior", () => canon(view));
    const [view2, write] = await Promise.all([map(tools, { detail: "files" }), call(tools.write_file, { path: "src/b.ts", content: "export const b = 1;\n" })]);
    check(write.ok === true && paths(view2).includes("src/b.ts"), "repo_map + write_file en el mismo paso (aunque repo_map se invoque primero): incluye el archivo nuevo", () => canon(paths(view2)));
    const counting = countingService(dir);
    const { tools: tools2 } = makeTools(dir, { repoMap: counting });
    const [one, two] = await Promise.all([map(tools2, { detail: "files" }), map(tools2, { detail: "overview" })]);
    check(one.ok && two.ok && counting.builds === 1, "dos repo_map en el mismo paso comparten UNA reconstrucción", () => String(counting.builds));
  }

  // ================================================================ cancelación y errores a nivel tool
  console.log("\n--- Cancelación y errores a nivel tool ---");
  {
    const { tools } = makeTools(baseDir);
    const aborted = new AbortController();
    aborted.abort();
    const out = await map(tools, {}, aborted.signal);
    check(!out.ok, "repo_map con el signal ya abortado → ok:false (nunca cuelga)", () => canon(out));

    const builds: Array<{ signal: AbortSignal; release: () => void }> = [];
    const tracker = createRepoMapTracker();
    const pipeline: RepoMapPipeline = ({ signal }) =>
      new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("abortado")), { once: true });
        builds.push({ signal, release: () => resolve(null as never) });
      });
    const service = createRepoMapService({ workspaceRoot: baseDir, tracker, pipeline });
    const { tools: gated } = makeTools(baseDir, { repoMap: { tracker, service } });
    const controller = new AbortController();
    const pending = map(gated, {}, controller.signal);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();
    const result = await pending;
    check(!result.ok && builds.length === 1 && builds[0].signal.aborted, "abortar el tool aborta de verdad la construcción subyacente (el AbortSignal del SDK llega hasta el pipeline)", () => canon({ result, builds: builds.length }));
  }
  {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "consenso-ia-test7d-sin-git-"));
    const { tools } = makeTools(dir);
    const out = await map(tools, {});
    check(!out.ok && out.code === "unsupported_workspace" && !out.error.includes(dir), "workspace en modo copia (sin .git): unsupported_workspace con mensaje claro", () => canon(out));
    const invalid = await map(makeTools(baseDir).tools, { subPath: "../fuera" });
    const noPath = await map(makeTools(baseDir).tools, { subPath: "no/existe" });
    check(!invalid.ok && invalid.code === "unsafe_path" && !noPath.ok && noPath.code === "path_not_in_map", "errores de entrada con su code (unsafe_path, path_not_in_map)", () => canon([invalid, noPath]));
    const throwing: RepoMapService = {
      async query() {
        throw new Error("fallo interno en C:\\Users\\secreto\\proyecto");
      },
    };
    const safe = await map(makeTools(baseDir, { repoMap: { tracker: createRepoMapTracker(), service: throwing } }).tools, {});
    check(!safe.ok && safe.code === "build_failed" && !canon(safe).includes("secreto"), "si el service lanzara una excepción, el tool igual devuelve {ok:false} con un mensaje fijo (sin filtrar rutas)", () => canon(safe));
  }

  // ================================================================ presupuesto con un repo grande
  console.log("\n--- Presupuesto y política con 1.200 archivos ---");
  {
    const files: Record<string, string> = {};
    for (let i = 0; i < 1200; i++) files[`src/m${String(i % 30).padStart(2, "0")}/f${String(i).padStart(4, "0")}.ts`] = `import "../m${String((i + 1) % 30).padStart(2, "0")}/f${String((i + 1) % 1200).padStart(4, "0")}";\nexport const v${i} = ${i};\nexport function fn${i}() {}\n`;
    const dir = await makeRepo("grande", files);
    const { tools } = makeTools(dir);
    const walk = async (detail: "files" | "symbols") => {
      const seen: string[] = [];
      let after: string | undefined;
      let pages = 0;
      let worst = 0;
      let failed = "";
      for (let guard = 0; guard < 500; guard++) {
        const page = await map(tools, { detail, after });
        pages += 1;
        worst = Math.max(worst, canon(page).length);
        if (!page.ok || page.detail === "overview") {
          failed = canon(page).slice(0, 200);
          break;
        }
        seen.push(...page.files.map((f) => f.path));
        if (!page.budget.truncated) break;
        after = page.budget.nextAfter;
      }
      return { seen, pages, worst, failed };
    };
    const filesWalk = await walk("files");
    check(filesWalk.failed === "" && filesWalk.seen.length === 1200 && new Set(filesWalk.seen).size === 1200 && filesWalk.worst <= REPO_MAP_LIMITS.maxOutputChars && filesWalk.pages >= 7, `files: ${filesWalk.pages} páginas por el tool real, 1.200 archivos sin huecos ni duplicados, la peor página = ${filesWalk.worst} chars (≤ 24.000; el wrapper de política jamás la descartó)`, () => canon(filesWalk));
    const symbolsWalk = await walk("symbols");
    check(symbolsWalk.failed === "" && symbolsWalk.seen.length === 1200 && new Set(symbolsWalk.seen).size === 1200 && symbolsWalk.worst <= REPO_MAP_LIMITS.maxOutputChars, `symbols: ${symbolsWalk.pages} páginas, 1.200 archivos completos, peor página = ${symbolsWalk.worst} chars`, () => canon({ ...symbolsWalk, seen: symbolsWalk.seen.length }));
    const overview = await map(tools, {});
    check(overview.ok && canon(overview).length < 10_000, "overview de un repo de 1.200 archivos: acotado (< 10.000 chars) sin depender del tamaño del repo", () => String(canon(overview).length));
  }

  // ================================================================ carga diferida
  console.log("\n--- Carga diferida del módulo pesado (TypeScript) ---");
  {
    const scriptDir = await fs.mkdtemp(path.join(os.tmpdir(), "consenso-ia-test7d-lazy-"));
    const scriptPath = path.join(scriptDir, "lazy-check.ts");
    await fs.writeFile(
      scriptPath,
      `const toolsPath = process.argv[2]; const repoDir = process.argv[3];
declare const require: any;
const loaded = (re: RegExp) => Object.keys(require.cache).some((key) => re.test(key));
const snapshot = () => ({ typescript: loaded(/node_modules[\\\\/]typescript[\\\\/]lib[\\\\/]typescript\\.js$/), service: loaded(/repo-map-service\\.ts$/), views: loaded(/repo-map-views\\.ts$/), tracker: loaded(/repo-map-tracker\\.ts$/) });
(async () => {
  const before = snapshot();
  const { createAgentTools } = require(toolsPath);
  const afterImport = snapshot();
  const tools = createAgentTools(repoDir, () => {}, [], null);
  const afterCreate = snapshot();
  const out = await tools.repo_map.execute({}, {});
  const afterCall = snapshot();
  console.log("RESULT " + JSON.stringify({ before, afterImport, afterCreate, afterCall, ok: out.ok }));
})();
`,
    );
    const toolsPath = path.resolve(process.cwd(), "lib/agent/tools.ts");
    const { stdout } = await execFileAsync("npx", ["tsx", scriptPath, toolsPath, baseDir], { cwd: process.cwd(), shell: process.platform === "win32", timeout: 120_000 });
    const line = stdout.split("\n").find((l) => l.startsWith("RESULT "));
    const state = line ? JSON.parse(line.slice(7)) : null;
    check(state !== null && state.afterImport.typescript === false && state.afterImport.service === false && state.afterImport.views === true && state.afterImport.tracker === true, "importar tools.ts NO carga TypeScript ni el service (solo el tracker y las vistas, que son livianos)", () => stdout.slice(-400));
    check(state !== null && state.afterCreate.typescript === false && state.afterCreate.service === false, "crear el set de tools tampoco los carga", () => canon(state));
    check(state !== null && state.ok === true && state.afterCall.typescript === true && state.afterCall.service === true, "la primera llamada a repo_map sí los carga (y funciona)", () => canon(state));
  }

  // ================================================================ loop real
  console.log("\n--- Integración con runAgentLoop (system prompt, eventos, progreso) ---");
  {
    const dir = await makeRepo("loop", { "src/a.ts": "export const a = 1;\n" });
    __resetProviderPoolsForTests();
    setOpenRouterCredentials("secret-test-7d");
    const project = await createProject({ name: `test-7d-${Math.random().toString(36).slice(2, 8)}`, localPath: dir });
    const taskId = createTask({ projectId: project.id, modelId: "test/modelo-no-registrado", prompt: "tarea de prueba, sin agente real" }).id;
    let system = "";
    let seenInStep: RepoMapResult | null = null;
    let afterWrite: RepoMapResult | null = null;
    const fake: RunAgentLoopOptions["generateTextImpl"] = async (opts) => {
      const o = opts as { system?: string; tools: Record<string, AnyTool>; abortSignal?: AbortSignal; onStepFinish?: (step: unknown) => void };
      system = o.system ?? "";
      seenInStep = await call(o.tools.repo_map, { detail: "overview" }, o.abortSignal);
      o.onStepFinish?.({ text: "miré el mapa", content: [{ type: "tool-result", toolName: "repo_map", input: { detail: "overview" }, output: seenInStep }] } as never);
      await call(o.tools.write_file, { path: "src/nuevo.ts", content: "export const nuevo = 1;\n" }, o.abortSignal);
      afterWrite = await call(o.tools.repo_map, { detail: "files" }, o.abortSignal);
      o.onStepFinish?.({ text: "", content: [{ type: "tool-result", toolName: "repo_map", input: { detail: "files" }, output: afterWrite }] } as never);
      return {};
    };
    const result = await runAgentLoop({ workspaceRoot: dir, repoRoot: dir, task: "mirá el proyecto", modelId: "test/modelo-no-registrado", taskId, generateTextImpl: fake });
    check(result.stopReason === "completed" && /repo_map/.test(system) && /empezá con repo_map/.test(system), "el loop real ofrece repo_map y el system prompt lo menciona (herramientas y regla de orientación)", () => canon({ stopReason: result.stopReason, hasPrompt: /repo_map/.test(system) }));
    check(seenInStep !== null && (seenInStep as RepoMapResult).ok && afterWrite !== null && paths(afterWrite as RepoMapResult).includes("src/nuevo.ts"), "dentro del loop real: repo_map funciona y ve lo que el mismo agente acaba de escribir", () => canon(afterWrite));
    const toolResults = listEvents(taskId).filter((e) => e.type === "tool_result");
    check(toolResults.length === 2 && toolResults.every((e) => (e.payload as { toolName?: string; ok?: boolean }).toolName === "repo_map" && (e.payload as { ok?: boolean }).ok === true), "cada repo_map queda registrado como evento tool_result (ok) como cualquier otro tool", () => canon(toolResults.map((e) => e.payload)));
    check(eq(result.touchedFiles, ["src/nuevo.ts"]) && result.steps === 2, "repo_map (solo lectura) no cuenta como archivo tocado: solo write_file", () => canon({ touched: result.touchedFiles, steps: result.steps }));
  }

  // ================================================================ proyecto real
  console.log("\n--- Copia del proyecto real vía el tool ---");
  {
    const root = process.cwd();
    const hasProject = await Promise.all(["tsconfig.json", "app", "lib"].map((p) => fs.stat(path.join(root, p)).then(() => true, () => false)));
    if (!hasProject.every(Boolean)) {
      console.log("⚠️  El directorio actual no parece la raíz del proyecto — se omite el caso del proyecto real.");
    } else {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "consenso-ia-test7d-proyecto-"));
      const skip = (src: string) => !/(^|[\\/])(node_modules|\.next)([\\/]|$)/.test(src);
      for (const entry of ["app", "lib"]) await fs.cp(path.join(root, entry), path.join(dir, entry), { recursive: true, filter: skip });
      for (const file of ["tsconfig.json", "package.json", "next.config.ts", "instrumentation.ts"]) await fs.copyFile(path.join(root, file), path.join(dir, file)).catch(() => undefined);
      await fs.writeFile(path.join(dir, ".gitignore"), "node_modules/\n.next/\n");
      await gitInit(dir);
      await gitCommitAll(dir);
      const { tools } = makeTools(dir);
      const overview = await map(tools, {});
      check(overview.ok && overview.detail === "overview" && overview.project?.frameworks[0]?.name === "next" && overview.graph.unresolved === 0 && overview.resolution.aliases.items.some((a) => a.pattern === "@/*") && (overview.next?.routes.items.length ?? 0) > 5, "overview del proyecto real: Next.js detectado, alias @/*, rutas de la API, 0 imports sin resolver", () => canon(overview).slice(0, 300));
      const toolSymbols = await map(tools, { detail: "symbols", subPath: "lib/agent/tools.ts" });
      const entry = toolSymbols.ok && toolSymbols.detail === "symbols" ? toolSymbols.files[0] : undefined;
      check(entry?.symbols.some((s) => s.name === "createAgentTools" && s.exported) === true && entry.symbols.some((s) => s.name === "REPO_MAP_POLICY") && entry.imports?.internal?.includes("lib/agent/repo-map-tracker.ts") === true && entry.imports.internal.includes("lib/agent/repo-map-views.ts") && entry.imports.internal.includes("lib/agent/repo-map-service.ts"), "symbols de tools.ts: createAgentTools y REPO_MAP_POLICY; importa el tracker y las vistas (estáticos) y el service (import() dinámico con literal, que 7C captura como dependencia real)", () => canon(entry?.imports));
      const safe = await map(tools, { detail: "symbols", subPath: "lib/agent/safe-path.ts" });
      const by = safe.ok && safe.detail === "symbols" ? safe.files[0].importedBy?.paths : [];
      check(["lib/agent/tools.ts", "lib/agent/repo-inventory.ts", "lib/agent/repo-analysis.ts", "lib/agent/repo-map-service.ts"].every((p) => by?.includes(p)), "importedBy de safe-path.ts incluye tools.ts y los módulos del repo map (incluido repo-map-service.ts)", () => canon(by));
      let after: string | undefined;
      const all: string[] = [];
      for (let guard = 0; guard < 100; guard++) {
        const page = await map(tools, { detail: "files", after });
        if (!page.ok || page.detail === "overview") break;
        all.push(...page.files.map((f) => f.path));
        if (!page.budget.truncated) break;
        after = page.budget.nextAfter;
      }
      const tracked = (await execFileAsync("git", ["ls-files"], { cwd: dir })).stdout.split("\n").filter(Boolean);
      check(all.length === tracked.length && new Set(all).size === all.length, `la paginación de files cubre los ${tracked.length} archivos del repo real sin huecos ni duplicados`, () => canon({ all: all.length, tracked: tracked.length }));
    }
  }

  completed = true;
  console.log(`\n${results.filter(Boolean).length}/${results.length} casos OK.`);
  if (results.some((r) => !r)) process.exit(1);
}

main().catch((error) => {
  console.error("Error inesperado en la prueba:", error);
  process.exit(1);
});
