/**
 * Prueba REAL de la Fase 2D: a diferencia de `test-runner.ts` (que usa un
 * loop simulado, sin red, para validar la orquestación), este script corre
 * `runTask` con el loop de verdad — necesita `OPENROUTER_API_KEY` en tu
 * `.env`/`.env.local` y un proyecto git real.
 *
 * A diferencia de `test-run.ts`/`stress-test.ts` (que llaman `runAgentLoop`
 * directo), este pasa por TODO el camino nuevo: Project → CodingTask →
 * runner.ts → Workspace → loop → transición de estado final en SQLite. Es
 * la forma más cercana a como se va a usar de verdad en 2H (UI).
 *
 * Uso: npm run agent:test-runner-real -- "C:\ruta\al\proyecto" "prompt para el agente" ["modelId" opcional]
 */
import path from "node:path";
import { createProject, listProjects } from "./project-store";
import { createTask, getTask } from "./task-store";
import { runTask } from "./runner";
import { getWorkspaceForTask } from "./workspace-store";
import { resolveCodingModelId } from "./loop";

for (const file of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(file);
  } catch {
    // no existe ese archivo puntual — probamos el siguiente
  }
}

async function main() {
  const localPath = process.argv[2];
  const prompt = process.argv[3];
  if (!localPath || !prompt) {
    console.error('Uso: npm run agent:test-runner-real -- "C:\\ruta\\al\\proyecto" "prompt para el agente"');
    process.exit(1);
  }

  console.log("== Fase 2D — prueba real (runTask con el loop real) ==\n");

  const existing = listProjects({ includeArchived: true }).find(
    (p) => path.resolve(p.localPath) === path.resolve(localPath),
  );
  const project = existing ?? (await createProject({ name: path.basename(path.resolve(localPath)), localPath }));

  if (!project.isGitRepo) {
    console.log(
      `⚠️  "${project.name}" no es un repo git (o le falta el primer commit). runTask lo va a rechazar de entrada ` +
        `— seguimos igual para que veas el mensaje de error real.\n`,
    );
  }

  const modelId = process.argv[4] ?? resolveCodingModelId().modelId;
  console.log(`Modelo: ${modelId}${process.argv[4] ? "" : " (default)"}`);
  const task = createTask({ projectId: project.id, modelId, prompt });
  console.log(`Task creada: ${task.id}`);
  console.log(`Corriendo runTask (esto puede tardar — el agente puede iterar varios pasos)...\n`);

  await runTask(task.id);

  const finalTask = getTask(task.id)!;
  console.log(`\nEstado final: ${finalTask.status}`);
  if (finalTask.stopReason) console.log(`stopReason: ${finalTask.stopReason}`);
  if (finalTask.error) console.log(`error: ${finalTask.error}`);

  if (finalTask.status === "READY_FOR_REVIEW") {
    const workspace = getWorkspaceForTask(task.id);
    console.log(`\n✅ Quedó lista para revisión. El workspace sigue vivo (todavía no hay UI de apply/discard — eso es 2F/2G):`);
    console.log(`   ${workspace?.worktreePath}`);
    console.log(`Revisalo con \`git -C "${workspace?.worktreePath}" diff\` o mirando los archivos directamente.`);
  } else if (finalTask.status === "NO_CHANGES") {
    console.log("\nEl agente terminó sin proponer cambios (workspace ya destruido).");
  } else if (finalTask.status === "FAILED") {
    console.log("\nLa task falló (workspace ya destruido). Ver `error` arriba.");
  }
}

main().catch((error) => {
  console.error("Falló la prueba real de Fase 2D:", error);
  process.exit(1);
});
