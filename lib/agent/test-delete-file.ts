/**
 * Prueba de aceptación de la Fase 4C (ver `fase4-diseno-v3-final.md`,
 * sección 4): la tool `delete_file`, la detección de proposals `kind:
 * "delete"` en `buildProposals` (ya no se saltea el status `D` de git),
 * y la regla especial de `apply.ts` — un archivo ya borrado a mano
 * (ENOENT) es SUCCESS, no conflicto, a diferencia de write/edit.
 *
 * Sin modelo real — `createAgentTools().delete_file` y `applyTask`
 * directo con proposals armadas a mano, mismo patrón que el resto de
 * las fases.
 *
 * Uso: npm run agent:test-delete-file
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createAgentTools } from "./tools";
import { createProject } from "./project-store";
import { createTask } from "./task-store";
import { runTask } from "./runner";
import { applyTask } from "./apply";
import type { AgentLoopResult } from "./loop";

const execFileAsync = promisify(execFile);

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text, "utf-8").digest("hex");
}

async function makeGitProject(name: string, files: Record<string, string>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `consenso-ia-test4c-${name}-`));
  for (const [relPath, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, relPath)), { recursive: true });
    await fs.writeFile(path.join(dir, relPath), content);
  }
  await execFileAsync("git", ["init"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
  await execFileAsync("git", ["add", "-A"], { cwd: dir });
  await execFileAsync("git", ["commit", "-m", "inicial"], { cwd: dir });
  return { project: await createProject({ name, localPath: dir }), dir };
}

function fakeResult(overrides: Partial<AgentLoopResult>): AgentLoopResult {
  return { stopReason: "completed", steps: 1, transcript: [], proposals: [], touchedFiles: [], ...overrides };
}

async function main() {
  console.log("== Fase 4C — prueba de aceptación (delete_file) ==\n");
  const results: boolean[] = [];

  // --- Caso 1: la tool delete_file borra de verdad dentro del workspace ---
  {
    console.log("--- Caso 1: delete_file borra un archivo real dentro del workspace ---");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "consenso-ia-test4c-tool-"));
    await fs.writeFile(path.join(dir, "a.ts"), "contenido\n");
    const tools = createAgentTools(dir, () => {});
    const result = await (tools as any).delete_file.execute({ path: "a.ts" });
    const stillExists = await fs
      .stat(path.join(dir, "a.ts"))
      .then(() => true)
      .catch(() => false);
    const ok = result.ok === true && !stillExists;
    console.log(ok ? "✅ delete_file borró el archivo real." : `❌ Falló. result=${JSON.stringify(result)}, stillExists=${stillExists}`);
    results.push(ok);

    // Sanity: borrar algo que no existe, o una carpeta, da error controlado.
    const resultMissing = await (tools as any).delete_file.execute({ path: "no-existe.ts" });
    await fs.mkdir(path.join(dir, "carpeta"));
    const resultDir = await (tools as any).delete_file.execute({ path: "carpeta" });
    const okGuards = resultMissing.ok === false && resultDir.ok === false;
    console.log(okGuards ? "✅ Borrar algo inexistente o una carpeta da error controlado, sin tirar." : `❌ Falló. missing=${JSON.stringify(resultMissing)}, dir=${JSON.stringify(resultDir)}`);
    results.push(okGuards);
  }

  // --- Caso 2: apply — archivo sigue existiendo con el mismo contenido → se borra ---
  {
    console.log("\n--- Caso 2: apply de un delete cuyo baseline coincide → se borra de verdad ---");
    const { project, dir } = await makeGitProject("caso2", { "b.ts": "contenido b\n" });
    const task = createTask({ projectId: project.id, modelId: "test-model", prompt: "borrar b.ts" });
    await runTask(task.id, {
      loopRunner: async () => fakeResult({ proposals: [{ kind: "delete", relPath: "b.ts", diff: "--- b.ts\n+++ /dev/null\n-contenido b", nextContent: "", baselineHash: sha256("contenido b\n"), typeCheck: { status: "skipped" } }] }),
    });
    const applyResult = await applyTask(task.id);
    const stillExists = await fs
      .stat(path.join(dir, "b.ts"))
      .then(() => true)
      .catch(() => false);
    const ok = applyResult.status === "APPLIED" && applyResult.appliedPaths.includes("b.ts") && !stillExists;
    console.log(ok ? "✅ El archivo se borró de verdad en el proyecto real." : `❌ Falló. applyResult=${JSON.stringify(applyResult)}, stillExists=${stillExists}`);
    results.push(ok);
  }

  // --- Caso 3: la regla especial — el archivo YA fue borrado a mano → SUCCESS, no conflicto ---
  {
    console.log("\n--- Caso 3: el archivo ya fue borrado a mano antes del apply → SUCCESS, NO conflicto ---");
    const { project, dir } = await makeGitProject("caso3", { "c.ts": "contenido c\n" });
    const task = createTask({ projectId: project.id, modelId: "test-model", prompt: "borrar c.ts" });
    await runTask(task.id, {
      loopRunner: async () => fakeResult({ proposals: [{ kind: "delete", relPath: "c.ts", diff: "--- c.ts\n+++ /dev/null\n-contenido c", nextContent: "", baselineHash: sha256("contenido c\n"), typeCheck: { status: "skipped" } }] }),
    });
    // El usuario (o cualquier otro proceso) ya lo borró él mismo, ANTES de que se presione Aplicar.
    await fs.unlink(path.join(dir, "c.ts"));

    const applyResult = await applyTask(task.id);
    const ok = applyResult.status === "APPLIED" && applyResult.appliedPaths.includes("c.ts") && applyResult.conflictedPaths.length === 0;
    console.log(
      ok
        ? "✅ Un archivo ya borrado a mano se trata como SUCCESS (el objetivo ya estaba cumplido), NUNCA como conflicto."
        : `❌ Falló. applyResult=${JSON.stringify(applyResult)}`,
    );
    results.push(ok);
  }

  // --- Caso 4: el archivo SIGUE existiendo pero fue MODIFICADO → conflicto, no se borra ---
  {
    console.log("\n--- Caso 4: el archivo fue modificado (no borrado) desde que se armó la proposal → conflicto ---");
    const { project, dir } = await makeGitProject("caso4", { "d.ts": "contenido original d\n" });
    const task = createTask({ projectId: project.id, modelId: "test-model", prompt: "borrar d.ts" });
    await runTask(task.id, {
      loopRunner: async () => fakeResult({ proposals: [{ kind: "delete", relPath: "d.ts", diff: "--- d.ts\n+++ /dev/null\n-contenido original d", nextContent: "", baselineHash: sha256("contenido original d\n"), typeCheck: { status: "skipped" } }] }),
    });
    const userEdited = "el usuario cambió esto antes de aplicar\n";
    await fs.writeFile(path.join(dir, "d.ts"), userEdited);

    const applyResult = await applyTask(task.id);
    const contentAfter = await fs.readFile(path.join(dir, "d.ts"), "utf-8");
    const ok = applyResult.status === "READY_FOR_REVIEW" && applyResult.conflictedPaths.includes("d.ts") && contentAfter === userEdited;
    console.log(
      ok
        ? "✅ Conflicto correcto: el cambio del usuario NUNCA se borró — no se pisa un cambio ajeno sin revisión."
        : `❌ Falló. applyResult=${JSON.stringify(applyResult)}, contentAfter="${contentAfter}"`,
    );
    results.push(ok);
  }

  // --- Caso 5: conflicto parcial — un delete en conflicto no bloquea que otros archivos sí se apliquen ---
  {
    console.log("\n--- Caso 5: conflicto parcial — un delete en conflicto convive con un write/edit que sí aplica ---");
    const { project, dir } = await makeGitProject("caso5", { "e.ts": "contenido e\n", "f.ts": "contenido f\n" });
    const task = createTask({ projectId: project.id, modelId: "test-model", prompt: "borrar e.ts, editar f.ts" });
    await runTask(task.id, {
      loopRunner: async () =>
        fakeResult({
          proposals: [
            { kind: "delete", relPath: "e.ts", diff: "--- e.ts\n+++ /dev/null\n-contenido e", nextContent: "", baselineHash: sha256("contenido e\n"), typeCheck: { status: "skipped" } },
            { kind: "edit", relPath: "f.ts", diff: "-contenido f\n+contenido f editado", nextContent: "contenido f editado\n", baselineHash: sha256("contenido f\n"), typeCheck: { status: "ok" } },
          ],
        }),
    });
    // e.ts se modifica a mano (no se borra) → va a quedar en conflicto. f.ts se deja tal cual.
    await fs.writeFile(path.join(dir, "e.ts"), "alguien más lo cambió\n");

    const applyResult = await applyTask(task.id);
    const eContent = await fs.readFile(path.join(dir, "e.ts"), "utf-8");
    const fContent = await fs.readFile(path.join(dir, "f.ts"), "utf-8");
    const ok =
      applyResult.status === "READY_FOR_REVIEW" &&
      applyResult.conflictedPaths.join(",") === "e.ts" &&
      applyResult.appliedPaths.join(",") === "f.ts" &&
      eContent === "alguien más lo cambió\n" &&
      fContent === "contenido f editado\n";
    console.log(
      ok
        ? "✅ e.ts (delete en conflicto) no se tocó; f.ts (edit sin conflicto) se aplicó igual — el conflicto de uno no bloquea al otro."
        : `❌ Falló. applyResult=${JSON.stringify(applyResult)}, e="${eContent}", f="${fContent}"`,
    );
    results.push(ok);
  }

  console.log(`\n${results.filter(Boolean).length}/${results.length} casos OK.`);
  if (results.some((r) => !r)) process.exit(1);
}

main().catch((error) => {
  console.error("Error inesperado en la prueba:", error);
  process.exit(1);
});
