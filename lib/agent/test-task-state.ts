/**
 * Prueba de aceptación de la Fase 2B: crea una `CodingTask` a mano en
 * `QUEUED`, recorre un camino válido de transiciones, y confirma que
 * un conjunto de transiciones inválidas se rechazan todas.
 *
 * Uso: npm run agent:test-task-state
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createProject } from "./project-store";
import { createTask, transitionTask, getTask, InvalidTaskTransitionError, type TaskStatus } from "./task-store";

function expectRejected(label: string, fn: () => void): boolean {
  try {
    fn();
    console.log(`❌ ${label} — se esperaba que fallara, pero se aplicó.`);
    return false;
  } catch (error) {
    if (error instanceof InvalidTaskTransitionError) {
      console.log(`✅ ${label} — rechazada correctamente (${error.message})`);
      return true;
    }
    console.log(`❌ ${label} — falló, pero con un error inesperado: ${error}`);
    return false;
  }
}

function expectApplied(label: string, fn: () => TaskStatus): boolean {
  try {
    const status = fn();
    console.log(`✅ ${label} — aplicada, status ahora: ${status}`);
    return true;
  } catch (error) {
    console.log(`❌ ${label} — se esperaba que se aplicara, pero falló: ${error}`);
    return false;
  }
}

async function main() {
  console.log("== Fase 2B — prueba de aceptación (máquina de estados de CodingTask) ==\n");

  const results: boolean[] = [];

  // agent_tasks tiene una FK real a agent_projects (better-sqlite3 trae
  // foreign_keys=ON por default) — hace falta un Project registrado de
  // verdad, aunque para esta prueba no importa que sea un repo git.
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "consenso-ia-test2b-"));
  const project = await createProject({ name: "Proyecto de prueba 2B", localPath: tmpDir });

  const task = createTask({ projectId: project.id, modelId: "test-model", prompt: "tarea de prueba" });
  console.log(`Task creada: ${task.id} (status: ${task.status})\n`);

  console.log("--- Camino válido ---");
  results.push(expectApplied("QUEUED → RUNNING", () => transitionTask(task.id, "RUNNING").status));
  results.push(expectApplied("RUNNING → READY_FOR_REVIEW", () => transitionTask(task.id, "READY_FOR_REVIEW").status));
  results.push(expectApplied("READY_FOR_REVIEW → APPLYING", () => transitionTask(task.id, "APPLYING").status));
  results.push(
    expectApplied(
      "APPLYING → READY_FOR_REVIEW (conflicto)",
      () => transitionTask(task.id, "READY_FOR_REVIEW", { conflictedPaths: ["lib/models.ts"] }).status,
    ),
  );
  results.push(expectApplied("READY_FOR_REVIEW → APPLYING (reintento)", () => transitionTask(task.id, "APPLYING").status));
  results.push(expectApplied("APPLYING → APPLIED", () => transitionTask(task.id, "APPLIED").status));

  const afterValid = getTask(task.id)!;
  console.log(`\nEstado final del camino válido: ${afterValid.status}, finishedAt: ${afterValid.finishedAt !== null}\n`);

  console.log("--- Transiciones inválidas (deben rechazarse todas) ---");
  // La task ya está en APPLIED (terminal) — nada debería poder moverla.
  results.push(expectRejected("APPLIED → RUNNING", () => transitionTask(task.id, "RUNNING")));
  results.push(expectRejected("APPLIED → QUEUED", () => transitionTask(task.id, "QUEUED")));

  // Una task nueva en QUEUED tampoco debería poder saltar directo a estados
  // que solo tienen sentido después de pasar por RUNNING.
  const task2 = createTask({ projectId: project.id, modelId: "test-model", prompt: "otra tarea" });
  results.push(expectRejected("QUEUED → READY_FOR_REVIEW (saltea RUNNING)", () => transitionTask(task2.id, "READY_FOR_REVIEW")));
  results.push(expectRejected("QUEUED → APPLIED (saltea todo)", () => transitionTask(task2.id, "APPLIED")));
  results.push(expectRejected("QUEUED → FAILED (FAILED solo desde RUNNING)", () => transitionTask(task2.id, "FAILED")));

  const allPassed = results.every(Boolean);
  console.log(`\n${allPassed ? "=== PRUEBA DE ACEPTACIÓN 2B: PASS ===" : "=== PRUEBA DE ACEPTACIÓN 2B: FAIL ==="}`);
  if (!allPassed) process.exit(1);
}

main().catch((error) => {
  console.error("Falló la prueba de Fase 2B:", error);
  process.exit(1);
});
