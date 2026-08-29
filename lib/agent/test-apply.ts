/**
 * Prueba de aceptación de la Fase 2G (ver diseño de Fase 2, secciones 10 y
 * 11, y el roadmap de la sección 20): el flujo de APPLY debe ser granular
 * por archivo, re-chequear `baseline_hash` contra el contenido REAL del
 * proyecto (`project.localPath`, no el worktree) en el momento exacto de
 * aplicar, y NUNCA sobrescribir en silencio un archivo que cambió por fuera
 * del agente. No depende de un modelo real (mismo patrón que `test-runner.ts`
 * de la Fase 2D: `loopRunner` fake para llegar a `READY_FOR_REVIEW`).
 *
 * Uso: npm run agent:test-apply
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
import { createProject } from "./project-store";
import { createTask, getTask } from "./task-store";
import { runTask } from "./runner";
import { getProposalsForTask, persistProposals } from "./proposal-store";
import { getWorkspaceForTask } from "./workspace-store";
import { applyTask } from "./apply";
import type { AgentLoopResult } from "./loop";

const execFileAsync = promisify(execFile);

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text, "utf-8").digest("hex");
}

async function makeGitProject(name: string, files: Record<string, string>): Promise<{ id: string; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `consenso-ia-test2g-${name}-`));
  for (const [relPath, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, relPath)), { recursive: true });
    await fs.writeFile(path.join(dir, relPath), content);
  }
  await execFileAsync("git", ["init"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
  await execFileAsync("git", ["add", "-A"], { cwd: dir });
  await execFileAsync("git", ["commit", "-m", "inicial"], { cwd: dir });
  const project = await createProject({ name, localPath: dir });
  return { id: project.id, dir };
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

async function readIfExists(p: string): Promise<string | null> {
  return fs.readFile(p, "utf-8").catch(() => null);
}

async function main() {
  console.log("== Fase 2G — prueba de aceptación (apply + detección de conflictos) ==\n");
  const results: boolean[] = [];

  // --- Caso 1: sin conflictos → APPLIED, edit + write nuevo, workspace destruido ---
  {
    console.log("--- Caso 1: aplicación exitosa (edit + archivo nuevo, sin conflictos) ---");
    const { id: projectId, dir } = await makeGitProject("caso1", { "a.ts": "let a = 1;\n" });
    const task = createTask({ projectId, modelId: "test-model", prompt: "modificar a.ts y crear b.ts" });
    const proposals: AgentLoopResult["proposals"] = [
      { kind: "edit", relPath: "a.ts", diff: "-let a = 1;\n+let a = 2;", nextContent: "let a = 2;\n", baselineHash: sha256("let a = 1;\n"), typeCheck: { status: "ok" } },
      { kind: "write", relPath: "b.ts", diff: "+export const b = 1;", nextContent: "export const b = 1;\n", baselineHash: sha256(""), typeCheck: { status: "skipped" } },
    ];
    await runTask(task.id, { loopRunner: async () => fakeResult({ proposals }) });

    const result = await applyTask(task.id);
    const finalTask = getTask(task.id)!;
    const workspace = getWorkspaceForTask(task.id);
    const aContent = await readIfExists(path.join(dir, "a.ts"));
    const bContent = await readIfExists(path.join(dir, "b.ts"));
    const persisted = getProposalsForTask(task.id);

    const ok =
      result.status === "APPLIED" &&
      result.appliedPaths.sort().join(",") === "a.ts,b.ts" &&
      result.conflictedPaths.length === 0 &&
      finalTask.status === "APPLIED" &&
      aContent === "let a = 2;\n" &&
      bContent === "export const b = 1;\n" &&
      workspace?.destroyedAt !== null &&
      persisted.every((p) => p.applied === true && p.conflict === false);
    console.log(
      ok
        ? "✅ status=APPLIED, a.ts editado, b.ts creado, workspace destruido, proposals marcadas applied."
        : `❌ Falló. result=${JSON.stringify(result)}, taskStatus=${finalTask.status}, a=${aContent}, b=${bContent}`,
    );
    results.push(ok);

    // --- Caso 1b (rechazo): re-aplicar una task ya APPLIED debe rechazarse ---
    let rejected = false;
    let rejectionMessage = "";
    try {
      await applyTask(task.id);
    } catch (error) {
      rejected = true;
      rejectionMessage = error instanceof Error ? error.message : String(error);
    }
    const okRetry = rejected && getTask(task.id)!.status === "APPLIED";
    console.log(okRetry ? `✅ Re-aplicar una task ya APPLIED se rechaza ("${rejectionMessage}").` : "❌ Falló: se permitió re-aplicar una task ya APPLIED.");
    results.push(okRetry);
  }

  // --- Caso 2: conflicto parcial → un archivo cambiado a mano bloquea SOLO ese archivo ---
  {
    console.log("\n--- Caso 2: edición manual de un archivo entre READY_FOR_REVIEW y APPLY → conflicto parcial ---");
    const { id: projectId, dir } = await makeGitProject("caso2", { "c.ts": "let c = 1;\n", "d.ts": "let d = 1;\n" });
    const task = createTask({ projectId, modelId: "test-model", prompt: "modificar c.ts y d.ts" });
    const proposals: AgentLoopResult["proposals"] = [
      { kind: "edit", relPath: "c.ts", diff: "-let c = 1;\n+let c = 2;", nextContent: "let c = 2;\n", baselineHash: sha256("let c = 1;\n"), typeCheck: { status: "ok" } },
      { kind: "edit", relPath: "d.ts", diff: "-let d = 1;\n+let d = 2;", nextContent: "let d = 2;\n", baselineHash: sha256("let d = 1;\n"), typeCheck: { status: "ok" } },
    ];
    await runTask(task.id, { loopRunner: async () => fakeResult({ proposals }) });

    // El usuario (o cualquier otro proceso) edita d.ts a mano DESPUÉS de que
    // la task quedó READY_FOR_REVIEW, ANTES de presionar Aplicar.
    const userEditedContent = "let d = 999; // cambio manual del usuario\n";
    await fs.writeFile(path.join(dir, "d.ts"), userEditedContent);

    const result = await applyTask(task.id);
    const finalTask = getTask(task.id)!;
    const workspace = getWorkspaceForTask(task.id);
    const cContent = await readIfExists(path.join(dir, "c.ts"));
    const dContent = await readIfExists(path.join(dir, "d.ts"));
    const persisted = getProposalsForTask(task.id);
    const cRow = persisted.find((p) => p.relPath === "c.ts")!;
    const dRow = persisted.find((p) => p.relPath === "d.ts")!;

    const ok =
      result.status === "READY_FOR_REVIEW" &&
      result.appliedPaths.join(",") === "c.ts" &&
      result.conflictedPaths.join(",") === "d.ts" &&
      finalTask.status === "READY_FOR_REVIEW" &&
      (finalTask.conflictedPaths ?? []).join(",") === "d.ts" &&
      cContent === "let c = 2;\n" && // se aplicó igual, sin conflicto
      dContent === userEditedContent && // NUNCA se sobrescribió el cambio del usuario
      workspace?.destroyedAt === null && // sigue vivo: hay conflicto sin resolver
      cRow.applied === true &&
      cRow.conflict === false &&
      dRow.applied === false &&
      dRow.conflict === true;
    console.log(
      ok
        ? "✅ c.ts se aplicó igual; d.ts quedó en conflicto SIN sobrescribirse; status volvió a READY_FOR_REVIEW; workspace sigue vivo."
        : `❌ Falló. result=${JSON.stringify(result)}, taskStatus=${finalTask.status}, conflictedPaths=${finalTask.conflictedPaths}, c=${cContent}, d=${dContent}`,
    );
    results.push(ok);

    // --- Reintento: el usuario revierte d.ts a lo que tenía el agente como base y reaplica ---
    console.log("\n--- Caso 2b: reintento tras resolver el conflicto a mano → aplica SOLO lo pendiente ---");
    await fs.writeFile(path.join(dir, "d.ts"), "let d = 1;\n"); // vuelve a matchear el baseline original
    const retryResult = await applyTask(task.id);
    const retryTask = getTask(task.id)!;
    const dContentAfterRetry = await readIfExists(path.join(dir, "d.ts"));
    const cContentAfterRetry = await readIfExists(path.join(dir, "c.ts"));
    const okRetry =
      retryResult.status === "APPLIED" &&
      retryResult.appliedPaths.join(",") === "d.ts" && // c.ts NO se reintenta, ya estaba aplicado
      retryResult.conflictedPaths.length === 0 &&
      retryTask.status === "APPLIED" &&
      dContentAfterRetry === "let d = 2;\n" &&
      cContentAfterRetry === "let c = 2;\n"; // intacto de antes, no se re-escribió
    console.log(
      okRetry
        ? "✅ Reintento aplicó SOLO d.ts (c.ts no se re-tocó), task quedó APPLIED."
        : `❌ Falló. retryResult=${JSON.stringify(retryResult)}, status=${retryTask.status}, d=${dContentAfterRetry}, c=${cContentAfterRetry}`,
    );
    results.push(okRetry);
  }

  // --- Caso 3 (rechazo): aplicar una task que no está en READY_FOR_REVIEW debe rechazarse ---
  {
    console.log("\n--- Caso 3: aplicar una task en QUEUED (transición inválida) debe rechazarse ---");
    const { id: projectId, dir } = await makeGitProject("caso3", { "e.ts": "let e = 1;\n" });
    const task = createTask({ projectId, modelId: "test-model", prompt: "nunca corrida" });
    // Persistimos proposals a mano, SIN pasar la task por RUNNING/READY_FOR_REVIEW,
    // para poder aislar específicamente el rechazo de la transición de estado
    // (no el guard de "no hay proposals pendientes").
    persistProposals(task.id, [
      { kind: "edit", relPath: "e.ts", diff: "-let e = 1;\n+let e = 2;", nextContent: "let e = 2;\n", baselineHash: sha256("let e = 1;\n"), typeCheck: { status: "ok" } },
    ]);

    let rejected = false;
    let message = "";
    try {
      await applyTask(task.id);
    } catch (error) {
      rejected = true;
      message = error instanceof Error ? error.message : String(error);
    }
    const finalTask = getTask(task.id)!;
    const eContent = await readIfExists(path.join(dir, "e.ts"));
    const persisted = getProposalsForTask(task.id);
    const ok =
      rejected &&
      finalTask.status === "QUEUED" && // no se tocó
      eContent === "let e = 1;\n" && // nada se escribió
      persisted[0].applied === false &&
      persisted[0].conflict === false;
    console.log(ok ? `✅ Rechazado correctamente ("${message}"), task y archivo intactos.` : `❌ Falló. rejected=${rejected}, status=${finalTask.status}, e=${eContent}`);
    results.push(ok);
  }

  console.log(`\n${results.filter(Boolean).length}/${results.length} casos OK.`);
  if (results.some((r) => !r)) process.exit(1);
}

main().catch((error) => {
  console.error("Error inesperado en la prueba:", error);
  process.exit(1);
});
