/**
 * Prueba de aceptación de la Fase 2F (ver diseño de Fase 2, sección 20):
 * una task que llega a `READY_FOR_REVIEW` con un `loopRunner` fake debe
 * dejar sus `AgentFileProposal` persistidas en `agent_proposals`, y
 * `toFileProposal` debe producir un objeto con el shape de `FileProposal`
 * sin perder ningún dato relevante para `FileProposalsPanel`.
 *
 * No depende de un modelo real (mismo patrón que `test-runner.ts`, Fase 2D).
 *
 * Uso: npm run agent:test-proposal-store
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createProject } from "./project-store";
import { createTask, getTask } from "./task-store";
import { runTask } from "./runner";
import { getProposalsForTask, getProposal } from "./proposal-store";
import { toFileProposal } from "./proposal-adapter";
import type { AgentLoopResult } from "./loop";

const execFileAsync = promisify(execFile);

async function makeGitProject(name: string): Promise<{ id: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `consenso-ia-test2f-${name}-`));
  await fs.writeFile(path.join(dir, "README.md"), "proyecto de prueba\n");
  await execFileAsync("git", ["init"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
  await execFileAsync("git", ["add", "-A"], { cwd: dir });
  await execFileAsync("git", ["commit", "-m", "inicial"], { cwd: dir });
  const project = await createProject({ name, localPath: dir });
  return { id: project.id };
}

function fakeResult(overrides: Partial<AgentLoopResult>): AgentLoopResult {
  return {
    stopReason: "completed",
    steps: 3,
    transcript: ["(resultado simulado)"],
    proposals: [],
    touchedFiles: [],
    ...overrides,
  };
}

async function main() {
  console.log("== Fase 2F — prueba de aceptación (proposal-store + adaptador) ==\n");
  const results: boolean[] = [];

  // --- Caso 1: 2 proposals de una task READY_FOR_REVIEW quedan persistidas tal cual ---
  {
    console.log("--- Caso 1: proposals de una task READY_FOR_REVIEW quedan en agent_proposals ---");
    const project = await makeGitProject("caso1");
    const task = createTask({ projectId: project.id, modelId: "test-model", prompt: "agregá dos archivos" });
    const fakeProposals: AgentLoopResult["proposals"] = [
      { kind: "write", relPath: "a.ts", diff: "+export const a = 1;", nextContent: "export const a = 1;\n", baselineHash: "hash-a", typeCheck: { status: "ok" } },
      { kind: "edit", relPath: "README.md", diff: "-viejo\n+nuevo", nextContent: "nuevo\n", baselineHash: "hash-readme", typeCheck: { status: "skipped" } },
    ];
    await runTask(task.id, { loopRunner: async () => fakeResult({ proposals: fakeProposals }) });

    const finalTask = getTask(task.id)!;
    const persisted = getProposalsForTask(task.id);
    const ok =
      finalTask.status === "READY_FOR_REVIEW" &&
      persisted.length === 2 &&
      persisted.every((p) => p.taskId === task.id && p.applied === false && p.conflict === false) &&
      persisted[0].relPath === "a.ts" &&
      persisted[0].baselineHash === "hash-a" &&
      persisted[0].typecheckStatus === "ok" &&
      persisted[0].diff === "+export const a = 1;" &&
      persisted[0].nextContent === "export const a = 1;\n" &&
      persisted[1].relPath === "README.md" &&
      persisted[1].typecheckStatus === "skipped";
    console.log(
      ok
        ? `✅ status=READY_FOR_REVIEW, ${persisted.length} proposals persistidas con los mismos campos que produjo el loop.`
        : `❌ Falló. status=${finalTask.status}, persisted=${JSON.stringify(persisted)}`,
    );
    results.push(ok);

    // getProposal individual también debe encontrarlas por id.
    const single = getProposal(persisted[0].id);
    const okSingle = single !== null && single.relPath === "a.ts";
    console.log(okSingle ? "✅ getProposal(id) encuentra la fila individual." : "❌ getProposal(id) no encontró la proposal.");
    results.push(okSingle);
  }

  // --- Caso 2: NO_CHANGES no persiste nada ---
  {
    console.log("\n--- Caso 2: sin proposals (NO_CHANGES) → nada en agent_proposals ---");
    const project = await makeGitProject("caso2");
    const task = createTask({ projectId: project.id, modelId: "test-model", prompt: "tarea sin cambios" });
    await runTask(task.id, { loopRunner: async () => fakeResult({ proposals: [] }) });
    const finalTask = getTask(task.id)!;
    const persisted = getProposalsForTask(task.id);
    const ok = finalTask.status === "NO_CHANGES" && persisted.length === 0;
    console.log(ok ? "✅ status=NO_CHANGES, sin filas persistidas." : `❌ Falló. status=${finalTask.status}, persisted=${persisted.length}`);
    results.push(ok);
  }

  // --- Caso 3: el adaptador produce el shape de FileProposal esperado por el panel ---
  {
    console.log("\n--- Caso 3: toFileProposal produce el shape que espera FileProposalsPanel ---");
    const project = await makeGitProject("caso3");
    const task = createTask({ projectId: project.id, modelId: "test-model", prompt: "un archivo" });
    const fakeProposals: AgentLoopResult["proposals"] = [
      { kind: "write", relPath: "src/nuevo.ts", diff: "+contenido", nextContent: "contenido\n", baselineHash: "hash-x", typeCheck: { status: "error", errors: ["TS2304: Cannot find name 'x'."] } },
    ];
    await runTask(task.id, { loopRunner: async () => fakeResult({ proposals: fakeProposals }) });
    const persisted = getProposalsForTask(task.id);
    const fileProposal = toFileProposal(persisted[0], task.id);
    const ok =
      fileProposal.id === persisted[0].id &&
      fileProposal.groupId === task.id &&
      fileProposal.kind === "write" &&
      fileProposal.relPath === "src/nuevo.ts" &&
      fileProposal.diff === "+contenido" &&
      fileProposal.nextContent === "contenido\n" &&
      fileProposal.typeCheck.status === "error" &&
      typeof fileProposal.absPath === "string" &&
      typeof fileProposal.createdAt === "number";
    console.log(
      ok
        ? "✅ toFileProposal: id/groupId/kind/relPath/diff/nextContent/typeCheck.status coinciden, absPath y createdAt presentes."
        : `❌ Falló. fileProposal=${JSON.stringify(fileProposal)}`,
    );
    results.push(ok);
    console.log(
      "   (nota esperada: typeCheck.errors NO sobrevive el redondeo por disco — el schema de agent_proposals solo " +
        "persiste el status, no el detalle de errores; ver comentario en proposal-store.ts)",
    );
  }

  console.log(`\n${results.filter(Boolean).length}/${results.length} casos OK.`);
  if (results.some((r) => !r)) process.exit(1);
}

main().catch((error) => {
  console.error("Error inesperado en la prueba:", error);
  process.exit(1);
});
