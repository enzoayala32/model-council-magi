/**
 * Fase 9B — tests del task ledger.
 *
 * Corre en un cwd temporal (la DB real NUNCA se toca) y con un workspace
 * temporal para validar evidencia de archivo. Cubre runs, versionado/poda
 * de planes, steps idempotentes, checkpoints, verificaciones y las reglas
 * de DONE/BLOCKED/FAILED.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let total = 0;
let failed = 0;

function check(condition: boolean, message: string, detail?: () => unknown): void {
  total += 1;
  if (condition) {
    console.log(`✅ ${message}`);
    return;
  }
  failed += 1;
  console.error(`❌ ${message}`);
  if (detail) console.error("   ", JSON.stringify(detail()));
}

function checkEq(actual: unknown, expected: unknown, message: string, detail?: () => unknown): void {
  check(JSON.stringify(actual) === JSON.stringify(expected), message, () => ({
    esperado: expected,
    actual,
    ...(detail ? { detalle: detail() } : {}),
  }));
}

function throws(run: () => unknown): unknown {
  try {
    run();
    return null;
  } catch (error) {
    return error;
  }
}

type SqliteDb = {
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number };
    all(...params: unknown[]): Array<Record<string, unknown>>;
    get(...params: unknown[]): Record<string, unknown> | undefined;
  };
  pragma(sql: string, options?: { simple?: boolean }): unknown;
  exec(sql: string): void;
  close(): void;
};

async function main(): Promise<void> {
  console.log("== Fase 9B — task ledger ==\n");

  const originalCwd = process.cwd();
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "magi-autonomy-ledger-"));
  const workspace = path.join(temp, "workspace");
  await fs.mkdir(path.join(workspace, "src"), { recursive: true });
  const fileContent = "hola mundo\n";
  await fs.writeFile(path.join(workspace, "src", "a.ts"), fileContent, "utf8");
  const fileHash = crypto.createHash("sha256").update(fileContent).digest("hex");

  let db: SqliteDb | null = null;

  try {
    process.chdir(temp);
    checkEq(process.cwd(), temp, "el test corre en un cwd temporal");

    const dbModule = (await import("../../db")) as { getDb(): SqliteDb };
    db = dbModule.getDb();
    db.pragma("foreign_keys = ON");

    const ledger = await import("./ledger");
    const planModule = await import("./plan");

    const now = Date.now();
    db.prepare(
      "INSERT INTO agent_projects (id, name, source_type, local_path, is_git_repo, archived, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("p1", "Proyecto", "local", workspace, 1, 0, now, now);
    db.prepare(
      "INSERT INTO agent_tasks (id, project_id, model_id, prompt, status, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("t1", "p1", "modelo", "tarea", "RUNNING", now);

    console.log("--- Runs ---");
    const run = ledger.createRun({ taskId: "t1" });
    checkEq(run.state, "PLANNING", "la corrida nace en PLANNING");
    checkEq(run.attempt, 1, "primer intento");
    checkEq(run.planVersion, 0, "sin plan todavía");
    checkEq(ledger.getActiveRunForTask("t1")?.id, run.id, "getActiveRunForTask devuelve la corrida");
    checkEq(ledger.getRun("no-existe"), null, "getRun inexistente → null");
    checkEq(ledger.listRunsForTask("t1").length, 1, "una corrida listada");

    const secondActive = throws(() => ledger.createRun({ taskId: "t1" }));
    check(secondActive instanceof Error, "no se puede crear una segunda corrida activa");
    check(
      secondActive instanceof Error && secondActive.message.includes("corrida activa"),
      "el error de corrida activa es claro",
      () => (secondActive instanceof Error ? secondActive.message : secondActive),
    );

    const invalidTransition = throws(() => ledger.transitionRun(run.id, "DONE"));
    check(invalidTransition instanceof Error, "PLANNING → DONE es inválida");

    const executing = ledger.transitionRun(run.id, "EXECUTING");
    checkEq(executing.state, "EXECUTING", "PLANNING → EXECUTING");
    checkEq(executing.finishedAt, null, "EXECUTING no tiene finishedAt");

    const progressed = ledger.updateRunProgress(run.id, {
      budget: { steps: 2, wallTimeMs: 1_000, inputTokens: 10, outputTokens: 5, estimatedCostUsd: 0.01 },
      headCommit: "abc123",
      lastEventSeq: 7,
    });
    checkEq(progressed.budget.steps, 2, "budget.steps actualizado");
    checkEq(progressed.budget.estimatedCostUsd, 0.01, "costo actualizado");
    checkEq(progressed.headCommit, "abc123", "headCommit actualizado");
    checkEq(progressed.lastEventSeq, 7, "lastEventSeq actualizado");

    console.log("\n--- Plan: versionado y poda ---");
    const planInput = {
      objective: "Implementar la feature X",
      acceptance: [{ kind: "typecheck" }],
      items: [
        { id: "t1", title: "Preparar", acceptance: [{ kind: "manual", description: "Revisar t1" }] },
        { id: "t2", title: "Verificar tipos", dependsOn: ["t1"], acceptance: [{ kind: "typecheck" }] },
        { id: "t3", title: "Archivo", dependsOn: ["t1"], acceptance: [{ kind: "file_hash", path: "src/a.ts", sha256: fileHash }] },
        { id: "t4", title: "Tests", dependsOn: ["t1"], acceptance: [{ kind: "script", name: "test" }] },
      ],
    };
    const normalized = planModule.normalizePlan(planInput);
    check(normalized.ok, "el plan de prueba es válido");
    if (!normalized.ok) throw new Error("plan de prueba inválido");

    const plan1 = ledger.savePlanVersion({ taskId: "t1", runId: run.id, plan: normalized.plan, source: "model" });
    checkEq(plan1.version, 1, "primera versión = 1");
    checkEq(plan1.status, "ACTIVE", "la primera versión queda ACTIVE");
    checkEq(plan1.items.length, 4, "cuatro items persistidos");
    checkEq(plan1.items.map((item) => item.logicalId), ["t1", "t2", "t3", "t4"], "ids lógicos preservados");
    checkEq(plan1.items.every((item) => item.status === "PENDING"), true, "todos los items nacen PENDING");
    checkEq(ledger.getRun(run.id)?.planVersion, 1, "run.planVersion apunta a la versión 1");
    checkEq(ledger.getActivePlan("t1")?.id, plan1.id, "getActivePlan devuelve la versión 1");
    checkEq(ledger.getPlanForRun(run.id)?.id, plan1.id, "getPlanForRun devuelve la versión 1");
    checkEq(ledger.getPlanVersion("t1", 1)?.hash, normalized.plan.hash, "el hash persistido coincide");

    const plan2 = ledger.savePlanVersion({ taskId: "t1", runId: run.id, plan: normalized.plan, source: "resume" });
    checkEq(plan2.version, 2, "segunda versión = 2");
    checkEq(ledger.getPlanById(plan1.id)?.status, "ABANDONED", "la versión anterior pasa a ABANDONED");
    checkEq(ledger.getActivePlan("t1")?.id, plan2.id, "la versión 2 queda ACTIVE");
    checkEq(ledger.getRun(run.id)?.planVersion, 2, "run.planVersion apunta a la versión 2");
    check(plan1.items[0].id !== plan2.items[0].id, "los ids físicos cambian entre versiones");
    checkEq(plan1.items[0].logicalId, plan2.items[0].logicalId, "el id lógico se conserva");

    const plan3 = ledger.savePlanVersion({ taskId: "t1", runId: run.id, plan: normalized.plan, source: "model", maxVersions: 2 });
    checkEq(plan3.version, 3, "tercera versión = 3");
    checkEq(ledger.getPlanVersion("t1", 1), null, "la versión 1 se podó");
    checkEq(ledger.listPlanVersions("t1").length, 2, "quedan dos versiones");
    const plan4 = ledger.savePlanVersion({ taskId: "t1", runId: run.id, plan: normalized.plan, source: "model", maxVersions: 2 });
    checkEq(plan4.version, 4, "cuarta versión = 4");
    checkEq(ledger.getPlanVersion("t1", 2), null, "la versión 2 se podó");
    checkEq(ledger.listPlanVersions("t1").map((entry) => entry.version), [4, 3], "quedan las versiones 3 y 4");
    ledger.updateRunProgress(run.id, { planVersion: 2 });
    checkEq(ledger.getPlanForRun(run.id), null, "una versión podada no cae al plan activo");
    ledger.updateRunProgress(run.id, { planVersion: 4 });
    checkEq(ledger.getPlanForRun(run.id)?.version, 4, "getPlanForRun vuelve a la versión vigente");
    checkEq(
      (db.prepare("SELECT COUNT(*) AS c FROM agent_plan_items WHERE plan_id = ?").get(plan3.id) as { c: number }).c,
      4,
      "los items de la versión 3 siguen intactos",
    );
    const activePlan = ledger.getActivePlan("t1");
    check(activePlan !== null, "hay un plan activo");
    if (!activePlan) throw new Error("sin plan activo");
    checkEq(activePlan.items.map((item) => item.logicalId), ["t1", "t2", "t3", "t4"], "el plan activo tiene los cuatro items");

    const invalidSource = throws(() =>
      ledger.savePlanVersion({ taskId: "t1", plan: normalized.plan, source: "otro" as never }),
    );
    check(invalidSource instanceof Error, "una fuente de plan inválida se rechaza");

    console.log("\n--- Steps ---");
    const step0 = ledger.recordStep({
      runId: run.id,
      stepIndex: 0,
      phase: "EXECUTING",
      actions: [
        {
          toolCallId: "call-1",
          toolName: "write_file",
          inputHash: "a".repeat(64),
          ok: true,
          files: ["src/a.ts", ".env", "../fuera.ts"],
        },
      ],
      results: [{ ok: true }],
      progress: { note: "sin contenido" },
      inputTokens: 10,
      outputTokens: 5,
    });
    checkEq(step0.phase, "EXECUTING", "step 0 persistido");
    checkEq(step0.actions[0].files, ["src/a.ts"], "archivos sensibles/peligrosos filtrados");
    checkEq(step0.progress.sensitiveFilesOmitted, 2, "se cuentan los archivos filtrados");
    checkEq(ledger.toolCallIdExists(run.id, "call-1"), true, "toolCallId call-1 existe");
    checkEq(ledger.toolCallIdExists(run.id, "call-2"), false, "toolCallId call-2 no existe");

    const step0b = ledger.recordStep({
      runId: run.id,
      stepIndex: 0,
      phase: "VERIFYING",
      actions: [
        { toolCallId: "call-1", toolName: "write_file", inputHash: "a".repeat(64), ok: true },
        { toolCallId: "call-2", toolName: "run_typecheck", inputHash: "b".repeat(64), ok: true },
      ],
      results: [{ ok: true }, { ok: true }],
      progress: { note: "actualizado" },
    });
    checkEq(step0b.phase, "VERIFYING", "el mismo stepIndex se actualiza");
    checkEq(ledger.getStepsForRun(run.id).length, 1, "no se duplica el step");
    checkEq(ledger.toolCallIdExists(run.id, "call-2"), true, "call-2 existe tras la actualización");
    checkEq(ledger.getStepsForRun(run.id, 1).length, 1, "el límite de steps funciona");

    const badStep = throws(() =>
      ledger.recordStep({ runId: run.id, stepIndex: -1, phase: "EXECUTING", actions: [] }),
    );
    check(badStep instanceof Error, "stepIndex negativo se rechaza");
    const hugeStep = throws(() =>
      ledger.recordStep({
        runId: run.id,
        stepIndex: 2,
        phase: "EXECUTING",
        actions: [],
        progress: { huge: "x".repeat(70_000) },
      }),
    );
    check(hugeStep instanceof Error, "un step demasiado grande se rechaza");

    const secretStep = ledger.recordStep({
      runId: run.id,
      stepIndex: 3,
      phase: "EXECUTING",
      actions: [],
      results: [
        { ok: true, summary: "resumen corto", stdout: "SECRETO_STDOUT", content: "SECRETO_CONTENIDO" },
        "texto crudo",
      ],
    });
    checkEq(secretStep.results, [{ ok: true, summary: "resumen corto" }], "results desconocidos se descartan");
    checkEq(secretStep.progress.omittedResultKeys, 3, "se cuentan las claves/entradas descartadas");

    console.log("\n--- Checkpoints ---");
    ledger.upsertFileCheckpoint({ runId: run.id, path: "src/a.ts", sha256: "b".repeat(64), size: 10, mtimeMs: 1_000 });
    checkEq(ledger.getFileCheckpoints(run.id).length, 1, "checkpoint insertado");
    ledger.upsertFileCheckpoint({ runId: run.id, path: "src/a.ts", sha256: "c".repeat(64), size: 20, mtimeMs: 2_000 });
    const checkpoints = ledger.getFileCheckpoints(run.id);
    checkEq(checkpoints.length, 1, "el checkpoint es upsert, no duplicado");
    checkEq(checkpoints[0].sha256, "c".repeat(64), "el hash del checkpoint se actualiza");
    checkEq(checkpoints[0].size, 20, "el tamaño del checkpoint se actualiza");
    const sensitiveCheckpoint = throws(() =>
      ledger.upsertFileCheckpoint({ runId: run.id, path: ".env", sha256: "d".repeat(64), size: 1, mtimeMs: 1 }),
    );
    check(sensitiveCheckpoint instanceof Error, "un checkpoint de ruta sensible se rechaza");
    const absoluteCheckpoint = throws(() =>
      ledger.upsertFileCheckpoint({ runId: run.id, path: "C:\\x", sha256: "d".repeat(64), size: 1, mtimeMs: 1 }),
    );
    check(absoluteCheckpoint instanceof Error, "un checkpoint de ruta absoluta se rechaza");
    const badHashCheckpoint = throws(() =>
      ledger.upsertFileCheckpoint({ runId: run.id, path: "src/a.ts", sha256: "abc", size: 1, mtimeMs: 1 }),
    );
    check(badHashCheckpoint instanceof Error, "un checkpoint con hash inválido se rechaza");

    console.log("\n--- Verificaciones ---");
    const verification = ledger.recordVerification({
      runId: run.id,
      itemId: activePlan.items[3].id,
      criterion: { kind: "script", name: "test" },
      status: "passed",
      evidence: { exitCode: 0, durationMs: 5, outputSha256: "e".repeat(64) },
    });
    checkEq(verification.status, "passed", "verificación persistida");
    checkEq(ledger.getVerificationsForRun(run.id).length, 1, "una verificación en la corrida");
    checkEq(ledger.findCommandVerification(run.id, "test", 0)?.id, verification.id, "encuentra test/0");
    checkEq(ledger.findCommandVerification(run.id, "test", 1), null, "no encuentra test/1");
    ledger.recordVerification({
      runId: run.id,
      itemId: activePlan.items[1].id,
      criterion: { kind: "typecheck" },
      status: "passed",
      evidence: { exitCode: 0, durationMs: 7 },
    });
    checkEq(ledger.findCommandVerification(run.id, "typecheck", 0)?.status, "passed", "encuentra typecheck/0");

    console.log("\n--- Items: DONE y evidencia ---");
    const t1 = activePlan.items.find((item) => item.logicalId === "t1")!;
    const t2 = activePlan.items.find((item) => item.logicalId === "t2")!;
    const t3 = activePlan.items.find((item) => item.logicalId === "t3")!;
    const t4 = activePlan.items.find((item) => item.logicalId === "t4")!;

    const t1Start = await ledger.updatePlanItem({ runId: run.id, itemId: "t1", status: "IN_PROGRESS" });
    check(t1Start.ok, "t1 → IN_PROGRESS");
    if (t1Start.ok) {
      checkEq(t1Start.item.status, "IN_PROGRESS", "t1 está IN_PROGRESS");
      check(t1Start.item.startedAt !== null, "t1 tiene startedAt");
      checkEq(t1Start.item.attempts, 1, "t1 attempts=1");
    }

    const t1NoEvidence = await ledger.updatePlanItem({ runId: run.id, itemId: "t1", status: "DONE" });
    check(!t1NoEvidence.ok, "DONE sin evidencia se rechaza");
    if (!t1NoEvidence.ok) checkEq(t1NoEvidence.code, "evidence_invalid", "código de DONE sin evidencia");

    const t1UnknownCall = await ledger.updatePlanItem({
      runId: run.id,
      itemId: "t1",
      status: "DONE",
      evidence: [{ kind: "tool_result", toolCallId: "no-existe" }],
    });
    check(!t1UnknownCall.ok, "DONE con toolCallId inexistente se rechaza");
    if (!t1UnknownCall.ok) checkEq(t1UnknownCall.code, "evidence_invalid", "código de toolCallId inexistente");

    const t1Done = await ledger.updatePlanItem({
      runId: run.id,
      itemId: "t1",
      status: "DONE",
      evidence: [
        { kind: "tool_result", toolCallId: "call-1" },
        { kind: "manual", description: "revisado" },
      ],
    });
    check(t1Done.ok, "t1 → DONE con evidencia real");
    if (t1Done.ok) {
      checkEq(t1Done.item.status, "DONE", "t1 está DONE");
      checkEq(t1Done.item.attempts, 2, "t1 attempts=2");
      check(t1Done.warnings.includes("manual_evidence_unverified"), "warning de evidencia manual");
      check(t1Done.item.finishedAt !== null, "t1 tiene finishedAt");
    }

    const t2Start = await ledger.updatePlanItem({ runId: run.id, itemId: "t2", status: "IN_PROGRESS" });
    check(t2Start.ok, "t2 → IN_PROGRESS");
    const t2BlockedNoReason = await ledger.updatePlanItem({ runId: run.id, itemId: "t2", status: "BLOCKED" });
    check(!t2BlockedNoReason.ok, "BLOCKED sin motivo se rechaza");
    if (!t2BlockedNoReason.ok) checkEq(t2BlockedNoReason.code, "plan_invalid", "código de BLOCKED sin motivo");
    const t2Blocked = await ledger.updatePlanItem({ runId: run.id, itemId: "t2", status: "BLOCKED", reason: "falta un dato" });
    check(t2Blocked.ok, "BLOCKED con motivo se acepta");
    const t2Resume = await ledger.updatePlanItem({ runId: run.id, itemId: "t2", status: "IN_PROGRESS" });
    check(t2Resume.ok, "BLOCKED → IN_PROGRESS se acepta");

    const failingVerifier: import("./ledger").AcceptanceVerifier = async () => ({
      status: "failed",
      evidence: { exitCode: 1 },
      detail: "falló",
    });
    const t2FailedVerification = await ledger.updatePlanItem({
      runId: run.id,
      itemId: "t2",
      status: "DONE",
      evidence: [{ kind: "manual", description: "creo que anda" }],
      workspaceRoot: workspace,
      verifier: failingVerifier,
    });
    check(!t2FailedVerification.ok, "DONE con verificación fallida se rechaza");
    if (!t2FailedVerification.ok) checkEq(t2FailedVerification.code, "verification_failed", "código verification_failed");
    const t2AfterFailure = ledger.getPlanForRun(run.id)?.items.find((item) => item.logicalId === "t2");
    checkEq(t2AfterFailure?.status, "IN_PROGRESS", "el rechazo no mutó t2");
    checkEq(ledger.getVerificationsForRun(run.id).filter((entry) => entry.status === "failed").length, 1, "la verificación fallida quedó registrada");

    const passingVerifier: import("./ledger").AcceptanceVerifier = async ({ criterion }) => ({
      status: "passed",
      evidence: { exitCode: 0, criterion: planModule.describeCriterion(criterion) },
    });
    const t2Done = await ledger.updatePlanItem({
      runId: run.id,
      itemId: "t2",
      status: "DONE",
      evidence: [{ kind: "manual", description: "verificado" }],
      workspaceRoot: workspace,
      verifier: passingVerifier,
    });
    check(t2Done.ok, "DONE con verificación aprobada se acepta");
    if (t2Done.ok) checkEq(t2Done.item.status, "DONE", "t2 está DONE");

    const t3Start = await ledger.updatePlanItem({ runId: run.id, itemId: "t3", status: "IN_PROGRESS" });
    check(t3Start.ok, "t3 → IN_PROGRESS");
    const t3WrongHash = await ledger.updatePlanItem({
      runId: run.id,
      itemId: "t3",
      status: "DONE",
      evidence: [{ kind: "file", path: "src/a.ts", sha256: "f".repeat(64) }],
      workspaceRoot: workspace,
      verifier: passingVerifier,
    });
    check(!t3WrongHash.ok, "DONE con hash de archivo incorrecto se rechaza");
    if (!t3WrongHash.ok) checkEq(t3WrongHash.code, "evidence_invalid", "código de hash incorrecto");
    const t3Missing = await ledger.updatePlanItem({
      runId: run.id,
      itemId: "t3",
      status: "DONE",
      evidence: [{ kind: "file", path: "src/missing.ts", sha256: fileHash }],
      workspaceRoot: workspace,
      verifier: passingVerifier,
    });
    check(!t3Missing.ok, "DONE con archivo inexistente se rechaza");
    if (!t3Missing.ok) {
      checkEq(t3Missing.code, "evidence_invalid", "código de archivo inexistente");
      check(!t3Missing.error.includes(workspace), "el error no filtra la ruta absoluta del workspace");
    }
    const t3Done = await ledger.updatePlanItem({
      runId: run.id,
      itemId: "t3",
      status: "DONE",
      evidence: [{ kind: "file", path: "src/a.ts", sha256: fileHash }],
      workspaceRoot: workspace,
      verifier: passingVerifier,
    });
    check(t3Done.ok, "DONE con hash de archivo correcto se acepta");
    if (t3Done.ok) checkEq(t3Done.item.status, "DONE", "t3 está DONE");

    const t4Start = await ledger.updatePlanItem({ runId: run.id, itemId: "t4", status: "IN_PROGRESS" });
    check(t4Start.ok, "t4 → IN_PROGRESS");
    const t4BadCommand = await ledger.updatePlanItem({
      runId: run.id,
      itemId: "t4",
      status: "DONE",
      evidence: [{ kind: "command", name: "test", exitCode: 1 }],
      workspaceRoot: workspace,
      verifier: passingVerifier,
    });
    check(!t4BadCommand.ok, "DONE con comando exit 1 se rechaza");
    if (!t4BadCommand.ok) checkEq(t4BadCommand.code, "evidence_invalid", "código de comando fallido");
    const t4UnknownCommand = await ledger.updatePlanItem({
      runId: run.id,
      itemId: "t4",
      status: "DONE",
      evidence: [{ kind: "command", name: "build", exitCode: 0 }],
      workspaceRoot: workspace,
      verifier: passingVerifier,
    });
    check(!t4UnknownCommand.ok, "DONE con comando no registrado se rechaza");
    if (!t4UnknownCommand.ok) checkEq(t4UnknownCommand.code, "evidence_invalid", "código de comando no registrado");
    const t4Done = await ledger.updatePlanItem({
      runId: run.id,
      itemId: "t4",
      status: "DONE",
      evidence: [{ kind: "command", name: "test", exitCode: 0 }],
      workspaceRoot: workspace,
      allowedScripts: ["test"],
      verifier: passingVerifier,
    });
    check(t4Done.ok, "DONE con comando verificado se acepta");
    if (t4Done.ok) checkEq(t4Done.item.status, "DONE", "t4 está DONE");

    const t1Reopen = await ledger.updatePlanItem({ runId: run.id, itemId: "t1", status: "IN_PROGRESS" });
    check(!t1Reopen.ok, "DONE → IN_PROGRESS se rechaza");
    if (!t1Reopen.ok) checkEq(t1Reopen.code, "plan_invalid", "código de transición inválida");

    console.log("\n--- Reset y estado del plan ---");
    const reset = ledger.resetPlanItemToPending(t1.id, "evidencia stale");
    checkEq(reset.status, "PENDING", "resetPlanItemToPending vuelve a PENDING");
    checkEq(reset.evidence, [], "el reset limpia la evidencia");
    checkEq(reset.lastError, "evidencia stale", "el reset conserva el motivo");
    const planCompleted = ledger.markPlanStatus(activePlan.id, "COMPLETED");
    checkEq(planCompleted?.status, "COMPLETED", "markPlanStatus COMPLETED");
    checkEq(ledger.getActivePlan("t1"), null, "un plan COMPLETED no es activo");
    const planReactivated = ledger.markPlanStatus(activePlan.id, "ACTIVE");
    checkEq(planReactivated?.status, "ACTIVE", "markPlanStatus ACTIVE");

    console.log("\n--- Cierre de la corrida ---");
    const verifying = ledger.transitionRun(run.id, "VERIFYING");
    checkEq(verifying.state, "VERIFYING", "EXECUTING → VERIFYING");
    const done = ledger.transitionRun(run.id, "DONE");
    checkEq(done.state, "DONE", "VERIFYING → DONE");
    checkEq(done.stopReason, "completed", "stopReason completed por defecto");
    check(done.finishedAt !== null, "DONE tiene finishedAt");
    checkEq(ledger.getActiveRunForTask("t1"), null, "una corrida terminal no está activa");

    const itemAfterTerminal = await ledger.updatePlanItem({
      runId: run.id,
      itemId: "t2",
      status: "DONE",
      evidence: [{ kind: "manual", description: "tarde" }],
    });
    check(!itemAfterTerminal.ok, "no se puede actualizar un item de una corrida terminal");
    if (!itemAfterTerminal.ok) checkEq(itemAfterTerminal.code, "internal_error", "código de corrida terminal");
    const progressAfterTerminal = throws(() => ledger.updateRunProgress(run.id, { error: "tarde" }));
    check(progressAfterTerminal instanceof Error, "no se puede actualizar progreso de una corrida terminal");
    const saveAfterTerminal = throws(() =>
      ledger.savePlanVersion({ taskId: "t1", runId: run.id, plan: normalized.plan, source: "model" }),
    );
    check(saveAfterTerminal instanceof Error, "no se puede guardar un plan en una corrida terminal");

    const run2 = ledger.createRun({ taskId: "t1" });
    checkEq(run2.attempt, 2, "una corrida nueva usa attempt 2");
    checkEq(ledger.getActiveRunForTask("t1")?.id, run2.id, "la corrida nueva queda activa");
    const saveWrongTask = throws(() =>
      ledger.savePlanVersion({ taskId: "otra", runId: run2.id, plan: normalized.plan, source: "model" }),
    );
    check(saveWrongTask instanceof Error, "no se puede guardar un plan de otra task en la corrida");
    ledger.transitionRun(run2.id, "CANCELLED");
    checkEq(ledger.getRun(run2.id)?.stopReason, "cancelled", "CANCELLED usa stopReason cancelled");
    checkEq(ledger.listRunsForTask("t1").length, 2, "dos corridas en total");
  } finally {
    try {
      db?.close();
    } catch {
      // best-effort
    }
    (globalThis as unknown as { __councilDb?: unknown }).__councilDb = undefined;
    process.chdir(originalCwd);
    await fs.rm(temp, { recursive: true, force: true }).catch(() => undefined);
  }

  console.log(`\n${total - failed}/${total} casos OK.`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error("Error inesperado en la prueba del ledger:", error);
  process.exit(1);
});
