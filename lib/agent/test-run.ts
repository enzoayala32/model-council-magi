/**
 * Prueba aislada de punta a punta de la Fase 1 del Coding Agent:
 * crea un worktree git real, corre el loop de AI SDK contra un solo
 * proveedor (OpenRouter), y muestra el resultado — sin tocar el Council
 * ni el agente de archivos actual.
 *
 * Uso: npm run agent:test -- "tarea en texto libre"
 * (o sin argumento, usa una tarea de prueba por default.)
 */
import { createAgentWorkspace, destroyAgentWorkspace, sweepOrphanedWorkspaces, getRepoRoot } from "./workspace";
import { runAgentLoop, resolveCodingModelId } from "./loop";

// A diferencia de `next dev` (que carga .env / .env.local solo), este
// script corre por fuera de Next.js — nadie carga el .env automáticamente
// acá. Probamos .env.local primero (así Next.js prioriza overrides locales)
// y después .env; si ninguno existe, seguimos igual — buildOpenRouterModel
// va a tirar un error claro si de verdad falta la key.
for (const file of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(file);
  } catch {
    // no existe ese archivo puntual — probamos el siguiente
  }
}

async function main() {
  const task = process.argv.slice(2).join(" ").trim() || "En el archivo lib/models.ts, agregá un comentario de una línea arriba de COUNCIL_MODELS que diga '// probado por el coding agent' y nada más. No busques ni crees ningún archivo nuevo — el archivo ya existe.";

  console.log("== Coding Agent — prueba aislada (Fase 1) ==\n");

  const { modelId, source } = resolveCodingModelId();
  console.log(`Modelo: ${modelId} (${source === "env" ? "de OPENROUTER_CODING_MODEL en .env" : "default — no hay OPENROUTER_CODING_MODEL en .env"})\n`);

  // Este script de prueba sigue probando el agente contra el propio repo de
  // MAGI (no pasa por la abstracción `Project` de Fase 2A) — por eso resuelve
  // `repoRoot` acá mismo con `getRepoRoot()` en vez de leerlo de un proyecto
  // registrado. `createAgentWorkspace`/`sweepOrphanedWorkspaces` ya no lo
  // asumen solos.
  const repoRoot = await getRepoRoot();

  const { swept } = await sweepOrphanedWorkspaces(repoRoot);
  if (swept.length) console.log(`Barrido de arranque: se limpiaron ${swept.length} workspace(s) huérfano(s).\n`);

  const taskId = `test-${Date.now()}`;
  console.log(`Tarea: ${task}`);
  console.log(`Creando workspace aislado (${taskId})…`);
  const workspace = await createAgentWorkspace(taskId, repoRoot);
  console.log(`Worktree: ${workspace.worktreePath}`);
  console.log(`Rama descartable: ${workspace.branchName}\n`);

  try {
    console.log("Corriendo el loop del agente…\n");
    const result = await runAgentLoop({
      task,
      workspaceRoot: workspace.worktreePath,
      repoRoot: workspace.repoRoot,
      modelId,
    });

    console.log("--- Transcript ---");
    for (const line of result.transcript) console.log(line);

    console.log(`\n--- Resultado ---`);
    console.log(`stopReason: ${result.stopReason}`);
    console.log(`pasos: ${result.steps}`);
    if (result.error) console.log(`error: ${result.error}`);

    console.log(`\n--- Propuestas de archivo (${result.proposals.length}) ---`);
    for (const proposal of result.proposals) {
      console.log(`\n[${proposal.kind}] ${proposal.relPath} — typecheck: ${proposal.typeCheck.status}`);
      console.log(proposal.diff.split("\n").slice(0, 20).join("\n"));
      if (proposal.diff.split("\n").length > 20) console.log("  … (diff truncado en este log)");
    }

    if (!result.proposals.length) {
      console.log("(El agente no modificó ningún archivo.)");
    }
  } finally {
    console.log(`\nLimpiando workspace…`);
    await destroyAgentWorkspace(workspace);
    console.log("Listo — worktree y rama descartable eliminados.");
  }
}

main().catch((error) => {
  console.error("Falló la prueba del Coding Agent:", error);
  process.exit(1);
});
