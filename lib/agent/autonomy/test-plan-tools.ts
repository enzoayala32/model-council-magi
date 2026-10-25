/**
 * Fase 9B — tests de las tools `update_plan` / `update_plan_item`.
 *
 * Verifica el schema Zod, que las tools persistan en el ledger, que un
 * plan inválido no se guarde, que DONE sin evidencia/verificación se
 * rechace y que la salida no filtre descripciones/evidencia. Corre en un
 * cwd temporal; la DB real no se toca.
 */
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

type SqliteDb = {
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number };
    all(...params: unknown[]): Array<Record<string, unknown>>;
    get(...params: unknown[]): Record<string, unknown> | undefined;
  };
  pragma(sql: string, options?: { simple?: boolean }): unknown;
  close(): void;
};

async function main(): Promise<void> {
  console.log("== Fase 9B — tools de plan ==\n");

  const originalCwd = process.cwd();
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "magi-autonomy-tools-"));
  const workspace = path.join(temp, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  let db: SqliteDb | null = null;

  try {
    process.chdir(temp);
    checkEq(process.cwd(), temp, "el test corre en un cwd temporal");

    const dbModule = (await import("../../db")) as { getDb(): SqliteDb };
    db = dbModule.getDb();
    db.pragma("foreign_keys = ON");

    const ledger = await import("./ledger");
    const toolsModule = await import("./tools");

    const now = Date.now();
    db.prepare(
      "INSERT INTO agent_projects (id, name, source_type, local_path, is_git_repo, archived, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("p1", "Proyecto", "local", workspace, 1, 0, now, now);
    db.prepare(
      "INSERT INTO agent_tasks (id, project_id, model_id, prompt, status, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("t1", "p1", "modelo", "tarea", "RUNNING", now);
    const run = ledger.createRun({ taskId: "t1" });
    ledger.transitionRun(run.id, "EXECUTING");

    console.log("--- Schemas ---");
    const validPlanInput = {
      objective: "Implementar X",
      constraints: ["no agregar dependencias"],
      acceptance: [{ kind: "typecheck" }],
      items: [
        {
          id: "t1",
          title: "Preparar",
          description: "SECRETO_NO_DEBE_SALIR",
          acceptance: [{ kind: "manual", description: "revisar" }],
        },
        { id: "t2", title: "Verificar", dependsOn: ["t1"], acceptance: [{ kind: "typecheck" }] },
      ],
    };
    check(toolsModule.updatePlanInputSchema.safeParse(validPlanInput).success, "schema de update_plan acepta un plan válido");
    check(
      !toolsModule.updatePlanInputSchema.safeParse({ objective: "x" }).success,
      "schema de update_plan rechaza sin items",
    );
    check(
      !toolsModule.updatePlanInputSchema.safeParse({ ...validPlanInput, items: [{ id: "t1", title: "x", acceptance: [{ kind: "deploy" }] }] }).success,
      "schema de update_plan rechaza acceptance desconocida",
    );
    check(
      toolsModule.updatePlanItemInputSchema.safeParse({ id: "t1", status: "DONE", evidence: [{ kind: "manual", description: "ok" }] }).success,
      "schema de update_plan_item acepta DONE con evidencia manual",
    );
    check(
      !toolsModule.updatePlanItemInputSchema.safeParse({ id: "t1", status: "PENDING" }).success,
      "schema de update_plan_item rechaza PENDING",
    );
    check(
      !toolsModule.updatePlanItemInputSchema.safeParse({ id: "t1", status: "DONE", evidence: [{ kind: "command", name: "deploy", exitCode: 0 }] }).success,
      "schema de update_plan_item rechaza comando no permitido",
    );

    console.log("\n--- update_plan ---");
    const tools = toolsModule.createAutonomyPlanTools({
      taskId: "t1",
      runId: run.id,
      workspaceRoot: workspace,
      allowedScripts: ["test"],
    });
    const updatePlan = (input: unknown, signal?: AbortSignal) =>
      (tools.update_plan as unknown as { execute(input: unknown, options?: { abortSignal?: AbortSignal }): Promise<any> }).execute(
        input,
        { abortSignal: signal },
      );
    const updatePlanItem = (input: unknown, signal?: AbortSignal) =>
      (tools.update_plan_item as unknown as { execute(input: unknown, options?: { abortSignal?: AbortSignal }): Promise<any> }).execute(
        input,
        { abortSignal: signal },
      );

    const firstPlan = await updatePlan(validPlanInput);
    checkEq(firstPlan.ok, true, "update_plan guarda un plan válido");
    checkEq(firstPlan.version, 1, "primera versión = 1");
    checkEq(firstPlan.items.length, 2, "devuelve dos items");
    checkEq(firstPlan.items[0].id, "t1", "devuelve el id lógico");
    check(!JSON.stringify(firstPlan).includes("SECRETO_NO_DEBE_SALIR"), "la salida no incluye la descripción del plan");
    checkEq(ledger.getActivePlan("t1")?.version, 1, "el plan quedó persistido");
    checkEq(ledger.getRun(run.id)?.planVersion, 1, "run.planVersion actualizado por la tool");

    const invalidPlan = await updatePlan({
      ...validPlanInput,
      items: [
        { id: "t1", title: "a", acceptance: [{ kind: "typecheck" }] },
        { id: "t1", title: "b" },
      ],
    });
    checkEq(invalidPlan.ok, false, "un plan inválido no se guarda");
    check(Array.isArray(invalidPlan.errors) && invalidPlan.errors.length > 0, "el rechazo incluye errores");
    checkEq(ledger.getActivePlan("t1")?.version, 1, "el plan inválido no crea una versión nueva");

    const tooLargeTools = toolsModule.createAutonomyPlanTools({
      taskId: "t1",
      runId: run.id,
      workspaceRoot: workspace,
      limits: { ...(await import("./contract")).DEFAULT_AUTONOMY_LIMITS, maxPlanItems: 1 },
    });
    const tooLarge = await (tooLargeTools.update_plan as unknown as { execute(input: unknown): Promise<any> }).execute(validPlanInput);
    checkEq(tooLarge.ok, false, "un plan que excede maxPlanItems se rechaza");
    check(
      Array.isArray(tooLarge.errors) && tooLarge.errors.some((error: { code: string }) => error.code === "plan_too_large"),
      "el rechazo por tamaño usa plan_too_large",
      () => tooLarge,
    );

    console.log("\n--- update_plan_item ---");
    const t1Start = await updatePlanItem({ id: "t1", status: "IN_PROGRESS" });
    checkEq(t1Start.ok, true, "t1 → IN_PROGRESS");
    const t1NoEvidence = await updatePlanItem({ id: "t1", status: "DONE" });
    checkEq(t1NoEvidence.ok, false, "t1 DONE sin evidencia se rechaza");
    checkEq(t1NoEvidence.code, "evidence_invalid", "código evidence_invalid");
    const t1Done = await updatePlanItem({
      id: "t1",
      status: "DONE",
      evidence: [{ kind: "manual", description: "SECRETO_EVIDENCIA" }],
    });
    checkEq(t1Done.ok, true, "t1 → DONE con evidencia manual");
    checkEq(t1Done.item.status, "DONE", "t1 está DONE");
    check(!JSON.stringify(t1Done).includes("SECRETO_EVIDENCIA"), "la salida no incluye la descripción de la evidencia");
    checkEq(t1Done.warnings, ["manual_evidence_unverified"], "warning de evidencia manual");

    const t2Start = await updatePlanItem({ id: "t2", status: "IN_PROGRESS" });
    checkEq(t2Start.ok, true, "t2 → IN_PROGRESS");
    const t2NoVerifier = await updatePlanItem({
      id: "t2",
      status: "DONE",
      evidence: [{ kind: "manual", description: "creo que anda" }],
    });
    checkEq(t2NoVerifier.ok, false, "t2 DONE sin verificador se rechaza");
    checkEq(t2NoVerifier.code, "verification_unavailable", "código verification_unavailable");

    const toolsWithVerifier = toolsModule.createAutonomyPlanTools({
      taskId: "t1",
      runId: run.id,
      workspaceRoot: workspace,
      allowedScripts: ["test"],
      verifier: async () => ({ status: "passed", evidence: { exitCode: 0 } }),
    });
    const t2Done = await (toolsWithVerifier.update_plan_item as unknown as { execute(input: unknown): Promise<any> }).execute({
      id: "t2",
      status: "DONE",
      evidence: [{ kind: "manual", description: "verificado" }],
    });
    checkEq(t2Done.ok, true, "t2 DONE con verificador se acepta");
    checkEq(t2Done.item.status, "DONE", "t2 está DONE");

    const unknownItem = await updatePlanItem({ id: "t9", status: "IN_PROGRESS" });
    checkEq(unknownItem.ok, false, "un item inexistente se rechaza");
    checkEq(unknownItem.code, "plan_item_unknown", "código plan_item_unknown");

    const secondPlan = await updatePlan(validPlanInput);
    checkEq(secondPlan.ok, true, "una segunda versión del plan se guarda");
    checkEq(secondPlan.version, 2, "segunda versión = 2");
    checkEq(ledger.getActivePlan("t1")?.items.every((item) => item.status === "PENDING"), true, "la versión nueva nace PENDING");

    console.log("\n--- Cancelación y corrida terminal ---");
    const controller = new AbortController();
    controller.abort();
    const abortedPlan = await updatePlan(validPlanInput, controller.signal);
    checkEq(abortedPlan.ok, false, "update_plan con signal abortado se rechaza");

    ledger.transitionRun(run.id, "CANCELLED");
    const terminalPlan = await updatePlan(validPlanInput);
    checkEq(terminalPlan.ok, false, "update_plan en corrida terminal se rechaza");
    const terminalItem = await updatePlanItem({ id: "t1", status: "IN_PROGRESS" });
    checkEq(terminalItem.ok, false, "update_plan_item en corrida terminal se rechaza");

    console.log("\n--- Políticas ---");
    check(
      toolsModule.AUTONOMY_PLAN_POLICIES.update_plan_item.timeoutMs > toolsModule.AUTONOMY_PLAN_POLICIES.update_plan.timeoutMs,
      "la tool que puede verificar tiene timeout mayor",
    );
    checkEq(toolsModule.AUTONOMY_PLAN_TOOL_NAMES, ["update_plan", "update_plan_item"], "nombres de tools exportados");
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
  console.error("Error inesperado en la prueba de tools:", error);
  process.exit(1);
});
