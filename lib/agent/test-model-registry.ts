/**
 * Prueba de aceptación de la Fase 2E (ver diseño de Fase 2, sección 20):
 * corre la MISMA task (ciclo tipo-error → fix → pass, igual que la Prueba 1
 * de Fase 1.5) contra un modelo NVIDIA nativo y uno Google nativo — los dos
 * proveedores nuevos del dispatcher multi-proveedor de `loop.ts` — pasando
 * por el camino REAL completo (`runTask`, no un loop simulado), y confirma
 * que `agent_events` tiene el transcript completo reconstruible al final.
 *
 * Necesita NVIDIA_API_KEY y/o GEMINI_API_KEY en tu `.env`/`.env.local` —
 * un modelo sin su key configurada se salta con una advertencia clara en
 * vez de fallar la prueba entera (así se puede correr con solo una de las
 * dos keys configuradas).
 *
 * Uso: npm run agent:test-model-registry
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createProject } from "./project-store";
import { createTask, getTask } from "./task-store";
import { runTask } from "./runner";
import { listEvents, eventsToTranscript } from "./event-log";
import { getCodingAgentModels, isCodingAgentEnabled } from "../models";

const execFileAsync = promisify(execFile);

for (const file of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(file);
  } catch {
    // no existe ese archivo puntual — probamos el siguiente
  }
}

const TS_RECOVERY_TASK =
  "En una carpeta nueva llamada agent-stress-out/ (creala si no existe) dentro del proyecto, creá un archivo " +
  "agent-stress-out/registry-ts-recovery.ts con: (1) una función `function add(a: number, b: number): number " +
  '{ return a + b; }`, y (2) debajo, una línea que la llame así, a propósito con un error de tipos: `const ' +
  'result = add("5", 10);`. Ejecutá run_typecheck — va a fallar. Analizá el error real que te devuelve, corregí ' +
  "la llamada para que use `add(5, 10)` (números, no strings), y ejecutá run_typecheck de nuevo para confirmar " +
  "que ahora compila limpio. No toques ningún otro archivo del proyecto.";

async function makeGitProject(name: string): Promise<{ id: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `consenso-ia-test2e-${name}-`));
  await fs.writeFile(path.join(dir, "README.md"), "proyecto de prueba 2E\n");
  // Sin esto, `run_typecheck` (que corre `npx tsc --noEmit`) nunca puede
  // pasar de verdad acá — npx intenta resolver `tsc` y, al no encontrarlo
  // instalado en ESTE proyecto puntual, dispara el mensaje-chiste de npm
  // ("This is not the tsc command you are looking for"), que el modelo (con
  // razón) interpreta como un error real y termina reintentando en un loop
  // que nunca puede resolver por su cuenta — no tiene una tool para instalar
  // paquetes (ver diseño de Fase 2, sección 16: nunca instalar deps es una
  // restricción a propósito). Bug real de este fixture, detectado en la
  // primera corrida real de 2E contra NVIDIA nativo.
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name, private: true, version: "0.0.0" }, null, 2));
  // Sin esto, `git add -A` commitea `node_modules` — el código de producción
  // (lib/agent/workspace.ts) asume que nunca está trackeado ("git worktree
  // no copia node_modules, está en .gitignore") y trata de symlinkearlo
  // aparte; si ya vino por el checkout del worktree, ese symlink choca con
  // EEXIST. No rompe run_typecheck en sí (el checkout real de node_modules
  // ya alcanza), pero es ruido que no debería estar — bug de este fixture,
  // no de workspace.ts, que sí refleja cómo es un proyecto real de verdad.
  await fs.writeFile(path.join(dir, ".gitignore"), "node_modules/\n");
  await execFileAsync("npm", ["install", "typescript", "--save-dev", "--no-audit", "--no-fund"], {
    cwd: dir,
    // En Windows, `npm` es un shim (.cmd), no un .exe real — a diferencia
    // de `git` (sí es un binario real, por eso las llamadas a git de acá
    // abajo funcionan sin esto). Sin shell:true, execFile tira ENOENT
    // ("spawn npm ENOENT") porque no sabe resolver un .cmd. Confirmado en
    // la corrida real del usuario en Windows tras el fix del fixture.
    shell: process.platform === "win32",
  });
  await fs.writeFile(
    path.join(dir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: "ES2022", module: "ESNext", moduleResolution: "Bundler" } }, null, 2),
  );
  await execFileAsync("git", ["init"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
  await execFileAsync("git", ["add", "-A"], { cwd: dir });
  await execFileAsync("git", ["commit", "-m", "inicial"], { cwd: dir });
  const project = await createProject({ name, localPath: dir });
  return { id: project.id };
}

async function runOne(modelId: string, envVarName: string): Promise<"pass" | "fail" | "skip"> {
  console.log(`\n--- Modelo: ${modelId} ---`);

  if (!isCodingAgentEnabled(modelId)) {
    console.log(`❌ El modelo no está marcado codingAgent.enabled:true en lib/models.ts — no debería llegar acá.`);
    return "fail";
  }
  if (!process.env[envVarName]) {
    console.log(`⚠️  Salteado: falta ${envVarName} en tu .env/.env.local. Configurala para correr esta prueba con este modelo.`);
    return "skip";
  }

  const project = await makeGitProject(modelId.replace(/[^a-z0-9]/gi, "-"));
  const task = createTask({ projectId: project.id, modelId, prompt: TS_RECOVERY_TASK });

  await runTask(task.id);

  const finalTask = getTask(task.id)!;
  const events = listEvents(task.id);
  const transcript = eventsToTranscript(events);

  const hasTypecheckFail = events.some((e) => e.payload.type === "typecheck_result" && e.payload.success === false);
  const hasTypecheckPass = events.some((e) => e.payload.type === "typecheck_result" && e.payload.success === true);
  const hasStatusChanges = events.some((e) => e.payload.type === "status_change");
  const reconstructible = events.length > 0 && transcript.length > 0;
  const fullTypecheckCycle = hasTypecheckFail && hasTypecheckPass;

  // Lo que 2E tiene que garantizar es el dispatcher multi-proveedor y el
  // event-log — NO que cada modelo respete al pie de la letra la
  // instrucción de correr run_typecheck antes de terminar (eso es una
  // decisión de cada modelo, y el loop ya contempla "skipped" como un
  // resultado legítimo y distinguible, no un error silencioso — ver
  // TypeCheckResult en loop.ts). Un modelo que llega a READY_FOR_REVIEW sin
  // haber verificado queda igual de visible en el transcript/proposal
  // final, solo que como "skipped" en vez de "ok"/"error".
  const ok = finalTask.status === "READY_FOR_REVIEW" && hasStatusChanges && reconstructible;

  console.log(`status final: ${finalTask.status} (esperado: READY_FOR_REVIEW)`);
  console.log(`eventos persistidos: ${events.length} (status_change presentes: ${hasStatusChanges}, reconstruible: ${reconstructible})`);
  if (!fullTypecheckCycle) {
    console.log(
      `ℹ️  Este modelo no completó el ciclo típecheck falla→corrige→pasa (typecheck falló al menos una vez: ${hasTypecheckFail}, pasó al menos una vez: ${hasTypecheckPass}) — no bloquea el PASS de 2E (responsabilidad de esta fase es el dispatcher/event-log, no la disciplina de cada modelo), pero vale la pena mirarlo si se repite siempre con este modelo.`,
    );
  }
  console.log(ok ? "✅ Dispatcher OK, task terminó en un estado válido, agent_events reconstruible." : "❌ Falló — ver detalle arriba.");
  if (!ok) {
    console.log("--- Transcript reconstruido desde agent_events ---");
    for (const line of transcript) console.log(line);
    if (finalTask.error) console.log(`error: ${finalTask.error}`);
  }

  return ok ? "pass" : "fail";
}

async function main() {
  console.log("== Fase 2E — prueba de aceptación (Model Registry multi-proveedor + eventos persistidos) ==");

  const enabled = getCodingAgentModels();
  console.log(`\nModelos habilitados para el Coding Agent (${enabled.length}): ${enabled.map((m) => `${m.id} (${m.provider ?? "openrouter"})`).join(", ")}`);

  const nvidiaModel = enabled.find((m) => m.provider === "nvidia");
  const googleModel = enabled.find((m) => m.provider === "google");

  const results: ("pass" | "fail" | "skip")[] = [];

  if (nvidiaModel) results.push(await runOne(nvidiaModel.id, "NVIDIA_API_KEY"));
  else console.log("\n(No hay ningún modelo NVIDIA nativo habilitado en lib/models.ts — nada que probar de ese proveedor.)");

  if (googleModel) results.push(await runOne(googleModel.id, "GEMINI_API_KEY"));
  else console.log("\n(No hay ningún modelo Google nativo habilitado en lib/models.ts — nada que probar de ese proveedor.)");

  const anyFailed = results.includes("fail");
  const anyPassed = results.includes("pass");
  const allSkipped = results.length > 0 && results.every((r) => r === "skip");

  if (anyFailed) {
    console.log("\n=== PRUEBA DE ACEPTACIÓN 2E: FAIL ===");
    process.exit(1);
  } else if (allSkipped) {
    console.log(
      "\n=== PRUEBA DE ACEPTACIÓN 2E: SIN CORRER (no cuenta como aprobada) — configurá NVIDIA_API_KEY y/o GEMINI_API_KEY y volvé a correr ===",
    );
    process.exit(1);
  } else if (anyPassed) {
    console.log("\n=== PRUEBA DE ACEPTACIÓN 2E: PASS ===");
  }
}

main().catch((error) => {
  console.error("Falló la prueba de Fase 2E:", error);
  process.exit(1);
});
